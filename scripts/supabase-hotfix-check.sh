#!/usr/bin/env bash
# ============================================================
# supabase 自托管热修复巡检脚本（检查 + 自动修复）
#
# 背景：opentu 生产 supabase（自托管）对模板默认值做过三处热修复，
# 但 volumes/ 下的文件在容器重建/镜像升级时会被官方模板静默覆盖。
# 本脚本在部署/升级后运行：发现漂移立即修复，并重启对应容器。
#
# 用法：
#   ./hotfix-check.sh               # 检查 + 自动修复（默认）
#   ./hotfix-check.sh --check-only  # 仅检查不修改，有漂移时退出码 1
#
# 巡检项与期望值（2026-09-15 / 2026-09-17 两次修复确立）：
#   1. volumes/functions/main/index.ts  memoryLimitMb    = 1024        （模板默认 150）
#   2. volumes/functions/main/index.ts  workerTimeoutMs  = 15*60*1000  （模板默认 60s）
#   3. volumes/api/envoy/lds.template.yaml  functions-v1-all 路由
#        timeout: 920s（模板默认 150s）+ stream_idle_timeout: 0s（模板无此行）
#
# 修复后需重启的容器：
#   index.ts 漂移  → supabase-edge-functions
#   envoy 模板漂移 → supabase-envoy
# ============================================================
set -u

SUPABASE_DIR="${SUPABASE_DIR:-/home/mdc/codes/supabase}"
MAIN_FILE="$SUPABASE_DIR/volumes/functions/main/index.ts"
ENVOY_FILE="$SUPABASE_DIR/volumes/api/envoy/lds.template.yaml"
LOG_FILE="$SUPABASE_DIR/hotfix-check.log"

EXPECT_MEM='const memoryLimitMb = 1024'
EXPECT_TIMEOUT='const workerTimeoutMs = 15 * 60 * 1000'
ENVOY_ROUTE='name: functions-v1-all'
ENVOY_RANGE="/${ENVOY_ROUTE}/,/request_headers_to_add/"   # sed 行范围（路由块内）
EXPECT_ENVOY_TIMEOUT='timeout: 920s'
EXPECT_ENVOY_IDLE='stream_idle_timeout: 0s'

CHECK_ONLY=0
[[ "${1:-}" == "--check-only" ]] && CHECK_ONLY=1

ok=0; fixed=0; broken=0
declare -a restart_containers=()

say() { echo "$@"; }
block_grep() {  # 在 functions-v1-all 路由块内 grep
  sed -n "$ENVOY_RANGE p" "$ENVOY_FILE" | grep -q "$1"
}

# ---------- 检查函数：返回 0=正常 1=漂移 ----------
check_main_mem()      { grep -q "$EXPECT_MEM" "$MAIN_FILE"; }
check_main_timeout()  { grep -qF "$EXPECT_TIMEOUT" "$MAIN_FILE"; }
check_envoy_timeout() { block_grep '^ *timeout: 920s'; }
check_envoy_idle()    { block_grep "$EXPECT_ENVOY_IDLE"; }

# ---------- 修复函数 ----------
fix_main_mem() {
  sed -i 's/const memoryLimitMb = .*/const memoryLimitMb = 1024/' "$MAIN_FILE"
}
fix_main_timeout() {
  sed -i 's/const workerTimeoutMs = .*/const workerTimeoutMs = 15 * 60 * 1000/' "$MAIN_FILE"
}
fix_envoy_timeout() {
  # 行首锚定（缩进+timeout:），避免误匹配 stream_idle_timeout 行
  sed -i "$ENVOY_RANGE s/^\( *\)timeout: [0-9][0-9]*s/\1timeout: 920s/" "$ENVOY_FILE"
}
fix_envoy_idle() {
  if block_grep 'stream_idle_timeout:'; then
    # 行存在但值不对 → 块内改值
    sed -i "$ENVOY_RANGE s/stream_idle_timeout: .*/stream_idle_timeout: 0s/" "$ENVOY_FILE"
  else
    # 行不存在 → 取块内 timeout 行的缩进，在其后插入
    local indent
    indent=$(sed -n "$ENVOY_RANGE p" "$ENVOY_FILE" | grep -m1 -E '^ *timeout: ' | sed 's/timeout:.*$//')
    sed -i "$ENVOY_RANGE {/timeout: 920s/s/timeout: 920s/timeout: 920s\\n${indent}stream_idle_timeout: 0s/}" "$ENVOY_FILE"
  fi
}

