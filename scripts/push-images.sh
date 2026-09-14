#!/bin/bash
# ============================================================================
# DLinkClaw TTS 镜像发布脚本（2026-09-14）
#
# 作用：把本地已构建好的镜像改名并推送到公开仓库。
#
# 命名方案（2026-09-14 石头哥定：方案 B —— 单仓库 + tag 区分模型）：
#   统一仓库名：dlinkclaw-tts
#   命名空间  ：rockchen896cn（Docker Hub 用户名）
#   改名映射：
#     workrelay-tts:20260813        → dlinkclaw-tts:kokoro-20260813
#     workrelay-tts:20260813        → dlinkclaw-tts:qwen-20260813   （同源镜像，模型安装时下载）
#     workrelay-tts-luxtts:20260815 → dlinkclaw-tts:luxtts-20260815
#
# 目标仓库：
#   国际：docker.io/rockchen896cn/dlinkclaw-tts:<tag>                    （Docker Hub，公开）
#   国内：registry.cn-hangzhou.aliyuncs.com/rockchen896cn/dlinkclaw-tts:<tag>（阿里云公共仓库，未发布可跳过）
#
# ⚠️ 安全：凭据走交互式 docker login（提示输入），绝不写入本脚本。
# ⚠️ Docker Hub：仓库不存在时推送会自动创建（Public）。
#
# 用法：
#   bash scripts/push-images.sh --intl-only        # 只推 Docker Hub（当前推荐）
#   bash scripts/push-images.sh --cn-only          # 只推阿里云公共仓库
#   bash scripts/push-images.sh                    # 两个都推
#   bash scripts/push-images.sh --intl-only --tag-only   # 只打标签本地检查
#   WR_NS=xxx bash scripts/push-images.sh --intl-only    # 换命名空间
# ============================================================================
set -eo pipefail

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; NC='\033[0m'

# 2026-09-14 双源命名空间分离：阿里云用 shiduo，Docker Hub 用 rockchen896cn
CN_NS="${WR_CN_NS:-shiduo}"                  # 阿里云 ACR 命名空间
INTL_NS="${WR_INTL_NS:-rockychen2016}"        # ghcr.io 用户名（GitHub 账号，必须小写）
REPO="dlinkclaw-tts"                         # 统一仓库名（tag 区分模型）
CN_REG="registry.cn-hangzhou.aliyuncs.com"   # 阿里云【公共域名】（长期有效，替代 crpi 个人版实例）
INTL_REG="${WR_INTL_REG:-ghcr.io}"             # GitHub Container Registry（Docker Hub 国内不可达，改用 ghcr）

MODE="all"; TAG_ONLY=0; SKIP_LOGIN=0
for arg in "$@"; do
  case "$arg" in
    --intl-only)  MODE="intl" ;;
    --cn-only)    MODE="cn" ;;
    --tag-only)   TAG_ONLY=1 ;;
    --skip-login) SKIP_LOGIN=1 ;;   # 2026-09-14：已登录（凭据在 docker config）时跳过交互登录
    -h|--help)    sed -n '2,30p' "$0"; exit 0 ;;
    *) echo -e "${RED}未知参数: $arg${NC}（可用: --intl-only / --cn-only / --tag-only / --skip-login）"; exit 1 ;;
  esac
done

REGISTRIES=()
case "$MODE" in
  intl) REGISTRIES=("$INTL_REG") ;;
  cn)   REGISTRIES=("$CN_REG") ;;
  *)    REGISTRIES=("$CN_REG" "$INTL_REG") ;;
esac

# 本地镜像:tag → 目标 tag（同一仓库 dlinkclaw-tts）
# 本地镜像 → 目标 tag（2026-09-14 起为瘦身版；瘦身后体积 8GB→4GB）
IMAGES=(
  "rockchen896cn/dlinkclaw-tts:kokoro-20260813-slim|kokoro-20260914"
  "rockchen896cn/dlinkclaw-tts:kokoro-20260813-slim|qwen-20260914"
  # luxtts 瘦身镜像构建完成后取消注释：
  # "dlinkclaw-tts:luxtts-20260914-slim|luxtts-20260914"
)
LEGACY_PREFIX="crpi-3zj44dlldca7vawm.cn-hangzhou.personal.cr.aliyuncs.com/shiduo"

export PATH="$PATH:/snap/bin:/usr/local/bin"
command -v docker >/dev/null || { echo -e "${RED}未找到 docker${NC}"; exit 1; }
if ! docker info >/dev/null 2>&1; then
  if sg docker -c "docker info" >/dev/null 2>&1; then docker() { sg docker -c "docker $(printf '%q ' "$@")"; }
  elif sudo -n docker info >/dev/null 2>&1; then docker() { sudo docker "$@"; }
  else echo -e "${RED}Docker 无权限${NC}"; exit 1; fi
