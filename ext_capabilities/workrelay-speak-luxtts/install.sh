#!/bin/bash
# WorkRelay 语音合成（LuxTTS 克隆声）一键安装脚本
# 独立容器 voicebox-luxtts（端口 17601），拉取含 LuxTTS 模型的阿里镜像，
# 自动创建"石头哥克隆声音"profile（内置样本），配置 OpenClaw TTS。
# 2026-08-15 新增能力：与 workrelay-speak（Kokoro）互不干扰，可同时安装。
set -eo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

VB_DIR="$HOME/.workrelay/voicebox-luxtts"
VB_HOST="${WR_VOICEBOX_HOST:-127.0.0.1}"
# 独立端口 17601（Kokoro 版占用 17493/17600，避免冲突）
VB_PORT="${WR_VOICEBOX_LUXTTS_PORT:-17601}"
VB_CONTAINER_PORT=17493
# 阿里云镜像：石头哥推送后使用（含 LuxTTS 模型 + Kokoro + 英文补丁）
VB_IMAGE="${WR_VOICEBOX_IMAGE:-crpi-3zj44dlldca7vawm.cn-hangzhou.personal.cr.aliyuncs.com/shiduo/workrelay-tts-luxtts:20260815}"
INSTALL_DIR="$(dirname "$(readlink -f "$0")")"

echo "============================================"
echo "  WorkRelay 语音合成（LuxTTS 克隆声）- 一键安装"
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

# snap docker 项目目录适配（与 workrelay-speak 一致）
if [ -d /var/snap/docker/common ]; then
  VB_DIR="/var/snap/docker/common/workrelay-voicebox-luxtts"
  echo "  ℹ 检测到 snap docker，项目目录使用 $VB_DIR（AppArmor 放行读写）"
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
RAM=$(free -m | awk '/^Mem:/{print $2}')
if [ "$RAM" -lt 6000 ]; then
  echo -e "${RED}不足 (${RAM}MB)${NC}"
  echo "错误：至少需要 6GB 内存，当前仅 ${RAM}MB"
  exit 1
fi
echo -e "${GREEN}OK${NC} (${RAM}MB)"

# ── 端口检查 ──
echo -n "[4/6] 检查端口 $VB_PORT... "
if ss -tlnp 2>/dev/null | grep -q ":$VB_PORT "; then
  echo -e "${RED}已被占用${NC}"
  echo "错误：端口 $VB_PORT 已被占用，请先停止占用进程或设置 WR_VOICEBOX_LUXTTS_PORT 换端口"
  exit 1
fi
echo -e "${GREEN}空闲${NC}"

# ── 拉取镜像 ──
echo -n "[5/6] 拉取 Voicebox (LuxTTS) 镜像... "
mkdir -p "$VB_DIR"
if docker pull "$VB_IMAGE" > /tmp/wr-pull-luxtts.log 2>&1; then
  echo -e "${GREEN}OK${NC} ($(docker images --format '{{.Repository}}:{{.Tag}}' "$VB_IMAGE" | head -1))"
else
  echo -e "${RED}失败${NC}"
  tail -5 /tmp/wr-pull-luxtts.log
  echo "错误：拉取镜像失败，检查网络连接"
  exit 1
fi

# ── 启动容器 ──
echo "[6/6] 启动 Voicebox (LuxTTS) 容器..."

mkdir -p "$VB_DIR/output"
chmod 777 "$VB_DIR/output" 2>/dev/null || true

docker rm -f voicebox-luxtts >/dev/null 2>&1 || true
if ! docker run -d --name voicebox-luxtts --restart unless-stopped \
    -p "127.0.0.1:${VB_PORT}:${VB_CONTAINER_PORT}" \
    -v "$VB_DIR/output:/app/data/generations" \
    -e LOG_LEVEL=info \
    -e NUMBA_CACHE_DIR=/tmp/numba_cache \
    --cpus 4 --memory 8g \
    "$VB_IMAGE" >/dev/null 2>&1; then
  echo -e "${RED}失败${NC}"
  echo "错误：docker run 失败，执行 docker logs voicebox-luxtts 查看日志"
  exit 1
fi
echo "  ✅ docker run 启动成功"

# 2026-08-15 权限兜底：snap docker 的 bind mount 目录在容器内可能显示 root:root 755，
# voicebox 用户（uid 999）无法写入 /app/data/generations 导致生成保存失败。
# 容器内 chmod 777 兜底（docker run 后立即执行，幂等）。
docker exec voicebox-luxtts chmod 777 /app/data/generations 2>/dev/null || true

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
  echo "  检查日志: docker logs voicebox-luxtts"
  exit 1
fi

# ── 创建石头哥克隆声音 profile ──
echo "  ⚙ 配置克隆声音（石头哥克隆声）..."

mkdir -p "$HOME/.workrelay/speak-luxtts"
PROFILE_FILE="$HOME/.workrelay/speak-luxtts/profile_id"
SAMPLE_DIR="$INSTALL_DIR/samples"

