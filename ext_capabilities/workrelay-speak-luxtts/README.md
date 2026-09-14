# WorkRelay 语音合成（LuxTTS 克隆声）

Agent 语音回复能力：Docker 部署 Voicebox（**LuxTTS 引擎**），内置**石头哥克隆声音**，音色自然。

## 特点

- **独立容器**：容器名 `voicebox-luxtts`，端口 `17601`，与 Kokoro 版（`voicebox` / 17493）**互不干扰，可同时安装**
- **克隆声音**：安装时自动创建克隆 profile（内置 4 个声音样本），开箱即有"石头哥克隆声"
- **引擎固定**：LuxTTS 为纯克隆声音引擎（无预设音色），桥接脚本固定 `engine=luxtts`
- **生产可用**：镜像含 LuxTTS 模型（1.1G），拉取即用，无需再下载模型

## 安装

扩展能力页 → 语音合成（LuxTTS 克隆声）→ 启用，或手动执行：

```bash
bash install.sh
```

前置条件：Linux + Docker（6GB 内存、10GB 磁盘）。

## 使用

安装后 OpenClaw 自动配置 `messages.tts.provider=tts-local-cli-luxtts`，
桥接脚本 `~/.workrelay/speak-luxtts/workrelay-tts.sh` 调用 `http://127.0.0.1:17601`。

声音 profile 记录在 `~/.workrelay/speak-luxtts/profile_id`，可用环境变量覆盖：

```bash
WR_VOICEBOX_PROFILE_ID=<profile_id>  # 指定其它克隆声音
WR_VOICEBOX_LUXTTS_PORT=17601        # 覆盖端口
```

## 与 Kokoro 版（workrelay-speak）关系

| 项 | workrelay-speak | workrelay-speak-luxtts |
|---|---|---|
| 容器名 | voicebox | voicebox-luxtts |
| 端口 | 17493/17600 | 17601 |
| 引擎 | Kokoro-82M | LuxTTS |
| 声音 | 50+ 预设音色 | 石头哥克隆声（可换） |
| OpenClaw provider | tts-local-cli | tts-local-cli-luxtts |

两者可共存，OpenClaw 当前生效的 TTS 由 `messages.tts.provider` 决定（后启用者生效）。