fi

echo "============================================"
echo "  DLinkClaw TTS 镜像发布（改名 + 推送）"
echo "============================================"
echo "  模式     : $MODE $([ "$TAG_ONLY" -eq 1 ] && echo '(仅打标签)')"
echo "  仓库     : ${REPO}（命名空间 ${NS}）"
for r in "${REGISTRIES[@]}"; do echo "  目标源   : $r"; done
echo ""

# ── 登录 ──
if [ "$TAG_ONLY" -eq 0 ] && [ "$SKIP_LOGIN" -eq 0 ]; then
  echo -e "${YELLOW}[1/4] 登录仓库（交互式输入账号密码，仅本次会话）${NC}"
  for reg in "${REGISTRIES[@]}"; do
    echo "  → $reg"
    docker login "$reg" || { echo -e "${RED}$reg 登录失败${NC}"; exit 1; }
  done
  echo -e "${GREEN}✅ 登录完成${NC}"
else
  echo -e "${YELLOW}[1/4] 跳过登录${NC}（$([ "$TAG_ONLY" -eq 1 ] && echo '--tag-only' || echo '--skip-login 已登录')）"
fi
echo ""

# ── 打标签（改名）──
echo "[2/4] 打标签（改名）..."
declare -a TAGGED=()
for item in "${IMAGES[@]}"; do
  SRC="${item%%|*}"; TAG_NAME="${item##*|}"
  # 本地镜像探测：裸名 → 旧个人版实例地址
  if ! docker image inspect "$SRC" >/dev/null 2>&1; then
    SRC="${LEGACY_PREFIX}/${SRC}"
  fi
  if ! docker image inspect "$SRC" >/dev/null 2>&1; then
    echo -e "${RED}  ✗ 本地镜像不存在: ${item%%|*}${NC}"; exit 1
  fi
  for REG in "${REGISTRIES[@]}"; do
    case "$REG" in "$CN_REG") NS="$CN_NS" ;; *) NS="$INTL_NS" ;; esac
    IMG="${REG}/${NS}/${REPO}:${TAG_NAME}"
    docker tag "$SRC" "$IMG"
    echo "  ✅ $SRC → $IMG"
    TAGGED+=("$IMG")
  done
done
echo ""

if [ "$TAG_ONLY" -eq 1 ]; then
  echo -e "${GREEN}✅ 已打标签（未推送）。检查无误后去掉 --tag-only 重跑即可推送。${NC}"
  exit 0
fi

# ── 推送 ──
echo "[3/4] 推送（单镜像 8~9GB，首次上传较慢；同仓库第 2 个 tag 复用 blob 层，很快）..."
FAIL=0
for IMG in "${TAGGED[@]}"; do
  echo -n "  → $IMG ... "
  if docker push "$IMG" > /tmp/wr-push.log 2>&1; then
    echo -e "${GREEN}OK${NC}"
  else
    echo -e "${RED}失败${NC}"; tail -3 /tmp/wr-push.log; FAIL=1
  fi
done
echo ""

# ── 匿名可拉性验证 ──
echo "[4/4] 匿名可拉性验证..."
for IMG in "${TAGGED[@]}"; do
  REG="${IMG%%/*}"; REST="${IMG#*/}"; REPO_PATH="${REST%%:*}"; TAG_NAME="${IMG##*:}"
  code=$(timeout 20 curl -s -o /dev/null -w "%{http_code}" "https://${REG}/v2/${REPO_PATH}/manifests/${TAG_NAME}" 2>/dev/null || echo "000")
  case "$code" in
    200) echo "  $IMG → HTTP 200 ✅（直接可拉）" ;;
    401) echo "  $IMG → HTTP 401 ✓（标准鉴权流程，匿名换 token 后可拉）" ;;
    *)   echo "  $IMG → HTTP $code ⚠️（检查仓库是否创建/权限）" ;;
  esac
done

echo ""
if [ "$FAIL" -eq 0 ]; then echo -e "${GREEN}✅ 发布完成${NC}"; else echo -e "${YELLOW}⚠️ 部分推送失败，见上方日志${NC}"; fi
for reg in "${REGISTRIES[@]}"; do
  case "$reg" in "$CN_REG") NS="$CN_NS" ;; *) NS="$INTL_NS" ;; esac
  echo "  $reg/$NS/$REPO:<tag>"
done
echo ""
