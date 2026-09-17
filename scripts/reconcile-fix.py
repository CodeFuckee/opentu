#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
对账修复脚本：处置「上游已计费、平台失败/卡死」的任务。

按可恢复性自动选择处置：
1. 异步任务且上游 new-api tasks 表有成功结果 → 下载产物转存 huabu bucket，
   task_submissions 置 completed（写 result/response_file_paths/completed_at），
   原始错误保留在 result.reconciled.original_error 里供审计；
2. 同步生图（上游不留存产物，结果不可找回）→ 平台预扣额度退回
   （refund_image_quota），任务保持 failed 并在 error.reconciled 写入对账标注；
   stuck 任务同样置为 failed，结束其 pending 状态。
3. 默认 dry-run：只打印处置计划；--apply 才真正改数据；--notify 推送钉钉汇总。

用法（服务器上）：
  python3 reconcile-fix.py --days 7            # 处置计划
  python3 reconcile-fix.py --days 7 --apply    # 执行
  python3 reconcile-fix.py --days 7 --apply --notify

注意：上游 new-api 侧的额度（chenkaidi 账号）如需退还，请在其管理后台人工操作，
本脚本只补偿平台侧。
退出码：0 正常；2 运行错误
"""

import argparse
import datetime
import json
import os
import shutil
import sqlite3
import subprocess
import sys
import tempfile
import urllib.request

BASE = "/home/mdc/codes/supabase"
REPORT = os.path.join(BASE, "reconcile-findings.json")
NEWAPI_DB = "/home/mdc/codes/new-api/data/one-api.db"
STORAGE_BASE = "http://localhost:8021/storage/v1/object"
PUBLIC_BASE = "http://10.37.80.25:8021/storage/v1/object/public"
BUCKET = "huabu"
LOG = os.path.join(BASE, "reconcile-fix.log")

REMOTE_ID_KEYS = ("remoteId", "remote_id", "upstreamId", "upstream_id",
                  "taskId", "task_id", "uid")


def run_psql(sql: str) -> str:
    out = subprocess.run(
        ["docker", "exec", "supabase-db", "psql", "-U", "supabase_admin",
         "-d", "postgres", "-tAc", sql],
        capture_output=True, text=True, timeout=120)
    if out.returncode != 0:
        raise RuntimeError(f"psql failed: {out.stderr.strip()[:300]}")
    return out.stdout.strip()


def service_role_key() -> str:
    out = subprocess.run(
        ["docker", "exec", "supabase-edge-functions", "env"],
        capture_output=True, text=True, timeout=30)
    for line in out.stdout.splitlines():
        if line.startswith(("SUPABASE_SERVICE_ROLE_KEY=",
                            "SERVICE_ROLE_KEY=")):
            return line.split("=", 1)[1].strip()
    raise RuntimeError("SERVICE_ROLE_KEY not found in edge-functions env")


def find_remote_id(task: dict, detail: dict) -> str | None:
    """从 params / upstream_response 里找上游异步任务 id（尽力而为）。"""
    candidates = [detail]
    for src_key in ("params", "upstream_response"):
        try:
            raw = json.loads(detail.get(src_key) or "null") \
                if isinstance(detail.get(src_key), str) else None
            if isinstance(raw, dict):
                candidates.append(raw)
                if isinstance(raw.get("data"), dict):
                    candidates.append(raw["data"])
        except Exception:
            continue
    for obj in candidates:
        if not isinstance(obj, dict):
            continue
        for key in REMOTE_ID_KEYS:
            val = obj.get(key)
            if isinstance(val, str) and val.startswith(("task_", "cgt-", "mj")):
                return val
    return None


def fetch_task_detail(task_id: str) -> dict:
    raw = run_psql(
        "SELECT coalesce(json_agg(t), '[]'::json)::text FROM (SELECT params, "
        "upstream_response FROM task_submissions "
        f"WHERE task_id='{task_id}') t")
    rows = json.loads(raw)
    return rows[0] if rows else {}


def lookup_upstream_task(remote_id: str) -> dict | None:
    tmp = tempfile.mktemp(prefix="na-fix-", suffix=".db")
    shutil.copy2(NEWAPI_DB, tmp)
    try:
        con = sqlite3.connect(f"file:{tmp}?mode=ro", uri=True)
        try:
            row = con.execute(
                "SELECT status, data FROM tasks WHERE task_id = ? "
                "ORDER BY created_at DESC LIMIT 1", (remote_id,)).fetchone()
        finally:
            con.close()
    finally:
        os.unlink(tmp)
    if not row or row[0] != "SUCCESS":
        return None
    try:
        return json.loads(row[1]) if isinstance(row[1], str) else (row[1] or {})
    except Exception:
        return None


def result_urls(data: dict) -> list:
    urls = []
    for key in ("video_url", "url", "image_url", "data_url"):
        val = data.get(key)
        if isinstance(val, str) and val.startswith("http"):
            urls.append(val)
    for item in data.get("results") or data.get("urls") or []:
        if isinstance(item, str) and item.startswith("http"):
            urls.append(item)
        elif isinstance(item, dict):
            u = item.get("url")
            if isinstance(u, str) and u.startswith("http"):
                urls.append(u)
    return urls


def get_tuzi_creds() -> tuple | None:
    """从 configs 读 tuzi 控制台凭证（TUZI_ACCESS_TOKEN / TUZI_USER_ID）。"""
    raw = run_psql(
        "SELECT coalesce(json_object_agg(key, value), '{}'::json)::text "
        "FROM configs WHERE key IN ('TUZI_ACCESS_TOKEN','TUZI_USER_ID')")
    cfg = json.loads(raw)
    token, uid = cfg.get("TUZI_ACCESS_TOKEN"), cfg.get("TUZI_USER_ID")
    return (token, uid) if token and uid else None


def tuzi_find_urls(upstream_request_id: str, bill_at: int, creds: tuple) -> list:
    """按 new-api 的 upstream_request_id 精确匹配 tuzi 日志，提取留存图片 URL。

    tuzi(New API 深度定制) 在 /api/log/self 行的 other 字段里留存
    generated_image_urls（image_storage_enabled=true），且其 request_id
    与 new-api 记录的 upstream_request_id 一致。"""
    if not upstream_request_id:
        return []
    token, uid = creds
    start = bill_at - 180
    end = bill_at + 180
    url = (f"https://api.tu-zi.com/api/log/self?p=1&page_size=100"
           f"&start_timestamp={start}&end_timestamp={end}")
    req = urllib.request.Request(
        url, headers={"Authorization": token, "New-Api-User": uid})
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            payload = json.loads(resp.read().decode())
    except Exception as exc:  # noqa: BLE001
        print(f"[warn] tuzi 日志查询失败: {exc}")
        return []
    data = payload.get("data") or {}
    items = data.get("items") if isinstance(data, dict) else data
    for row in items or []:
        if row.get("request_id") != upstream_request_id:
            continue
        try:
            other = json.loads(row.get("other") or "{}")
        except Exception:
            return []
        delivery = other.get("generated_image_delivery") or {}
        urls = [e.get("url") for e in delivery.get("entries") or []
                if isinstance(e, dict) and e.get("url")]
        if not urls:
            urls = other.get("generated_image_urls") or []
        if not urls and other.get("generated_image_url"):
            urls = [other["generated_image_url"]]
        return [u for u in urls if isinstance(u, str) and u.startswith("http")]
    return []


def ext_of(url: str) -> str:
    tail = url.split("?")[0].rsplit(".", 1)
    return tail[1][:5] if len(tail) == 2 and tail[1].isalnum() else "png"


def content_type_of(ext: str) -> str:
    return {
        "png": "image/png", "jpg": "image/jpeg", "jpeg": "image/jpeg",
        "webp": "image/webp", "gif": "image/gif",
    }.get(ext, "application/octet-stream")


def download_bytes(url: str, attempts: int = 3) -> bytes:
    """下载带重试：tuzi OSS 偶发掐断长下载（IncompleteRead）。"""
    import time
    last: Exception = RuntimeError("no attempt")
    for i in range(attempts):
        try:
            req = urllib.request.Request(
                url, headers={"User-Agent": "Mozilla/5.0 reconcile-fix"})
            with urllib.request.urlopen(req, timeout=180) as resp:
                return resp.read()
        except Exception as exc:  # noqa: BLE001
            last = exc
            time.sleep(2 * (i + 1))
    raise last


def upload_to_bucket(task_id: str, url: str, idx: int, srk: str,
                     folder: str) -> tuple:
    data = download_bytes(url)
    ext = ext_of(url)
    path = f"{folder}/reconciled-{task_id[:8]}-{idx}.{ext}"
    req = urllib.request.Request(
        f"{STORAGE_BASE}/{BUCKET}/{path}", data=data, method="PUT",
        headers={"Authorization": f"Bearer {srk}",
                 "Content-Type": content_type_of(ext)})
    with urllib.request.urlopen(req, timeout=120) as resp:
        if resp.status not in (200, 201):
            raise RuntimeError(f"storage upload http={resp.status}")
    return path, len(data)


def notify_dingtalk(text: str):
    try:
        webhook = run_psql(
            "SELECT value FROM configs WHERE key='DEV_DINGTALK_WEBHOOK'"
        ).strip().strip('"')
        if not webhook:
            return
        body = json.dumps({"msgtype": "markdown",
                           "markdown": {"title": "对账修复执行", "text": text}}
                          ).encode()
        req = urllib.request.Request(
            webhook, data=body, headers={"Content-Type": "application/json"})
        urllib.request.urlopen(req, timeout=15)
    except Exception as exc:  # noqa: BLE001
        print(f"[warn] 钉钉推送失败: {exc}")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--days", type=int, default=7)
    ap.add_argument("--apply", action="store_true",
                    help="真正执行（默认 dry-run 只打印计划）")
    ap.add_argument("--notify", action="store_true",
                    help="执行后推送钉钉汇总")
    args = ap.parse_args()

    out = subprocess.run(
        ["python3", os.path.join(BASE, "reconcile-upstream.py"),
         "--days", str(args.days), "--json"],
        capture_output=True, text=True, timeout=300)
    if out.returncode != 0:
        raise RuntimeError(f"对账脚本失败: {out.stderr.strip()[:300]}")
    findings = json.loads(out.stdout.strip().splitlines()[-1])

    targets = findings["billed_but_failed"] + findings["billed_but_stuck"]
    print(f"待处置任务: {len(targets)} 个（近 {args.days} 天，"
          f"疑似资损 {findings['loss_quota']}）\n")

    srk = service_role_key() if args.apply else ""
    tuzi_creds = get_tuzi_creds()
    if not tuzi_creds:
        print("[warn] configs 缺少 TUZI_ACCESS_TOKEN/TUZI_USER_ID，"
              "跳过 tuzi 结果回传，全部走退额路径")
    actions = []
    for t in targets:
        if t.get("reconciled"):
            print(f"[skip] {t['task_id'][:8]} 已标注 reconciled，跳过（防重复退款）")
            continue
        billed = sum(lg["quota"] for lg in t["logs"])
        detail = fetch_task_detail(t["task_id"])
        remote_id = find_remote_id(t, detail)
        upstream_task = lookup_upstream_task(remote_id) if remote_id else None
        urls = result_urls(upstream_task or {})
        recover_via = "upstream_tasks" if urls else None

        # tuzi 结果回传：按 new-api 流水的 upstream_request_id 精确匹配 tuzi 日志
        if not urls and tuzi_creds:
            for lg in t["logs"]:
                tuzi_urls = tuzi_find_urls(
                    lg.get("upstream_request_id", ""), lg["bill_at"], tuzi_creds)
                if tuzi_urls:
                    urls = tuzi_urls
                    recover_via = "tuzi"
                    break

        plan = {"task_id": t["task_id"], "model": t["model"],
                "status": t["status"], "user_id": t["user_id"],
                "billed": billed, "remote_id": remote_id,
                "recover_via": recover_via,
                "recoverable": bool(urls)}

        if urls:
            plan["action"] = "recover"
            plan["urls"] = urls
            if args.apply:
                try:
                    folder = "reconciled"
                    paths = []
                    for i, u in enumerate(urls):
                        path, size = upload_to_bucket(
                            t["task_id"], u, i, srk, folder)
                        paths.append((path, size, u))
                    first_path, first_size, first_url = paths[0]
                    # result.url 沿用平台惯例放源站 URL（huabu 桶非公开）；
                    # huabu 备份路径放 response_file_paths 走前端签名链路
                    meta = {"reconciled": {
                        "at": datetime.datetime.now().isoformat(
                            timespec="seconds"),
                        "action": "result_restored", "via": recover_via,
                        "source_url": first_url,
                        "huabu_paths": [p for p, _, _ in paths],
                        "upstream_quota": billed,
                        "original_error": (t.get("err") or "")[:200]}}
                    result = json.dumps(
                        {"url": first_url, "size": first_size,
                         "format": ext_of(first_url), **meta}
                    ).replace("'", "''")
                    paths_json = json.dumps(
                        [p for p, _, _ in paths]).replace("'", "''")
                    run_psql(
                        f"UPDATE task_submissions SET status='completed', "
                        f"result='{result}', response_file_paths='{paths_json}', "
                        f"completed_at=now(), updated_at=now(), error=NULL "
                        f"WHERE task_id='{t['task_id']}'")
                    plan["done"] = f"restored {len(paths)} file(s)"
                except Exception as exc:  # noqa: BLE001
                    plan["recover_error"] = (
                        f"{type(exc).__name__}: {exc}")[:200]
                    print(f"[warn] {t['task_id'][:8]} 恢复失败，转退额: "
                          f"{plan['recover_error']}")

        if not (urls and (not args.apply or plan.get("done"))):
            if not urls:
                reason = ("tuzi 无留存结果（或上游请求 id 缺失）" if tuzi_creds
                          else "上游不留存且未配置 tuzi 凭证")
            else:
                reason = ("恢复失败: " + plan.get("recover_error", ""))
            plan["action"] = "refund+annotate"
            plan["reason"] = reason
            if args.apply:
                run_psql(
                    f"SELECT refund_image_quota('{t['user_id']}', {int(t.get('n') or 1)})")
                new_status = "failed"
                meta = (json.dumps({"reconciled": {
                    "at": datetime.datetime.now().isoformat(timespec="seconds"),
                    "action": "quota_refunded",
                    "refunded_count": int(t.get("n") or 1),
                    "upstream_quota": billed, "reason": reason}}))
                err = run_psql(
                    f"SELECT coalesce(error::text, '{{}}') FROM task_submissions "
                    f"WHERE task_id='{t['task_id']}'").strip() or "{}"
                merged = json.dumps(
                    {**json.loads(err), **json.loads(meta)}).replace("'", "''")
                run_psql(
                    f"UPDATE task_submissions SET status='{new_status}', "
                    f"error='{merged}'::jsonb, updated_at=now() "
                    f"WHERE task_id='{t['task_id']}'")
                plan["done"] = (f"退回平台额度 {t.get('n', 1)}，状态置 {new_status}，"
                                f"已标注 reconciled")
        actions.append(plan)
        flag = "✓" if (not args.apply or plan.get("done")) else "·"
        print(f"[{flag}] {t['task_id'][:8]} {t['model']} [{t['status']}] "
              f"上游计费{billed} → {plan['action']}"
              + (f"（{plan.get('done', plan.get('reason', ''))}）"
                 if args.apply or plan.get("reason") else ""))

    summary_lines = [
        "### 🔧 对账修复" + ("（已执行）" if args.apply else "（计划预览，未执行）"),
        f"- 处置任务 {len(actions)} 个，疑似资损 {findings['loss_quota']}",
        f"- 恢复结果 {sum(1 for a in actions if a['action'] == 'recover')} 个 / "
        f"退额+标注 {sum(1 for a in actions if a['action'] == 'refund+annotate')} 个",
    ]
    print("\n".join(summary_lines))

    with open(LOG, "a", encoding="utf-8") as f:
        f.write(f"\n==== {datetime.datetime.now().isoformat(timespec='seconds')} "
                f"apply={args.apply} ====\n"
                + json.dumps(actions, ensure_ascii=False, indent=1) + "\n")
    if args.apply and args.notify:
        notify_dingtalk("\n".join(summary_lines))
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as exc:  # noqa: BLE001
        print(f"[error] {exc}", file=sys.stderr)
        sys.exit(2)
