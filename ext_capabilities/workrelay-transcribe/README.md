# WorkRelay 语音转录模块

## 文件说明

| 文件 | 作用 |
|------|------|
| `transcribe.py` | faster-whisper 转录引擎（纯 Python，CPU 推理） |
| `transcribe_server.py` | **常驻转写服务**（2026-08-12 新增）：模型加载一次常驻内存，免每次重新加载 |
| `voicebox-transcribe.sh` | 转录桥接：优先常驻服务 → 直接本地 → 可选远程 fallback |
| `install.sh` | 一键安装（依赖→模型→启动常驻服务→OpenClaw 配置） |
| `status.sh` | 状态查询，输出 JSON，客户端判断"已启用/未启用" |

## 客户端集成方案

### 设置页面

```
┌─────────────────────────────────────┐
│  ⚙️ 语音转录                        │
│                                     │
│  状态: ● 已启用 / ○ 未启用          │
│                                     │
│  模型: faster-whisper-small         │
│  存储: ~460MB（常驻内存）           │
│                                     │
│  [ 启用语音转录 ]  ← 仅未启用时显示  │
└─────────────────────────────────────┘
```

### 交互流程

```
客户端设置页 → 点击[启用] → 发送指令给 Agent
                           → Agent 执行 install.sh
                           → 返回进度/结果
                           → 客户端刷新状态

客户端设置页 → 加载时 → 调用 status.sh
                     → 解析 JSON
                     → 显示状态
```

### status.sh 返回格式

```json
{
  "status": "enabled",    // enabled | disabled | partial
  "description": "语音转录已启用",
  "checks": {
    "faster_whisper": true,
    "model": true,
    "scripts": true,
    "openclaw_config": true
  }
}
```

status 为 `enabled` 时四项全部为 true。

## 环境变量（可选）

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `WR_WHISPER_MODEL` | `small` | 模型大小（small 默认，广东话/普通话均可用） |
| `WR_WHISPER_CACHE` | `~/.cache/faster-whisper` | 模型缓存目录 |
| `WR_WHISPER_PORT` | `17890` | 常驻服务端口 |
| `WR_INSTALL_DIR` | `~/.workrelay/transcribe` | 脚本安装目录 |
| `WR_FALLBACK_URL` | 无 | 远程转录服务 URL（不设则仅本地） |

## 限制

- 仅支持 **Linux / macOS**（Windows 用户需 WSL2）
- 需要 **1GB+** 可用磁盘空间
- 需要可访问 HuggingFace（下载模型，small ~460MB）
- 常驻服务首次启动加载模型约 5-10 秒，之后转写即时（3-5 秒）
- OpenClaw 内置 `MIN_AUDIO_FILE_BYTES=1024`，小于 1KB 的语音不会触发转录
