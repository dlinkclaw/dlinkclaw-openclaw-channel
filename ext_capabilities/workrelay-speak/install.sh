#!/bin/bash
# WorkRelay 语音合成（TTS）一键安装脚本
# 通过 Docker 部署 Voicebox（jamiepine/voicebox），自动配置 OpenClaw
set -eo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

VB_DIR="$HOME/.workrelay/voicebox"
VB_HOST="${WR_VOICEBOX_HOST:-127.0.0.1}"
VB_PORT="${WR_VOICEBOX_PORT:-17493}"
VB_DOCKER_PORT="${WR_VOICEBOX_DOCKER_PORT:-17600}"
# 2026-08-14：改为直接拉取阿里云公开镜像（已含 Kokoro 模型 + 英文修复补丁），
# 不再本地 clone + patch + build。镜像由石头哥推送到阿里云个人版仓库，公开仓库拉取免登录。
# 2026-09-14 双源：国内=阿里云公共仓库（待发布）；国际=GitHub Container Registry (ghcr.io)
# 2026-09-14 改名为 dlinkclaw-tts（统一仓库名，tag 区分模型）；命名空间=GitHub 用户名
IMG_TAG="${WR_IMAGE_TAG:-kokoro-20260914}"
# 国内源：暂未发布（留空自动跳过）；发布后填入 registry.cn-hangzhou.aliyuncs.com/NAMESPACE/dlinkclaw-tts:${IMG_TAG}
IMG_CN="${WR_IMAGE_CN:-}"
IMG_INTL="${WR_IMAGE_INTL:-ghcr.io/rockychen2016/dlinkclaw-tts:${IMG_TAG}}"

# 2026-10-18：仅显式设置 WR_PROXY 时启用代理
if [ -n "${WR_PROXY:-}" ]; then
  export HTTPS_PROXY="$WR_PROXY" HTTP_PROXY="$WR_PROXY" ALL_PROXY="$WR_PROXY"
  echo "  使用代理: $WR_PROXY"
fi
VB_IMAGE=""
INSTALL_DIR="$(dirname "$(readlink -f "$0")")"

# ── 2026-09-14 镜像双源（国内=阿里云公共仓库 / 国际=ghcr.io）──
# 按 WR_IMAGE_REGION（auto|cn|intl）优先尝试，失败自动回退另一源；WR_VOICEBOX_IMAGE 可显式覆盖。
IMAGE_CANDIDATES=()
if [ -n "${WR_VOICEBOX_IMAGE:-}" ]; then
  IMAGE_CANDIDATES=("$WR_VOICEBOX_IMAGE")
else
  # 2026-09-14：国内源暂未发布（IMG_CN 为空则自动跳过），默认国际源优先；国内源上架后自动生效
  case "${WR_IMAGE_REGION:-auto}" in
    cn)   CAND_PRIMARY="$IMG_CN";   CAND_SECONDARY="$IMG_INTL" ;;
    intl) CAND_PRIMARY="$IMG_INTL"; CAND_SECONDARY="$IMG_CN" ;;
    *)    CAND_PRIMARY="$IMG_INTL"; CAND_SECONDARY="$IMG_CN" ;;
  esac
  [ -n "$CAND_PRIMARY" ] && IMAGE_CANDIDATES+=("$CAND_PRIMARY")
  [ -n "$CAND_SECONDARY" ] && IMAGE_CANDIDATES+=("$CAND_SECONDARY")
fi

pull_image_with_fallback() {
  local log="$1"
  for img in "${IMAGE_CANDIDATES[@]}"; do
    echo "  → 尝试镜像源: $img"
    if docker pull "$img" > "$log" 2>&1; then
      VB_IMAGE="$img"
      return 0
    fi
    echo "    ⚠ 该源拉取失败，尝试下一个..."
  done
  return 1
}


echo "============================================"
echo "  WorkRelay 语音合成（TTS）- 一键安装"
echo "============================================"
echo ""

# ── 系统检查 ──
echo -n "[1/6] 检查系统环境... "

OS="$(uname -s)"
case "$OS" in
  Linux)  ;;
  *)
    echo -e "${RED}失败${NC}"
    echo "错误：当前仅支持 Linux（TTS 需要 Docker）"
    exit 1
    ;;
esac

# 2026-08-11 修复：snap 安装的 docker 位于 /snap/bin，spawn 环境的 PATH 不含该目录，
# 导致 command -v docker 误判"未找到"。必须在 docker 检测之前补全 PATH。
export PATH="$PATH:/snap/bin:/usr/local/bin"

