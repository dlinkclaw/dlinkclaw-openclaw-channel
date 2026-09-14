#!/bin/bash
# WorkRelay 语音转录一键安装脚本
# 自动完成：依赖安装 → 模型下载 → OpenClaw 配置
set -e

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

INSTALL_DIR="$HOME/.workrelay/transcribe"
MODEL_CACHE="$HOME/.cache/faster-whisper"
WR_DIR="$(dirname "$(readlink -f "$0")")"

echo "============================================"
echo "  WorkRelay 语音转录 - 一键安装"
echo "============================================"
echo ""

# ── 系统检查 ──
echo -n "[1/5] 检查系统环境... "

OS="$(uname -s)"
case "$OS" in
  Linux)  ;;
  Darwin) ;;
  *)
    echo -e "${RED}失败${NC}"
    echo "错误：当前仅支持 Linux/macOS，不支持 $OS"
    echo "提示：Windows 用户请通过 WSL2 运行本脚本"
    exit 1
    ;;
esac

if ! command -v python3 &>/dev/null; then
  echo -e "${RED}失败${NC}"
  echo "错误：未找到 python3，请先安装 Python 3.8+"
  exit 1
fi

PYVER=$(python3 -c "import sys; print(f'{sys.version_info.major}.{sys.version_info.minor}')")
echo -e "${GREEN}OK${NC} (Python $PYVER, $(uname -o))"

# ── 磁盘空间检查 ──
echo -n "[2/5] 检查磁盘空间... "
AVAIL=$(df -BM "$HOME" | tail -1 | awk '{print $4}' | sed 's/M//')
if [ "$AVAIL" -lt 2500 ]; then
  echo -e "${RED}不足${NC}"
  echo "错误：可用空间 ${AVAIL}MB，至少需要 1GB（模型 ~460MB）"
  exit 1
fi
echo -e "${GREEN}OK${NC} (可用 ${AVAIL}MB)"

# ── 安装 Python 依赖 ──
echo -n "[3/5] 安装 Python 依赖... "

# 2026-08-18 修复：彻底移除 sudo 依赖，改用户级安装（pip --user / ensurepip --user）。
# 纯 Linux 上 sudo 通常需要密码，spawn 非交互环境无法输入 → 原 sudo apt-get 方案必失败。
# 用户级安装无需任何提权，任何机器可用；--break-system-packages 兼容 PEP668 系统。
export PATH="$PATH:$HOME/.local/bin:/usr/local/bin:/snap/bin"

# 统一 pip 调用入口（pip3 优先，否则 python3 -m pip）
pip_install() {
  if command -v pip3 >/dev/null 2>&1; then
    pip3 "$@"
  else
    python3 -m pip "$@"
  fi
}

# 确保 pip 可用：python3 -m pip / pip3 都没有时，用 ensurepip --user 自举（Python 自带，无需 sudo）
if ! python3 -m pip --version &>/dev/null 2>&1 && ! command -v pip3 &>/dev/null; then
  echo ""
  echo "  未检测到 pip，使用 python3 -m ensurepip --user 自举安装 ..."
  if ! python3 -m ensurepip --user >/tmp/wr-pip-err.log 2>&1; then
    echo -e "${RED}失败${NC}"
    echo "错误：pip 自举失败，请手动执行："
    echo "  python3 -m ensurepip --user"
    echo "  或安装系统 pip（需 root）：sudo apt install python3-pip"
    cat /tmp/wr-pip-err.log
    exit 1
  fi
  export PATH="$PATH:$HOME/.local/bin"
fi

# 安装 faster-whisper（用户级 --user，不写系统目录，无需 sudo）
echo "  pip 可用，安装 faster-whisper（用户级安装）..."
if ! pip_install install --user --quiet --break-system-packages faster-whisper 2>/tmp/wr-pip-err.log; then
  # fallback：老系统无 PEP668，无需 --break-system-packages
  if ! pip_install install --user --quiet faster-whisper 2>>/tmp/wr-pip-err.log; then
    echo -e "${RED}失败${NC}"
    echo "错误：faster-whisper 安装失败，请手动执行："
    echo "  pip3 install --user --break-system-packages faster-whisper"
    cat /tmp/wr-pip-err.log
    exit 1
  fi
fi
echo -e "${GREEN}OK${NC}"

# ── 下载模型 ──
echo -n "[4/5] 下载 Whisper 模型 (~460MB)... "
echo ""
# 2026-08-18 修复：systemd 透传的 all_proxy 可能是 socks5://（如 clash），
# 而 httpx 初始化 SOCKS 代理需要 socksio 包（默认未装）→ ImportError 导致下载失败。
# clash 混合端口（7890）同时支持 HTTP，这里将 socks5:// 降级为 http://，无需额外装包。
if [[ "${all_proxy:-}${ALL_PROXY:-}" == *"socks5://"* ]]; then
  echo "  ℹ 检测到 socks5 代理，降级为 http 代理（clash 混合端口兼容），避免 socksio 依赖"
  export all_proxy="${all_proxy//socks5:/http:}"
  export ALL_PROXY="${ALL_PROXY//socks5:/http:}"
