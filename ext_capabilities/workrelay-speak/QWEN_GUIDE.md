# WorkRelay 语音合成（TTS）— 使用 Qwen3-TTS（千问）引擎说明书

> 适用：已安装 workrelay-speak 扩展能力，想把 TTS 引擎从默认 Kokoro 换成
> **Qwen3-TTS 1.7B**（千问）的用户。千问模型效果更好、支持声音克隆，
> 代价是模型大（~4.6GB）、CPU 合成较慢。

---

## 一、两个引擎怎么选

| 项目 | Kokoro（默认） | Qwen3-TTS 1.7B（千问，可选） |
|------|---------------|------------------------------|
| 模型大小 | 82M（~350MB 落盘） | 1.7B（~4.6GB 落盘） |
| CPU 合成速度 | 快（秒级） | 较慢（10~60 秒/句，视文本长度） |
| 音色 | 50+ 预设音色 | 预设音色（Vivian 中文女声等）+ **声音克隆** |
| 中英混读 | 支持（install.sh 自动打补丁） | 支持 |
| 适合场景 | 默认开箱即用 | 追求音质 / 需要克隆自己的声音 |

> 声音克隆的完整步骤见同目录 `CLONE_GUIDE.md`；本说明聚焦「把引擎切到千问」。

---

## 二、第 1 步：下载千问模型（宿主机执行，一次性）

> ⚠️ 容器内直连 huggingface.co 通常不通（国内网络），必须在**宿主机**预下载后放入容器缓存卷。

```bash
# 1) 安装下载工具（没有则装）
python3 -m pip install --break-system-packages huggingface_hub

# 2) 找到容器缓存卷路径（compose 模式卷名带前缀；run 回退模式是裸卷，二选一）
HF_VOL=$(docker volume inspect voicebox_huggingface-cache -f '{{.Mountpoint}}' 2>/dev/null)
[ -z "$HF_VOL" ] && HF_VOL=$(docker volume inspect huggingface-cache -f '{{.Mountpoint}}' 2>/dev/null)

# 3) 下载千问 1.7B 模型（约 4.6GB，视网速 5~30 分钟）
HF_LOC=$(python3 -m pip show huggingface_hub | grep Location | awk '{print $2}')
sudo env PYTHONPATH="$HF_LOC" HF_HUB_DISABLE_PROGRESS_BARS=1 python3 -c "
from huggingface_hub import snapshot_download
snapshot_download('Qwen/Qwen3-TTS-12Hz-1.7B-Base', cache_dir='$HF_VOL')
print('模型下载完成')
"
```

> 无 sudo 权限时：直接去掉 `sudo env`，用 `PYTHONPATH=... python3 -c "..."` 执行。

---

## 三、第 2 步：确认容器离线加载配置

install.sh 安装时（compose 模式）已自动生成 `docker-compose.override.yml`，
包含离线加载环境变量。确认一下即可：

```bash
# Voicebox 仓库目录：install.sh 输出的实际路径（默认 ~/.workrelay/voicebox，
# snap docker 环境为 /var/snap/docker/common/workrelay-voicebox）
cd ~/.workrelay/voicebox

# 查看 override（应含 HF_HUB_CACHE 与 HF_HUB_OFFLINE=1）
cat docker-compose.override.yml

# 若文件缺失或内容不对，手动写入并重建容器：
cat > docker-compose.override.yml <<'EOF'
services:
  voicebox:
    environment:
      - HF_HUB_CACHE=/home/voicebox/.cache/huggingface
      - HF_HUB_OFFLINE=1
EOF
docker compose up -d
```

---

## 四、第 3 步：选择 / 创建千问 profile

**方式 A：用已有千问预设音色（Vivian 中文女声）**

install.sh 已自动创建过「小朵中文女声」profile（`preset_engine=qwen_custom_voice`，`preset_voice_id=Vivian`）。
查询确认并拿它的 id：

```bash
curl -s http://127.0.0.1:17600/profiles | python3 -m json.tool | grep -B2 -A6 "qwen"
```

**方式 B：新建一个千问 preset profile**

```bash
curl -X POST http://127.0.0.1:17600/profiles \
  -H "Content-Type: application/json" \
  -d '{"name":"我的千问声音","description":"Qwen3-TTS 预设","language":"zh","voice_type":"preset","preset_engine":"qwen_custom_voice","preset_voice_id":"Vivian"}'
# 记下返回的 "id"，下面用 <PROFILE_ID> 代替
```

**方式 C：克隆自己的声音** → 走 `CLONE_GUIDE.md`（克隆出的 profile 引擎自动是千问）。

---

## 五、第 4 步：把千问设为默认引擎

```bash
# 写入 profile_id 文件（覆盖默认 Kokoro），workrelay-tts.sh 会自动读取
echo "<PROFILE_ID>" > ~/.workrelay/speak/profile_id
```

> 也可以不写文件、临时指定：`WR_VOICEBOX_PROFILE_ID=<PROFILE_ID> ~/.workrelay/speak/workrelay-tts.sh "文本" /tmp/out.wav`
>
> 引擎无需手动指定：脚本按 profile 的 `default_engine` 自动匹配（qwen profile 自动走千问）。

---

## 六、验证

```bash
# 1) 确认 profile 存在
curl http://127.0.0.1:17600/profiles/<PROFILE_ID>

# 2) 命令行试合成（千问 CPU 较慢，耐心等）
WR_VOICEBOX_PROFILE_ID=<PROFILE_ID> \
  ~/.workrelay/speak/workrelay-tts.sh "你好，我是小朵，今天用千问模型给你合成语音。" /tmp/qwen-test.wav

# 3) 听一下（或看文件大小/时长）
ls -la /tmp/qwen-test.wav
```

---

## 七、常见问题

| 问题 | 原因 / 解决 |
|------|------------|
| 合成报模型下载失败 / 连不上 HF | 模型未预下载或 override 未生效；重做第 1、2 步 |
| 合成很慢 | 千问 1.7B CPU 推理正常现象；短句更快，可调大 OpenClaw `timeoutMs`（默认 180s 够用） |
| 合成报 `Profile not found` | profile_id 写错或 profile 被删；重新创建并核对 |
| 重跑 install.sh 后声音变回 Kokoro | install.sh 每次安装会重置默认 profile_id；按第 4 步重新 `echo` 千问 id 即可 |
| 想切回 Kokoro 默认声音 | `rm -f ~/.workrelay/speak/profile_id` |
| 想克隆自己的声音 | 见 `CLONE_GUIDE.md` |

---

## 八、附：关键信息速查

| 项目 | 值 |
|------|-----|
| 千问模型 | `Qwen/Qwen3-TTS-12Hz-1.7B-Base`（~4.6GB） |
| Voicebox API | `http://127.0.0.1:17600`（compose 固定映射；run 回退模式可能为 17493，以 status.sh 输出 endpoint 为准） |
| 缓存卷 | `voicebox_huggingface-cache`（compose）/ `huggingface-cache`（run 回退） |
| 引擎自动匹配 | 脚本读 profile 的 `default_engine`（qwen_custom_voice → 千问） |

---

*文档版本：2026-08-13（基于 WorkRelay workrelay-speak 扩展能力实测）*
