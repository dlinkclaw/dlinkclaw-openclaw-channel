
import EventEmitter from 'events';
// 2026-09-06 适配 openclaw 2026.9.1：根入口已移除，改从 core 导入
import { OpenClawConfig, PluginLogger } from 'openclaw/plugin-sdk/core';
import { AccumulatorsStatus, AutoReplyOpts, buildDLReplyMessage, messagePreviewHandler } from './message.js';
import { BotType, DLArchiveSession, DLKind, DLMessage, DLMessagePayload, DLResolvedAccount, MessageStatus } from './types.js';
import mqtt from 'mqtt';
import { DLHttp } from './dl-http.js';
import { decryptAesEcbPkcs5 } from './crypto.js';
import { AUTO_RELAY_API, AUTO_RELAY_PERSONA, AUTO_RELAY_APPROVAL_EVENT, AUTO_RELAY_UPLOAD, AUTO_RELAY_PERMISSION_CHECK, AUTO_RELAY_MODEL_CATALOG, AUTO_RELAY_MODEL_CHECK } from './const.js';
import { CmdHandler, createCmdHandler } from '../services/index.js';
import { CmdMessage, CmdResponse, CmdResult, EventType } from '../services/types.js';
import { uuidStr } from '../utils.js';
//import { getDLRuntime } from '../runtime.js';


export type DLContext = {
    account: DLResolvedAccount,
    channelId: string,
    cfg: OpenClawConfig,
    rbotId?: string
}

export interface DLMessageContext {
    ctx: DLContext,
    msg: DLMessagePayload,
    accStatus: AccumulatorsStatus
}

export type DLReceiveMessageHandler = (topic: string, msg: DLMessagePayload) => void;


export interface MqttConfig {
    url: string
    port: number
    websocketPort: number
    serverId: string
    qos: 0 | 1 | 2
    userName: string
    password: string
    willTopic: string
    serverTopics: Array<string>
    clientTopics: Array<string>
    openUserTopics: Array<string>
    openUserNotifyTopics: Array<string>
    /** 2026-10-21：团队创建人 empId（owner-only 能力校验） */
    ownerEmpId?: string
}

export class DLClient extends EventEmitter {
    private ctx: DLContext;
    private mqttConfig: MqttConfig | null = null;
    private mqttClient: mqtt.MqttClient | null = null;
    private cmdHandler: CmdHandler | null = null;
    private readonly http: DLHttp;
    private readonly logger: PluginLogger;
    private readonly accountLog: string;
    private lastInboundAt: number | null = null;
    //private runtime: PluginRuntime | null = null;
    constructor(ctx: DLContext, logger: PluginLogger) {
        super();
        this.ctx = ctx;
        this.logger = logger;
        this.accountLog = `account[${ctx.account.accountId}] [DL-Client.ts]`;
        const { baseUrl, apiKey, secret } = ctx.account.config;
        this.http = new DLHttp({ baseUrl, apiKey, secret }, logger);
        this.initCmdHandler();
    }

    /**
     * 2026-09-16 修复（石头哥报：加同事后 model.list / session.list 全空）：
     * cmdHandler 原来只在构造函数里创建一次，任何把它置空的路径（stop / 刷新配置）
     * 都会导致「此后永远为 null」→ 所有 cmd 请求失败且不可自愈（只能重启 openclaw 网关）。
     * 抽成幂等方法后，start() 会兜底重建。
     */
    private initCmdHandler(): void {
        if (this.cmdHandler) {
            return;
        }
        const cfg = this.ctx.cfg;
        if (cfg.gateway?.auth?.token) {
            const token = cfg.gateway.auth.token.toString();
            const gatewayUrl = 'ws://127.0.0.1:18789';
            this.cmdHandler = createCmdHandler({
                cfg,
                channelId: this.ctx.channelId,
                gatewayUrl,
                token,
                baseUrl: this.ctx.account.config.baseUrl
            }, this, this.logger)
        }
    }

