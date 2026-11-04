#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
jzxz-material-crawler.py — 建筑学长贴图素材库本机爬虫（最终版）

原理：真实页面自身完成接口签名（wallpaper 网关签名含时间因子，离线不可复现），
selenium 无头驱动贴图面板翻页；页面注入 fetch/XHR 钩子捕获 wallpaper/reference
响应，另有 DOM 网格文档级扫描兜底（面板命中缓存不发请求时）；图片按内容哈希
转存公开桶 jzxz-materials，元数据按 source_id upsert 表 jzxz_materials。

入口（2026-09 站点改版后）：/home 已是工作台而非编辑器——从「新建项目」进
/canvas/detail?projectId=<id> 画布编辑器（URL 记忆于 data/jzxz-canvas-project.json，
失效自动重建）；编辑器内有 4 个 input[type=file]（两个 accept=.txt 属其他功能），
探针图必须发进 accept 含 png/image 的图片输入，面板随即打开。

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
import base64
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
# 2026-11 素材库弹窗四库：家居库/植物库/材质库（commodity_materials 接口的
# 3D 模型，ref/modelUrl 字段，与本表贴图素材模式不同，暂不爬取）+ 配景库
# （wallpaper/reference 贴图体系，本爬虫目标，见 crawl()）

# 配景库已知分类(DOM 枚举空时的兜底;来源:库内 distinct category + 上游面板)
KNOWN_SCENERY_CATEGORIES = [
    "植物配景", "人物配景", "交通配景", "室内家具", "室内物品",
    "建筑构件", "城市建筑", "景观小品", "动物配景", "自然环境",
    "总平素材", "舞台构建装置",
]

# 分类切换校验用的已知 tag 种子（随每日爬取动态累积）
CATE_TAGS = {
    "植物配景": {"绿树", "彩树", "枯树", "前景树", "鸟瞰树", "总平植物", "植物百科", "灌木",
               "花坛绿篱", "竹子", "盆栽", "古风植物", "拼贴植物", "插画植物-纹理", "攀爬植物", "线稿植物"},
    "人物配景": {"青年", "老人", "小孩", "躺卧", "运动", "鸟瞰", "人群"},
    "交通配景": {"汽车", "自行车", "摩托车", "轮船", "直升机"},
    "动物配景": {"牛马驴", "猫", "羊", "鸡鸭鹅", "鹿"},
    "自然环境": {"假山", "山体", "石头", "自然远景"},
    "舞台构建装置": {"植物摆件", "舞台构件", "舞台装置"},
    "总平素材": {"铺装素材", "交通车辆", "运动场地"},
}

