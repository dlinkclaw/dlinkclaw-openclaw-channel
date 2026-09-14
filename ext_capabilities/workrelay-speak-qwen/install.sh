#!/bin/bash
# WorkRelay 语音合成（千问 Qwen3-TTS）一键安装脚本
# 2026-09-14 新增能力：
#   - 独立容器 voicebox-qwen（端口 17602），与 Kokoro(17493) / LuxTTS(17601) 互不干扰
#   - 复用 workrelay-tts 镜像（已内置 qwen_custom_voice 后端），安装时下载 Qwen3-TTS 1.7B 模型（~4.6GB）
#   - TTS 互斥：启用本能力会自动停止其它 TTS 容器，并把 tts.provider 切到本引擎
set -eo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

VB_DIR="$HOME/.workrelay/voicebox-qwen"
VB_HOST="${WR_VOICEBOX_HOST:-127.0.0.1}"
# 独立端口 17602（Kokoro 17493/17600、LuxTTS 17601，避免冲突）
VB_PORT="${WR_VOICEBOX_QWEN_PORT:-17602}"
VB_CONTAINER_PORT=17493
VB_IMAGE="${WR_VOICEBOX_IMAGE:-crpi-3zj44dlldca7vawm.cn-hangzhou.personal.cr.aliyuncs.com/shiduo/workrelay-tts:20260813}"
# 千问模型（CustomVoice 预设音色版，1.7B）
QWEN_MODEL="${WR_QWEN_MODEL:-Qwen/Qwen3-TTS-12Hz-1.7B-CustomVoice}"
# 2026-09-14：HF 下载走国内镜像（容器/宿主直连 huggingface.co 通常不通）
HF_MIRROR="${WR_HF_ENDPOINT:-https://hf-mirror.com}"
INSTALL_DIR="$(dirname "$(readlink -f "$0")")"

echo "============================================"
echo "  WorkRelay 语音合成（千问 Qwen3-TTS）- 一键安装"
echo "============================================"
echo ""

# ── 系统检查 ──
echo -n "[1/8] 检查系统环境... "

OS="$(uname -s)"
case "$OS" in
  Linux)  ;;
  *)
    echo -e "${RED}失败${NC}"
    echo "错误：当前仅支持 Linux（TTS 需要 Docker）"
    exit 1
    ;;
esac

export PATH="$PATH:/snap/bin:/usr/local/bin"

if ! command -v docker &>/dev/null; then
  echo -e "${RED}失败${NC}"
  echo "错误：未找到 Docker，请先安装 Docker"
  echo "  Ubuntu: sudo apt install docker.io docker-compose-v2"
  exit 1
fi

if ! docker info &>/dev/null 2>&1; then
  # docker 权限多级自适应（尽量零 sudo）
  if sg docker -c "docker info" &>/dev/null 2>&1; then
    echo "  ℹ 用户已加入 docker 组，通过 sg docker 执行（无需 sudo）"
    docker() { sg docker -c "docker $(printf '%q ' "$@")"; }
  elif sudo -n docker info &>/dev/null 2>&1; then
    echo "  ⚠ 当前用户无 docker 组权限，检测到免密 sudo，自动使用 sudo 执行 docker"
    docker() { sudo docker "$@"; }
  else
    echo -e "${RED}失败${NC}"
    echo "错误：Docker 未运行或无权限。请先执行一次以下命令："
    echo ""
    echo "  ① 启动 Docker：sudo systemctl start docker"
    echo "  ② 把当前用户加入 docker 组：sudo usermod -aG docker \$USER"
    echo "  ③ 重启 openclaw 服务（或重新登录会话），然后重新安装"
    exit 1
  fi
fi

echo -e "${GREEN}OK${NC} ($(docker --version | head -1), $(uname -o))"

