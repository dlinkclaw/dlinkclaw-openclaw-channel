# WorkRelay 语音功能最低硬件配置

## 一、语音转录（faster-whisper）

| 项目 | 最低要求 | 推荐配置 |
|------|----------|----------|
| **CPU** | 双核 2.0GHz+ | 四核 2.5GHz+ |
| **内存** | 4GB 可用 | 8GB+ |
| **磁盘** | 2.5GB 可用 | 5GB+ |
| **OS** | Linux / macOS | Ubuntu 22.04+ |
| **Python** | 3.8+ | 3.10+ |

**额外依赖：** `pip`, `git`（标准 Linux 发行版自带）

**实测数据（8核 31GB Linux CPU）：**
- 首次加载模型：10-20 秒
- 10 秒语音转录：2-5 秒
- 30 秒语音转录：5-10 秒

> ⚠️ 不支持原生 Windows（需 WSL2）

---

## 二、语音合成 / 声音克隆（Voicebox TTS，Docker）

| 项目 | 最低要求 | 推荐配置 |
|------|----------|----------|
| **CPU** | 双核 2.0GHz+ | 四核 3.0GHz+ |
| **内存** | 4GB 可用 | 8GB+ |
| **磁盘** | 10GB 可用 | 15GB+ |
| **OS** | Linux（需 Docker） | Ubuntu 22.04+ |
| **Docker** | 24.0+ | 27.0+ |
| **GPU** | 无（CPU 推理） | NVIDIA CUDA（加速 5-10x） |

**额外依赖：** `docker`, `docker compose v2`, `git`

**Docker 资源（默认 Kokoro 引擎）：**
- Voicebox 镜像：~11GB（含全部 TTS 引擎依赖）
- Kokoro 模型：~350MB（默认，安装时自动预下载）
- 运行内存：~2-3GB（Docker 内，Kokoro CPU 推理）

**实测数据（8核 31GB Linux CPU，Kokoro）：**
- 短句（10 字）：1-3 秒
- 中句（30 字）：3-8 秒
- 长句（100 字）：10-20 秒

> 默认使用 Kokoro（82MB）轻量引擎，开箱即用；
> 如需声音克隆或更高音质，可另配 Qwen3-TTS 1.7B（~4.6GB，内存需求 6GB+），详见 `CLONE_GUIDE.md`。

---

## 三、两个功能同时启用

| 项目 | 最低要求 | 推荐配置 |
|------|----------|----------|
| **CPU** | 四核 2.5GHz+ | 八核 3.0GHz+ |
| **内存** | 12GB 可用 | 16GB+（配置给 Docker 8GB） |
| **磁盘** | 15GB 可用 | 25GB+ |
| **GPU** | 无 | NVIDIA CUDA |

**内存分配建议（16GB 总内存场景）：**
- faster-whisper 模型常驻：~2GB
- Voicebox Docker 容器：~6-8GB
- 剩余系统缓冲：~6-8GB

---

## 四、客户端提示文案建议

### 转录
```
最低：2核 CPU + 4GB 内存 + 2.5GB 磁盘
推荐：4核 CPU + 8GB 内存 + 5GB 磁盘
不支持原生 Windows（需 WSL2）
首次安装需下载 1.6GB 模型文件
```

### 语音合成
```
最低：2核 CPU + 4GB 内存 + 10GB 磁盘 + Docker
推荐：4核 CPU + 8GB 内存 + 15GB 磁盘 + Docker
首次安装需下载 Docker 镜像 + Kokoro 模型（~350MB）
默认 Kokoro 轻量引擎，CPU 推理快，开箱即用
```