    /**
     * 2026-10-26：拉取当前会话所属 agent 的人格与生效约定（人设注入用）。
     * 失败返回 null，调用方降级为不注入，不影响正常对话。
     */
    async fetchPersona(sessionKey: string, agentId?: string): Promise<any | null> {
        try {
            const body: Record<string, string> = { sessionKey };
            if (agentId) {
                body.agentId = agentId;
            }
            const data = await this.http.post<any>(AUTO_RELAY_PERSONA, body);
            return data ?? null;
        } catch (e) {
            this.logger.warn(`fetchPersona failed: ${e}`);
            return null;
        }
    }

    /**
     * 2026-10-31 模型授权二次校验：应用模型覆盖前调用中继。
     */
    async checkModel(sessionKey: string, provider: string, model: string): Promise<any> {
        const data = await this.http.post<any>(AUTO_RELAY_MODEL_CHECK, { sessionKey, provider, model });
        return data ?? null;
    }

    /**
     * 2026-10-31 模型目录上报：握手后把归一化的 provider/model 列表推给中继，
     * 供客户端按规则过滤与切换校验使用。
     */
    async pushModelCatalog(payload: Record<string, unknown>): Promise<any> {
        try {
            // 2026-10-31 修正：中继 http 客户端签名会对参数做 trim，数组会报 value.trim is not a function；
            // 这里统一序列化为字符串参数提交，由中继侧反序列化。
            return await this.http.post<any>(AUTO_RELAY_MODEL_CATALOG, { payload: JSON.stringify(payload) });
        } catch (e) {
            this.logger.warn('pushModelCatalog failed: ' + String(e));
            return null;
        }
    }

    /**
     * 2026-10-31 档位权限：应用 presetId 之前回调中继校验。
     * 中继按 sessionKey 反查 agent 与操作人，插件不参与鉴权判定。
     */
    async checkPermission(sessionKey: string, presetId: string): Promise<any> {
        const data = await this.http.post<any>(AUTO_RELAY_PERMISSION_CHECK, { sessionKey, presetId });
        return data ?? null;
    }

    /** 2026-10-27 把审批请求交给中继（由中继扇出给最多三人） */
    async pushApprovalEvent(payload: Record<string, unknown>): Promise<any> {
        try {
            const data = await this.http.post<any>(AUTO_RELAY_APPROVAL_EVENT, payload as any);
            return data ?? null;
        } catch (e) {
            this.logger.warn(`pushApprovalEvent failed: ${e}`);
            return null;
        }
    }
    private async fetchConfig() {
        const url = `/guest/mqtt/getConfig/${this.ctx.account.config.apiKey}`;
        const res = await this.http.get<string>(url);
        if (res) {
            const secret = this.ctx.account.config.secret;
            const mqttConfig = decryptAesEcbPkcs5(res, secret);
            if (mqttConfig) {
                this.logger.info(`mqttconfig:${JSON.stringify(mqttConfig)}`)
                const topics = mqttConfig.serverTopics;
                const messageTopic = topics.find(item => item.endsWith('/message'));
                const cmdTopic = topics.find(item => item.endsWith('/cmd'));
                this.mqttConfig = { ...mqttConfig, serverTopics: [messageTopic!, cmdTopic!] };
                return;
            }
        }
        throw new Error(`Failed to get config!`);
    }

    private async changeConnectStatus(status: 'start' | 'stop') {
        const url = '/guest/relayBot/changeConnectStatus/' + this.ctx.account.config.apiKey;
        const p = {
            connect: status === 'start' ? 'true' : 'false'
        }
        return await this.http.post(url, p);
    }