# storage key 仅 ASCII：分类 → slug 映射（未知分类回退 c+哈希）
CATE_SLUGS = {
    "植物配景": "plant-scene", "人物配景": "people-scene", "交通配景": "traffic-scene",
    "室内家具": "indoor-furniture", "室内物品": "indoor-items",
    "建筑构件": "building-components", "城市建筑": "city-buildings",
    "景观小品": "landscape-ornament", "动物配景": "animal-scene",
    "自然环境": "nature", "总平素材": "masterplan",
    "舞台构建装置": "stage-scene",
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
  // 2026-11 改版：网格迁入 ReactVirtualized Masonry 虚拟滚动容器
  //（素材库弹窗内），直接以该容器为收割作用域——容器外的画布缩略条、
  // 首页信息流图天然排除（旧版靠分类行/分页按钮矩形围栏的方案随
  // first_cate_list/下一页按钮一起失效）
  const grids = [...document.querySelectorAll('.ReactVirtualized__Masonry')]
    .filter(m => { const r = m.getBoundingClientRect();
                   return r.height > 100 && r.width > 100; });
  const push = (raw) => {
    if (!raw) return;
    // 素材图域名实测（2026-09-25 探针实证，2026-11 复核）：贴图走
    // soutushenqi / image-assets，舞台构建装置走 ai-assets
    const m = raw.match(/https:\/\/[^"')]*(soutushenqi\.com|image-assets\.jianzhuxuezhang\.com|ai-assets\.jianzhuxuezhang\.com)[^"')]*/i);
    if (!m) return;
    const clean = m[0].split('?')[0];
    const stem = clean.split('/').pop().replace(/\.[a-z]+$/i, '');
    if (!stem || seen.has(stem)) return;
    seen.add(stem);
    out.push({ source_id: stem, url: clean, thumb: m[0],
               width: null, height: null, name: null });
  };
  for (const grid of grids) {
    for (const img of grid.querySelectorAll('img')) {
      push(img.currentSrc || img.src || '');
      push(img.getAttribute('data-src') || '');
    }
    for (const el of grid.querySelectorAll('*')) {
      const bg = getComputedStyle(el).backgroundImage || '';
      if (bg && bg !== 'none') push(bg);
    }
  }
  return out;
}
"""

# 2026-11 改版：分类/子分类行由「category_title 标题 + swiper 行」构成
#（配景分类：/素材分类：），旧 first_cate_list/sub_cate_list 容器类消失。
# 行定位改为按标题文本找行容器。
SCAN_CHIPS = r"""
() => {
  const out = { cate: [], sub: [] };
  const vis = (el) => { const r = el.getBoundingClientRect();
                        return r.width > 0 && r.height > 0; };
  for (const title of document.querySelectorAll("[class*='category_title']")) {
    const t = (title.innerText || '').trim();
    const key = t.includes('配景分类') ? 'cate' : (t.includes('素材分类') ? 'sub' : null);
    if (!key || !vis(title)) continue;
    let row = title.parentElement;
    for (const s of row.querySelectorAll('.swiper-slide')) {
      const txt = (s.innerText || '').trim();
      if (txt && txt.length <= 12 && !out[key].includes(txt)) out[key].push(txt);
    }
  }
  return out;
}
"""

# 行内查找单个 chip 的元素（供真实点击）；swiper 虚拟渲染下屏幕外 slide
# 可能不在 DOM：行有箭头时先点击 next 滚动。expanded 视图行全量可见，
# 箭头通常不存在，直接命中。
FIND_CHIP = r"""
(args) => {
  const [titleKey, name] = args;
  const vis = (el) => { const r = el.getBoundingClientRect();
                        return r.width > 0 && r.height > 0; };
  const titles = [...document.querySelectorAll("[class*='category_title']")]
    .filter(t => (t.innerText || '').includes(titleKey) && vis(t));
  if (!titles.length) return null;
  const row = titles[0].parentElement;
  for (const s of row.querySelectorAll('.swiper-slide')) {
    const txt = (s.innerText || '').trim();
    if (txt === name && vis(s)) return s;
  }
  // 精确未命中退化为前缀包含（chip 文本可能带冒号等修饰）
  for (const s of row.querySelectorAll('.swiper-slide')) {
    const txt = (s.innerText || '').trim();
    if (txt && (txt.startsWith(name) || name.startsWith(txt)) && vis(s)) return s;
  }
  return null;
}
"""

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
    # 新分类（舞台构建装置等）的请求 tag 是「<tag>.-免抠」后缀形态
    if t.endswith("-免抠"):
        t = t[:-3]
    return t.rstrip(".").strip()


def subcate_texts(driver):
    return scan_rows(driver).get("sub", [])


def scan_rows(driver):
    """批量扫描两行 chips（2026-11 改版行结构：category_title 标题 + swiper 行）"""
    try:
        return json.loads(driver.execute_script(
            "return JSON.stringify((" + SCAN_CHIPS + ")());") or "{}")
    except Exception:
        return {}


def tag_matches(req_tag, chip):
    """请求 tag 与面板 chip 文本的归属判定（包含式）。

    实测请求 tag 与 chip 不严格相等：人物配景 chip「青年」的请求是
    「免抠-青年人」，植物配景「绿树」的请求是「免抠-绿树.」（带点后缀）。
    norm_tag 去掉免抠前缀/点后缀后仍可能多出「人」等字，相等匹配会整
    tag 漏收（2026-11 改版实测），改为双向包含。"""
    nt = norm_tag(req_tag)
    c = (chip or "").strip()
    if not nt or not c:
        return False
    return nt == c or nt.startswith(c) or c.startswith(nt)


def _click_row_arrow(driver, which):
    """点击分类行内 next 箭头滚出屏外 slide（expanded 视图行全量可见，
    一般无箭头，此路仅为兼容兜底）"""
    title_key = "配景分类" if which == "cate" else "素材分类"
    try:
        return bool(driver.execute_script(r"""
          const key = arguments[0];
          const t = [...document.querySelectorAll("[class*='category_title']")]
            .find(e => e.getBoundingClientRect().height > 0 &&
                       (e.innerText||'').includes(key));
          if (!t) return false;
          const row = t.parentElement;
          const arrs = [...row.querySelectorAll("[class*='arrow']")]
            .filter(e => e.getBoundingClientRect().width > 0);
          const a = arrs.find(e => /next/i.test(e.className.toString())) ||
                    arrs.find(e => !/prev/i.test(e.className.toString()));
          if (!a) return false;
          const r = a.getBoundingClientRect();
          const hit = document.elementFromPoint(r.x + r.width/2, r.y + r.height/2);
          (hit || a).click();
          return true;
        """, title_key))
    except Exception:
        return False


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


def click_chip(driver, which, name, tries=3):
    """定位 chip 并在其当前位置真实点击（返回是否完成点击序列）。

    swiper 行带 transform 偏移且会过渡动画：move_to_element 的矩形中心
    在点击瞬间可能落空（旧文档已知坑，实测 ~1/10 tag 被吞）。改为点击
    前一刻取 rect 中心 → elementFromPoint 取命中元素 → ActionChains 点它，
    失败重试。"""
    title_key = "配景分类" if which == "cate" else "素材分类"
    for _ in range(tries):
        el = chip_element(driver, which, name)
        if el is None:
            time.sleep(0.8)
            continue
        try:
            r = el.rect
            cx, cy = r["x"] + r["width"] / 2, r["y"] + r["height"] / 2
        except Exception:
            real_click(driver, el)
            return True
        hit = driver.execute_script(
            "return document.elementFromPoint(arguments[0], arguments[1]);", cx, cy)
        target = hit if hit is not None else el
        try:
            real_click(driver, target)
            return True
        except Exception:
            time.sleep(0.8)
    return False


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


def known_source_ids(cfg, ids, category=None):
    """查 (source_id, category) 已采合——同一文件可挂多分类，
    只跳过「同分类已采」的；跨分类复用文件会补行（桶路径复用不重传）。"""
    if ARGS.dry_run or not ids:
        return set()
    params = {"select": "source_id",
              "source_id": f"in.({','.join(ids)})"}
    if category is None:
        params["category"] = "is.is.null"
    else:
        params["category"] = f"eq.{category}"
    r = requests.get(
        f"{cfg['supabase_url'].rstrip('/')}/rest/v1/{TABLE}",
        params=params,
        headers={"apikey": cfg["service_key"], "Authorization": f"Bearer {cfg['service_key']}"},
        timeout=30)
    return set(row["source_id"] for row in r.json()) if r.ok else set()


def cate_slug(category):
    if not category:
        return "misc"
    if category in CATE_SLUGS:
        return CATE_SLUGS[category]
    return "c" + hashlib.md5(category.encode("utf-8")).hexdigest()[:10]


def upload_item(cfg, item, driver=None):
    """下载→上传桶→upsert 表；任何失败返回状态串（不抛异常，不中断全量）"""
    # 跨分类复用素材：同文件已有行时直接复用桶路径，免重复下载/占用存储
    dup = requests.get(
        f"{cfg['supabase_url'].rstrip('/')}/rest/v1/{TABLE}",
        params={"select": "preview_path,file_path,content_hash,width,height,name",
                "source_id": f"eq.{item['source_id']}", "limit": "1"},
        headers={"apikey": cfg["service_key"], "Authorization": f"Bearer {cfg['service_key']}"},
        timeout=30)
    if dup.ok:
        rows = dup.json()
        if rows and rows[0].get("preview_path"):
            r0 = rows[0]
            row = {"source_id": item["source_id"], "gallery": item.get("gallery"),
                   "category": item["category"], "tag": item["tag"],
                   "name": item.get("name") or r0.get("name"),
                   "width": item.get("width") or r0.get("width"),
                   "height": item.get("height") or r0.get("height"),
                   "preview_path": r0["preview_path"], "file_path": r0["file_path"],
                   "source_url": item["url"], "content_hash": r0["content_hash"]}
            up = requests.post(
                f"{cfg['supabase_url'].rstrip('/')}/rest/v1/{TABLE}?on_conflict=source_id,category",
                headers={"apikey": cfg["service_key"], "Authorization": f"Bearer {cfg['service_key']}",
                         "Content-Type": "application/json",
                         "Prefer": "resolution=merge-duplicates,return=minimal"},
                data=json.dumps(row, ensure_ascii=False).encode("utf-8"), timeout=60)
            return "ok" if up.ok else f"table_http_{up.status_code}"

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
    if not data and driver is not None:
        # 花瓣系 CDN（gd-hbimg.huaban.com 等）有 EdgeOne WAF，requests 一律
        # 567 拦截；借浏览器 <img> 子资源加载 + 性能日志取响应体
        data = download_via_page(driver, item["url"])
        if not data:
            last_err = "browser fetch blocked"
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
        f"{cfg['supabase_url'].rstrip('/')}/rest/v1/{TABLE}?on_conflict=source_id,category",
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


def download_via_page(driver, url: str, timeout: int = 40):
    """花瓣系 CDN（gd-hbimg.huaban.com）有 EdgeOne WAF：requests/curl 一律 567
    拦截页，但站点页面里 <img> 子资源加载可过。借页面注入 <img> 触发浏览器
    下载，再从性能日志取该次响应体。失败返回 None。"""
    if driver is None:
        return None
    # 性能日志缓冲会被页面流量塞满（满了丢新事件）：先清积压 + 清浏览器
    # 缓存，保证注入后的 <img> 加载一定产生新的网络事件
    try:
        driver.get_log("performance")
    except Exception:
        pass
    try:
        driver.execute_cdp_cmd("Network.enable")
        driver.execute_cdp_cmd("Network.clearBrowserCache")
    except Exception:
        pass
    url_core = url.split("?")[0]
    deadline = time.time() + timeout
    tried = set()
    last_inject = 0.0
    polls = 0
    total = 0
    while time.time() < deadline:
        if time.time() - last_inject > 12:
            last_inject = time.time()
            try:
                driver.execute_script(
                    "const i = new Image(); i.src = arguments[0];"
                    " i.style.cssText = 'position:fixed;left:-9999px;width:1px';"
                    " document.body.appendChild(i); setTimeout(() => i.remove(), 60000);",
                    url)
            except Exception as e:
                log(f"    [diag] 注入 img 失败: {str(e)[:100]}")
                return None
        try:
            entries = driver.get_log("performance")
        except Exception as e:
            log(f"    [diag] 性能日志读取失败: {str(e)[:100]}")
            return None
        polls += 1
        total += len(entries)
        if polls % 8 == 0:
            log(f"    [diag] 轮询 {polls} 次累计日志 {total} 条")
        for entry in entries:
            try:
                msg = json.loads(entry["message"])["message"]
            except Exception:
                continue
            if msg.get("method") != "Network.responseReceived":
                continue
            params = msg.get("params") or {}
            resp = params.get("response") or {}
            if url_core not in (resp.get("url") or ""):
                continue
            rid = params.get("requestId")
            if rid in tried:
                continue
            tried.add(rid)
            if resp.get("status") != 200:
                continue
            try:
                body = driver.execute_cdp_cmd(
                    "Network.getResponseBody", {"requestId": rid})
                if body.get("base64Encoded"):
                    return base64.b64decode(body["body"])
                return body["body"].encode("utf-8")
            except Exception as e:
                log(f"    [diag] 取响应体失败: {str(e)[:100]}")
        time.sleep(0.4)
    return None


def process_batch(cfg, driver, items, stats, dry_items):
    stats["pages"] += 1
    stats["items"] += len(items)
    new_n = 0
    # (source_id, category) 唯一：按批内实际分类分组查已采合
    by_cat = {}
    for it in items:
        by_cat.setdefault(it.get("category"), []).append(it)
    known = set()
    for cat, its in by_cat.items():
        known |= {(i, cat) for i in known_source_ids(
            cfg, [x["source_id"] for x in its], cat)}
    for it in items:
        if (it["source_id"], it.get("category")) in known:
            stats["skipped_known"] += 1
            continue
        new_n += 1
        if ARGS.dry_run:
            dry_items.append(dict(it, known=False))
            continue
        status = upload_item(cfg, it, driver)
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
        try:
            driver.get_log("performance")  # 持续排空，防缓冲满丢事件
        except Exception:
            pass
        for cap in drain(driver):
            q = parse_qs(urlparse(cap["url"]).query)
            tag = q.get("tag", [""])[0]
            out.append((tag, parse_items(cap["body"], gallery, category, tag)))
        if not out:
            time.sleep(0.5)
    return out


def enumerate_row_texts(driver, which, rounds=10):
    """全量枚举行内 chip 文本（2026-11 改版：expanded 视图行全量可见，
    直接扫描即可；保留箭头翻页兼容兜底）。连续 2 轮无新 chip 视为到行尾
    （行渲染有时序，单轮无新即停曾漏行尾分类）"""
    texts, seen = [], set()
    miss = 0
    for _ in range(rounds):
        chips = scan_rows(driver).get(which, [])
        new = False
        for t in chips:
            if t and t not in seen:
                seen.add(t)
                texts.append(t)
                new = True
        if not new:
            miss += 1
            if miss >= 2:
                break
        else:
            miss = 0
        if not _click_row_arrow(driver, which):
            break
        time.sleep(0.6)
    return texts


def chip_element(driver, which, name):
    """把目标 chip 滚入可视区并返回其元素（行按标题文本定位；
    swiper 虚拟渲染下屏外 slide 不在 DOM，行内箭头滚动兜底）"""
    title_key = "配景分类" if which == "cate" else "素材分类"
    for _ in range(40):
        try:
            el = driver.execute_script(
                "return (" + FIND_CHIP + ")(arguments[0]);", [title_key, name])
        except Exception:
            el = None
        if el is not None:
            return el
        if not _click_row_arrow(driver, which):
            return None
        time.sleep(0.5)
    return None


def login_mode(cfg):
    profile_dir = Path(cfg.get("chrome_profile_dir", str(PROFILE_DIR_DEFAULT))).resolve()
    profile_dir.mkdir(parents=True, exist_ok=True)
    opts = Options()
    opts.add_argument(f"--user-data-dir={profile_dir}")
    opts.add_argument("--no-first-run")
    opts.add_argument("--window-size=1600,1000")
    opts.set_capability("goog:loggingPrefs", {"performance": "ALL"})
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


PROJECT_STATE_PATH = ROOT / "data" / "jzxz-canvas-project.json"


def create_project(driver, cfg):
    """站点 2026-09 改版后 /home 是工作台而非编辑器；从「新建项目」进画布编辑器。

    编辑器 URL 形如 /canvas/detail?projectId=<id>，落盘记忆供面板重开复用。"""
    driver.get(cfg.get("page_url", PAGE_URL))
    time.sleep(6)
    tgt = None
    for _ in range(15):
        driver.execute_script("document.querySelector(\"button[class*='close']\")?.click();")
        tgt = next((e for e in driver.find_elements(
            By.XPATH, "//*[normalize-space(text())='新建项目']") if e.is_displayed()), None)
        if tgt is not None:
            break
        time.sleep(2)
    if tgt is None:
        try:
            DATA_DIR.mkdir(parents=True, exist_ok=True)
            driver.save_screenshot(str(DATA_DIR / "entry-fail.png"))
        except Exception:
            pass
        if driver.find_elements(By.XPATH,
                                "//button[normalize-space(text())='登录'] | //*[normalize-space(text())='登录/注册']"):
            sys.exit("工作台无「新建项目」且出现登录入口——登录态疑似失效，请先运行 --login 扫码恢复会话")
        sys.exit("工作台「新建项目」入口未找到（30s 重试），现场已存 data/jzxz-captured/entry-fail.png")
    real_click(driver, tgt)
    deadline = time.time() + 25
    while time.time() < deadline:
        if "/canvas/detail" in (driver.current_url or ""):
            break
        time.sleep(1)
    else:
        sys.exit(f"点击「新建项目」后未进入编辑器（当前：{driver.current_url}）")
    if len(driver.window_handles) > 1:
        driver.switch_to.window(driver.window_handles[-1])
    editor_url = driver.current_url
    if "projectId=" in editor_url:
        try:
            PROJECT_STATE_PATH.write_text(json.dumps({
                "editor_url": editor_url,
                "project_id": editor_url.split("projectId=")[-1].split("&")[0],
                "updated": datetime.now().isoformat(timespec="seconds"),
            }, ensure_ascii=False), encoding="utf-8")
        except Exception:
            pass
    time.sleep(4)
    return editor_url


def enter_editor(driver, cfg):
    """进入可上传参考图的页面并返回其 URL。

    2026-10 上游改版:画布编辑器(/canvas/detail)上传按钮大多不再挂
    input(原生 picker)、「新建项目」不再跳转;但页面本身带参考图输入框
    (textarea/contenteditable),向其粘贴图片即触发贴图推荐面板。此处直接
    打开目标页并等输入框就绪(canvas/detail 旧记忆 URL 仍可用则复用,
    否则 /home)。"""
    url = cfg.get("page_url", PAGE_URL)
    if PROJECT_STATE_PATH.exists():
        try:
            saved = json.loads(
                PROJECT_STATE_PATH.read_text(encoding="utf-8")).get("editor_url")
        except Exception:
            saved = None
    else:
        saved = None
    for target in [u for u in (saved, url) if u]:
        try:
            driver.get(target)
        except Exception:
            continue
        deadline = time.time() + 25
        while time.time() < deadline:
            try:
                if driver.execute_script(
                    "return !!(document.querySelector('textarea') || "
                    "document.querySelector('[contenteditable=\"true\"]') "
                    "|| document.querySelector('[class*=upload_btn_box]'))"
                ):
                    return target
            except Exception:
                pass
            time.sleep(1)
    raise RuntimeError("参考图输入页未就绪(25s×2)")


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
    by_cat = {}
    for it in items:
        by_cat.setdefault(it.get("category"), []).append(it)
    known = set()
    for cat, its in by_cat.items():
        known |= {(i, cat) for i in known_source_ids(
            cfg, [x["source_id"] for x in its], cat)}
    for it in items:
        if (it["source_id"], it.get("category")) in known:
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


def close_overlays(driver):
    """关掉挡面板的运营弹窗（2026-11 改版：推广弹窗换成 ant-modal +
    CSS Modules 关闭图标（close_icon/close_btn），旧 button[class*=close]
    选择器扑空，弹窗常驻遮挡曾是每日失败的一环）"""
    for _ in range(3):
        n = driver.execute_script(r"""
          let n = 0;
          for (const m of document.querySelectorAll('.ant-modal')) {
            if (m.getBoundingClientRect().height <= 100) continue;
            const b = m.querySelector("[class*='close_icon'], [class*='close_btn']");
            if (b) { b.click(); n++; }
          }
          document.querySelector("button[class*='close']")?.click();
          return n;
        """)
        if not n:
            break
        time.sleep(1.2)


def open_scenery_panel(driver, editor_url):
    """重进编辑器并打开素材库弹窗的配景库（每次分类前调用，规避长会话漂移）。

    2026-11 改版：贴图推荐面板不再由「上传探针图」触发（旧链路整条消失：
    全站 input[type=file] 移除、粘贴进 AI 创作输入条、wallpaper/reference
    不再发出）。素材库改从左侧工具栏「素材库」按钮进入，弹窗内含
    家居库/植物库/材质库/配景库四个 tab；配景库沿用 wallpaper/reference
    接口，分类行/翻页交互全新。返回 editor_url。"""
    driver.get(editor_url)
    time.sleep(6)
    close_overlays(driver)
    time.sleep(1)
    driver.execute_script(CAPTURE_HOOK)
    # 1. 点左侧工具栏「素材库」（可见且高度合理的文本节点，JS click 实测有效）
    opened = driver.execute_script(r"""
      const cands = [...document.querySelectorAll('div,span,button')]
        .filter(e => (e.innerText || '').trim() === '素材库'
                     && e.getBoundingClientRect().height > 0
                     && e.getBoundingClientRect().height < 120);
      if (!cands.length) return false;
      cands[cands.length - 1].click();
      return true;
    """)
    if not opened:
        raise RuntimeError("素材库入口按钮未找到")
    # 2. 等弹窗 tab 行出现 → 点「配景库」
    deadline = time.time() + 15
    while time.time() < deadline:
        if driver.execute_script(r"""
          return [...document.querySelectorAll('button')]
            .some(e => (e.innerText||'').trim() === '配景库'
                       && /library_tab/.test(e.className.toString()));
        """):
            break
        time.sleep(1)
    else:
        raise RuntimeError("素材库弹窗未出现（library tab 缺失）")
    for _try in range(4):
        driver.execute_script(r"""
          [...document.querySelectorAll('button')]
            .filter(e => (e.innerText||'').trim() === '配景库'
                         && /library_tab/.test(e.className.toString()))[0]?.click();
        """)
        time.sleep(2.5)
        if driver.execute_script(r"""
          return [...document.querySelectorAll("[class*='category_title']")]
            .some(e => (e.innerText||'').includes('配景分类')
                       && e.getBoundingClientRect().height > 0);
        """):
            break
    else:
        raise RuntimeError("配景库 tab 切换未生效（分类行未出现）")
    # 3. 展开弹窗（⧉）：展开视图分类/子分类行全量可见，网格更宽（收割窗口更大）
    driver.execute_script(
        "document.querySelector(\"[class*='product_material_expand_button']\")?.click();")
    time.sleep(2.5)
    driver.execute_script(CAPTURE_HOOK)
    time.sleep(1)


def crawl():
    if ARGS.login:
        login_mode(load_config())
        return
    cfg = load_config()
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
    if headless:
        # 修复 P0（曾长期带病运行）：此前无条件无头，配置 headless:false 与
        # --headed 从不生效。无头下 ActionChains 真实点击系统性失效，2026-11
        # 改版后的分类切换/翻页全靠真实点击，必须尊重配置
        opts.add_argument("--headless=new")
    opts.add_argument("--no-first-run")
    opts.add_argument("--no-sandbox")
    opts.add_argument("--disable-gpu")
    opts.add_argument("--remote-allow-origins=*")
    opts.add_argument("--disable-blink-features=AutomationControlled")
    opts.add_argument("--window-size=1600,1000")
    opts.set_capability("goog:loggingPrefs", {"performance": "ALL"})
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
        editor_url = enter_editor(driver, cfg)
        log(f"画布编辑器就绪（{'有头' if not headless else '无头'}）：{editor_url}")
        try:
            open_scenery_panel(driver, editor_url)
        except Exception as exc:
            try:
                DATA_DIR.mkdir(parents=True, exist_ok=True)
                driver.save_screenshot(str(DATA_DIR / "entry-fail.png"))
            except Exception:
                pass
            sys.exit(f"素材库配景库面板未打开（{exc}），现场已存 data/jzxz-captured/entry-fail.png")
        log("贴图面板已就绪（素材库弹窗·配景库）")

        # 2026-11 改版：素材库弹窗中只有配景库沿用贴图（wallpaper/reference）
        # 体系；旧「家居库/植物库」平铺贴图已并入配景库分类，弹窗新增的
        # 家居/植物/材质三库是 3D 模型（commodity_materials 接口，ref/
        # modelUrl 字段），与本表贴图素材模式不同，暂不纳入
        gallery = "配景库"

        def grid_ids():
            try:
                return {d["source_id"] for d in json.loads(
                    driver.execute_script(
                        "return JSON.stringify((" + HARVEST_GRID + ")());") or "[]")}
            except Exception:
                return set()

        def fresh_dom(cate, tag, exclude):
            """网格 DOM 兜底，仅收 exclude 之外新出现的图（排除面板残留）"""
            rows = parse_grid(json.loads(driver.execute_script(
                "return JSON.stringify((" + HARVEST_GRID + ")());") or "[]"),
                gallery, cate, tag)
            return [d for d in rows if d["source_id"] not in exclude]

        cate_names = [t for t in enumerate_row_texts(driver, "cate") if len(t) <= 12]
        if not cate_names:
            # 面板 DOM 枚举偶发空(渲染时序/结构漂移)：兜底已知分类常量
            #（与库内 distinct category 一致，新分类由 DOM 通道发现后补充）
            cate_names = list(KNOWN_SCENERY_CATEGORIES)
            log(f"[warn] 分类行 DOM 枚举为空，回退已知分类 {len(cate_names)} 个")
        if categories:
            cate_names = [c for c in cate_names if c in categories]
        log(f"分类：{cate_names}")

        for cate in cate_names:
            # 每个分类前重开面板（dd1b6f08 的设计意图：规避长会话状态漂移）
            try:
                open_scenery_panel(driver, editor_url)
            except Exception as exc:
                log(f"  [warn] {cate}: 面板重开失败（{exc}），跳过")
                continue
            drain(driver)
            # 点一级分类：chip_element 滚入可视区，以子分类行变化/已知 tag 验证
            before_sub = subcate_texts(driver)
            known = CATE_TAGS.get(cate, set())
            ok = any(t in known for t in before_sub if t)
            # 分类点击前的网格快照：DOM 兜底只收「快照之后新出现」的图，
            # 防止面板残留的上一分类网格被错标（面板本就在本分类——
            # 快速通道时当前网格即本分类内容，快照置空全收）
            cat_before_ids = set() if ok else grid_ids()
            for _attempt in range(6):
                if ok:
                    break
                if not click_chip(driver, "cate", cate):
                    time.sleep(1)
                    continue
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
            tags = [t for t in enumerate_row_texts(driver, "sub") if len(t) <= 12]
            CATE_TAGS.setdefault(cate, set()).update(tags)
            processed_tag = set()
            dom_seen = set(cat_before_ids)  # 本分类 DOM 通道已归账的 id（防复收）

            log(f"== 爬取 {cate}（{len(tags) or 1} tags）==")
            for tag in (tags or [None]):
                if tag in processed_tag:
                    continue
                processed_tag.add(tag)
                chip_name = tag or cate  # 无子分类行：以分类 chip 为点击/翻页锚
                stale_noop = 0   # 连续「无响应且无新网格」（点击被吞/已翻尽）
                stale_known = 0  # 连续有响应但零新增（全已知安全网）
                for _round in range(max_pages):
                    # 2026-11 改版：面板无「下一页」按钮，重复点击也不推进
                    # 页码——每 tag 由面板预取页（实测 30~144 条，约至空或
                    # 5 页上限），第 1 轮即收割该预取面；后续轮只作「点击被
                    # 吞重试 + 空转探测」，连续无响应判库尾
                    if not click_chip(driver, "sub" if tag else "cate", chip_name):
                        log(f"    [warn] {cate}/{chip_name}: chip 不可见，跳过")
                        break
                    time.sleep(3)
                    got = wait_any(driver, gallery, cate, timeout=8)
                    items = [it for _, its in got for it in its]
                    dom_new = fresh_dom(cate, tag, dom_seen)
                    for d in dom_new:
                        dom_seen.add(d["source_id"])
                    if not items and not dom_new:
                        stale_noop += 1
                        if stale_noop >= 2:
                            # 留现场：一致失败的 tag 需要看面板当时显示了什么
                            if stats.get("nodata_dumped", 0) < 3:
                                stats["nodata_dumped"] = stats.get("nodata_dumped", 0) + 1
                                try:
                                    DATA_DIR.mkdir(parents=True, exist_ok=True)
                                    driver.save_screenshot(str(DATA_DIR / "tag-nodata.png"))
                                    (DATA_DIR / "tag-nodata.json").write_text(json.dumps({
                                        "cate": cate, "tag": chip_name,
                                        "sub_row": subcate_texts(driver),
                                        "body_text": (driver.execute_script(
                                            "return (document.body.innerText||'');") or "")[:2000],
                                    }, ensure_ascii=False, indent=2), encoding="utf-8")
                                    log("    [diag] 无响应现场已存 tag-nodata.png/json")
                                except Exception:
                                    pass
                            log(f"    {cate}/{chip_name}: 无响应且无新网格，到库尾")
                            break
                        continue  # 点击可能被吞，下一轮原样重点
                    stale_noop = 0
                    merged = merge_into_result(list(got), dom_new, gallery, cate, tag)
                    batch = [it for _, its in merged for it in its]
                    n, new_n = process_batch(cfg, driver, batch, stats, all_items)
                    log(f"    {cate}/{chip_name} 第 {_round + 1} 轮：{n} 条（新 {new_n}）")
                    if new_n == 0:
                        stale_known += 1
                        if stop_known > 0 and n >= 5 and stale_known >= stop_known:
                            log(f"    {cate}/{chip_name}: 连续 {stale_known} 页全已知，提前收尾")
                            break
                        if stale_known >= 3:
                            log(f"    {cate}/{chip_name}: 连续 {stale_known} 轮零新增，熔断")
                            break
                    else:
                        stale_known = 0
                    time.sleep(delay)

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