# snap docker 项目目录适配（AppArmor 只放行 /var/snap/docker/common）
if [ -d /var/snap/docker/common ]; then
  VB_DIR="/var/snap/docker/common/workrelay-voicebox-qwen"
  echo "  ℹ 检测到 snap docker，项目目录使用 $VB_DIR（AppArmor 放行读写）"
  if [ -d "$VB_DIR" ]; then
    sudo -n chown -R "$(id -u):$(id -g)" "$VB_DIR" 2>/dev/null || true
  elif ! sudo -n mkdir -p "$VB_DIR" 2>/dev/null; then
    echo -e "${RED}失败${NC}"
    echo "错误：无法创建项目目录 $VB_DIR（需要 root 权限）。"
    echo "请手动执行一次以下命令后重新安装："
    echo "  sudo mkdir -p $VB_DIR && sudo chown \$USER:\$USER $VB_DIR"
    exit 1
  fi
  sudo -n chown "$(id -u):$(id -g)" "$VB_DIR" 2>/dev/null || true
fi

# ── 磁盘空间（模型 4.6GB + 镜像，建议 ≥8GB）──
echo -n "[2/8] 检查磁盘空间... "
DF_TARGET="$VB_DIR"; [ -d "$DF_TARGET" ] || DF_TARGET="$HOME"
AVAIL=$(df -BM "$DF_TARGET" | tail -1 | awk '{print $4}' | sed 's/M//')
if [ "$AVAIL" -lt 8192 ]; then
  echo -e "${RED}不足${NC}"
  echo "错误：可用空间 ${AVAIL}MB，至少需要 8GB（模型 4.6GB + 运行缓存）"
  exit 1
fi
echo -e "${GREEN}OK${NC} (可用 ${AVAIL}MB)"

# ── 内存检查 ──
echo -n "[3/8] 检查内存... "
RAM=$(free -m | awk '/^Mem:/{print $2}')
if [ "$RAM" -lt 6000 ]; then
  echo -e "${RED}不足 (${RAM}MB)${NC}"
  echo "错误：至少需要 6GB 内存，当前仅 ${RAM}MB"
  exit 1
fi
echo -e "${GREEN}OK${NC} (${RAM}MB)"

# ── GPU 检测（有 NVIDIA 则启用 CUDA 加速）──
echo -n "[4/8] 检测 GPU... "
DOCKER_GPU_ARGS=""
if command -v nvidia-smi &>/dev/null && nvidia-smi -L &>/dev/null 2>&1; then
  echo -e "${GREEN}检测到 NVIDIA GPU${NC} ($(nvidia-smi -L 2>/dev/null | head -1))"
  DOCKER_GPU_ARGS="--gpus all"
else
  echo -e "${YELLOW}未检测到 N 卡，使用 CPU 合成（10~60 秒/句，较慢但可用）${NC}"
fi

# ── 端口检查 ──
echo -n "[5/8] 检查端口 $VB_PORT... "
if ss -tlnp 2>/dev/null | grep -q ":$VB_PORT "; then
  echo -e "${RED}已被占用${NC}"
  echo "错误：端口 $VB_PORT 已被占用，请先停止占用进程或设置 WR_VOICEBOX_QWEN_PORT 换端口"
  exit 1
fi
echo -e "${GREEN}空闲${NC}"

# ── 拉取镜像 ──
echo -n "[6/8] 拉取 Voicebox 镜像... "
mkdir -p "$VB_DIR"
if docker pull "$VB_IMAGE" > /tmp/wr-pull-qwen.log 2>&1; then
  echo -e "${GREEN}OK${NC} ($(docker images --format '{{.Repository}}:{{.Tag}}' "$VB_IMAGE" | head -1))"
else
  echo -e "${RED}失败${NC}"
  tail -5 /tmp/wr-pull-qwen.log
  echo "错误：拉取镜像失败，检查网络连接（阿里云国内公开镜像，通畅即可拉取）"
  exit 1
fi

# ── 预下载千问模型（用镜像自带的 huggingface_hub + 国内镜像源）──
# 说明：镜像内已内置 Kokoro 模型，但未含 Qwen 模型；把 Qwen 模型下载到独立缓存目录，
#       容器启动时挂载该目录作为 HF 缓存（HF_HUB_OFFLINE=1 离线加载，避免容器内联网失败）。
echo -n "[7/8] 下载千问模型（约 4.6GB，视网速 5~30 分钟）... "
HF_CACHE="$VB_DIR/hf-cache"
mkdir -p "$HF_CACHE"
if docker run --rm \
    -v "$HF_CACHE:/hf-cache" \
    -e HF_ENDPOINT="$HF_MIRROR" \
    -e HF_HUB_OFFLINE=0 \
    -e HF_HUB_DISABLE_PROGRESS_BARS=1 \
    --entrypoint python3 \
    "$VB_IMAGE" -c "