    private async connect(): Promise<void> {
        if (!this.mqttConfig) {
            await this.fetchConfig();
        }
        const config = this.mqttConfig!;
        const connectionUrl = `mqtt://${config.url}:${config.port}`;
        const rbotId = config.clientTopics[0].split('/')[1]
        const msgTopic = config.clientTopics.filter((item) => item.endsWith('/message'))[0];
        const cmdTopic = config.clientTopics.filter((item) => item.endsWith('/cmd'))[0]
        const account = this.ctx.account;
        return new Promise((resolve, reject) => {
            this.mqttClient = mqtt.connect(connectionUrl, {
                clientId: `openclaw_${account.accountId}_${rbotId}_${Date.now()}`,
                username: config.userName,
                password: config.password,
                qos: config.qos as 0 | 1 | 2,
                clean: true,
                reconnectPeriod: 5000,
                connectTimeout: 30000
            } as mqtt.IClientOptions);

            this.mqttClient.on("connect", () => {
                this.logger.info(`${this.accountLog} Connected to broker`);
                this.mqttClient?.subscribe([msgTopic, cmdTopic], { qos: config.qos }, (err: Error | null) => {
                    if (err) {
                        this.logger.error(`${this.accountLog} Subscribe error:${err}`);
                    } else {
                        this.logger.info(`${this.accountLog} Subscribed to topic:[${msgTopic}, ${cmdTopic}]`);
                        this.ctx.rbotId = rbotId;
                    }
                    resolve();
                });
            });

            this.mqttClient.on("message", (topic: string, message: Buffer) => {
                try {
                    this.logger.debug ?? (`${this.accountLog} Topic: ${topic}, Received message:${message}`);
                    const payload = JSON.parse(message.toString());
                    this.receiveEventHandle(topic, payload)
                } catch (err) {
                    this.logger.error(`${this.accountLog} Failed to parse message:${String(err)}`);
                }
            });

            this.mqttClient.on("error", (err: Error) => {
                this.logger.error(`${this.accountLog} Connection error:${err}`);
                reject(err);
            });

            this.mqttClient.on("close", () => {
                this.logger.warn(`${this.accountLog} Connection closed`);
                if (this.closeHandler != null) {
                    this.closeHandler();
                }
            });

            this.mqttClient.on("reconnect", () => {
                this.logger.info(`${this.accountLog} Reconnecting...`);
            });

            // try {
            //     this.runtime = getDLRuntime();
            //     if (this.runtime) {
            //         this.runtime.events.onAgentEvent(event => {
            //             this.logger.warn(`中间文本 >>> ${JSON.stringify(event)}`)
            //             if (event?.stream === "assistant" && event.data?.phase === "commentary" && event.data?.text) {
            //                // this.logger.warn(`中间文本 >>> ${event.data?.text}`)
            //             }
            //         })
            //         this.logger.info(`runtime.events.onAgentEvent事件注册成功...`)
            //     }
            // } catch (e) {
            //     this.logger.error(`${this.accountLog} ${new String(e)}`);
            // }
        });
    }

    private async receiveEventHandle(topic: string, msg: DLMessagePayload | CmdMessage) {
        if (topic.endsWith('/cmd')) {
            // 2026-09-15 方案A（石头哥确认）：服务端在新增/移除授权成员后，会往 bot 的 cmd topic
            // 发一个轻量信号 {"type":"event","event":"openUserChanged"}。
            // 插件收到后重新拉取 mqtt 配置并重连，让 openUserTopics 立刻是最新的
            // （否则新用户收不到 onTick / onHealth / onSessionsChanged 等事件推送）。
            // 只重连插件自身的 MQTT，不重启 openclaw 网关。
            if ((msg as { event?: string } | null)?.event === 'openUserChanged') {
                void this.refreshConfigAndReconnect();
                return;
            }
            const cmdMessage = msg as CmdMessage;
            let result: CmdResponse = {
                requestId: cmdMessage.requestId,
                success: false,
                error: 'CMD 处理器未初始化',
                timestamp: Date.now()
            }
            if (this.cmdHandler?.isReady()) {
                const res = await this.cmdHandler.handleCmdMessage(cmdMessage);
                result = {
                    ...res,
                    requestId: result.requestId
                }
            }
            if (cmdMessage.from) {
                await this.publishCmdResultToDLClient(cmdMessage.from, result, "1")
            } else {
                await this.publishCmdResultToServer(result, '1');
            }
            return;
        }
        this.lastInboundAt = Date.now();
        const accStatus = messagePreviewHandler(msg as DLMessagePayload, this.ctx.account.accountId, this.logger);
        const t = this.emit('message', {
            "ctx": this.ctx,
            "msg": msg,
            "accStatus": accStatus
        }, this);
        if (!t) {
            this.logger.error('DLClient Event[message] emit fail!');
        }
    }