if ! command -v docker &>/dev/null; then
  echo -e "${RED}失败${NC}"
  echo "错误：未找到 Docker，请先安装 Docker"
  echo "  Ubuntu: sudo apt install docker.io docker-compose-v2"
  exit 1
fi

if ! docker info &>/dev/null 2>&1; then
  # 2026-08-18 增强：docker 权限多级自适应（尽量零 sudo，任何机器可用）：
  #   ① 用户已在 docker 组（含会话未刷新）→ sg docker 切组执行
  #   ② 免密 sudo（sudo -n）可用 → sudo 包装
  #   ③ 都不行 → 给出一键修复指引，而不是干失败
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
    echo "  ② 把当前用户加入 docker 组（避免以后每次要密码）："
    echo "       sudo usermod -aG docker \$USER"
    echo "  ③ 重启 openclaw 服务（或重新登录会话），然后重新安装"
    echo ""
    echo "  备选：为当前用户配置免密 sudo（sudo visudo 添加：\$USER ALL=(ALL) NOPASSWD: ALL）"
    exit 1
  fi
fi

echo -e "${GREEN}OK${NC} ($(docker --version | head -1), $(uname -o))"

# 2026-08-13 方案A：snap 版 docker 的 compose 插件与 docker CLI 客户端受 AppArmor 隔离，
# 读不了 $HOME 下的文件（compose 报 permission denied、build 报 open Dockerfile: no such file），
# 只有 dockerd daemon 放行 $HOME（所以 docker run 正常）。检测到 snap docker 时，
# 项目目录改用 /var/snap/docker/common/（AppArmor 明确放行 rw），compose/build/run 全通。
if [ -d /var/snap/docker/common ]; then
  VB_DIR="/var/snap/docker/common/workrelay-voicebox"
  echo "  ℹ 检测到 snap docker，项目目录使用 $VB_DIR（AppArmor 放行读写）"
  # /var/snap/docker/common 属 root，当前用户无写权限：需 root 预创建项目目录并移交给当前用户，
  # 后续 docker pull / docker run 挂载的 output 目录写入不再需要提权。
  # 2026-08-18：无免密 sudo 时给出手动命令指引（不依赖 sudo 密码）。
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

# ── 磁盘空间 ──
echo -n "[2/6] 检查磁盘空间... "
# 2026-08-13：snap 模式下 VB_DIR 在 /var/snap/docker/common（可能与 $HOME 不同分区），
# 磁盘检查以实际项目目录所在分区为准
DF_TARGET="$VB_DIR"; [ -d "$DF_TARGET" ] || DF_TARGET="$HOME"
AVAIL=$(df -BM "$DF_TARGET" | tail -1 | awk '{print $4}' | sed 's/M//')
if [ "$AVAIL" -lt 10000 ]; then
  echo -e "${RED}不足${NC}"
  echo "错误：可用空间 ${AVAIL}MB，至少需要 10GB（Docker 镜像 + 模型 ~6GB）"
  exit 1
fi
echo -e "${GREEN}OK${NC} (可用 ${AVAIL}MB)"

# ── 内存检查 ──
echo -n "[3/6] 检查内存... "
# 2026-09-15 修复：中文 locale 下 free -m 输出“内存：”，awk 匹配 Mem: 失败会误报内存不足 → 强制 LANG=C
RAM=$(LANG=C free -m | awk '/^Mem:/{print $2}')
if [ "$RAM" -lt 6000 ]; then
  echo -e "${RED}不足 (${RAM}MB)${NC}"
  echo "错误：至少需要 6GB 内存，当前仅 ${RAM}MB"
  exit 1
fi
echo -e "${GREEN}OK${NC} (${RAM}MB)"

# ── 端口检查 ──
echo -n "[4/6] 检查端口 $VB_PORT... "
if ss -tlnp 2>/dev/null | grep -q ":$VB_PORT "; then
  echo -e "${YELLOW}已被占用${NC}"
  echo "提示：端口 $VB_PORT 已被占用，将使用 $VB_DOCKER_PORT"
  VB_ACTUAL_PORT=$VB_DOCKER_PORT
else
  echo -e "${GREEN}空闲${NC}"
  VB_ACTUAL_PORT=$VB_PORT

# 2026-10-18：snap docker + WSL 下 docker-proxy 端口发布不通，改用 host 网络
if [ -d /var/snap/docker/common ]; then
  NET_ARGS=(--network host)
  VB_ACTUAL_PORT=17493
else
  NET_ARGS=(-p "127.0.0.1:${VB_ACTUAL_PORT}:17493")
fi
fi