# ---------- 单项处理：检查（+ 修复 + 复检） ----------
# $1 名称  $2 检查函数名  $3 修复函数名  $4 需重启的容器（空=无需重启）
handle_item() {
  local name="$1" check_fn="$2" fix_fn="$3" container="$4"
  if ! "$check_fn"; then
    if [[ $CHECK_ONLY -eq 1 ]]; then
      say "  [漂移] $name（--check-only 未修复）"
      broken=$((broken+1))
      return
    fi
    if "$fix_fn" && "$check_fn"; then
      say "  [已修复] $name"
      fixed=$((fixed+1))
      [[ -n "$container" ]] && restart_containers+=("$container")
    else
      say "  [修复失败!] $name —— 修复后复检仍不通过，需人工检查"
      broken=$((broken+1))
    fi
  else
    say "  [正常] $name"
    ok=$((ok+1))
  fi
}

say "==== supabase 热修复巡检 $(date '+%F %T') ===="
say "模式: $([[ $CHECK_ONLY -eq 1 ]] && echo '仅检查' || echo '检查+自动修复')"

if [[ ! -f "$MAIN_FILE" || ! -f "$ENVOY_FILE" ]]; then
  say "[严重] 目标文件缺失（volumes 可能被重新初始化）："
  [[ ! -f "$MAIN_FILE" ]]  && say "  缺少 $MAIN_FILE"
  [[ ! -f "$ENVOY_FILE" ]] && say "  缺少 $ENVOY_FILE"
  say "请先恢复文件再运行本脚本（备份: main/index.ts.bak-*）"
  exit 1
fi

say "main/index.ts:"
handle_item "memoryLimitMb = 1024"           check_main_mem      fix_main_mem      "supabase-edge-functions"
handle_item "workerTimeoutMs = 15 分钟"       check_main_timeout  fix_main_timeout  "supabase-edge-functions"
say "envoy lds.template.yaml (functions-v1-all):"
handle_item "timeout: 920s"                  check_envoy_timeout fix_envoy_timeout "supabase-envoy"
handle_item "stream_idle_timeout: 0s"        check_envoy_idle    fix_envoy_idle    "supabase-envoy"

# ---------- 重启受影响容器（有修复才重启） ----------
if [[ $CHECK_ONLY -eq 0 && ${#restart_containers[@]} -gt 0 ]]; then
  unique=($(printf '%s\n' "${restart_containers[@]}" | sort -u))
  for c in "${unique[@]}"; do
    say "重启容器: $c ..."
    docker restart "$c" >/dev/null
  done
  sleep 8
  for c in "${unique[@]}"; do
    local_status=$(docker ps --filter "name=$c" --format '{{.Status}}')
    say "容器状态: $c → $local_status"
  done
fi

# ---------- 汇总 ----------
summary="结果: 正常 $ok / 修复 $fixed / 异常 $broken"
say "$summary"
echo "$(date '+%F %T') mode=$([[ $CHECK_ONLY -eq 1 ]] && echo check-only || echo fix) ok=$ok fixed=$fixed broken=$broken" >> "$LOG_FILE"

if [[ $broken -gt 0 ]]; then
  say "存在未解决的漂移，请人工介入！"
  exit 1
fi
say "全部通过。"
exit 0
