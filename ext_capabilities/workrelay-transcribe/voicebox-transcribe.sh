#!/bin/bash
# WorkRelay 语音转录桥接脚本
# 优先本地 faster-whisper 常驻服务（模型常驻内存，免重复加载），服务不可用时回退直接转写
# 环境变量：
#   WR_WHISPER_HOST   - 常驻服务地址（默认 127.0.0.1）
#   WR_WHISPER_PORT   - 常驻服务端口（默认 17890）
#   WR_WHISPER_MODEL  - 本地模型名（默认 small）
#   WR_FALLBACK_URL   - 远程转录服务 URL（可选，不设则仅本地）

set -e

AUDIO_FILE="$1"
SCRIPT_DIR="$(dirname "$(readlink -f "$0")")"

if [ ! -f "$AUDIO_FILE" ]; then
  echo "ERROR: audio file not found: $AUDIO_FILE" >&2
  exit 1
fi

WH_HOST="${WR_WHISPER_HOST:-127.0.0.1}"
WH_PORT="${WR_WHISPER_PORT:-17890}"

# ── 第1步：常驻服务（模型常驻内存，转写快）──
result=$(curl -s --connect-timeout 2 --max-time 60 \
  -X POST "http://${WH_HOST}:${WH_PORT}/transcribe" \
  -F "file=@${AUDIO_FILE}" 2>/dev/null)
if [ -n "$result" ]; then
  text=$(echo "$result" | python3 -c "
import sys, json
try:
    data = json.load(sys.stdin)
    if data.get('text'):
        print(data['text'].strip())
    else:
        print('ERROR: ' + str(data.get('error', 'unknown')))
except Exception:
    print('ERROR: bad response')
" 2>/dev/null)
  if [ -n "$text" ] && [[ "$text" != ERROR:* ]]; then
    echo "$text"
    exit 0
  fi
fi

# ── 第2步：直接本地 faster-whisper（常驻服务未启动时的回退）──
result=$(python3 "$SCRIPT_DIR/transcribe.py" "$AUDIO_FILE" 2>/tmp/wr-transcribe-err.log)
exit_code=$?

if [ $exit_code -eq 0 ] && [ -n "$result" ]; then
  # 排除以 ERROR: 开头的输出（有些 Python 错误仍返回 exit 0）
  if [[ "$result" != ERROR:* ]]; then
    echo "$result"
    exit 0
  fi
fi

# 本地失败日志
cat /tmp/wr-transcribe-err.log >&2
rm -f /tmp/wr-transcribe-err.log

# ── 第3步：远程 fallback（如果配置了） ──
if [ -n "${WR_FALLBACK_URL:-}" ]; then
  result=$(curl -s --connect-timeout 5 --max-time 60 \
    -X POST "$WR_FALLBACK_URL" \
    -F "file=@${AUDIO_FILE}" \
    -F "language=zh" 2>&1)

  # 尝试解析 JSON 响应
  text=$(echo "$result" | python3 -c "
import sys, json
try:
    data = json.load(sys.stdin)
    for key in ('text','transcript','result'):
        if data.get(key):
            print(data[key].strip())
            break
except:
    pass
" 2>/dev/null)

  if [ -n "$text" ]; then
    echo "$text"
    exit 0
  fi
fi

echo "ERROR: transcription failed (local whisper + remote fallback both failed)" >&2
exit 1