from huggingface_hub import snapshot_download
p = snapshot_download('$QWEN_MODEL', cache_dir='/hf-cache')
print('MODEL_READY:' + p)
" > /tmp/wr-qwen-download.log 2>&1; then
  echo -e "${GREEN}OK${NC}"
  chmod -R a+rX "$HF_CACHE" 2>/dev/null || true
else
  echo -e "${RED}失败${NC}"
  tail -10 /tmp/wr-qwen-download.log
  echo "错误：千问模型下载失败，请检查网络（hf-mirror.com）后重试"
  exit 1
fi

# ── 启动容器 ──
echo "[8/8] 启动 Voicebox (千问) 容器..."

mkdir -p "$VB_DIR/output"
chmod 777 "$VB_DIR/output" 2>/dev/null || true

docker rm -f voicebox-qwen >/dev/null 2>&1 || true
if ! docker run -d --name voicebox-qwen --restart unless-stopped \
    -p "127.0.0.1:${VB_PORT}:${VB_CONTAINER_PORT}" \
    -v "$VB_DIR/output:/app/data/generations" \
    -v "$HF_CACHE:/home/voicebox/.cache/huggingface" \
    -e LOG_LEVEL=info \
    -e NUMBA_CACHE_DIR=/tmp/numba_cache \
    -e HF_HUB_OFFLINE=1 \
    $DOCKER_GPU_ARGS \
    --cpus 4 --memory 8g \
    "$VB_IMAGE" >/dev/null 2>&1; then
  echo -e "${RED}失败${NC}"
  echo "错误：docker run 失败，执行 docker logs voicebox-qwen 查看日志"
  exit 1
fi
echo "  ✅ docker run 启动成功"

docker exec voicebox-qwen chmod 777 /app/data/generations 2>/dev/null || true

# 等待 API 就绪
echo -n "  等待 Voicebox API 就绪..."
for i in $(seq 1 90); do
  if curl -s --max-time 2 "http://${VB_HOST}:${VB_PORT}/mcp" >/dev/null 2>&1; then
    echo -e " ${GREEN}OK${NC} (耗时 ${i} 次检查)"
    break
  fi
  sleep 5
  echo -n "."
done

if ! curl -s --max-time 2 "http://${VB_HOST}:${VB_PORT}/mcp" >/dev/null 2>&1; then
  echo ""
  echo -e "${RED}Voicebox 启动失败${NC}"
  echo "  检查日志: docker logs voicebox-qwen"
  exit 1
fi

# ── 创建千问预设音色 profile（Vivian 中文女声）──
echo "  ⚙ 配置千问预设音色（Vivian 中文女声）..."

mkdir -p "$HOME/.workrelay/speak-qwen"
PROFILE_FILE="$HOME/.workrelay/speak-qwen/profile_id"