    private closeHandler() {
        const t = this.emit('close');
        if (!t) {
            this.logger.warn(`DLClient account[${this.ctx.account.accountId}] Event[close] emit fail!`);
        }
    }

    private publish(topic: string, payload: string, sqos?: '0' | '1' | '2'): Promise<void> {
        const qos = (sqos ? parseInt(sqos) : (this.mqttConfig?.qos ?? 0)) as (0 | 1 | 2);
        return new Promise((reslove, reject) => {
            this.mqttClient!.publish(
                topic,
                payload,
                { qos },
                (error) => {
                    if (error) {
                        const errorStr = String(error);
                        this.logger.error(`${this.accountLog} Publish error:${errorStr}`);
                        reject(errorStr)
                    } else {
                        //this.logger.info(`${this.accountLog} Published to ${topic}`);
                        reslove();
                    }
                }
            );
        })
    }

    getLastInboundAt() {
        return this.lastInboundAt;
    }

    isConnected() {
        return this.mqttClient?.connected ?? false;
    }

    async start() {
        // 2026-09-16 修复：cmdHandler 缺失就补建（幂等），保证 start() 可重入、不再出现
        // “start 之后 RPC 永久失效”的情况。
        if (!this.cmdHandler) {
            this.initCmdHandler();
        }
        if (!this.isConnected()) {
            await this.connect();
        }
        if (this.cmdHandler) {
            await this.cmdHandler.initialize();
        }
        await this.changeConnectStatus('start');
    }

    async stop() {
        // 2026-10-19：关闭阶段必须有界。MQTT end 回调或 HTTP 上报只要有一个不返回，
        // 网关的 drain 就会一直等（systemd TimeoutStopSec 默认 15 分钟），表现为重启卡死。
        if (this.mqttClient) {
            await Promise.race([
                new Promise<void>((resolve) => {
                    this.mqttClient!.end(true, () => {
                        this.mqttClient = null;
                        this.logger.warn(`DLClient account[${this.ctx.account.accountId}] Disconnected`);
                        if (this.cmdHandler) {
                            this.cmdHandler.cleanup();
                        }
                        this.cmdHandler = null;
                        this.mqttConfig = null;
                        resolve();
                    });
                }),
                new Promise<void>((resolve) => setTimeout(() => {
                    this.logger.warn(`DLClient account[${this.ctx.account.accountId}] mqtt end timeout(3s), force continue`);
                    this.mqttClient = null;
                    this.cmdHandler = null;
                    this.mqttConfig = null;
                    resolve();
                }, 1200)),
            ]);
        }
        try {
            await Promise.race([
                this.changeConnectStatus('stop'),
                new Promise<void>((resolve) => setTimeout(resolve, 5000)),
            ]);
        } catch (e) {
            this.logger.warn(`DLClient changeConnectStatus(stop) failed: ${String(e)}`);
        }
    }

    /**
     * 2026-09-15 方案A（石头哥确认）：重新拉取 mqtt 配置（含 openUserTopics）。
     * 触发时机：服务端新增/移除授权成员后，会往 bot 的 cmd topic 发 openUserChanged 信号。
     *
     * 2026-09-16 修复（石头哥报：加同事后 model.list / session.list 全部为空）：
     * 原实现是「断连 + 置空 cmdHandler + 重连」，有致命副作用——cmdHandler 只在构造函数
     * 里创建一次，置空后 start() 不会重建 → 所有 cmd RPC 永久失效，只能重启 openclaw 网关恢复。
     * 而本方法的目的只是刷新 openUserTopics——它是 publishEventToDLClient（L348）实时读取的，
     * 与 MQTT 订阅目标（clientTopics）、Gateway WS 通道都无关 → 只刷新配置即可，不断连、不重连。
     */
    /** 2026-10-21：团队创建人（终端等 owner-only 能力使用） */
    getOwnerEmpId(): string | undefined {
        return this.mqttConfig?.ownerEmpId;
    }