# 查已存在的同款克隆 profile（按名字匹配，避免重复创建）
EXIST_ID=$(curl --noproxy '*' -s --max-time 5 "http://${VB_HOST}:${VB_PORT}/profiles" 2>/dev/null \
  | python3 -c '
import json,sys
try:
    d=json.load(sys.stdin)
    for p in d:
        if p.get("name")=="石头哥克隆声" and p.get("voice_type")=="cloned":
            print(p.get("id","")); break
except Exception:
    print("")
' 2>/dev/null)

if [ -z "$EXIST_ID" ]; then
  # 创建克隆 profile
  EXIST_ID=$(curl --noproxy '*' -s --max-time 10 -X POST "http://${VB_HOST}:${VB_PORT}/profiles" \
    -H "Content-Type: application/json" \
    -d '{"name":"石头哥克隆声","description":"WorkRelay LuxTTS 内置克隆声音（石头哥）","language":"zh","voice_type":"cloned"}' \
    | python3 -c 'import json,sys; print(json.load(sys.stdin).get("id",""))' 2>/dev/null)
fi

if [ -n "$EXIST_ID" ]; then
  # 上传样本（file + reference_text 多文件）
  SAMPLE_COUNT=0
  while IFS='|' read -r fname reftext; do
    [ -z "$fname" ] && continue
    fpath="$SAMPLE_DIR/$fname"
    if [ -f "$fpath" ]; then
      if curl --noproxy '*' -s --max-time 15 -X POST "http://${VB_HOST}:${VB_PORT}/profiles/${EXIST_ID}/samples" \
          -F "file=@${fpath}" -F "reference_text=${reftext}" \
          | python3 -c 'import json,sys; d=json.load(sys.stdin); print("ok" if d.get("id") else "fail")' 2>/dev/null | grep -q ok; then
        SAMPLE_COUNT=$((SAMPLE_COUNT+1))
      fi
    fi
  done < "$SAMPLE_DIR/reference_text.txt"
  echo "  ✅ 克隆声音 profile 已就绪（${SAMPLE_COUNT} 个样本）"
  echo "$EXIST_ID" > "$PROFILE_FILE"
else
  echo "  ⚠ 克隆 profile 创建失败，可手动设 WR_VOICEBOX_PROFILE_ID 指定声音"
fi

# ── TTS 互斥：停止其它 TTS 容器（2026-09-14：TTS 只能启用一个）──
echo "  🔒 互斥处理：停止其它 TTS 容器..."
for other in voicebox voicebox-qwen; do
  if docker ps --format '{{.Names}}' 2>/dev/null | grep -qx "$other"; then
    docker stop "$other" >/dev/null 2>&1 && echo "     ⏹ 已停止 $other" || true
  fi
done

# ── 部署脚本 & 配置 OpenClaw ──
echo -n "[收尾] 部署 TTS 桥接脚本 & 配置 OpenClaw... "

mkdir -p "$HOME/.workrelay/speak-luxtts"
cp "$INSTALL_DIR/workrelay-tts.sh" "$HOME/.workrelay/speak-luxtts/"
chmod +x "$HOME/.workrelay/speak-luxtts/workrelay-tts.sh"
cp "$INSTALL_DIR/README.md" "$HOME/.workrelay/speak-luxtts/" 2>/dev/null || true

if command -v openclaw &>/dev/null; then
  TTS_SCRIPT="$HOME/.workrelay/speak-luxtts/workrelay-tts.sh"
  # 独立 provider 名（tts-local-cli-luxtts），与 Kokoro 版 tts-local-cli 互不覆盖
  # 2026-09-14：openclaw 升级后 TTS 配置在顶层 tts.*（旧 messages.tts.* 已失效）
  openclaw config set tts.provider tts-local-cli-luxtts 2>/dev/null || true
  openclaw config set tts.providers.tts-local-cli-luxtts.command "$TTS_SCRIPT" 2>/dev/null || true
  openclaw config set tts.providers.tts-local-cli-luxtts.args '["{{Text}}","{{OutputPath}}"]' 2>/dev/null || true
  openclaw config set tts.providers.tts-local-cli-luxtts.outputFormat wav 2>/dev/null || true
  openclaw config set tts.providers.tts-local-cli-luxtts.timeoutMs 180000 2>/dev/null || true

  # MCP 配置（独立 server 名 voicebox-luxtts）
  openclaw config set mcp.servers.voicebox-luxtts.url "http://${VB_HOST}:${VB_PORT}/mcp" 2>/dev/null || true
  openclaw config set mcp.servers.voicebox-luxtts.transport streamable-http 2>/dev/null || true
  openclaw config set mcp.servers.voicebox-luxtts.timeout 60 2>/dev/null || true

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
docker ps --format '{{.Names}}' 2>/dev/null | grep -q voicebox-luxtts && echo -e "${GREEN}运行中${NC}" || echo -e "${RED}未运行${NC}"

echo -n "  API 连通性: "
curl -s --max-time 2 "http://${VB_HOST}:${VB_PORT}/mcp" >/dev/null 2>&1 \
  && echo -e "${GREEN}OK${NC} (http://${VB_HOST}:${VB_PORT})" \
  || echo -e "${RED}无法连接${NC}"

echo -n "  TTS 桥接脚本: "
[ -f "$HOME/.workrelay/speak-luxtts/workrelay-tts.sh" ] && echo -e "${GREEN}已部署${NC}" || echo -e "${RED}缺失${NC}"

echo -n "  克隆声音 profile: "
[ -f "$PROFILE_FILE" ] && echo -e "${GREEN}$(cat "$PROFILE_FILE")${NC}" || echo -e "${RED}缺失${NC}"

echo ""
echo -e "${GREEN}✅ Voicebox (LuxTTS) 安装完成！${NC}"
echo "  API 地址:  http://${VB_HOST}:${VB_PORT}"
echo "  管理命令:  docker ps | grep voicebox-luxtts"
echo "  查看日志:  docker logs -f voicebox-luxtts"
echo ""
echo "  🎙️ 声音：内置石头哥克隆声（LuxTTS 引擎）"
echo ""
