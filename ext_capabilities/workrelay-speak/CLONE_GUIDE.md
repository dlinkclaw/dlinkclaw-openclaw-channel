# WorkRelay 语音合成（TTS）扩展能力 — 声音克隆配置说明书

> 适用：已安装 workrelay-speak 扩展能力（默认 Kokoro 预设声音可用）的用户，
> 需要**克隆自己的声音**（做视频配音、个性化语音等场景）时的进阶配置。

---

## 一、原理说明

- WorkRelay TTS 扩展能力基于 Docker 部署的 **Voicebox** 服务，默认使用 **Kokoro** 小模型（82M，50+ 预设音色，开箱即用）。
- **Kokoro 不支持声音克隆**（只支持预设音色）。
- **声音克隆需要 Qwen3-TTS（千问）模型**（1.7B，约 4.6GB），Voicebox 内置支持 zero-shot 克隆：
  上传一段参考音频 + 逐字稿 → 生成克隆声音 profile → 用该 profile 合成语音。

---

## 二、准备工作

| 项目 | 要求 |
|---|---|
| 已安装 workrelay-speak 扩展 | Voicebox 容器运行中（`docker ps` 能看到 voicebox） |
| 参考音频 | 1~5 段**清晰人声**（10~30 秒/段，44.1kHz 或 48kHz 更佳，无明显噪音） |
| 逐字稿 | 每段音频对应的**逐字文本**（必须和音频内容一字不差，克隆质量关键） |
| 磁盘空间 | ≥ 5GB（千问模型 4.6GB） |

> 音频格式支持 wav / mp3 / m4a / webm 等（opuse/webm 会自动转码）。

---

## 三、配置步骤

### 第 1 步：下载千问 TTS 模型

> ⚠️ 容器内直连 huggingface.co 通常不通（国内网络），需在**宿主机**预下载后放入容器缓存卷。

```bash
# 1) 安装下载工具（宿主机执行，一次性）
python3 -m pip install --break-system-packages huggingface_hub

# 2) 找到容器缓存卷路径
HF_VOL=$(docker volume inspect voicebox_huggingface-cache -f '{{.Mountpoint}}')

# 3) 下载千问 1.7B 模型（约 4.6GB，视网速 5~30 分钟）
HF_LOC=$(python3 -m pip show huggingface_hub | grep Location | awk '{print $2}')
sudo env PYTHONPATH="$HF_LOC" HF_HUB_DISABLE_PROGRESS_BARS=1 python3 -c "
from huggingface_hub import snapshot_download
snapshot_download('Qwen/Qwen3-TTS-12Hz-1.7B-Base', cache_dir='$HF_VOL')
print('模型下载完成')
"
```

### 第 2 步：让容器离线加载模型

```bash
# 在 Voicebox 仓库目录生成 override 配置并重建容器
cd ~/.workrelay/voicebox
cat > docker-compose.override.yml <<'EOF'
services:
  voicebox:
    environment:
      - HF_HUB_CACHE=/home/voicebox/.cache/huggingface
      - HF_HUB_OFFLINE=1
EOF
docker compose up -d
# 等待容器 healthy（约 30 秒）
```

### 第 3 步：创建克隆声音 profile

```bash
# 创建克隆 profile（cloned 类型）
curl -X POST http://127.0.0.1:17600/profiles \
  -H "Content-Type: application/json" \
  -d '{"name":"我的克隆声音","description":"我的声音克隆","language":"zh","voice_type":"cloned"}'
# 记下返回的 "id"（形如 xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx），下面用 <PROFILE_ID> 代替
```

### 第 4 步：上传参考音频样本

```bash
# 每段音频一条命令；reference_text 必须与音频内容逐字一致！
curl -X POST "http://127.0.0.1:17600/profiles/<PROFILE_ID>/samples" \
  -F "file=@/path/to/sample1.wav" \
  -F "reference_text=这段音频里说的话，逐字写在这里"

# 建议上传 2~5 段同一个人不同语句的样本，克隆效果更好
```

### 第 5 步：用克隆声音合成

```bash
# 方式 A：命令行直接合成（WR_VOICEBOX_PROFILE_ID 指向克隆 profile）
WR_VOICEBOX_PROFILE_ID=<PROFILE_ID> \
  ~/.workrelay/speak/workrelay-tts.sh "用克隆声音说的测试文字" /tmp/clone-test.wav

# 方式 B：让 OpenClaw 默认用克隆声音回复（写入 profile_id 文件，覆盖默认预设）
echo "<PROFILE_ID>" > ~/.workrelay/speak/profile_id
```

> 引擎无需手动指定：克隆 profile 未设引擎时，脚本自动使用 qwen（千问）。
> 想切回默认 Kokoro 预设声音：`rm -f ~/.workrelay/speak/profile_id` 即可。

---

## 四、验证

```bash
# 检查克隆 profile 及样本
curl http://127.0.0.1:17600/profiles/<PROFILE_ID>
curl http://127.0.0.1:17600/profiles/<PROFILE_ID>/samples

# 试听合成的 wav
ls -la /tmp/clone-test.wav
```

---

## 五、常见问题

| 问题 | 原因 / 解决 |
|---|---|
| 合成报 `Profile not found` | profile_id 写错，或 profile 被删；重新创建并核对 |
| 合成报模型下载失败/连不上 HF | 模型未预下载或 override 未生效；重做第 1、2 步 |
| 克隆声音不像 | 样本太短/有噪音/逐字稿不匹配；换更清晰样本、多传几段 |
| 想恢复默认声音 | 删除 `~/.workrelay/speak/profile_id` |

---

*文档版本：2026-08-12（基于 WorkRelay workrelay-speak 扩展能力实测）*
