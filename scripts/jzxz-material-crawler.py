#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
jzxz-material-crawler.py — 建筑学长贴图素材库本机爬虫（最终版）

原理：真实页面自身完成接口签名（wallpaper 网关签名含时间因子，离线不可复现），
selenium 无头驱动贴图面板翻页；页面注入 fetch/XHR 钩子捕获 wallpaper/reference
响应，另有 DOM 网格文档级扫描兜底（面板命中缓存不发请求时）；图片按内容哈希
转存公开桶 jzxz-materials，元数据按 source_id upsert 表 jzxz_materials。

面板结构（实测 v2.17.29）：
- 家居库/植物库：无分类行，属性筛选直翻页；
- 配景库：分类行（11 类）→ tag 行（如 植物配景→绿树/彩树/枯树…）两级。
- swiper 虚拟渲染会移除滚出视口的 slide；面板命中缓存时不发网络请求。

用法：
  python scripts/jzxz-material-crawler.py --dry-run     # 只抓取解析落 JSON
  python scripts/jzxz-material-crawler.py --headed      # 有头调试
  python scripts/jzxz-material-crawler.py --login       # 首次登录（会话存 profile）
  python scripts/jzxz-material-crawler.py               # 每日增量+上传

配置：scripts/jzxz-crawler.local.json（gitignored，模板 .example）
"""

import argparse
import faulthandler
import hashlib
import json
import os
import sys
import threading
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
TABLE = "jzxz_materials"
PAGE_URL = "https://www.jianzhuxuezhang.com/home"
GALLERIES = ["家居库", "植物库", "配景库"]

# 分类切换校验用的已知 tag 种子（随每日爬取动态累积）
CATE_TAGS = {
    "植物配景": {"绿树", "彩树", "枯树", "前景树", "鸟瞰树", "总平植物", "植物百科", "灌木",
               "花坛绿篱", "竹子", "盆栽", "古风植物", "拼贴植物", "插画植物-纹理", "攀爬植物", "线稿植物"},
    "人物配景": {"青年", "老人", "小孩", "躺卧", "运动", "鸟瞰", "人群"},
    "交通配景": {"汽车", "自行车", "摩托车", "轮船", "直升机"},
    "动物配景": {"牛马驴", "猫", "羊", "鸡鸭鹅", "鹿"},
    "自然环境": {"假山", "山体", "石头", "自然远景"},
    "总平素材": {"铺装素材", "交通车辆", "运动场地"},
}

# storage key 仅 ASCII：分类 → slug 映射（未知分类回退 c+哈希）
CATE_SLUGS = {
    "植物配景": "plant-scene", "人物配景": "people-scene", "交通配景": "traffic-scene",
    "室内家具": "indoor-furniture", "室内物品": "indoor-items",
    "建筑构件": "building-components", "城市建筑": "city-buildings",
    "景观小品": "landscape-ornament", "动物配景": "animal-scene",
    "自然环境": "nature", "总平素材": "masterplan",
}

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
  const out = [];
  const seen = new Set();
  const push = (raw) => {
    if (!raw) return;
    // 素材图域名实测不止一个：贴图走 soutushenqi，动物/总平等分类走
    // image-assets.jianzhuxuezhang.com（2026-09-25 探针实证）；其余
    // ai-assets/web-assets 等是页面 UI 图，不能放行
    const m = raw.match(/https:\/\/[^"')]*(soutushenqi\.com|image-assets\.jianzhuxuezhang\.com)[^"')]*/i);
    if (!m) return;
    const clean = m[0].split('?')[0];
    const stem = clean.split('/').pop().replace(/\.[a-z]+$/i, '');
    if (!stem || seen.has(stem)) return;
    seen.add(stem);
    out.push({ source_id: stem, url: clean, thumb: m[0],
               width: null, height: null, name: null });
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

SUB_TEXTS = ("return JSON.stringify(Array.from(document.querySelectorAll("
             "'div[class*=sub_cate_list] div[class*=swiper-slide]'))"
             ".map(s => (s.innerText||'').trim()))")

SCAN_CHIPS = r"""
() => {
  const out = { first_cate_list: [], sub_cate_list: [] };
  for (const frag of ['first_cate_list', 'sub_cate_list']) {
    const row = [...document.querySelectorAll('div[class*=' + JSON.stringify(frag) + ']')]
      .find(r => r.offsetWidth > 0);
    if (!row) continue;
    for (const s of row.querySelectorAll('div[class*=swiper-slide]')) {
      const t = (s.innerText || '').trim();
      if (t && t.length <= 12 && !out[frag].includes(t)) out[frag].push(t);
    }
  }
  return out;
}
"""

PROBE_PNG_B64 = ("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGA"
                 "WjR9awAAAABJRU5ErkJggg==")

_LAST_PROGRESS = time.time()


def log(msg):
    global _LAST_PROGRESS
    _LAST_PROGRESS = time.time()
    print(f"[{datetime.now().strftime('%H:%M:%S')}] {msg}", flush=True)


def _progress_watchdog(max_silent_sec=1800):
    """看门狗：进度静默超时 → 转储全部线程栈（诊断卡点）→ 强制退出（每日任务续爬）"""
    def _watch():
        while True:
            time.sleep(60)
            if time.time() - _LAST_PROGRESS > max_silent_sec:
                print(f"[watchdog] 进度静默超过 {max_silent_sec}s，判定挂起，转储栈后退出", flush=True)
                faulthandler.dump_traceback()
                os._exit(1)
    t = threading.Thread(target=_watch, daemon=True)
    t.start()


def norm_tag(tag):
    t = (tag or "").strip()
    if t.startswith("免抠-"):
        t = t[3:]
    return t.rstrip(".").strip()


def subcate_texts(driver):
    try:
        return json.loads(driver.execute_script(SUB_TEXTS) or "[]")
    except Exception:
        return []


def load_config():
    if not CONFIG_PATH.exists():
        sys.exit(f"缺少配置文件 {CONFIG_PATH}（模板见 scripts/jzxz-crawler.local.json.example）")
    cfg = json.loads(CONFIG_PATH.read_text(encoding="utf-8"))
    for key in ("supabase_url", "service_key"):
        if not cfg.get(key) and not ARGS.dry_run:
            sys.exit(f"配置缺少 {key}（非 dry-run 模式必填）")
    return cfg


def _service(cfg):
    cd = cfg.get("chromedriver_path")
    return Service(cd) if cd else Service()


def real_click(driver, el):
    ActionChains(driver).move_to_element(el).pause(0.1).click().perform()


def drain(driver):
    return driver.execute_script(
        "return window.__jzxzCapture ? window.__jzxzCapture.splice(0) : [];")


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
        stem = Path(urlparse(url).path).stem
        out.append({"source_id": stem, "gallery": gallery, "category": category,
                    "tag": norm_tag(tag), "name": r.get("name"),
                    "width": r.get("width"), "height": r.get("height"),
                    "url": url, "thumb": r.get("thumbUrl")})
    return out


def parse_grid(rows, gallery, category, tag):
    out = []
    for r in rows or []:
        url = r.get("url") or ""
        if not url:
            continue
        out.append({"source_id": r["source_id"], "gallery": gallery,
                    "category": category, "tag": norm_tag(tag),
                    "name": r.get("name"), "width": r.get("width"),
                    "height": r.get("height"), "url": url, "thumb": r.get("thumb")})
    return out


def known_source_ids(cfg, ids):
    if ARGS.dry_run or not ids:
        return set()
    r = requests.get(
        f"{cfg['supabase_url'].rstrip('/')}/rest/v1/{TABLE}",
        params={"select": "source_id", "source_id": f"in.({','.join(ids)})"},
        headers={"apikey": cfg["service_key"], "Authorization": f"Bearer {cfg['service_key']}"},
        timeout=30)
    return set(row["source_id"] for row in r.json()) if r.ok else set()


def cate_slug(category):
    if not category:
        return "misc"
    if category in CATE_SLUGS:
        return CATE_SLUGS[category]
    return "c" + hashlib.md5(category.encode("utf-8")).hexdigest()[:10]


def upload_item(cfg, item):
    """下载→上传桶→upsert 表；任何失败返回状态串（不抛异常，不中断全量）"""
    data = None
    last_err = ""
    for headers in ({"User-Agent": "Mozilla/5.0",
                     "Referer": "https://www.jianzhuxuezhang.com/"},
                    {"User-Agent": "Mozilla/5.0"}):
        try:
            img = requests.get(item["url"], timeout=90, headers=headers)
            img.raise_for_status()
            data = img.content
            if data:
                break
        except Exception as e:
            last_err = str(e)[:80]
    if not data:
        host = urlparse(item["url"]).hostname or ""
        log(f"    [warn] 下载失败 ({host}): {last_err}")
        return "download_failed"
    content_hash = hashlib.md5(data).hexdigest()
    path = f"{cate_slug(item['category'])}/{content_hash}.png"
    put = requests.put(
        f"{cfg['supabase_url'].rstrip('/')}/storage/v1/object/{BUCKET}/{path}",
        headers={"apikey": cfg["service_key"], "Authorization": f"Bearer {cfg['service_key']}",
                 "Content-Type": "image/png", "x-upsert": "true"},
        data=data, timeout=180)
    if not put.ok:
        return f"upload_http_{put.status_code}"
    row = {"source_id": item["source_id"], "gallery": item.get("gallery"),
           "category": item["category"], "tag": item["tag"], "name": item.get("name"),
           "width": item.get("width"), "height": item.get("height"),
           "preview_path": path, "file_path": path, "source_url": item["url"],
           "content_hash": content_hash}
    up = requests.post(
        f"{cfg['supabase_url'].rstrip('/')}/rest/v1/{TABLE}?on_conflict=source_id",
        headers={"apikey": cfg["service_key"], "Authorization": f"Bearer {cfg['service_key']}",
                 "Content-Type": "application/json",
                 "Prefer": "resolution=merge-duplicates,return=minimal"},
        data=json.dumps(row, ensure_ascii=False).encode("utf-8"), timeout=60)
    return "ok" if up.ok else f"table_http_{up.status_code}"


def flush_dry(dry_items):
    """dry-run 增量落盘（固定文件名，随时可取）"""
    if not ARGS.dry_run:
        return
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    out = DATA_DIR / "captured-dryrun.json"
    out.write_text(json.dumps(dry_items, ensure_ascii=False, indent=1), encoding="utf-8")


def process_batch(cfg, items, stats, dry_items):
    known = known_source_ids(cfg, [i["source_id"] for i in items])
    stats["pages"] += 1
    stats["items"] += len(items)
    new_n = 0
    for it in items:
        if it["source_id"] in known:
            stats["skipped_known"] += 1
            continue
        new_n += 1
        if ARGS.dry_run:
            dry_items.append(dict(it, known=False))
            continue
        status = upload_item(cfg, it)
        if status == "ok":
            stats["downloaded"] += 1
        else:
            stats["failed"] += 1
            log(f"    [warn] {it['source_id']} 上传失败：{status}")
        time.sleep(0.2)
    flush_dry(dry_items)
    return len(items), new_n


def wait_any(driver, gallery, category, timeout=20):
    """等待任意新 reference 响应并解析（面板可能命中缓存不发请求 → 空列表）"""
    deadline = time.time() + timeout
    out = []
    while time.time() < deadline and not out:
        for cap in drain(driver):
            q = parse_qs(urlparse(cap["url"]).query)
            tag = q.get("tag", [""])[0]
            out.append((tag, parse_items(cap["body"], gallery, category, tag)))
        if not out:
            time.sleep(0.5)
    return out


def row_arrows(driver, row):
    """行内前/后箭头（按 y 坐标同行配对；相邻行箭头 y 不同）"""
    try:
        ry = row.rect["y"]
    except Exception:
        return None, None
    parent = row.find_element(By.XPATH, "..")
    prev = nxt = None
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
            nxt = el
    return prev, nxt


def scan_chips(driver):
    """单次 JS 批量扫描两行 chips（受脚本超时保护）；返回 {行: [texts]}"""
    try:
        return json.loads(driver.execute_script(
            "return JSON.stringify((" + SCAN_CHIPS + ")());") or "{}")
    except Exception:
        return {}


def enumerate_row_texts(driver, row_class_frag, rounds=40):
    """箭头翻页全量枚举行内 chip 文本（swiper 虚拟渲染安全）；
    收集稳定或箭头消失即止，最后滚回行首"""
    texts, seen = [], set()
    row = next((r for r in driver.find_elements(
        By.XPATH, f"//div[contains(@class,'{row_class_frag}')]") if r.is_displayed()), None)
    if row is None:
        return texts
    # 滚回行首
    for _ in range(40):
        prv, _n = row_arrows(driver, row)
        if not prv:
            break
        try:
            real_click(driver, prv)
        except Exception:
            break
        time.sleep(0.3)
    for _ in range(rounds):
        chips = scan_chips(driver).get(row_class_frag, [])
        new = False
        for t in chips:
            if t and t not in seen:
                seen.add(t)
                texts.append(t)
                new = True
        row = next((r for r in driver.find_elements(
            By.XPATH, f"//div[contains(@class,'{row_class_frag}')]") if r.is_displayed()), None)
        _, nxt = row_arrows(driver, row)
        if not nxt or not new:
            break
        try:
            real_click(driver, nxt)
        except Exception:
            break
        time.sleep(0.6)
    return texts


def chip_element(driver, row_class_frag, name):
    """把目标 chip 滚入可视区并返回其元素。
    文档级 XPath 定位（不受 swiper 重渲染/作用域影响）；
    方向用行 y 配对的箭头：目标在可视窗左侧点 prev、右侧/未渲染点 next"""
    row = next((r for r in driver.find_elements(
        By.XPATH, f"//div[contains(@class,'{row_class_frag}')]") if r.is_displayed()), None)
    if row is None:
        return None
    try:
        row_rect = row.rect
    except Exception:
        return None
    base = f"//div[contains(@class,'{row_class_frag}')]//*[contains(@class,'swiper-slide')]"

    def arrows_near(y):
        arrs = driver.find_elements(By.XPATH, ".//*[contains(@class,'arrow_icon')]")
        prv = nxt = None
        for el in arrs:
            try:
                r = el.rect
            except Exception:
                continue
            if abs(r["y"] - y) <= 25:
                if "prev_" in (el.get_attribute("class") or ""):
                    prv = el
                elif "next_" in (el.get_attribute("class") or ""):
                    nxt = el
        return prv, nxt

    def find_visible():
        try:
            els = driver.find_elements(
                By.XPATH,
                base + f"[contains(normalize-space(.), '{name}')]")
        except Exception:
            return None, None
        for el in els:
            try:
                r = el.rect
                if row_rect["x"] - 5 <= r["x"] + r["width"] / 2 <= row_rect["x"] + row_rect["width"] + 5:
                    return el, None
            except Exception:
                continue
        # 存在但不在可视窗：返回第一个元素与其中心，供方向判断
        if els:
            return None, els[0]
        return None, None

    for _ in range(60):
        el, off = find_visible()
        if el is not None:
            return el
        if off is not None:
            try:
                r = off.rect
                cx = r["x"] + r["width"] / 2
            except Exception:
                cx = None
            prv, nxt = arrows_near(r["y"] if cx is None else r["y"])
            if cx is not None and cx < row_rect["x"] + row_rect["width"] / 2:
                use = prv
            else:
                use = nxt
            if use is None:
                use = nxt or prv
            if use is None:
                return None
            try:
                real_click(driver, use)
            except Exception:
                return None
        else:
            prv, nxt = arrows_near(row_rect["y"])
            use = nxt or prv
            if use is None:
                return None
            try:
                real_click(driver, use)
            except Exception:
                return None
        time.sleep(0.4)
    return None


def click_chip_verified(driver, name, row_class_frag, attempts=3):
    for _ in range(attempts):
        el = chip_element(driver, row_class_frag, name)
        if el is None:
            time.sleep(1)
            continue
        real_click(driver, el)
        deadline = time.time() + 8
        while time.time() < deadline:
            sel = driver.find_elements(
                By.XPATH,
                f"//div[contains(@class,'{row_class_frag}')]//*[contains(@class,'swiper-slide')]"
                f"[contains(normalize-space(.), '{name}')][contains(@class,'active')]")
            if sel:
                return True
            time.sleep(0.5)
    return False


def login_mode(cfg):
    profile_dir = Path(cfg.get("chrome_profile_dir", str(PROFILE_DIR_DEFAULT))).resolve()
    profile_dir.mkdir(parents=True, exist_ok=True)
    opts = Options()
    opts.add_argument(f"--user-data-dir={profile_dir}")
    opts.add_argument("--no-first-run")
    opts.add_argument("--window-size=1600,1000")
    driver = webdriver.Chrome(options=opts, service=_service(cfg))
    driver.get(cfg.get("page_url", PAGE_URL))
    print("请在打开的浏览器里完成登录（微信扫码/手机号均可）。", flush=True)
    print("登录完成后，回到这个控制台按回车确认，浏览器会自动关闭。", flush=True)
    try:
        input("（按回车确认已完成登录）> ")
    except EOFError:
        pass
    print("会话已保存到 profile ✓", flush=True)
    driver.quit()


def merge_into_result(matched, dom_items, gallery, cate, tag):
    """网络响应 + DOM 收割双通道合并"""
    if matched and dom_items:
        seen_ids = {i["source_id"] for i in matched[-1][1]}
        extra = [i for i in dom_items if i["source_id"] not in seen_ids]
        if extra:
            matched[-1] = (matched[-1][0], matched[-1][1] + extra)
    elif not matched and dom_items:
        matched = [(None, dom_items)]
    return matched


def upload_from_json(path):
    """从 dry-run 捕获 JSON 逐条上传（爬取与上传解耦：浏览器阶段 100% 可靠，上传阶段纯 HTTP）"""
    cfg = load_config()
    items = json.loads(Path(path).read_text(encoding="utf-8"))
    log(f"上传模式：{len(items)} 条待处理")
    stats = {"downloaded": 0, "skipped_known": 0, "failed": 0}
    known = known_source_ids(cfg, [i["source_id"] for i in items])
    for it in items:
        if it["source_id"] in known:
            stats["skipped_known"] += 1
            continue
        status = upload_item(cfg, it)
        if status == "ok":
            stats["downloaded"] += 1
        else:
            stats["failed"] += 1
            log(f"  [warn] {it['source_id']} 上传失败：{status}")
        time.sleep(0.2)
    log(f"上传完成：新 {stats['downloaded']}，已知跳过 {stats['skipped_known']}，失败 {stats['failed']}")


def open_panel(driver, page_url):
    """刷新页面并重开贴图面板（每次分类切换前调用，规避长会话面板状态漂移）"""
    driver.get(page_url)
    time.sleep(6)
    driver.execute_script("document.querySelector(\"button[class*='close']\")?.click();")
    time.sleep(1)
    driver.execute_script(CAPTURE_HOOK)
    boxes = []
    deadline = time.time() + 25
    while time.time() < deadline:
        boxes = [e for e in driver.find_elements(By.XPATH, "//*[contains(@class,'upload_btn_box')]") if e.is_displayed()]
        if boxes:
            break
        driver.execute_script("document.querySelector(\"button[class*='close']\")?.click();")
        time.sleep(2)
    if not boxes:
        raise RuntimeError("本地上传入口未找到")
    real_click(driver, boxes[0])
    time.sleep(2)
    probe = DATA_DIR / "_probe.png"
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    if not probe.exists():
        import base64
        probe.write_bytes(base64.b64decode(PROBE_PNG_B64))
    inputs = driver.find_elements(By.CSS_SELECTOR, "input[type='file']")
    if not inputs:
        raise RuntimeError("file input 未找到")
    driver.execute_script("arguments[0].style.display='block';", inputs[0])
    inputs[0].send_keys(str(probe))
    deadline = time.time() + 40
    while time.time() < deadline:
        if driver.find_elements(By.XPATH, "//div[contains(@class,'first_cate_list')]"):
            break
        time.sleep(1)
    else:
        raise RuntimeError("贴图面板未出现")
    time.sleep(2)
    driver.execute_script(CAPTURE_HOOK)


def crawl():
    if ARGS.login:
        login_mode(load_config())
        return
    cfg = load_config()
    page_url = cfg.get("page_url", PAGE_URL)
    categories = [c for c in (ARGS.categories or cfg.get("categories") or "").split(",") if c.strip()]
    max_pages = ARGS.max_pages or int(cfg.get("max_pages_per_tag", 200))
    delay = int(cfg.get("page_delay_ms", 2000)) / 1000
    stop_known = int(cfg.get("stop_known_pages", 0))
    headless = (not ARGS.headed) and bool(cfg.get("headless", True))

    opts = Options()
    bin_loc = cfg.get("chrome_binary")
    if bin_loc:
        opts.binary_location = bin_loc
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
    try:
        driver.set_script_timeout(45)
        driver.set_page_load_timeout(60)
    except Exception:
        pass
    _progress_watchdog(1800)
    all_items = []
    stats = {"pages": 0, "items": 0, "downloaded": 0, "skipped_known": 0, "failed": 0}

    try:
        log(f"打开 {page_url}（{'有头' if not headless else '无头'}）")
        driver.get(page_url)
        time.sleep(6)
        driver.execute_script("document.querySelector(\"button[class*='close']\")?.click();")
        time.sleep(1)
        driver.execute_script(CAPTURE_HOOK)
        boxes = []
        deadline = time.time() + 25
        while time.time() < deadline:
            boxes = [e for e in driver.find_elements(By.XPATH, "//*[contains(@class,'upload_btn_box')]") if e.is_displayed()]
            if boxes:
                break
            driver.execute_script("document.querySelector(\"button[class*='close']\")?.click();")
            time.sleep(2)
        if not boxes:
            sys.exit("未找到本地上传入口（upload_btn_box，25s 超时）")
        real_click(driver, boxes[0])
        time.sleep(2)
        probe = DATA_DIR / "_probe.png"
        DATA_DIR.mkdir(parents=True, exist_ok=True)
        if not probe.exists():
            import base64
            probe.write_bytes(base64.b64decode(PROBE_PNG_B64))
        inputs = []
        deadline = time.time() + 20
        while time.time() < deadline and not inputs:
            time.sleep(1)
            inputs = driver.find_elements(By.CSS_SELECTOR, "input[type='file']")
        if not inputs:
            try:
                driver.save_screenshot("data/jzxz-captured/entry-fail.png")
            except Exception:
                pass
            sys.exit("未找到 input[type=file]（上传对话框未弹出，20s 超时）")
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
            # tab 行可能晚于面板就绪渲染，且有运营弹窗遮挡：重试等待可见
            tab_spans = []
            for _tab_wait in range(8):
                tab_spans = [e for e in driver.find_elements(
                    By.XPATH, f"//span[contains(@class,'tab_btn')][normalize-space(text())='{gallery}']") if e.is_displayed()]
                if tab_spans:
                    break
                driver.execute_script(
                    "document.querySelector(\"button[class*='close']\")?.click();")
                time.sleep(2)
            if not tab_spans:
                log(f"[warn] {gallery}: tab 不可见，跳过")
                if gallery == GALLERIES[0]:
                    try:
                        DATA_DIR.mkdir(parents=True, exist_ok=True)
                        driver.save_screenshot(str(DATA_DIR / "tab-invisible.png"))
                        log("[diag] 现场已存 data/jzxz-captured/tab-invisible.png")
                    except Exception:
                        pass
                continue
            tab_ok = False
            for _tab_try in range(4):
                real_click(driver, tab_spans[0])
                time.sleep(2.5)
                tabs_now = [e for e in driver.find_elements(
                    By.XPATH, f"//span[contains(@class,'tab_btn')][normalize-space(text())='{gallery}']") if e.is_displayed()]
                if tabs_now and "active" in (tabs_now[0].get_attribute("class") or ""):
                    tab_ok = True
                    break
            if not tab_ok:
                log(f"[warn] {gallery}: tab 点击未生效（active 未迁移），跳过")
                continue
            time.sleep(1)
            drain(driver)

            if gallery != "配景库":
                log(f"== {gallery} ==（属性筛选库，直接翻页）")
                flat_stall = 0
                for page in range(max_pages):
                    got = wait_any(driver, gallery, None, timeout=10)
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
                    if new_n == 0:
                        flat_stall += 1
                        if flat_stall >= 3:
                            log(f"  {gallery}: 连续 {flat_stall} 轮零新增，熔断")
                            break
                    else:
                        flat_stall = 0
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

            # 配景库：逐分类处理——每个分类前重开面板（dd1b6f08 的设计意图，
            # 此前 open_panel 未接线），分类 chip 用 chip_element 滚入可视区
            # （swiper 虚拟渲染下屏幕外 slide 不在 DOM，按文本直找必然落空）
            log("== 配景库 ==")
            cate_names = [t for t in enumerate_row_texts(driver, "first_cate_list") if len(t) <= 12]
            if categories:
                cate_names = [c for c in cate_names if c in categories]
            log(f"分类：{cate_names}")

            for cate in cate_names:
                try:
                    open_panel(driver, page_url)
                except Exception as exc:
                    log(f"  [warn] {cate}: 面板重开失败（{exc}），跳过")
                    continue
                # 重开面板后回到配景库 tab
                tab_ok = False
                for _tab_try in range(5):
                    tabs_now = [e for e in driver.find_elements(
                        By.XPATH, "//span[contains(@class,'tab_btn')][normalize-space(text())='配景库']") if e.is_displayed()]
                    if tabs_now and "active" in (tabs_now[0].get_attribute("class") or ""):
                        tab_ok = True
                        break
                    if tabs_now:
                        real_click(driver, tabs_now[0])
                    time.sleep(2.5)
                if not tab_ok:
                    log(f"  [warn] {cate}: 重开面板后配景库 tab 未就位，跳过")
                    continue
                drain(driver)
                # 点一级分类：chip_element 滚入可视区，以子分类行变化/已知 tag 验证
                before_sub = subcate_texts(driver)
                known = CATE_TAGS.get(cate, set())
                ok = any(t in known for t in before_sub if t)
                for _attempt in range(6):
                    if ok:
                        break
                    slide = chip_element(driver, "first_cate_list", cate)
                    if slide is None:
                        time.sleep(1)
                        continue
                    real_click(driver, slide)
                    deadline = time.time() + 15
                    while time.time() < deadline:
                        cur_sub = subcate_texts(driver)
                        if known and any(t in known for t in cur_sub):
                            ok = True
                            break
                        if before_sub is not None and cur_sub != before_sub and cur_sub:
                            ok = True
                            break
                        time.sleep(0.5)
                    if ok:
                        break
                    time.sleep(1.5)
                if not ok:
                    log(f"  [warn] {cate}: 分类点击未生效，跳过")
                    continue
                tags = [t for t in enumerate_row_texts(driver, "sub_cate_list") if len(t) <= 12]
                CATE_TAGS.setdefault(cate, set()).update(tags)
                processed_tag = set()
                log(f"== 爬取 {cate}（{len(tags)} tags）==")
                for tag in tags:
                    if tag in processed_tag:
                        continue
                    processed_tag.add(tag)
                    tag_el = chip_element(driver, "sub_cate_list", tag)
                    if tag_el is None:
                        log(f"    [warn] {cate}/{tag}: chip 不可见，跳过")
                        continue
                    real_click(driver, tag_el)
                    time.sleep(3)
                    got = wait_any(driver, gallery, cate, timeout=8)
                    matched = [(tg, its) for tg, its in got if norm_tag(tg) == tag]
                    dom_items = parse_grid(json.loads(driver.execute_script(
                        "return JSON.stringify((" + HARVEST_GRID + ")());") or "[]"),
                        gallery, cate, tag)
                    matched = merge_into_result(matched, dom_items, gallery, cate, tag)
                    if not matched:
                        # 留现场：一致失败的 tag 需要看面板当时到底显示了什么
                        if stats.get("nodata_dumped", 0) < 3:
                            stats["nodata_dumped"] = stats.get("nodata_dumped", 0) + 1
                            try:
                                DATA_DIR.mkdir(parents=True, exist_ok=True)
                                driver.save_screenshot(str(DATA_DIR / "tag-nodata.png"))
                                (DATA_DIR / "tag-nodata.json").write_text(json.dumps({
                                    "cate": cate, "tag": tag,
                                    "sub_row": subcate_texts(driver),
                                    "body_text": (driver.execute_script(
                                        "return (document.body.innerText||'');") or "")[:2000],
                                }, ensure_ascii=False, indent=2), encoding="utf-8")
                                log(f"    [diag] 无响应现场已存 tag-nodata.png/json")
                            except Exception:
                                pass
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
                        got = wait_any(driver, gallery, cate, timeout=8)
                        matched = [(tg, its) for tg, its in got if norm_tag(tg) == tag]
                        dom_items = parse_grid(json.loads(driver.execute_script(
                            "return JSON.stringify((" + HARVEST_GRID + ")());") or "[]"),
                            gallery, cate, tag)
                        matched = merge_into_result(matched, dom_items, gallery, cate, tag)
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
    parser.add_argument("--upload-json", help="读取 dry-run 捕获 JSON 并逐条上传（无浏览器）")
    ARGS = parser.parse_args()
    if ARGS.upload_json:
        upload_from_json(Path(ARGS.upload_json))
    else:
        crawl()