    async refreshConfigAndReconnect(): Promise<void> {
        try {
            await this.fetchConfig();
            this.logger.info(`${this.accountLog} mqtt 配置已刷新（openUserTopics 已更新，未重连）`);
        } catch (e) {
            this.logger.error(`${this.accountLog} 刷新 mqtt 配置失败（保持旧配置）: ${String(e)}`);
        }
    }

    async exeCmd(cmdMessage: CmdMessage) {
        if (this.cmdHandler?.isReady()) {
            return await this.cmdHandler.handleCmdMessage(cmdMessage);
        }
    }

    async publishEventToDLClient(payload: any, event: EventType, sqos?: '0' | '1' | '2', to?: string): Promise<void> {
        const timestamp = Date.now();
        const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
        const api_key = this.ctx.account.config.apiKey;
        const message: CmdResult = {
            apiKey: api_key,
            type: 'event',
            event: event,
            payload: payload,
            agentBrand: 'openClaw',
            timestamp,
            timezone
        }
        if (to && to.length > 0) {
            this.logger.info(`推送客户端事件消息, topic= ${to}`,)
            try {
                await this.publish(to, JSON.stringify(message), sqos);
                return;
            } catch (e) {
                this.logger.error(String(e))
            }
            return;
        }
        const openUserTopics = this.mqttConfig?.openUserTopics ?? []
        //this.logger.info(`推送客户端事件消息, topics= [${openUserTopics}]`,)
        for (const topic of openUserTopics) {
            try {
                await this.publish(topic, JSON.stringify(message), sqos);
            } catch (e) {
                this.logger.error(String(e))
            }
        }
    }

    async publishCmdResultToDLClient(topic: string, playload: CmdResponse, sqos?: '0' | '1' | '2'): Promise<void> {
        const timestamp = Date.now();
        const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
        const api_key = this.ctx.account.config.apiKey;
        const message: CmdResult = {
            apiKey: api_key,
            type: 'cmd',
            payload: playload,
            agentBrand: 'openClaw',
            timestamp,
            timezone
        }
        return await this.publish(topic, JSON.stringify(message), sqos);
    }

    async publishEventToServer(playload: any, event: EventType, sqos?: '0' | '1' | '2'): Promise<void> {
        const topic = this.mqttConfig?.serverTopics[1];
        if (!topic) {
            return;
        }
        const timestamp = Date.now();
        const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
        const api_key = this.ctx.account.config.apiKey;
        const message: CmdResult = {
            apiKey: api_key,
            type: 'event',
            event: event,
            payload: playload,
            agentBrand: 'openClaw',
            timestamp,
            timezone
        }
        return await this.publish(topic, JSON.stringify(message), sqos);
    }

    async publishCmdResultToServer(playload: CmdResponse, sqos?: '0' | '1' | '2'): Promise<void> {
        const topic = this.mqttConfig?.serverTopics[1];
        if (!topic) {
            return;
        }
        const timestamp = Date.now();
        const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
        const api_key = this.ctx.account.config.apiKey;
        const message: CmdResult = {
            apiKey: api_key,
            type: 'cmd',
            payload: playload,
            agentBrand: 'openClaw',
            timestamp,
            timezone
        }
        return await this.publish(topic, JSON.stringify(message), sqos);
    }