# ── 拉取 Voicebox 镜像 ──
echo -n "[5/6] 拉取 Voicebox 镜像... "
# 2026-08-14：镜像已由石头哥构建并推送到阿里云（含 Kokoro 模型 + 英文修复补丁），
# 直接 docker pull 即可，无需 clone 仓库 / patch / build。
mkdir -p "$VB_DIR"
if pull_image_with_fallback /tmp/wr-pull.log; then
  echo -e "${GREEN}OK${NC} ($VB_IMAGE)"
else
  echo -e "${RED}失败${NC}"
  tail -5 /tmp/wr-pull.log
  echo "错误：所有镜像源均拉取失败，检查网络连接（国内=阿里云公共仓库 / 国际=ghcr.io）"
  exit 1
fi

# ── 启动容器 ──
echo "[6/6] 启动 Voicebox 容器..."

# 创建输出目录（容器内 voicebox 用户需要可写）
# 2026-09-15 修复（生产环境反馈）：持久化整个 /app/data
# 含 voicebox.db（音色库）+ profiles + generations，避免容器重建后音色/数据丢失
mkdir -p "$VB_DIR/data/generations" "$VB_DIR/data/profiles" "$VB_DIR/data/cache"
chmod -R 777 "$VB_DIR/data" 2>/dev/null || true

# 2026-08-14：镜像已内置 Kokoro 模型（/home/voicebox/.cache/huggingface）且 ENV 已含
# HF_HUB_OFFLINE=1 / HF_HUB_CACHE，直接 docker run 即可。
# ⚠ 注意：不能挂【空卷】到 /home/voicebox/.cache/huggingface（会遮蔽内置模型）；
#   /app/data 现已挂载宿主机预建目录（含 generations/profiles/cache），用于持久化 voicebox.db 音色库。
#   否则会遮蔽镜像内已内置的模型/数据（旧版 clone+build 方案才需要挂卷）。
docker rm -f voicebox >/dev/null 2>&1 || true
if ! docker run -d --name voicebox --restart unless-stopped \
    "${NET_ARGS[@]}" \
    -v "$VB_DIR/data:/app/data" \
    -e LOG_LEVEL=info \
    -e NUMBA_CACHE_DIR=/tmp/numba_cache \
    --cpus 4 --memory 8g \
    "$VB_IMAGE" >/dev/null 2>&1; then
  echo -e "${RED}失败${NC}"
  echo "错误：docker run 失败，执行 docker logs voicebox 查看日志"
  exit 1
fi
echo "  ✅ docker run 启动成功"

# 等待 API 就绪
echo -n "  等待 Voicebox API 就绪..."
for i in $(seq 1 90); do
  if curl -s --max-time 2 "http://${VB_HOST}:${VB_ACTUAL_PORT}/health" >/dev/null 2>&1; then
    echo -e " ${GREEN}OK${NC} (耗时 ${i} 次检查)"
    break
  fi
  sleep 5
  echo -n "."
done

if ! curl -s --max-time 2 "http://${VB_HOST}:${VB_ACTUAL_PORT}/health" >/dev/null 2>&1; then
  echo ""
  echo -e "${RED}Voicebox 启动失败${NC}"
  echo "  检查日志: docker logs voicebox"
  exit 1
fi

# ── 预设声音（安装后开箱即用）──
# 2026-08-14：模型已内置镜像，无需宿主机预下载/离线配置；只需创建预设声音 profile。
echo "  ⚙ 配置预设声音..."

