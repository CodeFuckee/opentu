#!/usr/bin/env bash
# yue-image MCP 服务器全链路冒烟（对已部署的生产容器执行）
#
# 用法：
#   scripts/smoke-image-mcp-server.sh                  # 本机直连部署宿主机
#   scripts/smoke-image-mcp-server.sh http://127.0.0.1:8301   # 在宿主机上冒烟
#
# 步骤：initialize → tools/list → check_quota → generate_image 一张（花 1 配额）
# 依赖：curl、node ≥18（构造 JSON 与解析）
set -euo pipefail

BASE=${1:-http://10.0.0.220:8301}
TOKEN=${MCP_AUTH_TOKEN:-}
if [ -z "${TOKEN}" ]; then
  echo "需要 MCP_AUTH_TOKEN 环境变量（与部署 ~/image-mcp.env 中一致）"
  exit 1
fi

call_mcp() {
  # $1=method $2=params $3=id；返回 JSON 响应（enableJsonResponse，纯 JSON）
  node --input-type=module -e '
    const [base, token, method, params, id] = process.argv.slice(1);
    const res = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        jsonrpc: "2.0", id: Number(id), method,
        ...(method === "initialize" ? { params: JSON.parse(params) } : params ? { params: JSON.parse(params) } : {}),
      }),
    });
    if (!res.ok) { console.error(`HTTP ${res.status}: ${await res.text()}`); process.exit(1); }
    const json = await res.json();
    if (json.error) { console.error(`MCP error: ${JSON.stringify(json.error)}`); process.exit(1); }
    console.log(JSON.stringify(json.result));
  ' "${BASE}" "${TOKEN}" "$1" "${2:-}" "${3:-0}"
}

echo "== 1/4 initialize =="
INIT_PARAMS='{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"smoke","version":"0"}}'
SERVER_INFO=$(call_mcp initialize "${INIT_PARAMS}" 1)
echo "${SERVER_INFO}" | node --input-type=module -e 'const d=JSON.parse((await import("node:fs")).readFileSync(0));console.log("serverInfo:", d.serverInfo.name, d.serverInfo.version)'

echo "== 2/4 tools/list =="
TOOLS=$(call_mcp tools/list "{}" 2)
echo "${TOOLS}" | node --input-type=module -e 'const d=JSON.parse((await import("node:fs")).readFileSync(0));console.log("tools:", d.tools.map(t=>t.name).join(", "))'

echo "== 3/4 check_quota =="
QUOTA=$(call_mcp tools/call '{"name":"check_quota","arguments":{}}' 3)
echo "${QUOTA}" | node --input-type=module -e '
  const d=JSON.parse((await import("node:fs")).readFileSync(0));
  const payload=JSON.parse(d.content[0].text);
  if (!payload.success) throw new Error(payload.error);
  console.log("quota:", JSON.stringify(payload.quota));'

echo "== 4/4 generate_image（真实生图，花 1 配额）=="
GEN=$(call_mcp tools/call '{"name":"generate_image","arguments":{"prompt":"a tiny cute robot mascot, flat vector style, simple background","size":"1x1"}}' 4)
echo "${GEN}" | node --input-type=module -e '
  const d=JSON.parse((await import("node:fs")).readFileSync(0));
  if (d.isError) throw new Error(JSON.parse(d.content[0].text).error);
  const payload=JSON.parse(d.content[0].text);
  if (!payload.success) throw new Error(payload.error);
  const img=payload.images[0];
  console.log("task_id:", payload.task_id);
  console.log("model:", payload.model, "archived:", img.archived);
  console.log("url:", img.url);
  const res = await fetch(img.url, { method: "HEAD" });
  if (!res.ok) throw new Error(`直链不可访问: HTTP ${res.status}`);
  console.log(`直链校验 OK (HTTP ${res.status})`);'

echo "== 冒烟全部通过 =="
