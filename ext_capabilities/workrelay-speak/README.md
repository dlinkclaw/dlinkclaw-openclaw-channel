# WorkRelay 语音合成（TTS）模块

Agent 语音回复能力：Docker 部署 **Voicebox**（默认 **Kokoro** 引擎，82M 轻量模型），
50+ 预设音色，开箱即用，CPU 推理快。

## 文件说明

| 文件 | 作用 |
|------|------|
| `workrelay-tts.sh` | TTS 桥接脚本（调 Voicebox Docker REST API） |
| `install.sh` | 一键安装（Docker → 克隆仓库 → 启动容器 → 模型预下载 → 配置 OpenClaw） |
| `status.sh` | 状态查询，输出 JSON，客户端判断"已启用/未启用" |
| `CLONE_GUIDE.md` | 声音克隆进阶配置说明书（可选，需千问 Qwen3-TTS 模型） |
| `QWEN_GUIDE.md` | 使用 Qwen3-TTS（千问）引擎说明书（含预设音色 Vivian + 切引擎步骤） |

## 依赖

- **Docker** (docker + docker compose v2)
- **Voicebox** (`jamiepine/voicebox`) — 通过 Docker 部署
- TTS 引擎：**Kokoro**（默认，82M，CPU 推理，50+ 预设音色）
- 首次安装：下载 Docker 镜像 + Kokoro 模型（约 350MB）

> 声音克隆（可选）：需另配 Qwen3-TTS 1.7B 模型（~4.6GB），详见 `CLONE_GUIDE.md`。

## 客户端集成方案

### 设置页面

```
┌─────────────────────────────────────┐
│  🎙️ 语音合成（TTS）                 │
│                                     │
│  状态: ● 已启用 / ○ 未启用          │
│                                     │
│  引擎: Kokoro (预设 50+ 音色)       │
│  服务: Voicebox (Docker)            │
│                                     │
│  [ 启用语音合成 ]  ← 仅未启用时显示  │
└─────────────────────────────────────┘
```

### status.sh 返回格式

```json
{
  "status": "enabled",
  "description": "语音合成已启用",
  "endpoint": "http://127.0.0.1:17493",
  "checks": {
    "docker": true,
    "container": true,
    "api": true,
    "tts_script": true,
    "openclaw_config": true
  }
}
```

### OpenClaw 自动配置项

| 配置路径 | 值 |
|----------|-----|
| `messages.tts.auto` | `off`（手动触发） |
| `messages.tts.provider` | `tts-local-cli` |
| `messages.tts.providers.tts-local-cli.command` | `workrelay-tts.sh` |
| `messages.tts.providers.tts-local-cli.args` | `["{{Text}}","{{OutputPath}}"]` |
| `messages.tts.providers.tts-local-cli.outputFormat` | `wav` |
| `messages.tts.providers.tts-local-cli.timeoutMs` | `180000` |
| `mcp.servers.voicebox.url` | `http://127.0.0.1:17493/mcp` |

## 环境变量（可选）

| 变量 | 说明 | 默认 |
|------|------|------|
| `WR_VOICEBOX_PROFILE_ID` | 指定声音 profile（预设或克隆，不设则自动解析） | 自动 |
| `WR_VOICEBOX_HOST` | Voicebox 地址 | 127.0.0.1 |
| `WR_VOICEBOX_PORT` | Voicebox 端口 | 17493 |
| `WR_VOICEBOX_ENGINE` | TTS 引擎（不设则按 profile 自动匹配） | 自动 |
| `WR_VOICEBOX_LANG` | 语言 | zh |