# 创建预设声音 profile（kokoro 中文女声 zf_xiaoxiao），id 写入 profile_id 供 workrelay-tts.sh 自动读取
mkdir -p "$HOME/.workrelay/speak"
PROFILE_FILE="$HOME/.workrelay/speak/profile_id"
# 先查已存在的同款 preset profile，避免重名 400
EXIST_ID=$(curl --noproxy '*' -s --max-time 5 "http://${VB_HOST}:${VB_ACTUAL_PORT}/profiles" 2>/dev/null \
  | python3 -c '
import json,sys
try:
    d=json.load(sys.stdin)
    for p in d:
        if p.get("preset_engine")=="kokoro" and p.get("preset_voice_id")=="zf_xiaoxiao":
            print(p.get("id","")); break
except Exception:
    print("")
' 2>/dev/null)
if [ -z "$EXIST_ID" ]; then
  EXIST_ID=$(curl --noproxy '*' -s --max-time 10 -X POST "http://${VB_HOST}:${VB_ACTUAL_PORT}/profiles" \
    -H "Content-Type: application/json" \
    -d '{"name":"WorkRelay 默认声音","description":"WorkRelay TTS 预设中文女声","language":"zh","voice_type":"preset","preset_engine":"kokoro","preset_voice_id":"zf_xiaoxiao"}' \
    | python3 -c 'import json,sys; print(json.load(sys.stdin).get("id",""))' 2>/dev/null)
fi
if [ -n "$EXIST_ID" ]; then
  echo "$EXIST_ID" > "$PROFILE_FILE"
  echo "  ✅ 预设声音已就绪"
else
  echo "  ⚠ 预设声音创建失败，可手动设 WR_VOICEBOX_PROFILE_ID 指定声音"
fi

# ── TTS 互斥：停止其它 TTS 容器（2026-09-14：TTS 只能启用一个）──
echo "  🔒 互斥处理：停止其它 TTS 容器..."
for other in voicebox-luxtts voicebox-qwen; do
  if docker ps --format '{{.Names}}' 2>/dev/null | grep -qx "$other"; then
    docker stop "$other" >/dev/null 2>&1 && echo "     ⏹ 已停止 $other" || true
  fi
done

# ── 部署脚本 & 配置 OpenClaw ──
echo -n "[收尾] 部署 TTS 桥接脚本 & 配置 OpenClaw... "

mkdir -p "$HOME/.workrelay/speak"
cp "$INSTALL_DIR/workrelay-tts.sh" "$HOME/.workrelay/speak/"
chmod +x "$HOME/.workrelay/speak/workrelay-tts.sh"

# 2026-08-12：随安装部署说明文档（README + 声音克隆说明书 + 千问引擎说明书），用户安装后即可查看
cp "$INSTALL_DIR/README.md" "$HOME/.workrelay/speak/" 2>/dev/null || true
cp "$INSTALL_DIR/CLONE_GUIDE.md" "$HOME/.workrelay/speak/" 2>/dev/null || true
cp "$INSTALL_DIR/QWEN_GUIDE.md" "$HOME/.workrelay/speak/" 2>/dev/null || true

# 写入 OpenClaw TTS 配置
if command -v openclaw &>/dev/null; then
  TTS_SCRIPT="$HOME/.workrelay/speak/workrelay-tts.sh"
  # 2026-09-14：openclaw 升级后 TTS 配置在顶层 tts.*（旧 messages.tts.* 已失效，写入会被忽略）
  # 注意：不再写 tts.auto（避免覆盖用户已有的 inbound 自动语音回复设置）
  openclaw config set tts.provider tts-local-cli 2>/dev/null || true
  openclaw config set tts.providers.tts-local-cli.command "$TTS_SCRIPT" 2>/dev/null || true
  openclaw config set tts.providers.tts-local-cli.args '["{{Text}}","{{OutputPath}}"]' 2>/dev/null || true
  openclaw config set tts.providers.tts-local-cli.outputFormat wav 2>/dev/null || true
  openclaw config set tts.providers.tts-local-cli.timeoutMs 180000 2>/dev/null || true

  # MCP 配置
  openclaw config set mcp.servers.voicebox.url "http://${VB_HOST}:${VB_ACTUAL_PORT}/mcp" 2>/dev/null || true
  openclaw config set mcp.servers.voicebox.transport streamable-http 2>/dev/null || true
  openclaw config set mcp.servers.voicebox.timeout 60 2>/dev/null || true

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
docker ps --format '{{.Names}}' 2>/dev/null | grep -q voicebox && echo -e "${GREEN}运行中${NC}" || echo -e "${RED}未运行${NC}"

echo -n "  API 连通性: "
curl -s --max-time 2 "http://${VB_HOST}:${VB_ACTUAL_PORT}/health" >/dev/null 2>&1 \
  && echo -e "${GREEN}OK${NC} (http://${VB_HOST}:${VB_ACTUAL_PORT})" \
  || echo -e "${RED}无法连接${NC}"

echo -n "  TTS 桥接脚本: "
[ -f "$HOME/.workrelay/speak/workrelay-tts.sh" ] && echo -e "${GREEN}已部署${NC}" || echo -e "${RED}缺失${NC}"

echo ""
echo -e "${GREEN}✅ Voicebox TTS 安装完成！${NC}"
echo "  API 地址:  http://${VB_HOST}:${VB_ACTUAL_PORT}"
echo "  管理命令:  docker ps | grep voicebox"
echo "  查看日志:  docker logs -f voicebox"
echo ""
echo "  🎤 预设声音：开箱即用（Voicebox 内置 50+ 音色）"
echo "  🎙️ 声音克隆：可选，设 WR_VOICEBOX_PROFILE_ID=你的profile_id"
echo ""