fi
# 2026-08-18 修复：国内机器直连 HuggingFace 经常 Network unreachable，
# 增加 hf-mirror.com 镜像自动 fallback（HF_ENDPOINT 环境变量由 huggingface_hub 原生支持）。
# 直连失败 → 镜像重试 → 仍失败给出手动指引。
dl_model() {
  python3 -c "
import os
from huggingface_hub import snapshot_download
endpoint = os.environ.get('HF_ENDPOINT', 'https://huggingface.co')
print(f'  正在从 {endpoint} 下载 faster-whisper-small ...')
snapshot_download('Systran/faster-whisper-small',
                  cache_dir='$MODEL_CACHE')
print('  模型下载完成')
" 2>&1
}
if dl_model; then
  :
elif HF_ENDPOINT=https://hf-mirror.com dl_model; then
  echo "  ℹ 直连 HuggingFace 失败，已通过国内镜像 hf-mirror.com 下载成功"
else
  echo -e "${RED}模型下载失败${NC}"
  echo "提示：检查网络连接，或手动设置 WR_WHISPER_CACHE 到已有模型目录"
  echo "  也可手动下载：HF_ENDPOINT=https://hf-mirror.com python3 -c \"from huggingface_hub import snapshot_download; snapshot_download('Systran/faster-whisper-small', cache_dir='$MODEL_CACHE')\""
  exit 1
fi
echo -e "  ${GREEN}OK${NC}"

# ── 安装脚本 & 配置 OpenClaw ──
echo -n "[5/5] 部署脚本 & 配置 OpenClaw... "
mkdir -p "$INSTALL_DIR"
cp "$WR_DIR/transcribe.py" "$INSTALL_DIR/"
cp "$WR_DIR/transcribe_server.py" "$INSTALL_DIR/"
cp "$WR_DIR/voicebox-transcribe.sh" "$INSTALL_DIR/"
chmod +x "$INSTALL_DIR/voicebox-transcribe.sh" "$INSTALL_DIR/transcribe.py" "$INSTALL_DIR/transcribe_server.py"

# 2026-08-12：启动常驻转写服务（模型常驻内存，免每次重新加载）。
# 已在跑则跳过；未跑则后台 detached 启动，日志写入 ~/.openclaw/logs/wr-transcribe-server.log。
WR_SERVER_PORT="${WR_WHISPER_PORT:-17890}"
if curl -s --connect-timeout 2 "http://127.0.0.1:${WR_SERVER_PORT}/health" >/dev/null 2>&1; then
  echo -n " (常驻服务已运行) "
else
  mkdir -p "$(dirname "$HOME/.openclaw/logs/wr-transcribe-server.log" 2>/dev/null)" 2>/dev/null || true
  nohup python3 "$INSTALL_DIR/transcribe_server.py" "$WR_SERVER_PORT" \
    >>"$HOME/.openclaw/logs/wr-transcribe-server.log" 2>&1 &
  echo -n " (常驻服务已启动) "
fi

# 写入 OpenClaw 配置
if command -v openclaw &>/dev/null; then
  openclaw config set audio.transcription.command \
    "[\"$INSTALL_DIR/voicebox-transcribe.sh\", \"{{MediaPath}}\"]" 2>/dev/null || {
    echo -e "${YELLOW}⚠ OpenClaw 配置写入失败，请手动执行：${NC}"
    echo "  openclaw config set audio.transcription.command '[\"$INSTALL_DIR/voicebox-transcribe.sh\", \"{{MediaPath}}\"]'"
  }

  # 2026-08-12：入站语音转写切到本地 faster-whisper（tools.media.audio → cli 模式）。
  # 默认 OpenClaw 入站音频转写走 tools.media.audio 的云端 provider（如商汤 SenseAudio），
  # 安装本扩展后应切到本地命令，避免联网/费用；用户无需手动改配置。
  openclaw config set tools.media.audio.models \
    '[{"type":"cli","command":"'"$INSTALL_DIR"'/voicebox-transcribe.sh","args":["{{MediaPath}}"]}]' 2>/dev/null || {
    echo -e "${YELLOW}⚠ tools.media.audio 切本地失败，请手动配置${NC}"
  }
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

echo -n "  faster-whisper: "
python3 -c "import faster_whisper; print(faster_whisper.__version__)" 2>/dev/null \
  && echo "" \
  || echo -e "${RED}未安装${NC}"

echo -n "  模型: "
if [ -d "$MODEL_CACHE" ] && [ "$(du -sm "$MODEL_CACHE" | cut -f1)" -gt 500 ]; then
  echo -e "${GREEN}$(du -sh "$MODEL_CACHE" | cut -f1)${NC}"
else
  echo -e "${RED}未下载或异常${NC}"
fi

echo -n "  转录脚本: "
if [ -f "$INSTALL_DIR/transcribe.py" ] && [ -f "$INSTALL_DIR/voicebox-transcribe.sh" ]; then
  echo -e "${GREEN}已部署${NC}  ($INSTALL_DIR)"
else
  echo -e "${RED}缺失${NC}"
fi

echo ""
echo -e "${GREEN}✅ 安装完成！${NC}"
echo "  语音转录将在下次 OpenClaw 重启后生效。"
echo ""