    async publishToServer(params: {
        streamId: string,
        content: string,
        finish: boolean,
        kind: DLKind,
        mediaFiles?: Array<string>,
        session?: DLArchiveSession
    }, autoParams?: AutoReplyOpts) {
        const { streamId, content, finish, mediaFiles, session, kind } = params;
        if (!this.mqttClient || !this.mqttConfig) {
            throw new Error(`${this.accountLog} client not connected`);
        }

        const message = buildDLReplyMessage({
            streamId,
            content,
            finish,
            kind
        });

        if (!message) {
            if (autoParams) {
                const { toAgent, contactId, relayId, chatId, notifyUrl, isGroup, botType } = autoParams;
                this.logger.info(`${this.accountLog} streamId:[${streamId}] has been cleaned up due to overdue. current use autoSend...`);
                const data: Record<string, string> = {
                    "chatId": chatId,
                    "botType": botType,
                    "group": isGroup ? "true" : "false",
                    "content": content ?? "",
                    "notifyUrl": notifyUrl ?? "",
                    "toAgent.id": toAgent.id,
                    "toAgent.sessionKey": toAgent.sessionKey,
                    "contactId": contactId ?? '',
                    "relayId": relayId,
                    "relayType": "openClaw"
                }
                if (session) {
                    data["archiveSession.archived"] = session.archived ? 'true' : 'false';
                    data["archiveSession.sessionKey"] = session.sessionKey;
                    if (session.newSessionKey) {
                        data["archiveSession.newSessionKey"] = session.newSessionKey;
                    }
                    data["archiveSession.runId"] = session.runId;
                }
                let res: string | undefined
                if (mediaFiles && mediaFiles.length > 0) {
                    res = await this.http.upload<string>(AUTO_RELAY_API, mediaFiles, data);
                } else if (data.content.length > 0) {
                    res = await this.http.post<string>(AUTO_RELAY_API, data);
                }
                return {
                    autoRelay: true,
                    reqId: res
                };
            }
            this.logger.error(`${this.accountLog} streamId:[${streamId}] has been cleaned up due to overdue.`);
            return {
                autoRelay: true
            }
        }

        const now = Date.now();
        if (message.relayTimeRhreshold && now > message.relayTimeRhreshold) {
            //超时回复使用主动回复
            this.logger.info(`${this.accountLog} Over the reply time, take the initiative to reply!`);
            message.notify = true;
        }

        if (mediaFiles && mediaFiles.length > 0) {
            this.logger.info(`${this.accountLog} upload media files..`);
            const data: Record<string, string> = {
                "streamId": streamId
            }
            const res = await this.http.upload<string[]>(AUTO_RELAY_UPLOAD, mediaFiles, data);
            if (res && res.length > 0) {
                this.logger.info(`${this.accountLog} upload media files success!`);
            }
        }

        if (session) {
            message.archiveSession = { ...session }
        }

        const topic = this.mqttConfig.serverTopics[0];
        try {
            await this.publish(topic, JSON.stringify(message));
            return {
                autoRelay: false,
                reqId: message.streamId
            }
        } catch (e) {
            throw e
        }
    }

    /**
     * 减轻服务端负担，将处理状态直接推送到客户端(处理结果走服务端)
     * @param params 
     */
    async publishProcessingState(params: {
        streamId: string,
        content: string,
        status: MessageStatus,
        runId?: string,
        kind: DLKind,
    }) {
        const { streamId, content, kind, status, runId } = params;
        if (!this.mqttClient || !this.mqttConfig) {
            throw new Error(`${this.accountLog} client not connected`);
        }
        const message = buildDLReplyMessage({
            streamId,
            content,
            finish: false,
            kind,
            runId
        });
        if (!message) {
            this.logger.error(`[publishProcessingState]${this.accountLog} streamId:[${streamId}] has been cleaned up due to overdue.`);
            return;
        }
        const now = Date.now();
        if (message.relayTimeRhreshold && now > message.relayTimeRhreshold) {
            this.logger.error(`[publishProcessingState]${this.accountLog} Over the reply time, take the initiative to reply!`);
            return;
        }

        const fromUsers = message.fromUsers ?? [];
        if (fromUsers.length === 0) {
            this.logger.warn(`[publishProcessingState]${this.accountLog} from users is empty, can not send message status!`);
            return;
        }

        //if (kind === 'plan' && message.contactType === 'group') {
            //群组时中间态消息就不回传了，显得消息太杂
            //return;
        //}

        let result_content = message.payload;
        if (kind !== 'patch' && kind !== 'plan' && kind !== 'block') {
            if (result_content.length > 200) {
                result_content = result_content.substring(0, 200)
            }
        }
        const toAgent = message.toAgent;
        const sessionKey = toAgent.sessionKey;
        for (const user of fromUsers) {
            const msg: DLMessage = {
                msgId: uuidStr(36),
                streamId,
                chatId: message.chatId,
                sender: {
                    id: toAgent.id,
                    nickname: toAgent.nickname,
                    avatar: toAgent.avatarUrl,
                    jobPost: toAgent.jobPost
                },
                receiver: {
                    id: user.id,
                    nickname: user.nickname
                },
                contactType: message.contactType,
                contactId: message.contactId,
                botType: message.botType,
                payload: result_content,
                createdAt: Date.now(),
                timezone: message.timezone!,
                status,
                finish: message.finish,
                kind,
                sessionKey,
                runId,
                relayType: 'openClaw'
            }
            try {
                await this.publish(user.chatTopic, JSON.stringify(msg));
            } catch (e) {
                this.logger.error(String(e))
            }
        }
    }

