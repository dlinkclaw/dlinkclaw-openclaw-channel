# dlinkclaw-openclaw

**DLinkClaw（朵联统一 AI 工作台）的 OpenClaw 接入通道插件**

DLinkClaw 朵联统一 AI 工作台是一款企业级即时通讯 + 多智能体协作客户端，支持机器人、群组、语音、文件等多形态消息互通。本插件作为 **OpenClaw 的 channel 中继**，将你的 OpenClaw 网关安全地接入 DLinkClaw —— 让部署在家或公司内网的 OpenClaw 通过朵联工作台随时随地使用，实现内外自由连接。

---

## 界面一览

![DLinkClaw 朵联统一 AI 工作台](https://dlinkclaw.com/dlinkclaw-app.png)


> 截图：DLinkClaw 客户端 —— 左侧机器人/群组会话列表、中间多智能体对话区、右侧工作区/自动化面板。

---

## 特性

- **多 OpenClaw 实例**：可同时接入多个 OpenClaw 网关，每个实例独立部署、独立账号，工作台内自由切换。
- **多 DSH 实例**：同样支持接入多个 DSH（DeepSeek）实例，与 OpenClaw 实例统一管理。
- **更多 Agent 实例**：单个实例可暴露任意数量的 Agent（技术专家、研究员、文案专员、小红书助手等），在工作台中以机器人形式呈现。
- **单聊 / 群聊**：支持与机器人一对一对话，也可拉入群组协作，群内多 Agent 可互相调用。
- **双向中继**：OpenClaw 的回复、主动出站消息经 MQTT 中继到 DLinkClaw 客户端；客户端消息实时推送到 OpenClaw 会话。
- **扩展能力**：内置语音合成 / 语音转写等扩展能力（`ext_capabilities`），开箱即用。
- **安全接入**：AES 签名认证 + MQTT 加密通道，内网部署无需暴露公网端口。

> 更多多实例、多 Agent 的能力与配置方式，请到**官网了解**：https://dlinkclaw.com

---

## 客户端下载

使用本插件需要 **DLinkClaw（朵联统一 AI 工作台）客户端**：

👉 **下载地址：https://dlinkclaw.com**

---

## 插件安装（OpenClaw 侧）

```bash
# 1. 安装插件
openclaw plugins install npm:dlinkclaw-openclaw

# 2. 添加 dlink 通道
openclaw channels add --channel dlink

# 3. 配置（填入朵联 apiKey / secret / baseUrl）
openclaw configure
```

安装完成后，在 DLinkClaw 客户端中即可看到接入的 OpenClaw 机器人并开始对话。

---

## 配置说明

| 配置项 | 说明 |
| --- | --- |
| `apiKey` | 朵联平台分配的 apiKey |
| `secret` | 朵联签名密钥（AES 加密通信用）|
| `baseUrl` | 朵联服务回调 URL |
| `accountId` | 账号标识，默认 `default` |
| `mediaMaxMb` | 媒体大小上限（MB），默认 100 |

---

## 使用说明

1. 在 DLinkClaw 客户端登录并进入 **机器人** 列表。
2. 添加/打开接入的 OpenClaw Agent 即可开始对话。
3. 需要模型切换、上下文占用率等高级能力，请确保 OpenClaw 网关运行正常。

---

## 许可

[MIT](./LICENSE)
