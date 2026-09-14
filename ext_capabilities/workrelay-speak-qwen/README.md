# WorkRelay 语音合成（千问 Qwen3-TTS）扩展能力

Agent 语音回复能力：Docker 部署 **Voicebox**（**Qwen3-TTS CustomVoice 1.7B** 引擎），
9 种预设音色（含中文女声 Vivian），中英日韩多语种，断句/语速自然，适合视频配音。

> 2026-09-14 新增。与 `workrelay-speak`（Kokoro）、`workrelay-speak-luxtts`（LuxTTS）**互斥**：
> TTS 同时只能启用一个，启用本能力会自动停止其它两个 TTS 容器并接管 `tts.provider`。

## 文件说明

| 文件 | 作用 |
|------|------|
| `workrelay-tts.sh` | TTS 桥接脚本（调 voicebox-qwen REST API，固定引擎 qwen_custom_voice） |
| `install.sh` | 一键安装（拉镜像 → 下载千问模型 → 起容器 → 建音色 profile → 互斥 → 配 OpenClaw） |
| `status.sh` | 状态查询（含**互斥判定**：读 `tts.provider` 判断是否当前启用） |
| `manifest.json` | 前置条件清单（含镜像仓库可达性 + GPU 检测） |

## 关键参数

| 项 | 值 |
|---|---|
| 容器名 | `voicebox-qwen` |
| 端口 | `17602`（Kokoro 17493/17600、LuxTTS 17601） |
| 镜像 | `crpi-...aliyuncs.com/shiduo/workrelay-tts:20260813`（复用，已含 qwen_custom_voice 后端） |
| 模型 | `Qwen/Qwen3-TTS-12Hz-1.7B-CustomVoice`（~4.6GB，安装时经 hf-mirror.com 下载） |
| 音色 profile | Vivian（中文女声）；其它：Serena/Uncle_Fu/Dylan/Eric/Ryan/Aiden/Ono_Anna/Sohee |
| OpenClaw provider | `tts-local-cli-qwen`（配置在顶层 `tts.providers.*`） |
| 合成超时 | 300000 ms（5 分钟，CPU 推理较慢） |

## 状态返回（status.sh）

```json
{
  "status": "enabled | disabled | partial",
  "description": "…",
  "endpoint": "http://127.0.0.1:17602",
  "checks": {
    "docker": true, "container": true, "api": true,
    "tts_script": true, "profile": true,
    "openclaw_config": true, "provider_active": true
  }
}
```

- `provider_active=true` → 当前 TTS 就是本引擎（`tts.provider=tts-local-cli-qwen`）
- `provider_active=false` → 已安装但被其它 TTS 接管 → 状态显示"已安装但未启用"

## 管理命令

```bash
docker ps | grep voicebox-qwen          # 查看容器
docker logs -f voicebox-qwen            # 查看日志
curl -s http://127.0.0.1:17602/profiles # 查看音色 profile
docker stop voicebox-qwen               # 停用（并把 tts.provider 切回其它引擎）
```

## GPU 说明

- 有 NVIDIA GPU（`nvidia-smi` 可用）→ 安装时自动 `--gpus all`，合成快
- 无独显 → CPU 合成，1.7B 模型约 10~60 秒/句（慢但可用）

*文档版本：2026-09-14*