EXIST_ID=$(curl --noproxy '*' -s --max-time 5 "http://${VB_HOST}:${VB_PORT}/profiles" 2>/dev/null \
  | python3 -c '
import json,sys
try:
    d=json.load(sys.stdin)
    for p in d:
        if p.get("preset_engine")=="qwen_custom_voice" and p.get("preset_voice_id")=="Vivian":
            print(p.get("id","")); break
except Exception:
    print("")
' 2>/dev/null)

if [ -z "$EXIST_ID" ]; then
  EXIST_ID=$(curl --noproxy '*' -s --max-time 15 -X POST "http://${VB_HOST}:${VB_PORT}/profiles" \
    -H "Content-Type: application/json" \
    -d '{"name":"WorkRelay 千问女声","description":"WorkRelay 千问 Qwen3-TTS 预设中文女声","language":"zh","voice_type":"preset","preset_engine":"qwen_custom_voice","preset_voice_id":"Vivian"}' \
    | python3 -c 'import json,sys; print(json.load(sys.stdin).get("id",""))' 2>/dev/null)
fi

if [ -n "$EXIST_ID" ]; then
  echo "$EXIST_ID" > "$PROFILE_FILE"
  echo "  ✅ 千问预设音色已就绪"
else
  echo "  ⚠ 预设音色创建失败，可手动设 WR_VOICEBOX_PROFILE_ID 指定声音"
fi

# ── TTS 互斥：停止其它 TTS 容器（TTS 只能启用一个）──
echo "  🔒 互斥处理：停止其它 TTS 容器..."
for other in voicebox voicebox-luxtts; do
  if docker ps --format '{{.Names}}' 2>/dev/null | grep -qx "$other"; then
    docker stop "$other" >/dev/null 2>&1 && echo "     ⏹ 已停止 $other" || true
  fi
done

# ── 部署脚本 & 配置 OpenClaw ──
echo -n "[收尾] 部署 TTS 桥接脚本 & 配置 OpenClaw... "

mkdir -p "$HOME/.workrelay/speak-qwen"
cp "$INSTALL_DIR/workrelay-tts.sh" "$HOME/.workrelay/speak-qwen/"
chmod +x "$HOME/.workrelay/speak-qwen/workrelay-tts.sh"
cp "$INSTALL_DIR/README.md" "$HOME/.workrelay/speak-qwen/" 2>/dev/null || true

if command -v openclaw &>/dev/null; then
  TTS_SCRIPT="$HOME/.workrelay/speak-qwen/workrelay-tts.sh"
  # 2026-09-14：openclaw 升级后 TTS 配置在顶层 tts.*（旧 messages.tts.* 已失效）
  # 独立 provider 名 tts-local-cli-qwen，与 Kokoro(tts-local-cli)/LuxTTS(tts-local-cli-luxtts) 互不覆盖
  openclaw config set tts.provider tts-local-cli-qwen 2>/dev/null || true
  openclaw config set tts.providers.tts-local-cli-qwen.command "$TTS_SCRIPT" 2>/dev/null || true
  openclaw config set tts.providers.tts-local-cli-qwen.args '["{{Text}}","{{OutputPath}}"]' 2>/dev/null || true
  openclaw config set tts.providers.tts-local-cli-qwen.outputFormat wav 2>/dev/null || true
  openclaw config set tts.providers.tts-local-cli-qwen.timeoutMs 300000 2>/dev/null || true

  openclaw gateway restart 2>/dev/null || true
else
  echo -e "${YELLOW}⚠ 未检测到 openclaw CLI，跳过自动配置${NC}"
fi

echo -e "${GREEN}OK${NC}"
echo ""

# ── 验证 ──
echo "============================================"
echo "  安装验证"
echo "============================================"

echo -n "  Docker 容器: "
docker ps --format '{{.Names}}' 2>/dev/null | grep -q voicebox-qwen && echo -e "${GREEN}运行中${NC}" || echo -e "${RED}未运行${NC}"

echo -n "  API 连通性: "
curl -s --max-time 2 "http://${VB_HOST}:${VB_PORT}/mcp" >/dev/null 2>&1 \
  && echo -e "${GREEN}OK${NC} (http://${VB_HOST}:${VB_PORT})" \
  || echo -e "${RED}无法连接${NC}"

echo -n "  千问 profile: "
[ -f "$PROFILE_FILE" ] && echo -e "${GREEN}$(cat "$PROFILE_FILE")${NC}" || echo -e "${RED}缺失${NC}"

echo -n "  TTS provider: "
openclaw config get tts.provider 2>/dev/null | head -1 || echo "(读取失败)"

echo ""
echo -e "${GREEN}✅ 千问 Qwen3-TTS 安装完成！${NC}"
echo "  API 地址:  http://${VB_HOST}:${VB_PORT}"
echo "  管理命令:  docker ps | grep voicebox-qwen"
echo "  查看日志:  docker logs -f voicebox-qwen"
echo ""
echo "  🎙️ 音色：Vivian（中文女声）；其它预设：Serena/Eric/Dylan/Ryan/Aiden 等 9 种"
echo "  ⏱️ 首次合成需加载 1.7B 模型到内存，会稍慢（CPU 10~60 秒/句）"
echo ""
