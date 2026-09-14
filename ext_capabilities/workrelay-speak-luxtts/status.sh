#!/bin/bash
# WorkRelay 语音合成（LuxTTS 克隆声）状态检查
# 返回值: 0=已启用, 1=未安装, 2=部分安装, 3=Docker未运行
# 同时输出 JSON 给客户端解析
# 2026-08-15 新增能力：独立容器 voicebox-luxtts + 端口 17601 + provider tts-local-cli-luxtts

set -e

STATUS_OK=0
STATUS_NOT_INSTALLED=1
STATUS_PARTIAL=2
STATUS_DOCKER_DOWN=3

VB_HOST="${WR_VOICEBOX_HOST:-127.0.0.1}"
VB_PORT="${WR_VOICEBOX_LUXTTS_PORT:-17601}"
VB_DOCKER_PORT="${WR_VOICEBOX_LUXTTS_PORT:-17601}"

export PATH="$PATH:/snap/bin:/usr/local/bin"
# 2026-08-18：与 install.sh 保持一致的 docker 权限自适应（sg docker / 免密 sudo）
if ! docker info &>/dev/null 2>&1; then
  if sg docker -c "docker info" &>/dev/null 2>&1; then
    docker() { sg docker -c "docker $(printf '%q ' "$@")"; }
  elif sudo -n docker info &>/dev/null 2>&1; then
    docker() { sudo docker "$@"; }
  fi
fi

# 检测实际端口（17601，fallback 同端口）
check_port=$VB_PORT
curl -s --max-time 2 "http://${VB_HOST}:${VB_PORT}/mcp" >/dev/null 2>&1 && check_port=$VB_PORT || {
  curl -s --max-time 2 "http://${VB_HOST}:${VB_DOCKER_PORT}/mcp" >/dev/null 2>&1 && check_port=$VB_DOCKER_PORT
}

# 检查1: Docker
check_docker=0
docker info &>/dev/null 2>&1 && check_docker=1 || true

# 检查2: voicebox-luxtts 容器
check_container=0
docker ps --format '{{.Names}}' 2>/dev/null | grep -q "voicebox-luxtts" && check_container=1 || true

# 检查3: API
check_api=0
curl -s --max-time 3 "http://${VB_HOST}:${check_port}/mcp" >/dev/null 2>&1 && check_api=1 || true

# 检查4: TTS 桥接脚本
check_tts_script=0
[ -f "$HOME/.workrelay/speak-luxtts/workrelay-tts.sh" ] && check_tts_script=1 || true

# 检查5: 克隆声音 profile
check_profile=0
[ -f "$HOME/.workrelay/speak-luxtts/profile_id" ] && check_profile=1 || true

# 检查6: OpenClaw TTS 配置（2026-09-14 openclaw 升级后：config 路径 messages.tts.* → 顶层 tts.*；
# 不再调 openclaw CLI（升级后可能挂起卡插件队列），改为直接读 openclaw.json）
# 2026-09-14 互斥判定：仅当 tts.provider == tts-local-cli-luxtts 时才算"已启用"（TTS 只能启用一个）
check_config=0
check_provider=0
OC_JSON="${OPENCLAW_HOME:-$HOME/.openclaw}/openclaw.json"
if [ -f "$OC_JSON" ]; then
  grep -q '"tts-local-cli-luxtts":' "$OC_JSON" && check_config=1 || true
  CUR_PROVIDER=$(python3 -c '
import json,sys
try:
    c=json.load(open(sys.argv[1]))
    print((c.get("tts") or {}).get("provider",""))
except Exception:
    print("")
' "$OC_JSON" 2>/dev/null)
  [ "$CUR_PROVIDER" = "tts-local-cli-luxtts" ] && check_provider=1 || true
fi

# ── 汇总状态 ──
total=$((check_docker + check_container + check_api + check_tts_script + check_profile + check_config))

case $total in
  6)
    # 2026-09-14 互斥：安装齐全后再看 provider 是否指向本引擎
    if [ "$check_provider" -eq 1 ]; then
      status="enabled";   desc="语音合成（LuxTTS 克隆声）已启用"; exit_code=$STATUS_OK
    else
      status="disabled";  desc="已安装但未启用（当前语音合成为其它引擎，TTS 只能启用一个）"; exit_code=$STATUS_NOT_INSTALLED
    fi
    ;;
  0) status="disabled";  desc="未安装";          exit_code=$STATUS_NOT_INSTALLED ;;
  *)
    if [ "$check_container" -eq 0 ] && [ "$check_docker" -eq 1 ]; then
      status="disabled"; desc="Docker 运行中但 voicebox-luxtts 未安装"; exit_code=$STATUS_NOT_INSTALLED
    elif [ "$check_container" -eq 1 ] && [ "$check_api" -eq 0 ]; then
      status="partial"; desc="voicebox-luxtts 容器存在但 API 未就绪（可能在下载模型）"; exit_code=$STATUS_DOCKER_DOWN
    else
      status="partial"; desc="部分安装"; exit_code=$STATUS_PARTIAL
    fi
    ;;
esac

# ── 输出 JSON ──
cat <<EOF
{
  "status": "$status",
  "description": "$desc",
  "endpoint": "http://${VB_HOST}:${check_port}",
  "checks": {
    "docker": $( [ $check_docker -eq 1 ] && echo true || echo false ),
    "container": $( [ $check_container -eq 1 ] && echo true || echo false ),
    "api": $( [ $check_api -eq 1 ] && echo true || echo false ),
    "tts_script": $( [ $check_tts_script -eq 1 ] && echo true || echo false ),
    "profile": $( [ $check_profile -eq 1 ] && echo true || echo false ),
    "openclaw_config": $( [ $check_config -eq 1 ] && echo true || echo false ),
    "provider_active": $( [ $check_provider -eq 1 ] && echo true || echo false )
  }
}
EOF

exit $exit_code
