#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
jzxz-plant-crawler.py — 建筑学长植物库爬取脚本（Selenium 有头模式）

与 jzxz-home-crawler.py（家居库）同构，机制均沿用其验证过的实现：
登录态持久化、上传测试图进编辑器、点击升级阶梯（ActionChains→原生→JS，
以"进入详情/变页"信号验证）、翻页双信号（网格签名+翻页控件文本）、
连续失败重建面板、glb 三路获取（网络捕获→DOM 直链→点"下载"按钮）、
glb_attempts 计数（连续 3 次没拿到视为无 glb 不再重试）。

流程：打开 https://www.jianzhuxuezhang.com/home →
1. 登录：已登录（本地 profile 有会话）直接进入；未登录自动点击右上角
   "登录/注册"，由用户扫码；会话由 Chrome profile 持久化，下次免登录。
2. 上传测试图：点击首页"本地上传"格子（upload_btn_box），向页面内
   input[type=file] 提交测试图，等待图片编辑器打开。
3. 植物库采集：点击贴图面板"植物库"tab（筛选保持默认"全部"），
   逐个遍历 product_material_item_*，点击"查看详情"采集名称/品类/标签/
   尺寸，下载视图图片与 glb 模型，转存公开桶 jzxz-plant-materials，
   元数据 upsert 表 jzxz_plant_materials；每处理一条打印一行结果。
   source_id 已入库的条目跳过。
4. 有"下一页"翻页继续；默认只处理第 1 页，--all 遍历全部页
   （无页数上限，直到没有"下一页"或翻页后内容不再变化）。

站点结构实测（2026-09-23）：
- 植物库与家居库共用贴图面板：tab: custom_gallery_btn（active_MOpxV0），
  条目 product_material_item_*（名称 product_material_name_* title，
  "查看详情"在 product_material_detail_*），上一页/下一页翻页。
- 植物库顶部有三组筛选下拉（地域气候区/核心气候类型/植物类型等），
  默认"全部"，脚本不触碰筛选，直接全库遍历。
- api.jianzhuxuezhang.com 响应为密文（ciphertext），详情数据只能 DOM 解析
  （label 行匹配）+ 网络捕获兜底（fetch/XHR 钩子抓 .glb 直链）。
- React 忽略合成事件，真实点击必须 ActionChains；运营弹窗 popup_window_box
  需反复关闭。

用法：
  python scripts/jzxz-plant-crawler.py                # 第 1 页
  python scripts/jzxz-plant-crawler.py --all          # 遍历所有页
  python scripts/jzxz-plant-crawler.py --max-pages 3
  python scripts/jzxz-plant-crawler.py --max-items 3  # 每次最多实采 N 条
  python scripts/jzxz-plant-crawler.py --dry-run      # 只采集下载打印，不入库不转存
  python scripts/jzxz-plant-crawler.py --no-pause     # 结束/失败不等待回车（便于托管运行）

