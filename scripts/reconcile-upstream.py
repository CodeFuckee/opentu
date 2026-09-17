#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
平台(new-api token: huabu) ↔ 上游 new-api 计费对账

背景：平台任务可能因网关自身故障失败（ai-proxy worker 被杀/超时等），但上游
new-api 已完成生成并计费 → 「上游成功、平台失败」的隐性资损，人工难以发现。
本脚本周期性对账两类账本：
  - 平台账：supabase task_submissions（任务状态/失败原因）
  - 上游账：new-api SQLite logs 表（type=2 计费流水）

匹配锚点：上游请求开始时间 = created_at - use_time，必须落在平台任务的存活
区间内（任务创建后才会发出请求；任务死亡后不可能再发出新请求），同模型即候选，
按开始时间最近贪心 1:1 配对。

分类：
  billed_but_failed   上游已计费 + 平台 failed        → 疑似资损（重点）
  billed_but_stuck    上游已计费 + 平台长时间 submitted → 疑似资损（重点）
  billed_but_ok       上游已计费 + 平台成功           → 正常（仅计数）
  fail_no_bill        平台失败 + 上游无账             → 网关自伤，无上游资损
  bill_no_task        上游有账、平台无任务可配        → 待人工核查（可能丢任务记录）

用法（在服务器上运行）：
  python3 reconcile-upstream.py [--days 2] [--always-notify] [--dry-run]
  --days N        对账最近 N 天（默认 2）
  --always-notify 无发现也发钉钉（默认仅有发现时发）
  --dry-run       不发钉钉、不写状态，只打印
