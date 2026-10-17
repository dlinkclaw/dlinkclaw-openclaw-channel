#!/bin/bash
# WorkRelay TTS 桥接脚本 - 调用本地 Voicebox REST API
# 环境变量：
#   WR_VOICEBOX_HOST       - Voicebox 服务地址（默认 127.0.0.1）
#   WR_VOICEBOX_PORT       - Voicebox 端口（默认 17493）
#   WR_VOICEBOX_PROFILE_ID - 声音 profile ID（可选，缺省时自动解析：
#                            ① ~/.workrelay/speak/profile_id（install.sh 写入）
#                            ② 从 Voicebox /profiles 查找 preset profile）
#   WR_VOICEBOX_ENGINE     - TTS 引擎（可选，缺省时按 profile 的 default_engine 自动匹配）
#   WR_VOICEBOX_LANG       - 语言（默认 zh）

set -e

TEXT="$1"
OUT="$2"

if [ -z "$TEXT" ] || [ -z "$OUT" ]; then
  echo "usage: $0 <text> <output_path>" >&2
  exit 1
fi

VB_HOST="${WR_VOICEBOX_HOST:-127.0.0.1}"
VB_PORT="${WR_VOICEBOX_PORT:-17493}"
VB_DOCKER_PORT="${WR_VOICEBOX_DOCKER_PORT:-17600}"
PROFILE_ID="${WR_VOICEBOX_PROFILE_ID:-}"
ENGINE="${WR_VOICEBOX_ENGINE:-}"
LANG="${WR_VOICEBOX_LANG:-zh}"

# 自动探测端口
BASE_URL="http://${VB_HOST}:${VB_PORT}"
curl -s --max-time 2 "${BASE_URL}/mcp" >/dev/null 2>&1 || {
  BASE_URL="http://${VB_HOST}:${VB_DOCKER_PORT}"
  curl -s --max-time 2 "${BASE_URL}/mcp" >/dev/null 2>&1 || {
    echo "ERROR: Voicebox API 不可达 ($VB_HOST:$VB_PORT / $VB_DOCKER_PORT)" >&2
    exit 1
  }
}

# ── 2026-08-12：profile 自动解析（安装后开箱即用，无需手动传 ID）──
if [ -z "$PROFILE_ID" ] && [ -f "$HOME/.workrelay/speak/profile_id" ]; then
  PROFILE_ID=$(cat "$HOME/.workrelay/speak/profile_id" 2>/dev/null | tr -d ' \n')
fi
if [ -z "$PROFILE_ID" ]; then
  # 兜底：从 /profiles 找 preset profile（优先 kokoro + 中文）
  PROFILE_ID=$(curl --noproxy '*' -s --max-time 5 "$BASE_URL/profiles" 2>/dev/null \
    | python3 -c '
import json,sys
out=""
try:
    d=json.load(sys.stdin)
    for p in d:
        if p.get("preset_engine")=="kokoro" and p.get("language")=="zh":
            out=p.get("id",""); break
    if not out:
        for p in d:
            if p.get("voice_type")=="preset":
                out=p.get("id",""); break
    print(out)
except Exception:
    print("")
' 2>/dev/null)
fi
if [ -z "$PROFILE_ID" ]; then
  echo "ERROR: 未找到可用的语音 profile（Voicebox /profiles 为空）" >&2
  exit 1
fi

# ── 2026-08-12：引擎未指定时按 profile 的 default_engine 自动匹配 ──
if [ -z "$ENGINE" ]; then
  ENGINE=$(curl --noproxy '*' -s --max-time 5 "$BASE_URL/profiles/$PROFILE_ID" 2>/dev/null \
    | python3 -c '
import json,sys
try:
    d=json.load(sys.stdin)
    print(d.get("default_engine") or d.get("preset_engine") or "qwen")
except Exception:
    print("qwen")
' 2>/dev/null)
fi

# JSON-escape text
TEXT_JSON=$(python3 "$HOME/.workrelay/speak/clean_text.py" "$TEXT")

# 提交生成请求
RESP=$(curl --noproxy '*' -s --max-time 15 -X POST "$BASE_URL/generate" \
  -H "Content-Type: application/json" \
  -H "X-Voicebox-Client-Id: workrelay-tts" \
  -d "{\"text\": $TEXT_JSON, \"profile_id\": \"$PROFILE_ID\", \"language\": \"$LANG\", \"engine\": \"$ENGINE\"}")

GEN_ID=$(echo "$RESP" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("id",""))' 2>/dev/null)
if [ -z "$GEN_ID" ]; then
  echo "ERROR: Voicebox 生成提交失败: $RESP" >&2
  exit 1
fi

# 轮询等待完成（CPU 推理约 10-180 秒，视文本长度）
MAX_POLLS=180
for i in $(seq 1 $MAX_POLLS); do
  sleep 1
  ST=$(curl --noproxy '*' -s --max-time 10 "$BASE_URL/history/$GEN_ID" 2>/dev/null \
    | python3 -c 'import json,sys; d=json.load(sys.stdin); print(d.get("status",""))' 2>/dev/null)
  if [ "$ST" = "completed" ]; then
    break
  fi
  if [ "$ST" = "error" ] || [ "$ST" = "failed" ]; then
    echo "ERROR: Voicebox 生成失败 (id=$GEN_ID, status=$ST)" >&2
    exit 1
  fi
done

# 下载音频
curl --noproxy '*' -s --max-time 30 -o "$OUT" "$BASE_URL/audio/$GEN_ID"
if [ -s "$OUT" ]; then
  exit 0
else
  echo "ERROR: Voicebox 音频下载失败 (id=$GEN_ID)" >&2
  exit 1
fi
