#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
jzxz-material-crawler.py — 建筑学长贴图素材库本机爬虫

原理：真实页面自己完成签名（规避接口逆向），selenium 无头驱动贴图面板翻页，
页面内注入 fetch/XHR 钩子捕获 wallpaper/reference 响应；图片下载后按内容哈希
转存 Supabase 公开桶 jzxz-materials，元数据 upsert 到表 jzxz_materials。

面板层级（实测 v2.17.29）：库 tab(家居库/植物库/配景库)
  → 分类 chips（div.first_cate_list_*，11 类）
  → tag chips（div.sub_cate_list_*，如 绿树/彩树/枯树…）
  → 网格（每页 12 条，上一页/下一页）
  接口 tag 参数 = "免抠-<tag名>."

用法：
  python scripts/jzxz-material-crawler.py --dry-run          # 只抓取解析，落本地 JSON，不上传
  python scripts/jzxz-material-crawler.py --headed           # 有头模式（观察/调试）
  python scripts/jzxz-material-crawler.py --login            # 首次登录（有头，会话存 profile）
  python scripts/jzxz-material-crawler.py                    # 每日定时：无头+增量+上传
  python scripts/jzxz-material-crawler.py --categories 植物配景,人物配景

配置：scripts/jzxz-crawler.local.json（gitignored，模板见 .example）
"""

import argparse
import hashlib
import json
import sys
import time
from datetime import datetime
from pathlib import Path
from urllib.parse import urlparse, parse_qs

import requests
from selenium import webdriver
from selenium.webdriver.chrome.options import Options
from selenium.webdriver.chrome.service import Service
from selenium.webdriver.common.by import By
from selenium.webdriver.common.action_chains import ActionChains

ROOT = Path(__file__).resolve().parent.parent
CONFIG_PATH = ROOT / "scripts" / "jzxz-crawler.local.json"
DATA_DIR = ROOT / "data" / "jzxz-captured"
PROFILE_DIR_DEFAULT = ROOT / "data" / "jzxz-chrome-profile"
BUCKET = "jzxz-materials"
# storage key 仅允许 ASCII：分类 → slug 映射（未知分类回退 c+哈希）
CATE_SLUGS = {
    "植物配景": "plant-scene", "人物配景": "people-scene", "交通配景": "traffic-scene",
    "室内家具": "indoor-furniture", "室内物品": "indoor-items",
    "建筑构件": "building-components", "城市建筑": "city-buildings",
    "景观小品": "landscape-ornament", "动物配景": "animal-scene",
    "自然环境": "nature", "总平素材": "masterplan",
}


def cate_slug(category: str) -> str:
    if category in CATE_SLUGS:
        return CATE_SLUGS[category]
    return "c" + hashlib.md5(category.encode("utf-8")).hexdigest()[:10]
TABLE = "jzxz_materials"
GALLERIES = ["家居库", "植物库", "配景库"]  # 配景库有两级分类，其余两库为属性筛选直翻页


def norm_tag(tag: str) -> str:
    """tag 归一化为 chip 文本：去 免抠- 前缀与尾点"""
    t = (tag or "").strip()
    if t.startswith("免抠-"):
        t = t[3:]
    return t.rstrip(".").strip()
PAGE_URL = "https://www.jianzhuxuezhang.com/home"

CAPTURE_HOOK = r"""
window.__jzxzCapture = window.__jzxzCapture || [];
(function () {
  if (window.__jzxzHooked) return;
  window.__jzxzHooked = true;
  async function record(url, text) {
    try {
      if (/wallpaper\/reference/.test(url) && text && text[0] === '{') {
        window.__jzxzCapture.push({ url: String(url), body: text, at: Date.now() });
      }
    } catch (e) {}
  }
  const origFetch = window.fetch;
  window.fetch = async function (...args) {
    const res = await origFetch.apply(this, args);
    try {
      const url = typeof args[0] === 'string' ? args[0] : (args[0] && args[0].url) || '';
      if (/wallpaper\/reference/.test(url)) { const c = res.clone(); c.text().then((t) => record(url, t)); }
    } catch (e) {}
    return res;
  };
  const O = XMLHttpRequest.prototype.open, S = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (m, u) { this.__jzxzUrl = u; return O.apply(this, arguments); };
  XMLHttpRequest.prototype.send = function () {
    this.addEventListener('load', function () {
      try { if (this.__jzxzUrl) record(this.__jzxzUrl, this.responseText); } catch (e) {}
    });
    return S.apply(this, arguments);
  };
})();
"""

HARVEST_GRID = r"""
() => {
  const panel = [...document.querySelectorAll('div')].find(d => {
    const w = d.offsetWidth;
    return w > 250 && w < 520 && (d.innerText || '').includes('贴图') && (d.innerText || '').includes('下一页');
  });
  if (!panel) return [];
  const out = [];
  const seen = new Set();
  const push = (raw) => {
    if (!raw) return;
    const m = raw.match(/https:\/\/[^"')]*soutushenqi\.com[^"')]*(?:\?[^"')]*)?/);
    if (!m) return;
    const full = m[0];
    const clean = full.split('?')[0];
    const stem = clean.split('/').pop().replace(/\.[a-z]+$/i, '');
    if (!stem || seen.has(stem)) return;
    seen.add(stem);
    out.push({ source_id: stem, url: clean, thumb: full, width: null, height: null, name: null });
  };
  for (const img of document.querySelectorAll('img')) {
    push(img.currentSrc || img.src || '');
    push(img.getAttribute('data-src') || '');
  }
  for (const el of document.querySelectorAll('*')) {
    const bg = getComputedStyle(el).backgroundImage || '';
    if (/image(-assets)?\.soutushenqi\.com/.test(bg)) push(bg);
  }
  return out;
}
"""

PROBE_PNG_B64 = ("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGA"
                 "WjR9awAAAABJRU5ErkJggg==")


def log(msg):
    print(f"[{datetime.now().strftime('%H:%M:%S')}] {msg}", flush=True)


def load_config():
    if not CONFIG_PATH.exists():
        sys.exit(f"缺少配置文件 {CONFIG_PATH}（模板见 scripts/jzxz-crawler.local.json.example）")
    cfg = json.loads(CONFIG_PATH.read_text(encoding="utf-8"))
    for key in ("supabase_url", "service_key"):
        if not cfg.get(key) and not ARGS.dry_run:
            sys.exit(f"配置缺少 {key}（非 dry-run 模式必填）")
    return cfg


def real_click(driver, el):
    """ActionChains 真实输入管线点击（自动滚动到元素）"""
    ActionChains(driver).move_to_element(el).pause(0.15).click().perform()


def mouse_click(driver, el):
    driver.execute_script("""
      const el = arguments[0];
      for (const t of ['pointerdown','mousedown','pointerup','mouseup','click']) {
        el.dispatchEvent(new MouseEvent(t, {bubbles: true, cancelable: true, view: window}));
      }
    """, el)


def drain(driver):
    return driver.execute_script("return window.__jzxzCapture ? window.__jzxzCapture.splice(0) : [];")


def wait_any(driver, gallery, timeout=20):
    """等待任意新 reference 响应；返回 [(tag_param, items), ...]。
    面板会按 tag 记忆翻页位置（点击 tag 不一定回到第 0 页），故只做事件驱动收割，
    乱序页按 source_id 去重，不影响最终覆盖。"""
    deadline = time.time() + timeout
    out = []
    while time.time() < deadline and not out:
        for cap in drain(driver):
            q = parse_qs(urlparse(cap["url"]).query)
            tag = q.get("tag", [""])[0]
            out.append((tag, parse_items(cap["body"], gallery, None, tag)))
        if not out:
            time.sleep(0.5)
    return out


def process_batch(cfg, items, stats, dry_items):
    known = known_source_ids(cfg, [i["source_id"] for i in items])
    stats["pages"] += 1
    stats["items"] += len(items)
    new_here = 0
    for it in items:
        if it["source_id"] in known:
            stats["skipped_known"] += 1
            continue
        new_here += 1
        if ARGS.dry_run:
            dry_items.append(dict(it, known=False))
            stats["downloaded"] += 0
            continue
        status = upload_item(cfg, it)
        if status == "ok":
            stats["downloaded"] += 1
        else:
            stats["failed"] += 1
            log(f"    [warn] {it['source_id']} 上传失败：{status}")
        time.sleep(0.2)
    return len(items), new_here


def row_arrows(driver, row):
    """行内前/后箭头（按 y 坐标同行配对；相邻行的箭头 y 不同）"""
    try:
        ry = row.rect["y"]
    except Exception:
        return None, None
    parent = row.find_element(By.XPATH, "..")
    prev = next_e = None
    for el in parent.find_elements(By.XPATH, ".//*[contains(@class,'arrow_icon')]"):
        cls = el.get_attribute("class") or ""
        try:
            r = el.rect
        except Exception:
            continue
        if abs(r["y"] - ry) > 25:
            continue
        if "prev_" in cls:
            prev = el
        elif "next_" in cls:
            next_e = el
    return prev, next_e


def panel_chips(driver, row_class_frag):
    """分类/tag 行内全部 chip（文本, 元素）；行内箭头滚动直到 chip 集合稳定"""
    row = next((r for r in driver.find_elements(By.XPATH, f"//div[contains(@class,'{row_class_frag}')]") if r.is_displayed()), None)
    if row is None:
        return []
    collected = {}

    def collect():
        for s in row.find_elements(By.XPATH, ".//*[contains(@class,'swiper-slide')]"):
            t = (s.text or "").strip()
            if t and len(t) <= 12:
                collected[t] = s

    prev, nxt = row_arrows(driver, row)
    for _ in range(30):
        before = set(collected)
        collect()
        if len(collected) == len(before):
            break
        if not nxt:
            break
        try:
            real_click(driver, nxt)
        except Exception:
            break
        time.sleep(0.5)
        prev, nxt = row_arrows(driver, row)
    collect()
    return list(collected.items())


def bring_chip_into_view(driver, row_class_frag, name, attempts=30):
    """点击行内箭头把目标 chip 滚入可视区，返回该 chip 元素"""
    row = next((r for r in driver.find_elements(By.XPATH, f"//div[contains(@class,'{row_class_frag}')]") if r.is_displayed()), None)
    if row is None:
        return None
    row_rect = row.rect
    for _ in range(attempts):
        slides = row.find_elements(By.XPATH, ".//*[contains(@class,'swiper-slide')]")
        for sl in slides:
            if (sl.text or "").strip() == name:
                r = sl.rect
                if row_rect["x"] - 5 <= r["x"] and r["x"] + r["width"] <= row_rect["x"] + row_rect["width"] + 5:
                    return sl
        prev, nxt = row_arrows(driver, row)
        if not prev or not nxt:
            return None
        target = None
        for sl in slides:
            if (sl.text or "").strip() == name:
                target = sl
                break
        if target is None:
            return None
        tr = target.rect
        if tr["x"] + tr["width"] / 2 < row_rect["x"] + row_rect["width"] / 2:
            real_click(driver, prev)
        else:
            real_click(driver, nxt)
        time.sleep(0.4)
    return None


def click_chip_verified(driver, name, row_class_frag, attempts=3):
    """滚入可视区 → 真实点击 → 轮询校验 active 迁移；失败重试"""
    for _ in range(attempts):
        el = bring_chip_into_view(driver, row_class_frag, name)
        if el is None:
            time.sleep(1)
            continue
        real_click(driver, el)
        deadline = time.time() + 8
        while time.time() < deadline:
            cur = next((r for r in driver.find_elements(By.XPATH, f"//div[contains(@class,'{row_class_frag}')]") if r.is_displayed()), None)
            if cur is not None:
                sel = [s for s in cur.find_elements(By.XPATH, ".//*[contains(@class,'swiper-slide')]")
                       if (s.text or "").strip() == name and "active" in (s.get_attribute("class") or "")]
                if sel:
                    return True
            time.sleep(0.5)
    return False


def parse_items(body_text, gallery, category, tag):
    try:
        j = json.loads(body_text)
        rows = j.get("data") if isinstance(j.get("data"), list) else []
    except Exception:
        return []
    out = []
    for r in rows:
        if not isinstance(r, dict):
            continue
        url = r.get("largeUrl") or r.get("thumbUrl") or ""
        if not url:
            continue
        stem = Path(urlparse(url).path).stem  # UUID 文件名 = 稳定 source_id
        out.append({
            "source_id": stem, "gallery": gallery, "category": category,
            "tag": norm_tag(tag),
            "name": r.get("name"),
            "width": r.get("width"), "height": r.get("height"),
            "url": url, "thumb": r.get("thumbUrl"),
        })
    return out


def parse_grid(rows, gallery, category, tag):
    out = []
    for r in rows or []:
        url = r.get("url") or ""
        if not url:
            continue
        out.append({
            "source_id": r["source_id"], "gallery": gallery, "category": category,
            "tag": norm_tag(tag),
            "name": r.get("name"), "width": r.get("width"), "height": r.get("height"),
            "url": url, "thumb": r.get("thumb"),
        })
    return out


def known_source_ids(cfg, ids):
    if ARGS.dry_run or not ids:
        return set()
    r = requests.get(
        f"{cfg['supabase_url'].rstrip('/')}/rest/v1/{TABLE}",
        params={"select": "source_id", "source_id": f"in.({','.join(ids)})"},
        headers={"apikey": cfg["service_key"], "Authorization": f"Bearer {cfg['service_key']}"},
        timeout=30,
    )
    return set(row["source_id"] for row in r.json()) if r.ok else set()


def upload_item(cfg, item):
    img = requests.get(item["url"], timeout=90, headers={"User-Agent": "Mozilla/5.0"})
    img.raise_for_status()
    data = img.content
    if not data:
        return "empty"
    content_hash = hashlib.md5(data).hexdigest()
    mime = (img.headers.get("content-type") or "").split(";")[0] or "image/png"
    ext = {"image/png": "png", "image/jpeg": "jpg", "image/webp": "webp"}.get(mime, "png")
    path = f"{cate_slug(item['category'])}/{content_hash}.{ext}"
    put = requests.put(
        f"{cfg['supabase_url'].rstrip('/')}/storage/v1/object/{BUCKET}/{path}",
        headers={"apikey": cfg["service_key"], "Authorization": f"Bearer {cfg['service_key']}",
                 "Content-Type": mime, "x-upsert": "true"},
        data=data, timeout=180,
    )
    if not put.ok:
        return f"upload_http_{put.status_code}"
    row = {
        "source_id": item["source_id"], "gallery": item.get("gallery"),
        "category": item["category"], "tag": item["tag"],
        "name": item["name"], "width": item["width"], "height": item["height"],
        "preview_path": path, "file_path": path, "source_url": item["url"],
        "content_hash": content_hash,
    }
    up = requests.post(
        f"{cfg['supabase_url'].rstrip('/')}/rest/v1/{TABLE}?on_conflict=source_id",
        headers={"apikey": cfg["service_key"], "Authorization": f"Bearer {cfg['service_key']}",
                 "Content-Type": "application/json",
                 "Prefer": "resolution=merge-duplicates,return=minimal"},
        data=json.dumps(row, ensure_ascii=False).encode("utf-8"), timeout=60,
    )
    return "ok" if up.ok else f"table_http_{up.status_code}"


def login_mode(cfg):
    profile_dir = Path(cfg.get("chrome_profile_dir", str(PROFILE_DIR_DEFAULT))).resolve()
    profile_dir.mkdir(parents=True, exist_ok=True)
    opts = Options()
    opts.add_argument(f"--user-data-dir={profile_dir}")
    opts.add_argument("--no-first-run")
    opts.add_argument("--window-size=1600,1000")
    driver = webdriver.Chrome(options=opts, service=_service(cfg))
    driver.get(cfg.get("page_url", PAGE_URL))
    print("请在打开的浏览器里完成登录（微信扫码/手机号均可）。登录成功后窗口自动关闭，最长等待 10 分钟…", flush=True)
    for _ in range(600):
        time.sleep(1)
        try:
            if not driver.find_elements(By.XPATH, "//*[contains(text(),'登录 / 注册')]"):
                print("检测到已登录 ✓ 会话已保存到 profile。", flush=True)
                break
        except Exception:
            pass
    else:
        print("[warn] 等待超时——若已登录请忽略。", flush=True)
    driver.quit()


def _service(cfg):
    cd = cfg.get("chromedriver_path")
    return Service(cd) if cd else Service()


def click_chip_verified(driver, name, row_class_frag, attempts=3):
    """点击 chip 并校验 active 迁移到目标；数据加载时 active 可能延迟，轮询最多 8s/次"""
    for attempt in range(attempts):
        fresh = dict(panel_chips(driver, row_class_frag))
        el = fresh.get(name)
        if el is None:
            time.sleep(1)
            continue
        real_click(driver, el)
        deadline = time.time() + 8
        while time.time() < deadline:
            again = dict(panel_chips(driver, row_class_frag))
            sel = again.get(name)
            if sel is not None and "active" in (sel.get_attribute("class") or ""):
                return True
            time.sleep(0.5)
        log(f"    [retry] {name}: active 未迁移（当前 {[t for t, e in again.items() if 'active' in (e.get_attribute('class') or '')]}）")
    return False


def crawl():
    cfg = load_config()
    page_url = cfg.get("page_url", PAGE_URL)
    categories = [c for c in (ARGS.categories or cfg.get("categories") or "").split(",") if c.strip()]
    max_pages = ARGS.max_pages or int(cfg.get("max_pages_per_tag", 200))
    delay = int(cfg.get("page_delay_ms", 2000)) / 1000
    stop_known = int(cfg.get("stop_known_pages", 0))  # 0 = 每日全量翻页（不提前停）
    headless = (not ARGS.headed) and bool(cfg.get("headless", True))

    opts = Options()
    profile_dir = Path(cfg.get("chrome_profile_dir", str(PROFILE_DIR_DEFAULT))).resolve()
    profile_dir.mkdir(parents=True, exist_ok=True)
    opts.add_argument(f"--user-data-dir={profile_dir}")
    opts.add_argument("--headless=new")
    opts.add_argument("--no-first-run")
    opts.add_argument("--no-sandbox")
    opts.add_argument("--disable-gpu")
    opts.add_argument("--remote-allow-origins=*")
    opts.add_argument("--disable-blink-features=AutomationControlled")
    opts.add_argument("--window-size=1600,1000")
    driver = webdriver.Chrome(options=opts, service=_service(cfg))
    all_items = []
    stats = {"pages": 0, "items": 0, "downloaded": 0, "skipped_known": 0, "failed": 0}

    try:
        log(f"打开 {page_url}（{'有头' if not headless else '无头'}）")
        driver.get(page_url)
        time.sleep(6)
        driver.execute_script("document.querySelector(\"button[class*='close']\")?.click();")
        time.sleep(1)
        driver.execute_script(CAPTURE_HOOK)
        # 打开编辑对话框：本地上传格子 → 探针图
        boxes = []
        deadline = time.time() + 25
        while time.time() < deadline:
            boxes = [e for e in driver.find_elements(By.XPATH, "//*[contains(@class,'upload_btn_box')]") if e.is_displayed()]
            if boxes:
                break
            # 可能有弹窗遮挡，尝试关闭
            driver.execute_script("document.querySelector(\"button[class*='close']\")?.click();")
            time.sleep(2)
        if not boxes:
            sys.exit("未找到本地上传入口（upload_btn_box，25s 超时）")
        mouse_click(driver, boxes[0])
        time.sleep(2)
        DATA_DIR.mkdir(parents=True, exist_ok=True)
        probe = DATA_DIR / "_probe.png"
        if not probe.exists():
            import base64
            probe.write_bytes(base64.b64decode(PROBE_PNG_B64))
        inputs = driver.find_elements(By.CSS_SELECTOR, "input[type='file']")
        if not inputs:
            sys.exit("未找到 input[type=file]（上传对话框未弹出）")
        driver.execute_script("arguments[0].style.display='block';", inputs[0])
        inputs[0].send_keys(str(probe))
        log("探针图已提交，等待贴图面板…")
        deadline = time.time() + 40
        while time.time() < deadline:
            if driver.find_elements(By.XPATH, "//div[contains(@class,'first_cate_list')]"):
                break
            time.sleep(1)
        else:
            sys.exit("贴图面板未出现（first_cate_list 不存在）")
        time.sleep(2)
        driver.execute_script(CAPTURE_HOOK)
        log("贴图面板已就绪")

        for gallery in GALLERIES:
            tab_spans = [e for e in driver.find_elements(
                By.XPATH, f"//span[contains(@class,'tab_btn')][normalize-space(text())='{gallery}']") if e.is_displayed()]
            if not tab_spans:
                log(f"[warn] {gallery}: tab 不可见，跳过")
                continue
            real_click(driver, tab_spans[0])
            time.sleep(3)
            drain(driver)

            if gallery != "配景库":
                # 家居库/植物库：无分类行，属性筛选直翻页
                log(f"== {gallery} ==（属性筛选库，直接翻页）")
                for page in range(max_pages):
                    got = wait_any(driver, gallery, timeout=10)
                    items = [it for _, its in got for it in its]
                    dom_items = parse_grid(json.loads(driver.execute_script(
                        "return JSON.stringify((" + HARVEST_GRID + ")());") or "[]"),
                        gallery, None, None)
                    merged = {i["source_id"]: i for i in items}
                    for i in dom_items:
                        merged.setdefault(i["source_id"], i)
                    items = list(merged.values())
                    if not items:
                        log(f"  {gallery}: 无数据，到库尾")
                        break
                    n, new_n = process_batch(cfg, items, stats, all_items)
                    log(f"  {gallery} 第 {page + 1} 轮：{n} 条（新 {new_n}）")
                    nxt = [e for e in driver.find_elements(
                        By.XPATH,
                        "//div[normalize-space(text())='下一页'] | //span[normalize-space(text())='下一页'] | //button[normalize-space(text())='下一页']")
                        if e.is_displayed()]
                    if not nxt:
                        log(f"  {gallery}: 无下一页，到库尾")
                        break
                    real_click(driver, nxt[0])
                    time.sleep(delay)
                continue

            # 配景库：分类行(first_cate_list) × tag 行(sub_cate_list) 两级
            cate_chips = panel_chips(driver, "first_cate_list")
            if categories:
                cate_chips = [(t, e) for (t, e) in cate_chips if t in categories]
            log(f"== 配景库 == 分类：{[t for t, _ in cate_chips]}")
            for cate, cate_el in cate_chips:
                cate_pending = cate
                # 冗余双击提升点击命中率；若未生效，本 tag 批次安全跳过（已知项去重），
                # 每日重跑自然补覆盖
                real_click(driver, cate_el)
                time.sleep(1.5)
                real_click(driver, cate_el)
                time.sleep(2)
                log(f"  -- {cate} --")
                processed_tags = set()
                stale_rounds = 0
                while True:
                    # 收割当前可见批：未处理且在可视窗内的 tag chips
                    tag_chips = panel_chips(driver, "sub_cate_list")
                    row = next((rr for rr in driver.find_elements(By.XPATH, "//div[contains(@class,'sub_cate_list')]") if rr.is_displayed()), None)
                    fresh = []
                    if row is not None:
                        rr_ = row.rect
                        for t, el in tag_chips:
                            if t in processed_tags:
                                continue
                            r = el.rect
                            if rr_["x"] - 5 <= r["x"] and r["x"] + r["width"] <= rr_["x"] + rr_["width"] + 5:
                                fresh.append((t, el))
                    if not fresh:
                        # 可视窗内无新 tag：滚动一行（行内 next 箭头），连空 3 轮即到行尾
                        stale_rounds += 1
                        nxt_arrow = None
                        if row is not None:
                            _, nxt_arrow = row_arrows(driver, row)
                        if stale_rounds > 3 or not nxt_arrow:
                            break
                        real_click(driver, nxt_arrow)
                        time.sleep(1)
                        continue
                    stale_rounds = 0
                    # 处理可视批（每个 tag：点击 → 等响应/DOM 收割 → 翻页至库尾）
                    for tag, tag_el in fresh:
                        processed_tags.add(tag)
                        real_click(driver, tag_el)
                        time.sleep(3)
                        got = wait_any(driver, gallery, timeout=8)
                        matched = [(tg, its) for tg, its in got if norm_tag(tg) == tag]
                        dom_items = parse_grid(json.loads(driver.execute_script(
                            "return JSON.stringify((" + HARVEST_GRID + ")());") or "[]"),
                            gallery, cate, tag)
                        if matched and dom_items:
                            seen_ids = {i["source_id"] for i in matched[-1][1]}
                            extra = [i for i in dom_items if i["source_id"] not in seen_ids]
                            if extra:
                                matched[-1] = (matched[-1][0], matched[-1][1] + extra)
                        elif not matched and dom_items:
                            matched = [(None, dom_items)]
                        if not matched:
                            log(f"    [warn] {cate}/{tag}: 无响应且无网格，跳过")
                            continue
                        known_streak = 0
                        for _round in range(max_pages):
                            tg, items = matched[-1]
                            if not items:
                                log(f"    {cate}/{tag}: 空页，到库尾")
                                break
                            n, new_n = process_batch(cfg, items, stats, all_items)
                            log(f"    {cate}/{tag}：{n} 条（新 {new_n}）")
                            if stop_known > 0 and n >= 5 and new_n == 0:
                                known_streak += 1
                                if known_streak >= stop_known:
                                    log(f"    {cate}/{tag}: 连续 {known_streak} 页全已知，提前收尾")
                                    break
                            else:
                                known_streak = 0
                            nxt2 = [e for e in driver.find_elements(
                                By.XPATH,
                                "//div[normalize-space(text())='下一页'] | //span[normalize-space(text())='下一页'] | //button[normalize-space(text())='下一页']")
                                if e.is_displayed()]
                            if not nxt2:
                                log(f"    {cate}/{tag}: 无下一页，到库尾")
                                break
                            real_click(driver, nxt2[0])
                            time.sleep(delay)
                            got = wait_any(driver, gallery, timeout=8)
                            matched = [(tg, its) for tg, its in got if norm_tag(tg) == tag]
                            dom_items = parse_grid(json.loads(driver.execute_script(
                                "return JSON.stringify((" + HARVEST_GRID + ")());") or "[]"),
                                gallery, cate, tag)
                            if matched and dom_items:
                                seen_ids = {i["source_id"] for i in matched[-1][1]}
                                extra = [i for i in dom_items if i["source_id"] not in seen_ids]
                                if extra:
                                    matched[-1] = (matched[-1][0], matched[-1][1] + extra)
                            elif not matched and dom_items:
                                matched = [(None, dom_items)]
                            if not matched:
                                log(f"    {cate}/{tag}: 翻页无响应，到库尾")
                                break

        log(f"汇总：页面 {stats['pages']}，条目 {stats['items']}，新下载 {stats['downloaded']}，"
            f"已知跳过 {stats['skipped_known']}，失败 {stats['failed']}")
        if ARGS.dry_run:
            out = DATA_DIR / f"captured-{datetime.now().strftime('%Y%m%d-%H%M%S')}.json"
            out.write_text(json.dumps(all_items, ensure_ascii=False, indent=1), encoding="utf-8")
            log(f"dry-run 捕获 {len(all_items)} 条 → {out}")
    finally:
        driver.quit()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="建筑学长贴图素材库爬虫（本机 selenium）")
    parser.add_argument("--dry-run", action="store_true", help="只抓取解析落本地 JSON，不上传")
    parser.add_argument("--headed", action="store_true", help="有头模式（调试观察）")
    parser.add_argument("--login", action="store_true", help="首次登录模式（有头，手动登录后保存会话）")
    parser.add_argument("--max-pages", type=int, help="每 tag 最大页数（覆盖配置）")
    parser.add_argument("--categories", help="逗号分隔分类，如 植物配景,人物配景")
    ARGS = parser.parse_args()
    crawl()
