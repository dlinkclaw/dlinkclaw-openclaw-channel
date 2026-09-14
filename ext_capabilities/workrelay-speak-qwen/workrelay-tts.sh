#!/bin/bash
# WorkRelay TTS 桥接脚本（千问 Qwen3-TTS 引擎）
# 调用本地 Voicebox (voicebox-qwen, 端口 17602) REST API
# 环境变量：
#   WR_VOICEBOX_QWEN_PORT  - 千问实例端口（默认 17602，独立于 Kokoro 17493/17600、LuxTTS 17601）
#   WR_VOICEBOX_PROFILE_ID - 声音 profile ID（可选，缺省读取 ~/.workrelay/speak-qwen/profile_id）
#   WR_VOICEBOX_LANG       - 语言（默认 zh）
# 2026-09-14 新增：千问 Qwen3-TTS 能力，固定引擎 qwen_custom_voice（预设音色）
set -e

TEXT="$1"
OUT="$2"

if [ -z "$TEXT" ] || [ -z "$OUT" ]; then
  echo "usage: $0 <text> <output_path>" >&2
  exit 1
fi

VB_HOST="${WR_VOICEBOX_HOST:-127.0.0.1}"
VB_PORT="${WR_VOICEBOX_QWEN_PORT:-17602}"
PROFILE_ID="${WR_VOICEBOX_PROFILE_ID:-}"
# 固定引擎：千问预设音色引擎
ENGINE="qwen_custom_voice"
LANG="${WR_VOICEBOX_LANG:-zh}"

BASE_URL="http://${VB_HOST}:${VB_PORT}"
if ! curl -s --max-time 2 "${BASE_URL}/mcp" >/dev/null 2>&1; then
  echo "ERROR: Voicebox (千问) API 不可达 ($VB_HOST:$VB_PORT)" >&2
  exit 1
fi

# ── profile 自动解析（install.sh 写入千问预设音色 profile id）──
if [ -z "$PROFILE_ID" ] && [ -f "$HOME/.workrelay/speak-qwen/profile_id" ]; then
  PROFILE_ID=$(cat "$HOME/.workrelay/speak-qwen/profile_id" 2>/dev/null | tr -d ' \n')
fi
if [ -z "$PROFILE_ID" ]; then
  # 兜底：从 /profiles 找千问预设 profile（优先中文女声 Vivian）
  PROFILE_ID=$(curl --noproxy '*' -s --max-time 5 "$BASE_URL/profiles" 2>/dev/null \
    | python3 -c '
import json,sys
out=""
try:
    d=json.load(sys.stdin)
    for p in d:
        if p.get("preset_engine")=="qwen_custom_voice" and p.get("language")=="zh":
            out=p.get("id",""); break
    if not out:
        for p in d:
            if p.get("preset_engine")=="qwen_custom_voice":
                out=p.get("id",""); break
    print(out)
except Exception:
    print("")
' 2>/dev/null)
fi
if [ -z "$PROFILE_ID" ]; then
  echo "ERROR: 未找到可用的千问预设音色 profile（Voicebox /profiles 为空）" >&2
  exit 1
fi

# JSON-escape text
TEXT_JSON=$(python3 -c 'import json,sys; print(json.dumps(sys.argv[1]))' "$TEXT")

# 提交生成请求（固定 engine=qwen_custom_voice）
RESP=$(curl --noproxy '*' -s --max-time 15 -X POST "$BASE_URL/generate" \
  -H "Content-Type: application/json" \
  -H "X-Voicebox-Client-Id: workrelay-tts-qwen" \
  -d "{\"text\": $TEXT_JSON, \"profile_id\": \"$PROFILE_ID\", \"language\": \"$LANG\", \"engine\": \"$ENGINE\"}")

GEN_ID=$(echo "$RESP" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("id",""))' 2>/dev/null)
if [ -z "$GEN_ID" ]; then
  echo "ERROR: Voicebox (千问) 生成提交失败: $RESP" >&2
  exit 1
fi

# 轮询等待完成（千问 1.7B CPU 推理约 10~180 秒，GPU 更快）
MAX_POLLS=300
for i in $(seq 1 $MAX_POLLS); do
  sleep 1
  ST=$(curl --noproxy '*' -s --max-time 10 "$BASE_URL/history/$GEN_ID" 2>/dev/null \
    | python3 -c 'import json,sys; d=json.load(sys.stdin); print(d.get("status",""))' 2>/dev/null)
  if [ "$ST" = "completed" ]; then
    break
  fi
  if [ "$ST" = "error" ] || [ "$ST" = "failed" ]; then
    echo "ERROR: Voicebox (千问) 生成失败 (id=$GEN_ID, status=$ST)" >&2
    exit 1
  fi
done

# 下载音频
curl --noproxy '*' -s --max-time 60 -o "$OUT" "$BASE_URL/audio/$GEN_ID"
if [ -s "$OUT" ]; then
  exit 0
else
  echo "ERROR: Voicebox (千问) 音频下载失败 (id=$GEN_ID)" >&2
  exit 1
fi