退出码：0 正常；2 运行错误
"""

import argparse
import json
import os
import shutil
import sqlite3
import subprocess
import sys
import tempfile
import urllib.request
from datetime import datetime

# ---------- 固定拓扑（本机自托管） ----------
PLATFORM_TOKEN_USER = "chenkaidi"   # 平台流量在 new-api 的归属账号
PLATFORM_TOKEN_NAME = "huabu"       # 平台专用 token 名
NEWAPI_DB = "/home/mdc/codes/new-api/data/one-api.db"
QUOTA_PER_UNIT = 500000             # new-api 默认：500000 quota = $1

# 匹配容差（秒）：上游开始时间 ∈ [task.created - T0, task.ended + T1]
TOL_BEFORE = 15
TOL_AFTER = 60
# submitted 任务超过该秒数仍未终态才视为 stuck（异步任务有合法长耗时）
STUCK_AFTER_S = 2 * 3600

BASE = "/home/mdc/codes/supabase"
STATE_FILE = os.path.join(BASE, "reconcile-state.json")
REPORT_LOG = os.path.join(BASE, "reconcile-report.log")


def run_psql(sql: str) -> str:
    out = subprocess.run(
        ["docker", "exec", "supabase-db", "psql", "-U", "supabase_admin",
         "-d", "postgres", "-tAc", sql],
        capture_output=True, text=True, timeout=120,
    )
    if out.returncode != 0:
        raise RuntimeError(f"psql failed: {out.stderr.strip()[:300]}")
    return out.stdout.strip()


def fetch_platform_tasks(days: int) -> list:
    """拉取平台任务（含成功，供完整配对），时间统一 epoch 秒。

    days 额外 +1 天：避免窗口边界切割造成「任务已出窗、上游账仍在窗内」的
    假阳性（bill_no_task）。"""
    sql = f"""
    SELECT coalesce(json_agg(t), '[]'::json) FROM (
      SELECT task_id,
             user_id,
             type,
             status,
             params->>'model' AS model,
             coalesce((params->>'n')::int, 1) AS n,
             extract(epoch from created_at)::bigint AS created,
             extract(epoch from coalesce(completed_at, updated_at))::bigint AS ended,
             (error ? 'reconciled') AS reconciled,
             left(replace(replace(coalesce(error::text, ''), chr(10), ' '),
                  chr(9), ' '), 200) AS err
      FROM task_submissions
      WHERE created_at > now() - interval '{int(days)} days'
    ) t"""
    return json.loads(run_psql(sql)) or []


def fetch_upstream_logs(since_epoch: int) -> list:
    """拷贝 new-api SQLite 后只读查询（避免锁）。"""
    tmp = tempfile.mktemp(prefix="newapi-reconcile-", suffix=".db")
    shutil.copy2(NEWAPI_DB, tmp)
    try:
        con = sqlite3.connect(f"file:{tmp}?mode=ro", uri=True)
        try:
            rows = con.execute(
                """SELECT id, created_at, use_time, model_name, quota,
                          channel_name, content
                   FROM logs
                   WHERE username = ? AND token_name = ? AND type = 2
                     AND created_at >= ?
                   ORDER BY created_at""",
                (PLATFORM_TOKEN_USER, PLATFORM_TOKEN_NAME, since_epoch),
            ).fetchall()
        finally:
            con.close()
    finally:
        os.unlink(tmp)
    return [
        {
            "log_id": r[0], "bill_at": r[1], "use_time": r[2],
            "model": r[3], "quota": r[4], "channel": r[5] or "",
            "content": (r[6] or "")[:80],
            "start": r[1] - (r[2] or 0),  # 上游请求开始时间
        }
        for r in rows
    ]


def match(tasks: list, logs: list) -> None:
    """同模型 + 上游开始时间落在任务区间内 → 候选；按开始时间差贪心 1:1。"""
    for lg in logs:
        best = None
        for t in tasks:
            if t["model"] != lg["model"]:
                continue
            if not (t["created"] - TOL_BEFORE <= lg["start"] <= t["ended"] + TOL_AFTER):
                continue
            diff = abs(lg["start"] - t["created"])
            if best is None or diff < best[0]:
                best = (diff, t)
        if best:
            best[1].setdefault("logs", []).append(lg)


def usd(quota: int) -> str:
    return f"${quota / QUOTA_PER_UNIT:.2f}"


def fmt_row(t, lg) -> str:
    t0 = datetime.fromtimestamp(t["created"]).strftime("%m-%d %H:%M:%S")
    dur = t["ended"] - t["created"]
    sig = ""
    err = t.get("err") or ""
    for key in ("WorkerRequestCancelled", "stream timeout", "504", "timeout"):
        if key in err:
            sig = key
            break
    if not sig and err:
        sig = err[:40]
    lgq = f"上游计费 {lg['quota']}({usd(lg['quota'])})" if lg else "上游无账"
    return (f"- 任务 `{t['task_id'][:8]}` {t['model']} | {t0} 用时{dur}s | "
            f"平台[{t['status']}] {sig} | {lgq}")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--days", type=int, default=2)
    ap.add_argument("--always-notify", action="store_true")
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--json", action="store_true",
                    help="输出 JSON 发现清单（供 reconcile-fix.py 消费），"
                         "不推送钉钉、不写状态")
    args = ap.parse_args()

    now = int(datetime.now().timestamp())
    since = now - args.days * 86400

    tasks = fetch_platform_tasks(args.days + 1)
    logs = fetch_upstream_logs(since - 900)  # 上游账多取15分钟避免边界丢账
    logs = [lg for lg in logs if lg["bill_at"] >= since - 900]

    # stuck：submitted 且 updated_at 距今超阈值（ succeeded/failed 均为终态 ）
    for t in tasks:
        t["stuck"] = t["status"] == "submitted" and (now - t["ended"]) > STUCK_AFTER_S
        t.setdefault("logs", [])

    match(tasks, logs)

    billed_but_failed = [t for t in tasks if t["status"] == "failed" and t["logs"]]
    billed_but_stuck = [t for t in tasks if t["stuck"] and t["logs"]]
    fail_no_bill = [t for t in tasks if t["status"] == "failed" and not t["logs"]]
    ok_matched = [t for t in tasks if t["status"] not in ("failed",) and not t["stuck"] and t["logs"]]
    matched_log_ids = {lg["log_id"] for t in tasks for lg in t["logs"]}
    bill_no_task = [lg for lg in logs if lg["log_id"] not in matched_log_ids]

    total_tasks = len(tasks)
    total_quota = sum(lg["quota"] for lg in logs)
    loss_quota = sum(lg["quota"] for t in billed_but_failed + billed_but_stuck for lg in t["logs"])

    # 机器可读输出（供 reconcile-fix.py 消费）：不推送、不写状态
    if args.json:
        def task_json(t: dict) -> dict:
            return {
                "task_id": t["task_id"], "user_id": t["user_id"],
                "type": t["type"], "status": t["status"], "model": t["model"],
                "n": t.get("n", 1), "created": t["created"], "ended": t["ended"],
                "err": t.get("err", ""), "stuck": t["stuck"],
                "reconciled": t.get("reconciled", False), "logs": t["logs"],
            }
        print(json.dumps({
            "generated_at": datetime.now().isoformat(timespec="seconds"),
            "days": args.days,
            "billed_but_failed": [task_json(t) for t in billed_but_failed],
            "billed_but_stuck": [task_json(t) for t in billed_but_stuck],
            "fail_no_bill": [task_json(t) for t in fail_no_bill],
            "bill_no_task": bill_no_task,
            "ok_matched_count": len(ok_matched),
            "total_quota": total_quota,
            "loss_quota": loss_quota,
        }, ensure_ascii=False))
        return 0

    lines = [
        f"对账窗口: 近 {args.days} 天（截至 "
        f"{datetime.now().strftime('%m-%d %H:%M')}）",
        f"平台任务 {total_tasks} | 上游计费 {len(logs)} 笔共 {total_quota}({usd(total_quota)})",
        "",
        f"❗上游已计费但平台失败: {len(billed_but_failed)} 个，疑似资损 {loss_quota}({usd(loss_quota)})",
        f"❗上游已计费但平台卡死: {len(billed_but_stuck)} 个",
        f"⚠ 上游有账、平台无任务可配: {len(bill_no_task)} 笔",
        f"○ 平台失败、上游无账(网关自伤无资损): {len(fail_no_bill)} 个",
        f"✓ 正常配对成功: {len(ok_matched)} 个",
    ]

    detail = []
    for t in billed_but_failed[:10]:
        detail.append(fmt_row(t, t["logs"][0]))
    for t in billed_but_stuck[:5]:
        detail.append(fmt_row(t, t["logs"][0]))
    for lg in bill_no_task[:5]:
        t0 = datetime.fromtimestamp(lg["bill_at"]).strftime("%m-%d %H:%M")
        detail.append(f"- 流水 `{lg['log_id']}` {lg['model']} | {t0} | "
                      f"{lg['quota']}({usd(lg['quota'])}) | {lg['content']}")
    if detail:
        lines.append("")
        lines.append("明细（疑似资损/卡死/无任务）:")
        lines.extend(detail)

    summary = "\n".join(lines)
    print(summary)

    with open(REPORT_LOG, "a", encoding="utf-8") as f:
        f.write(f"\n==== {datetime.now().isoformat(timespec='seconds')} "
                f"days={args.days} ====\n{summary}\n")

    has_findings = bool(billed_but_failed or billed_but_stuck or bill_no_task)

    # 钉钉去重：只报新发现（state 记录已通知的 task/log 标识）
    state = {"notified": []}
    if os.path.exists(STATE_FILE):
        try:
            with open(STATE_FILE, encoding="utf-8") as f:
                state = json.load(f)
        except Exception:
            pass
    seen = set(state.get("notified", []))
    fresh = []
    for t in billed_but_failed + billed_but_stuck:
        if t["task_id"] not in seen:
            fresh.append(t)
    fresh_log_ids = {lg["log_id"] for lg in bill_no_task} - seen
    fresh_bill_no_task = [lg for lg in bill_no_task if lg["log_id"] in fresh_log_ids]

    if not args.dry_run:
        state["notified"] = sorted(
            seen
            | {t["task_id"] for t in billed_but_failed + billed_but_stuck}
            | fresh_log_ids
        )[-2000:]
        with open(STATE_FILE, "w", encoding="utf-8") as f:
            json.dump(state, f)

    if (has_findings and fresh) or args.always_notify:
        try:
            webhook = run_psql(
                "SELECT value FROM configs WHERE key='DEV_DINGTALK_WEBHOOK'"
            ).strip().strip('"')
        except Exception as e:
            print(f"[warn] 读取钉钉 webhook 失败: {e}")
            webhook = ""
        fresh_loss = sum(lg["quota"] for t in fresh if t.get("logs") for lg in t["logs"])
        md = [
            f"### 🔍 平台↔上游对账（近 {args.days} 天）",
            f"- ❗疑似资损(新发现): **{len(fresh)}** 个任务，约 {fresh_loss}({usd(fresh_loss)})",
            f"- 上游有账无任务: {len(fresh_bill_no_task)} 笔",
            f"- 平台失败上游无账: {len(fail_no_bill)} 个（无资损）",
            "",
            "```",
            *lines[2:14],
            "```",
        ]
        if webhook:
            if args.dry_run:
                print(f"[dry-run] 将推送钉钉: {md[0]}")
            else:
                body = json.dumps({
                    "msgtype": "markdown",
                    "markdown": {"title": "平台↔上游对账发现",
                                 "text": "\n".join(md)},
                }).encode()
                req = urllib.request.Request(
                    webhook, data=body,
                    headers={"Content-Type": "application/json"})
                try:
                    with urllib.request.urlopen(req, timeout=15) as resp:
                        print(f"[钉钉] 推送完成 http={resp.status}")
                except Exception as e:
                    print(f"[warn] 钉钉推送失败: {e}")
        else:
            print("[warn] 未配置 DEV_DINGTALK_WEBHOOK，跳过推送")
    else:
        print("[钉钉] 无新发现，未推送")

    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as exc:  # noqa: BLE001
        print(f"[error] {exc}", file=sys.stderr)
        sys.exit(2)
