#!/bin/bash
# WorkRelay 语音转录状态检查
# 返回值: 0=已启用, 1=未安装, 2=部分安装, 3=配置缺失
# 同时输出 JSON 给客户端解析

set -e

STATUS_OK=0
STATUS_NOT_INSTALLED=1
STATUS_PARTIAL=2
STATUS_CONFIG_MISSING=3

INSTALL_DIR="${WR_INSTALL_DIR:-$HOME/.workrelay/transcribe}"
MODEL_CACHE="${WR_WHISPER_CACHE:-$HOME/.cache/faster-whisper}"

checks=()

# 检查1: faster-whisper 包
check_dep=0
python3 -c "import faster_whisper" 2>/dev/null && check_dep=1 || true

# 检查2: 模型（small 模型 ~460MB，阈值从 500 降到 200，避免误报未下载）
check_model=0
if [ -d "$MODEL_CACHE" ]; then
  model_size=$(du -sm "$MODEL_CACHE" 2>/dev/null | cut -f1 || echo 0)
  [ "$model_size" -gt 200 ] && check_model=1
fi

# 检查3: 脚本
check_scripts=0
[ -f "$INSTALL_DIR/transcribe.py" ] && [ -f "$INSTALL_DIR/voicebox-transcribe.sh" ] && check_scripts=1

# 检查4: OpenClaw 配置（2026-09-14 openclaw 升级后：1) config 路径变更 audio.transcription.* → tools.media.models；2) 不再调 openclaw CLI——升级后 CLI 可能挂起卡住插件队列，改为直接读 openclaw.json，毫秒级返回）
check_config=0
OC_JSON="${OPENCLAW_HOME:-$HOME/.openclaw}/openclaw.json"
if [ -f "$OC_JSON" ]; then
  grep -q 'voicebox-transcribe' "$OC_JSON" && check_config=1 || true
fi

# ── 汇总状态 ──
total=$((check_dep + check_model + check_scripts + check_config))

case $total in
  4) status="enabled";  desc="语音转录已启用"; exit_code=$STATUS_OK ;;
  0) status="disabled"; desc="未安装";          exit_code=$STATUS_NOT_INSTALLED ;;
  *) status="partial";  desc="部分安装";        exit_code=$STATUS_PARTIAL ;;
esac

# ── 输出 JSON ──
cat <<EOF
{
  "status": "$status",
  "description": "$desc",
  "checks": {
    "faster_whisper": $([ $check_dep -eq 1 ] && echo true || echo false),
    "model": $([ $check_model -eq 1 ] && echo true || echo false),
    "scripts": $([ $check_scripts -eq 1 ] && echo true || echo false),
    "openclaw_config": $([ $check_config -eq 1 ] && echo true || echo false)
  }
}
EOF

exit $exit_code