    async downloadFileRaw(url: string, botType: BotType) {
        return await this.http.downloadFileRaw(url, { botType });
    }

    /**
     * 对码成功回调通知
     */
    async approved(ok: boolean): Promise<void> {
        const url = '/guest/relayBot/approved/' + this.ctx.rbotId;
        const p: Record<string, string> = {
            "approved": ok ? "true" : "false"
        }
        await this.http.post(url, p);
    }

    async autoReply(params: {
        to: string,
        text?: string,
        mediaFiles?: Array<string>
    }): Promise<{ channel: string; messageId: string; chatId: string }> {
        const { to: rawTo, text, mediaFiles } = params;
        const { channelId, account } = this.ctx;
        const config = account.config;

        if (!config.configured) {
            throw new Error(`${channelId} account[${account.accountId}] not configured`);
        }
        if ((!text || text.length === 0) && (!mediaFiles || mediaFiles.length === 0)) {
            throw new Error(`${channelId} account[${account.accountId}] content is empty!`);
        }

        // 从 to 中解析 sessionKey（格式: dlink:user:xxx-xxx-dLink#agent:main:dlink-00001:direct:xxx）
        const hashIdx = rawTo.lastIndexOf('#');
        const to = hashIdx > 0 ? rawTo.substring(0, hashIdx) : rawTo;
        const sessionKey = hashIdx > 0 ? rawTo.substring(hashIdx + 1) : undefined;

        const channelPrefix = new RegExp(`^${channelId}:`, "i");
        const chat_id = to.replace(channelPrefix, "");
        const isGroup = chat_id.includes("group:");
        const strArr = isGroup ? chat_id.replace(new RegExp('^group:', 'i'), "").split("-") : chat_id.replace(new RegExp('^user:', 'i'), "").split("-");
        const chatId = strArr[0];
        const botId = strArr[1];
        const botType = strArr[2];
        const relayId = strArr[3];
        const data: Record<string, string> = {
            "chatId": chatId,
            "toAgent.id": botId,
            "botType": botType,
            "group": isGroup ? "true" : "false",
            "content": text ?? '',
            "relayId": relayId,
            "relayType": "openClaw"
        }
        // 携带 sessionKey 到服务端，用于下游 Agent 路由
        if (sessionKey) {
            data["toAgent.sessionKey"] = sessionKey;
        }
        let res;
        if (mediaFiles && mediaFiles.length > 0) {
            res = await this.http.upload<string>(AUTO_RELAY_API, mediaFiles, data);
        } else {
            res = await this.http.post<string>(AUTO_RELAY_API, data);
        }
        if (res) {
            return {
                channel: channelId,
                messageId: res,
                chatId: chatId
            }
        }
        throw new Error(`${channelId} account[${account.accountId}] Sending message failed.`);
    }
}