配置：scripts/jzxz-crawler.local.json（gitignored，与家居/素材爬虫共用：
supabase_url / service_key / chromedriver_path / chrome_binary）
"""

import argparse
import base64
import hashlib
import json
import re
import struct
import time
import zlib
from datetime import datetime
from pathlib import Path
from urllib.parse import urlparse

import requests
from selenium import webdriver
from selenium.common.exceptions import (
    ElementClickInterceptedException,
    StaleElementReferenceException,
)
from selenium.webdriver.chrome.options import Options
from selenium.webdriver.chrome.service import Service
from selenium.webdriver.common.action_chains import ActionChains
from selenium.webdriver.common.by import By
from selenium.webdriver.support.ui import WebDriverWait

ROOT = Path(__file__).resolve().parent.parent
PAGE_URL = "https://www.jianzhuxuezhang.com/home"
PROFILE_DIR = ROOT / "data" / "jzxz-chrome-profile"
DATA_DIR = ROOT / "data" / "jzxz-captured"
GLB_DIR = DATA_DIR / "plant-glb"
CONFIG_PATH = ROOT / "scripts" / "jzxz-crawler.local.json"
# 与 jzxz-material-crawler.py 共用同一画布项目（同一浏览器 profile/站点）
PROJECT_STATE_PATH = ROOT / "data" / "jzxz-canvas-project.json"
EDITOR_URL = None  # enter_canvas_editor 成功后记录，翻页恢复时复用

TABLE = "jzxz_plant_materials"
BUCKET = "jzxz-plant-materials"
STORE_PREFIX = "plant"  # 桶内路径前缀 plant/<source_id>/…

LOGIN_WAIT_SECONDS = 180    # 单轮扫码等待上限
UPLOAD_ATTEMPTS = 3         # 上传重试次数
UPLOAD_SETTLE_SECONDS = 90  # "上传中"消失等待上限
GLB_DOWNLOAD_SECONDS = 300  # glb 下载等待上限（大文件）

CAPTURE_HOOK = """
window.__cap = window.__cap || [];
(function(){
  if (window.__hooked) return; window.__hooked = true;
  const of = window.fetch;
  window.fetch = async function(...a){
    const r = await of.apply(this, a);
    try {
      const u = (typeof a[0]==='string') ? a[0] : a[0].url;
      window.__cap.push({u: String(u).slice(0,400)});
    } catch(e){}
    return r;
  };
  const oo = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function(m, u){ this.__u = u;
    return oo.apply(this, arguments); };
  const os = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.send = function(){
    this.addEventListener('load', () => {
      try { window.__cap.push({u: String(this.__u).slice(0,400)}); } catch(e){}
    });
    return os.apply(this, arguments);
  };
})();
"""


# ---------------------------------------------------------------- 基础

def log(msg: str) -> None:
    print(msg, flush=True)


def load_config() -> dict:
    if CONFIG_PATH.exists():
        try:
            return json.loads(CONFIG_PATH.read_text(encoding="utf-8"))
        except Exception as exc:
            log(f"[warn] 配置解析失败（{exc}），按无库模式运行。")
    else:
        log("[warn] 未找到 scripts/jzxz-crawler.local.json，按无库模式运行"
            "（只采集打印，不写 Supabase）。")
    return {}


def human(nbytes: float) -> str:
    for unit in ("B", "KB", "MB", "GB"):
        if nbytes < 1024 or unit == "GB":
            return f"{nbytes:.1f} {unit}" if unit != "B" else f"{int(nbytes)} B"
        nbytes /= 1024
    return f"{nbytes:.1f} GB"


def make_driver(cfg: dict) -> webdriver.Chrome:
    opts = Options()
    if cfg.get("chrome_binary"):
        opts.binary_location = cfg["chrome_binary"]
    opts.add_argument(f"--user-data-dir={PROFILE_DIR}")
    opts.add_argument("--no-first-run")
    opts.add_argument("--window-size=1600,1000")
    # 降低自动化特征，避免站点弹登录/验证
    opts.add_argument("--disable-blink-features=AutomationControlled")
    opts.add_experimental_option("prefs", {
        "download.default_directory": str(GLB_DIR),
        "download.prompt_for_download": False,
        "download.directory_upgrade": True,
    })
    svc = Service(cfg["chromedriver_path"]) if cfg.get("chromedriver_path") \
        else Service()
    return webdriver.Chrome(service=svc, options=opts)


def real_click(driver: webdriver.Chrome, el) -> None:
    """真实点击（React 忽略 JS 合成事件）；被遮挡时降级 JS 点击。"""
    try:
        driver.execute_script(
            "arguments[0].scrollIntoView({block:'center'});", el)
        time.sleep(0.3)
        ActionChains(driver).move_to_element(el).pause(0.1).click().perform()
    except ElementClickInterceptedException:
        driver.execute_script("arguments[0].click()", el)


def visible(driver, xpath: str) -> list:
    out = []
    for e in driver.find_elements(By.XPATH, xpath):
        try:
            if e.is_displayed():
                out.append(e)
        except StaleElementReferenceException:
            pass
    return out


def drain_captures(driver) -> list:
    return driver.execute_script(
        "return window.__cap ? window.__cap.splice(0) : [];")


# ---------------------------------------------------------------- Supabase

def sb_headers(cfg: dict, extra: dict = None) -> dict:
    h = {"apikey": cfg["service_key"],
         "Authorization": f"Bearer {cfg['service_key']}"}
    h.update(extra or {})
    return h


def known_source_ids(cfg: dict, ids: list) -> dict:
    """查询不需重采的 source_id → glb_attempts。

    植物以图片为主体，与家居库不同：已采到图片（image_total_bytes>0）
    即视为完成；仅有 glb 未获取不算缺失（植物基本无 glb 模型，
    三振计数只在连续无图时兜底）。
    """
    if ARGS.dry_run or not cfg.get("supabase_url") or not ids:
        return {}
    r = requests.get(
        f"{cfg['supabase_url'].rstrip('/')}/rest/v1/{TABLE}",
        params={"select": "source_id,glb_attempts",
                "source_id": f"in.({','.join(ids)})",
                "or": "(glb_path.not.is.null,glb_attempts.gte.3,"
                      "image_total_bytes.gt.0)"},
        headers=sb_headers(cfg), timeout=30)
    if not r.ok:
        log(f"[warn] 查询已采集合失败 http {r.status_code}，本次不跳过。")
        return {}
    return {row["source_id"]: row.get("glb_attempts") or 0
            for row in r.json()}


def upload_to_bucket(cfg: dict, path: str, data: bytes, content_type: str,
                     label: str) -> bool:
    if ARGS.dry_run:
        return True
    r = requests.put(
        f"{cfg['supabase_url'].rstrip('/')}/storage/v1/object/{BUCKET}/{path}",
        headers=sb_headers(cfg, {"Content-Type": content_type, "x-upsert": "true"}),
        data=data, timeout=600)
    if not r.ok:
        log(f"    [warn] {label} 转存失败 http {r.status_code}: {r.text[:120]}")
    return r.ok


def upsert_row(cfg: dict, row: dict) -> bool:
    if ARGS.dry_run:
        return True
    # 注意：本机自托管 Supabase 的 PostgREST 为老版本，只认旧 prefer 名
    # resolution=merge-duplicates（新名 merge-deduplicate 会被静默忽略，
    # 落成裸 INSERT 撞唯一键 409）
    for attempt in (1, 2):
        try:
            r = requests.post(
                f"{cfg['supabase_url'].rstrip('/')}/rest/v1/{TABLE}",
                params={"on_conflict": "source_id"},
                headers=sb_headers(cfg, {"Prefer": "resolution=merge-duplicates,"
                                                    "return=representation"}),
                json=row, timeout=60)
            ok = r.ok and isinstance(r.json(), list) and \
                r.json() and r.json()[0].get("source_id") == row["source_id"]
            if ok:
                return True
            log(f"    [warn] 入库校验失败（第 {attempt} 次）http {r.status_code}:"
                f" {r.text[:150]}")
        except requests.RequestException as exc:
            log(f"    [warn] 入库请求异常（第 {attempt} 次）: {str(exc)[:120]}")
        time.sleep(2)
    return False


# ---------------------------------------------------------------- 登录

LOGIN_ENTRANCE_SELECTOR = 'header div[class*="login_entrance"]'


def is_logged_in(driver: webdriver.Chrome) -> bool:
    """已登录 = 头部存在且不再含"登录/注册"入口元素。"""
    state = driver.execute_script(
        "const hd = document.querySelector('header');"
        "if (!hd) return {header: false, login_btn: false};"
        "return {header: true,"
        "  login_btn: !!hd.querySelector('div[class*=\"login_entrance\"]')};"
    )
    return bool(state and state.get("header")) and not (state or {}).get("login_btn")


def open_home(driver: webdriver.Chrome) -> None:
    driver.get(PAGE_URL)
    WebDriverWait(driver, 30).until(
        lambda d: d.execute_script("return document.readyState") == "complete"
    )
    time.sleep(3)  # SPA 水合，等头部渲染完成


def _save_editor_url(url: str) -> None:
    global EDITOR_URL
    EDITOR_URL = url
    if "projectId=" in url:
        try:
            PROJECT_STATE_PATH.write_text(json.dumps({
                "editor_url": url,
                "project_id": url.split("projectId=")[-1].split("&")[0],
                "updated": datetime.now().isoformat(timespec="seconds"),
            }, ensure_ascii=False), encoding="utf-8")
        except Exception:
            pass


def enter_canvas_editor(driver: webdriver.Chrome) -> str:
    """站点 2026-09 改版后 /home 是工作台而非编辑器（无本地上传入口）。

    进画布编辑器：优先复用记忆的 /canvas/detail?projectId=… URL（与素材
    爬虫共用 data/jzxz-canvas-project.json），失效则在工作台点「新建项目」。"""
    if PROJECT_STATE_PATH.exists():
        try:
            saved = json.loads(
                PROJECT_STATE_PATH.read_text(encoding="utf-8")).get("editor_url")
        except Exception:
            saved = None
        if saved:
            driver.get(saved)
            deadline = time.time() + 25
            while time.time() < deadline:
                if visible(driver, "//*[contains(@class,'upload_btn_box')]"):
                    log(f"已复用画布编辑器: {saved}")
                    EDITOR_URL = saved
                    return saved
                time.sleep(1)
            log("  记忆的编辑器 URL 已失效，改从工作台新建项目。")
    open_home(driver)
    tgt = None
    for _ in range(15):
        close_popups(driver)
        tgt = next((e for e in driver.find_elements(
            By.XPATH, "//*[normalize-space(text())='新建项目']") if e.is_displayed()), None)
        if tgt is not None:
            break
        time.sleep(2)
    if tgt is None:
        driver.save_screenshot(str(DATA_DIR / "entry-fail.png"))
        raise RuntimeError("工作台「新建项目」入口未找到（登录态失效或页面改版），"
                           "现场已存 data/jzxz-captured/entry-fail.png")
    real_click(driver, tgt)
    deadline = time.time() + 25
    while time.time() < deadline:
        if "/canvas/detail" in (driver.current_url or ""):
            break
        time.sleep(1)
    else:
        raise RuntimeError(f"点击「新建项目」后未进入编辑器（当前：{driver.current_url}）")
    if len(driver.window_handles) > 1:
        driver.switch_to.window(driver.window_handles[-1])
    url = driver.current_url
    _save_editor_url(url)
    time.sleep(4)
    log(f"已新建画布编辑器: {url}")
    return url


def click_login_entrance(driver: webdriver.Chrome) -> bool:
    try:
        el = driver.find_element(By.CSS_SELECTOR, LOGIN_ENTRANCE_SELECTOR)
    except Exception:
        return False
    try:
        el.click()
    except ElementClickInterceptedException:
        driver.execute_script("arguments[0].click()", el)
    return True


def wait_for_login(driver: webdriver.Chrome) -> bool:
    log(f"请在浏览器窗口中完成扫码登录（本轮等待上限 {LOGIN_WAIT_SECONDS} 秒）...")
    deadline = time.time() + LOGIN_WAIT_SECONDS
    while time.time() < deadline:
        if is_logged_in(driver):
            return True
        time.sleep(2)
    return False


def ensure_login(driver: webdriver.Chrome) -> None:
    if is_logged_in(driver):
        log("已检测到登录态（来自本地保存的会话），无需重新登录。")
        return
    if not click_login_entrance(driver):
        log("未找到右上角\"登录/注册\"入口（页面结构可能变化），请手动点击登录。")
    else:
        log("已点击右上角\"登录/注册\"。")
    while True:
        if wait_for_login(driver):
            log("登录成功，会话已保存到本地 profile，下次运行免登录。")
            return
        if ARGS.no_pause:
            log("未检测到登录成功（--no-pause 不等待人工），放弃登录继续。")
            return
        ans = input("未检测到登录成功：完成扫码后直接按回车继续等待，"
                    "输入 q 放弃并继续: ").strip().lower()
        if ans == "q":
            log("已放弃等待登录（登录态未保存，下次仍需扫码）。")
            return


# ---------------------------------------------------------------- 上传

def make_test_png(size: int = 64, rgb=(200, 60, 60)) -> bytes:
    """纯 python 生成一张纯色 PNG 测试图。"""
    def chunk(tag, data):
        c = struct.pack(">I", len(data)) + tag + data
        return c + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)
    raw = b"".join(b"\x00" + bytes(rgb) * size for _ in range(size))
    return (b"\x89PNG\r\n\x1a\n"
            + chunk(b"IHDR", struct.pack(">IIBBBBB", size, size, 8, 2, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(raw))
            + chunk(b"IEND", b""))


def ensure_test_image() -> Path:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    path = DATA_DIR / "test-upload.png"
    if not path.exists():
        path.write_bytes(make_test_png())
    return path


def close_popups(driver: webdriver.Chrome) -> None:
    """关掉运营弹窗（popup_window_box）与通用弹窗，清理点击路径。"""
    driver.execute_script(
        "document.querySelector(\"button[class*='close']\")?.click();")
    driver.execute_script("""
      const pop = document.querySelector('[class*="popup_window_box"]');
      if (pop) {
        const btn = pop.querySelector('[class*="close_icon"], [class*="close"]');
        if (btn) btn.click(); else pop.style.display = 'none';
      }
    """)


def upload_running(driver) -> bool:
    return driver.execute_script(
        "return (document.body.innerText || '').includes('上传中');")


def editor_open(driver) -> bool:
    return driver.execute_script(
        "return (document.body.innerText || '').includes('图片编辑');")


def close_upload_modal(driver):
    driver.execute_script("""
      const mm = document.querySelector('.micro-modal');
      if (mm) {
        const btn = mm.querySelector('button[class*="close"], [class*="close"]');
        if (btn) btn.click();
      }
    """)


def submit_upload(driver, file_path: Path) -> bool:
    """提交测试图;返回是否成功发起上传。

    2026-10 上游改版:全站 input[type=file] 移除(改原生 showOpenFilePicker,
    Selenium 无法对话)。双通道:先按旧路找 input(兼容回归),找不到则向
    参考图输入框合成 ClipboardEvent 粘贴文件(与真实 Ctrl+V 同链路)。"""
    # 旧通道:upload_btn_box + 图片 input(改版回归时仍可用)
    boxes = visible(driver, "//*[contains(@class,'upload_btn_box')]")
    if boxes:
        real_click(driver, boxes[0])
        log("  已点击\"本地上传\"，等待文件选择框…")
        inputs = []
        deadline = time.time() + 8
        while time.time() < deadline and not inputs:
            time.sleep(1)
            inputs = [i for i in driver.find_elements(By.CSS_SELECTOR, "input[type='file']")
                      if "png" in (i.get_attribute("accept") or "").lower()
                      or "image" in (i.get_attribute("accept") or "").lower()]
        if inputs:
            driver.execute_script("arguments[0].style.display='block';", inputs[0])
            inputs[0].send_keys(str(file_path))
            return True
        log("  无图片 input（2026-10 改版），改走粘贴通道…")
    # 粘贴通道:读文件字节,合成 paste 事件注入参考图输入框
    try:
        b64 = base64.b64encode(file_path.read_bytes()).decode()
    except Exception as e:
        log(f"  读取测试图失败: {e}")
        return False
    ok = driver.execute_script("""
      const target = document.querySelector('textarea') ||
                     document.querySelector('[contenteditable="true"]');
      if (!target) return false;
      target.focus();
      const b64 = arguments[0];
      const bin = atob(b64); const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      const file = new File([bytes], arguments[1], { type: 'image/png' });
      const dt = new DataTransfer();
      dt.items.add(file);
      target.dispatchEvent(new ClipboardEvent('paste', {
        bubbles: true, cancelable: true, clipboardData: dt }));
      return true;
    """, b64, file_path.name)
    if ok:
        log("  已粘贴测试图到参考图输入框。")
    else:
        log("  粘贴失败（参考图输入框未找到）。")
    return bool(ok)


def upload_test_image(driver, file_path: Path) -> bool:
    """上传测试图并等图片编辑器打开；卡"上传中"自动重试。返回是否成功。"""
    for attempt in range(1, UPLOAD_ATTEMPTS + 1):
        log(f"  上传第 {attempt}/{UPLOAD_ATTEMPTS} 次尝试…")
        if not submit_upload(driver, file_path):
            close_popups(driver)
            time.sleep(2)
            continue
        deadline = time.time() + 45
        while time.time() < deadline:
            if editor_open(driver):
                break
            time.sleep(1)
        if not editor_open(driver):
            log("  编辑器未打开（可能卡在上传中），关闭弹窗后重试。")
            driver.save_screenshot(str(DATA_DIR / f"upload-stuck-{attempt}.png"))
            close_upload_modal(driver)
            close_popups(driver)
            time.sleep(2)
            continue
        deadline = time.time() + UPLOAD_SETTLE_SECONDS
        while time.time() < deadline:
            if not upload_running(driver):
                log("  测试图上传完成，图片编辑器已打开。")
                return True
            time.sleep(2)
        log(f"  上传中超过 {UPLOAD_SETTLE_SECONDS}s 未完成，重试。")
        driver.save_screenshot(str(DATA_DIR / f"upload-stuck-{attempt}.png"))
        close_upload_modal(driver)
        close_popups(driver)
        time.sleep(2)
    return False


# ---------------------------------------------------------------- 植物库采集

def item_elements(driver) -> list:
    return [e for e in driver.find_elements(
        By.XPATH, "//*[contains(@class,'product_material_item')]") if e.is_displayed()]


def item_summary(driver) -> list:
    """可见条目 [{name, source_id, img_url}]。"""
    return driver.execute_script("""
      const items = [];
      document.querySelectorAll('[class*="product_material_item"]').forEach(el => {
        if (el.getBoundingClientRect().width <= 0) return;
        const n = el.querySelector('[class*="product_material_name"]');
        const img = el.querySelector('img');
        items.push({
          name: n ? (n.getAttribute('title') || n.textContent) : '',
          img: img ? (img.currentSrc || img.src || '') : ''
        });
      });
      return items;
    """) or []


def source_id_from_img(img_url: str) -> str:
    m = re.search(r"/([0-9a-fA-F-]{36})(?:\.[a-zA-Z]+)?(?:\?|$)", img_url or "")
    if m:
        return m.group(1)
    if img_url:
        return hashlib.md5(img_url.encode("utf-8")).hexdigest()
    return ""


def item_detail_el(item_el):
    try:
        return item_el.find_element(
            By.CSS_SELECTOR, '[class*="product_material_detail"]')
    except Exception:
        return None


def new_overlay_class(driver, before_classes: list):
    return driver.execute_script("""
      const before = arguments[0];
      let found = null;
      document.querySelectorAll('[class*="modal"], [class*="detail"], [class*="Detail"], [class*="drawer"], [class*="Drawer"]').forEach(el => {
        const r = el.getBoundingClientRect();
        if (found || r.width < 250 || r.height < 200) return;
        const cls = String(el.className || '');
        if (before.some(b => cls.includes(b))) return;
        found = cls;
      });
      return found;
    """, before_classes)


def extract_detail(driver, overlay_cls: str) -> dict:
    """从详情视图提取 名称/品类/标签/尺寸 + 图片 src 列表 + glb 链接 + 文本快照。"""
    return driver.execute_script("""
      const hint = arguments[0] ? arguments[0].split(' ')[0] : null;
      let ov = null;
      if (hint) {
        document.querySelectorAll('[class*="modal"], [class*="detail"], [class*="Detail"], [class*="drawer"]').forEach(el => {
          const r = el.getBoundingClientRect();
          if (!ov && r.width > 250 && r.height > 200
              && String(el.className).includes(hint)) ov = el;
        });
      }
      const root = ov || document;
      const out = {category: '', tags: '', size: '', name: '',
                   imgs: [], glbHrefs: [], raw: '', inOverlay: !!ov};
      const lines = (root.innerText || '').split('\\n')
        .map(s => s.trim()).filter(Boolean);
      function pick(re) {
        // 值形如"xx:"的是下一个小节头，不能当字段值（品类空值时下一行是"标签:"）
        function isHeader(s) { return /^[^:：]{1,8}[:：]$/.test(s); }
        for (let i = 0; i < lines.length; i++) {
          if (!re.test(lines[i])) continue;
          let v = lines[i].replace(re, '').replace(/^[:：\\s]+/, '').trim();
          if (v && v.length <= 80 && !isHeader(v)) return v;
          const nx = (lines[i + 1] || '').trim();
          if (nx && nx.length <= 80 && !isHeader(nx)) return nx;
        }
        return '';
      }
      out.category = pick(/品类|分类/);
      out.tags = pick(/标签/);
      out.size = pick(/尺寸|规格|大小/);
      out.name = pick(/名称|标题/);
      // 植物库标签是多行区块（气候区/习性/颜色混排，直到下一小节头或结尾），
      // 逐行收集；遇到"xx:"小节头（品类:/尺寸:…）即停
      out.tagsMany = [];
      for (let i = 0; i < lines.length; i++) {
        if (!/^标签/.test(lines[i])) continue;
        for (let j = i + 1; j < lines.length; j++) {
          const t = lines[j];
          if (/^[^:：]{1,8}[:：]$/.test(t)) break;
          if (t.length <= 20 && out.tagsMany.indexOf(t) < 0) {
            out.tagsMany.push(t);
          }
          if (out.tagsMany.length >= 30) break;
        }
        break;
      }
      const seen = new Set();
      root.querySelectorAll('img').forEach(img => {
        const r = img.getBoundingClientRect();
        const src = img.currentSrc || img.src || '';
        if (r.width >= 60 && r.height >= 60 && src
            && !src.startsWith('data:') && !seen.has(src)) {
          seen.add(src); out.imgs.push(src);
        }
      });
      document.querySelectorAll('a[href]').forEach(a => {
        const h = a.href || '';
        if (/\\.glb($|\\?)/i.test(h) && out.glbHrefs.indexOf(h) < 0) {
          out.glbHrefs.push(h);
        }
      });
      out.raw = lines.join('\\n').slice(0, 4000);
      return out;
    """, overlay_cls) or {}


def glb_url_from_captures(driver) -> str:
    for c in drain_captures(driver):
        u = (c or {}).get("u") or ""
        if ".glb" in u.lower():
            return u
    return ""


def split_tags(text: str) -> list:
    if not text:
        return []
    parts = re.split(r"[ /、，,|;；]+", text.strip())
    return [p for p in (s.strip() for s in parts) if p][:20]


def http_session_with_cookies(driver) -> requests.Session:
    s = requests.Session()
    s.headers.update({"User-Agent": "Mozilla/5.0",
                      "Referer": "https://www.jianzhuxuezhang.com/"})
    try:
        for c in driver.get_cookies():
            if "jianzhuxuezhang" in (c.get("domain") or ""):
                s.cookies.set(c["name"], c.get("value"),
                              domain=c.get("domain"), path=c.get("path", "/"))
    except Exception:
        pass
    return s


def download_bytes(session: requests.Session, url: str,
                   timeout=(15, 300)) -> bytes:
    r = session.get(url, timeout=timeout)
    r.raise_for_status()
    return r.content


def download_images(driver, urls: list, source_id: str, cfg: dict) -> tuple:
    """下载视图图片并转存桶；返回 (paths, total_bytes)。"""
    session = http_session_with_cookies(driver)
    paths, total = [], 0
    for i, u in enumerate(urls):
        try:
            data = download_bytes(session, u)
        except Exception as exc:
            log(f"    [warn] 图片 {i + 1} 下载失败: {str(exc)[:80]}")
            continue
        ext = ".png"
        m = re.search(r"\.([a-zA-Z]{3,4})(?:\?|$)", u)
        if m:
            ext = "." + m.group(1).lower()
        path = f"{STORE_PREFIX}/{source_id}/img-{i}{ext}"
        ctype = "image/jpeg" if ext in (".jpg", ".jpeg") else \
            "image/webp" if ext == ".webp" else "image/png"
        if upload_to_bucket(cfg, path, data, ctype, f"图片 {i + 1}"):
            paths.append(path)
            total += len(data)
    return paths, total


def glb_via_download_button(driver) -> tuple:
    """点详情里的"下载"按钮借浏览器下载 glb；返回 (bytes, filename) 或 (None, '')。"""
    btns = visible(driver, "//*[normalize-space(text())='下载']")
    btns += [b for xp in (
        "//button[contains(., '下载')]",
        "//a[contains(., '下载')]") for b in visible(driver, xp)]
    if not btns:
        return None, ""
    GLB_DIR.mkdir(parents=True, exist_ok=True)
    baseline = set(p.name for p in GLB_DIR.glob("*"))
    real_click(driver, btns[0])
    log("    已点击\"下载\"，等待浏览器落盘…")
    deadline = time.time() + GLB_DOWNLOAD_SECONDS
    while time.time() < deadline:
        time.sleep(2)
        # 新标签页打开直链的情况
        if len(driver.window_handles) > 1:
            main = driver.window_handles[0]
            driver.switch_to.window(driver.window_handles[-1])
            url = driver.current_url
            driver.close()
            driver.switch_to.window(main)
            if ".glb" in url.lower():
                try:
                    return download_bytes(
                        http_session_with_cookies(driver), url), "model.glb"
                except Exception:
                    pass
        for p in GLB_DIR.glob("*"):
            if p.name in baseline or p.name.endswith(".crdownload"):
                continue
            if p.stat().st_size > 0:
                time.sleep(1)  # 等文件写完
                return p.read_bytes(), p.name
    return None, ""


def fetch_glb(driver, detail: dict) -> tuple:
    """拿 glb 字节：网络捕获直链 → DOM 链接 → 点"下载"按钮。返回 (bytes, name)。"""
    session = http_session_with_cookies(driver)
    url = glb_url_from_captures(driver)
    if not url:
        url = (detail.get("glbHrefs") or [""])[0]
    if url:
        try:
            return download_bytes(session, url), url.rsplit("/", 1)[-1][:80]
        except Exception as exc:
            log(f"    [warn] glb 直链下载失败: {str(exc)[:80]}")
    data, name = glb_via_download_button(driver)
    return data, name


def process_item(driver, idx: int, total: int, info: dict, cfg: dict,
                 skip_ids: set, results: list) -> bool:
    """处理单条：详情→提取→下载→转存→入库→打印；返回 False 表示遍历中断。"""
    name = info.get("name") or "(无名)"
    sid = source_id_from_img(info.get("img") or "")
    prefix = f"    [{idx + 1}/{total}]"
    prev_glb_attempts = skip_ids.get(sid, 0) if sid else 0
    if sid and sid in skip_ids:
        log(f"{prefix} {name}: 已采集过，跳过")
        results.append({"name": name, "source_id": sid, "skipped": True})
        return True

    els = item_elements(driver)
    detail_btn = None
    if idx < len(els):
        try:
            detail_btn = item_detail_el(els[idx])
        except StaleElementReferenceException:
            detail_btn = None
    if detail_btn is None:
        log(f"{prefix} {name}: 无\"查看详情\"按钮，跳过")
        results.append({"name": name, "source_id": sid, "ok": False,
                        "reason": "no-detail-btn"})
        return True

    before_classes = driver.execute_script("""
      const cls = [];
      document.querySelectorAll('[class*="modal"], [class*="detail"], [class*="drawer"]').forEach(el => {
        const r = el.getBoundingClientRect();
        if (r.width > 250 && r.height > 200) cls.push(String(el.className));
      });
      return cls;
    """) or []
    # 点击升级阶梯：透明遮挡层会让 ActionChains 静默落空（不抛异常），
    # 每种方式点击后都以"进入详情"信号（新容器出现/网格消失）验证效果
    clickers = (
        ("ActionChains", lambda e: real_click(driver, e)),
        ("原生 click", lambda e: e.click()),
        ("JS click", lambda e: driver.execute_script(
            "arguments[0].click()", e)),
    )
    entered = False
    overlay_cls = None
    for attempt, (cname, clicker) in enumerate(clickers, 1):
        try:
            clicker(detail_btn)
        except Exception as exc:
            log(f"{prefix} {cname} 点击异常: {exc.__class__.__name__}")
            time.sleep(1)
            continue
        time.sleep(2)
        overlay_cls = new_overlay_class(driver, before_classes)
        entered = bool(overlay_cls) or items_gone(driver)
        if entered:
            if attempt > 1:
                log(f"{prefix} 第 {attempt} 次尝试（{cname}）进入详情成功")
            break
        # 重新定位按钮（网格可能已被局部刷新）
        els_now = item_elements(driver)
        detail_btn = item_detail_el(els_now[idx]) \
            if idx < len(els_now) else None
        if detail_btn is None:
            break
    if not entered:
        log(f"{prefix} {name}: 详情点击 3 种方式均未进入，跳过")
        dump_click_diagnostics(driver, page_tag=None, text="查看详情")
        results.append({"name": name, "source_id": sid, "ok": False,
                        "reason": "no-detail-view"})
        return True

    # ---- 详情页内提取与下载
    detail = extract_detail(driver, overlay_cls)
    img_urls = (detail.get("imgs") or [])[:12]
    glb_bytes, glb_name = fetch_glb(driver, detail)
    img_paths, img_total = download_images(driver, img_urls, sid, cfg) \
        if sid else ([], 0)

    glb_path = ""
    glb_size = 0
    if glb_bytes and sid:
        glb_path = f"{STORE_PREFIX}/{sid}/model.glb"
        if upload_to_bucket(cfg, glb_path, glb_bytes,
                            "model/gltf-binary", "glb 模型"):
            glb_size = len(glb_bytes)
        else:
            glb_path = ""

    glb_attempts = 0 if glb_bytes else prev_glb_attempts + 1
    # 多行标签区块优先；老格式（单行"标签:"值）兜底
    tags = [t for t in (detail.get("tagsMany") or []) if t] \
        or split_tags(detail.get("tags") or "")
    row = {"source_id": sid, "name": name,
           "category": detail.get("category") or None,
           "tags": tags,
           "size_text": detail.get("size") or None,
           "image_paths": img_paths, "image_total_bytes": img_total,
           "glb_path": glb_path or None, "glb_bytes": glb_size,
           "glb_attempts": glb_attempts,
           "glb_name": glb_name or None,
           "source_url": info.get("img") or None,
           "raw": {"text": detail.get("raw") or ""}}
    saved = upsert_row(cfg, row)

    tags_txt = "/".join(row["tags"]) or "-"
    glb_txt = human(glb_size) if glb_size else (
        "未获取" + ("（连续 3 次未拿到，视为无 glb，不再重试）"
                    if glb_attempts >= 3 else ""))
    status = "已入库" if saved else ("dry-run" if ARGS.dry_run else "未入库")
    log(f"{prefix} {name} | 品类: {detail.get('category') or '-'} "
        f"| 标签: {tags_txt} | 尺寸: {detail.get('size') or '-'} "
        f"| 图片: {len(img_paths)} 张（{human(img_total)}）"
        f" | glb: {glb_txt} | {status}")
    if not detail.get("category") and not detail.get("size") \
            and not detail.get("tags"):
        log(f"      [warn] 品类/标签/尺寸全空，详情文本头几行: "
            f"{(detail.get('raw') or '')[:120]!r}")

    results.append({"name": name, "source_id": sid, "ok": saved or ARGS.dry_run,
                    "category": detail.get("category"),
                    "tags": row["tags"], "size": detail.get("size"),
                    "images": len(img_paths),
                    "image_bytes": img_total, "glb_bytes": glb_size})

    # ---- 返回网格
    overlay_cls_now = overlay_cls or new_overlay_class(driver, before_classes)
    for _ in range(3):
        if go_back_from_detail(driver, overlay_cls_now):
            return True
        time.sleep(1)
    log(f"{prefix} {name}: 未能返回网格，浏览器保持当前状态，遍历中止。")
    driver.save_screenshot(str(DATA_DIR / "back-failed.png"))
    return False


def items_gone(driver) -> bool:
    return not item_elements(driver)


def go_back_from_detail(driver, overlay_cls) -> bool:
    """从详情视图返回条目网格：优先详情容器内的返回/关闭，再退而求其次。"""
    xpaths = [
        "//*[normalize-space(text())='返回']",
        "//*[contains(@class,'back') and not(contains(@class,'background'))]",
        "//*[contains(@class,'close')]",
    ]
    first_cls = overlay_cls.split(" ")[0] if overlay_cls else ""
    for xp in xpaths:
        els = visible(driver, xp)
        if first_cls:
            scoped = []
            for e in els:
                scope_cls = driver.execute_script(
                    "const s = arguments[0].closest('[class*=\"modal\"],"
                    " [class*=\"detail\"], [class*=\"drawer\"]');"
                    "return s ? s.className : '';",
                    e) or ""
                if first_cls in scope_cls:
                    scoped.append(e)
            if scoped:
                els = scoped
        for e in els:
            try:
                real_click(driver, e)
                time.sleep(2)
                if item_elements(driver):
                    return True
            except Exception:
                continue
    return bool(item_elements(driver))


def next_page_btn(driver):
    for b in visible(driver,
                     "//button[.//span[normalize-space(text())='下一页']]"
                     " | //div[normalize-space(text())='下一页']"):
        disabled = (b.get_attribute("disabled") or "") != "" \
            or "disabled" in (b.get_attribute("class") or "")
        if not disabled:
            return b
    return None


def page_indicator(driver) -> str:
    """翻页控件文本（页码/按钮集合），作为网格签名之外的变页第二信号。"""
    return driver.execute_script("""
      const els = document.querySelectorAll(
        '[class*="page_btn"], [class*="page_num"], [class*="pagination"], [class*="pager"]');
      const texts = [];
      els.forEach(e => {
        const t = (e.textContent || '').trim();
        if (t && t.length < 20) texts.push(t);
      });
      texts.sort();
      return texts.join('|');
    """) or ""


def page_state(driver) -> dict:
    """翻页比对状态：网格图片 URL 签名 + 翻页控件文本。"""
    return {"sig": sorted(i.get("img") or "" for i in item_summary(driver)),
            "ind": page_indicator(driver)}


def state_changed(before: dict, now: dict) -> bool:
    grid_changed = bool(now["sig"]) and now["sig"] != before["sig"]
    ind_changed = bool(now["ind"]) and bool(before["ind"]) \
        and now["ind"] != before["ind"]
    return grid_changed or ind_changed


def wait_page_changed(driver, before: dict, timeout: int) -> bool:
    """轮询等待翻页生效（下一页数据靠网络拉取，渲染可能明显慢于点击）。"""
    deadline = time.time() + timeout
    while time.time() < deadline:
        time.sleep(1.5)
        if state_changed(before, page_state(driver)):
            return True
    return False


def native_click(el) -> bool:
    try:
        el.click()
        return True
    except Exception:
        return False


def click_next_with_retries(driver, nxt, before: dict,
                            verbose: bool = True) -> bool:
    """翻页点击升级阶梯：ActionChains → 原生 click → JS click。

    透明遮挡层会让 ActionChains 静默落空（不抛异常），靠变页轮询判定效果。
    注意此处不得调 close_popups（全局找 close 按钮可能误关编辑器）。
    verbose=False 用于恢复翻页（逐页翻回时静默，只报异常与失败）。
    """
    clickers = (
        ("ActionChains", lambda e: real_click(driver, e)),
        ("原生 click", native_click),
        ("JS click", lambda e: driver.execute_script(
            "arguments[0].click()", e)),
    )
    for attempt, (name, clicker) in enumerate(clickers, 1):
        try:
            clicker(nxt)
        except Exception as exc:
            log(f"  \"下一页\"点击异常（第 {attempt} 次/{name}）: "
                f"{exc.__class__.__name__}")
            time.sleep(1)
            continue
        if verbose or attempt > 1:
            log(f"  已点击\"下一页\"（第 {attempt} 次，{name}），等待下一页渲染…")
        if wait_page_changed(driver, before, timeout=20):
            return True
        nxt = next_page_btn(driver)
        if not nxt:
            log("  重试时\"下一页\"已不可用，判定到库尾。")
            return False
    return False


def dump_click_diagnostics(driver, page_tag, text: str,
                           tag: str = "click-fail") -> None:
    """点击失效留现场：目标文本元素状态 + 按钮中心点实际命中的元素。"""
    try:
        info = driver.execute_script("""
          const out = {matches: []};
          const xp = document.evaluate(
            "//*[normalize-space(text())=arguments[0]]", document, null,
            XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
          for (let i = 0; i < xp.snapshotLength && i < 6; i++) {
            const el = xp.snapshotItem(i);
            const r = el.getBoundingClientRect();
            let covering = null;
            if (r.width > 0 && r.height > 0) {
              const hit = document.elementFromPoint(
                r.x + r.width / 2, r.y + r.height / 2);
              covering = hit
                ? String(hit.className || hit.tagName).slice(0, 90) : null;
            }
            const btn = el.closest('button') || el;
            out.matches.push({tag: el.tagName,
              cls: String(el.className).slice(0, 90),
              btnCls: String(btn.className).slice(0, 110),
              disabled: btn.disabled === true
                || String(btn.className).includes('disabled'),
              rect: {x: Math.round(r.x), y: Math.round(r.y),
                     w: Math.round(r.width), h: Math.round(r.height)},
              covering});
          }
          out.gridCount =
            document.querySelectorAll('[class*="product_material_item"]').length;
          return out;
        """, text)
        DATA_DIR.mkdir(parents=True, exist_ok=True)
        ts = datetime.now().strftime("%Y%m%d-%H%M%S")
        (DATA_DIR / f"{tag}-{ts}.json").write_text(
            json.dumps({"page": page_tag, "text": text, **(info or {})},
                       ensure_ascii=False, indent=2),
            encoding="utf-8")
        driver.save_screenshot(str(DATA_DIR / f"{tag}-{ts}.png"))
        log(f"  失败现场已存: data/jzxz-captured/{tag}-{ts}.json")
    except Exception:
        pass


def enter_zhiwuku_tab(driver) -> bool:
    """点植物库 tab 直到条目渲染出来。"""
    clicked = 0
    for _ in range(6):
        tabs = visible(driver,
                       "//span[contains(@class,'tab_btn')][normalize-space(text())='植物库']")
        if not tabs:
            close_popups(driver)
            time.sleep(2)
            continue
        real_click(driver, tabs[0])
        clicked += 1
        deadline = time.time() + 10
        while time.time() < deadline:
            if item_summary(driver):
                break
            time.sleep(1)
        if item_summary(driver):
            break
        time.sleep(1)
    if not item_summary(driver):
        return False
    log(f"  已进入植物库（tab 点击 {clicked} 次生效）。")
    driver.execute_script(CAPTURE_HOOK)
    return True


def recover_to_page(driver, cfg: dict, test_img: Path,
                    target_page: int) -> bool:
    """刷新页面重建面板并翻回目标页（规避长会话面板状态漂移导致的点击失效，
    与家居库爬虫"重开面板"同一思路）。"""
    log(f"  常规翻页失效，刷新页面重建面板，翻回第 {target_page} 页…")
    driver.get(EDITOR_URL or PAGE_URL)
    WebDriverWait(driver, 30).until(
        lambda d: d.execute_script("return document.readyState") == "complete")
    time.sleep(4)
    close_popups(driver)
    if not upload_test_image(driver, test_img):
        log("  恢复失败：重建面板时上传未成功。")
        return False
    if not enter_zhiwuku_tab(driver):
        log("  恢复失败：植物库 tab 未进入。")
        return False
    for p in range(2, target_page + 1):
        nxt = next_page_btn(driver)
        if not nxt:
            log(f"  恢复失败：翻回第 {p} 页时无\"下一页\"。")
            return False
        before = page_state(driver)
        if not click_next_with_retries(driver, nxt, before, verbose=False):
            log(f"  恢复失败：翻回第 {p} 页时点击未生效。")
            return False
        if p == 2 or p % 5 == 0 or p == target_page:
            log(f"  恢复翻页进度: {p - 1}/{target_page - 1}")
    return True


def browse_zhiwuku(driver, cfg: dict, test_img: Path) -> list:
    """点植物库 tab → 逐页采集条目。"""
    if not enter_zhiwuku_tab(driver):
        log("  植物库条目未渲染（tab 点击未生效或面板结构变化）。")
        return []

    results = []
    page = 0
    while True:
        page += 1
        if not ARGS.all and page > ARGS.max_pages:
            break
        infos = item_summary(driver)
        sids = [s for s in (source_id_from_img(i.get("img") or "")
                            for i in infos) if s]
        skip_ids = known_source_ids(cfg, sids)
        n_skip = len([i for i in infos
                      if source_id_from_img(i.get("img") or "") in skip_ids])
        log(f"  第 {page} 页共 {len(infos)} 个条目"
            f"（已完成/不再重试 {n_skip} 条，将跳过）")
        # 逐条处理；连续 3 条进不了详情时重建面板重试本页（上限 2 次）
        rebuilds = 0
        i = 0
        consec_fail = 0
        processed = 0
        stop = False
        while i < len(infos):
            if ARGS.max_items and processed >= ARGS.max_items:
                log(f"  已实采 {processed} 条（--max-items {ARGS.max_items}），停止。")
                stop = True
                break
            infos_now = item_summary(driver)
            info = infos_now[i] if i < len(infos_now) else infos[i]
            if not process_item(driver, i, len(infos), info, cfg,
                                skip_ids, results):
                stop = True
                break
            last = results[-1] if results else {}
            if not last.get("skipped"):
                processed += 1
            if last.get("reason") == "no-detail-view":
                consec_fail += 1
                if consec_fail >= 3:
                    if rebuilds >= 2:
                        log("  本页面板重建重试已达上限，停止遍历。")
                        stop = True
                        break
                    rebuilds += 1
                    log(f"  连续 {consec_fail} 条进不了详情，"
                        f"重建面板后重试第 {page} 页…")
                    if recover_to_page(driver, cfg, test_img, page):
                        infos = item_summary(driver)
                        sids = [s for s in (source_id_from_img(x.get("img") or "")
                                            for x in infos) if s]
                        skip_ids = known_source_ids(cfg, sids)
                        consec_fail = 0
                        i = 0  # 本页已入库条目会按库内记录快速跳过
                        continue
                    log("  面板重建失败，停止遍历。")
                    stop = True
                    break
            else:
                consec_fail = 0
            i += 1
        if stop:
            break
        nxt = next_page_btn(driver)
        if not nxt:
            log(f'  第 {page} 页后无可用"下一页"，遍历结束。')
            break
        before = page_state(driver)
        if click_next_with_retries(driver, nxt, before):
            time.sleep(1)
            continue
        # 三种点击方式 + 双信号均无变化 → 判定真库尾。
        # （不做重建翻回：库尾翻回要空翻几百页；早期漂移吞点击的失效
        # 已由点击阶梯与双信号覆盖，若误判可查 pagination-fail 现场。）
        after = page_state(driver)
        log(f"  [diag] 翻页比对未通过：点击前 grid={len(before['sig'])} 条/"
            f"指示={before['ind'][:40]!r}；当前 grid={len(after['sig'])} 条/"
            f"指示={after['ind'][:40]!r}")
        try:
            DATA_DIR.mkdir(parents=True, exist_ok=True)
            ts = datetime.now().strftime("%Y%m%d-%H%M%S")
            (DATA_DIR / f"pagination-fail-{ts}.json").write_text(
                json.dumps({"page": page, "verdict": "last-page-assumed",
                            "before": before, "after": after},
                           ensure_ascii=False, indent=2), encoding="utf-8")
            driver.save_screenshot(str(DATA_DIR / f"pagination-fail-{ts}.png"))
            log(f"  现场已存: data/jzxz-captured/pagination-fail-{ts}.json")
        except Exception:
            pass
        dump_click_diagnostics(driver, page, "下一页", "pagination-btns")
        log(f'  第 {page} 页判定为库尾，遍历结束。')
        break
    return results


# ---------------------------------------------------------------- 主流程

def main() -> None:
    global ARGS
    parser = argparse.ArgumentParser(description="建筑学长植物库采集（有头）")
    parser.add_argument("--all", action="store_true",
                        help="遍历所有页（直到没有下一页，无上限）")
    parser.add_argument("--max-pages", type=int, default=1,
                        help="处理页数（默认 1，--all 时忽略）")
    parser.add_argument("--max-items", type=int, default=0,
                        help="本次最多实采条数（默认 0 不限制；跳过不计）")
    parser.add_argument("--dry-run", action="store_true",
                        help="只采集下载打印与本地汇总，不写 Supabase")
    parser.add_argument("--no-pause", action="store_true",
                        help="结束/失败时不等待回车（登录/上传失败也直接跳过人工兜底）")
    ARGS = parser.parse_args()

    cfg = load_config()
    if ARGS.dry_run:
        log("== dry-run 模式：不入库、不转存 ==")
    GLB_DIR.mkdir(parents=True, exist_ok=True)
    driver = make_driver(cfg)
    try:
        open_home(driver)
        log(f"页面已打开: {driver.current_url}")
        log(f"标题: {driver.title}")

        ensure_login(driver)

        results = []
        if not is_logged_in(driver):
            log("未登录，跳过上传与遍历。")
        else:
            enter_canvas_editor(driver)
            test_img = ensure_test_image()
            log(f"开始上传测试图片（{test_img.name}）…")
            ok_upload = upload_test_image(driver, test_img)
            if not ok_upload and not ARGS.no_pause:
                log("自动上传未成功。可在浏览器里手动拖入一张图片，"
                    "待编辑器打开后按回车继续遍历；输入 q 跳过: ")
                ans = input().strip().lower()
                ok_upload = ans != "q" and editor_open(driver)
            if ok_upload:
                log("开始遍历植物库…")
                results = browse_zhiwuku(driver, cfg, test_img)

        done = sum(1 for r in results if r.get("ok"))
        skipped = sum(1 for r in results if r.get("skipped"))
        log(f"遍历汇总：处理 {len(results)} 条，成功 {done}，跳过 {skipped}。")
        if results:
            DATA_DIR.mkdir(parents=True, exist_ok=True)
            out = DATA_DIR / f"zhiwuku-visit-{datetime.now():%Y%m%d-%H%M%S}.json"
            out.write_text(json.dumps(results, ensure_ascii=False, indent=2),
                           encoding="utf-8")
            log(f"明细已写入: {out}")

        if ARGS.no_pause:
            log("== 运行结束（--no-pause，不等待回车）==")
        else:
            input("浏览器保持打开，检查完成后回到终端按回车关闭...")
    finally:
        driver.quit()


if __name__ == "__main__":
    main()
