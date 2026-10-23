/**
 * Claw-Services 主服务接口
 * 为 duolian 插件提供 OpenClaw API 封装
 */


import EventEmitter from 'events';
import { exec, spawn } from 'child_process';
import { promisify } from 'util';
import fs from 'fs';
import path from 'path';
import { AgentCreateParams, AgentSummary,  AskAgentParams, ClawServiceOptions, CmdMessage, CmdParamsPatchSessionEntry, CmdResponse, CmdType, CronListResponse, SystemSummary } from './types.js';
import type {
  ArtifactGetParams, ArtifactDownloadParams,
  AgentFilesListParams, AgentFilesGetParams,
} from './types.js';
import WSClient from './ws-client.js';
// 2026-09-06 适配 openclaw 2026.9.1：根入口已移除，改从 core 导入
import { PluginLogger } from 'openclaw/plugin-sdk/core';
import { getOpenclawPath, getExtCapabilitiesDir } from '../utils.js';
import { applyModelOverrideToSessionEntry } from 'openclaw/plugin-sdk/model-session-runtime';
// 2026-10-15 适配 openclaw 2026.10.3：config-runtime 子路径已被官方移除（2026-09-30 SDK owner 批准），
// 下列符号现由 session-store-runtime 导出（同名、签名兼容：resolveStorePath/getSessionEntry/listSessionEntries 仍为同步，patchSessionEntry 为 async，调用处均已 await）
import { getSessionEntry, patchSessionEntry, resolveStorePath, listSessionEntries } from 'openclaw/plugin-sdk/session-store-runtime';
// 2026-09-06 适配 openclaw 2026.9.1：approveChannelPairingCode 不再导出，改走宿主 RPC（见 gateway-rpc.ts）
import { setGatewayClient, approvePairingRequest } from './gateway-rpc.js';
import { DEFAULT_ACCOUNT_ID } from 'openclaw/plugin-sdk/core';
import { markRunStopped } from '../runtime.js';
import { flushPendingMessages } from '../pending-pairing.js';
import { TerminalManager, TerminalDataSink } from './terminal.js';



/**
 * Claw-Services 主类
 * 处理 CMD 消息并调用相应的 OpenClaw API
 */
export class ClawServices extends EventEmitter {
  private client: WSClient | null = null;
  private readonly options: ClawServiceOptions;
  private isInitialized = false;
  private readonly logger: PluginLogger;
  // 2026-10-21：终端会话管理（PTY / 管道）
  private readonly terminalManager: TerminalManager;
  /** 2026-10-22：token 用量上报（中继落库，按同事聚合） */
  private readonly usagePublisher?: (payload: Record<string, unknown>) => void;
  private usageTimer: NodeJS.Timeout | null = null;
  constructor(options: ClawServiceOptions, logger: PluginLogger, terminalSink?: TerminalDataSink, usagePublisher?: (payload: Record<string, unknown>) => void) {
    super();
    this.options = options;
    this.logger = logger;
    this.usagePublisher = usagePublisher;
    this.terminalManager = new TerminalManager(
      terminalSink ?? (() => { }),
      (msg, type) => this.log(msg, (type as any) ?? 'info'),
    );
  }

  /** 2026-10-22：每 60 秒把最近一天的 token 用量上报中继（幂等 upsert） */
  private startUsageReporter() {
    if (this.usageTimer || !this.usagePublisher) {
      return;
    }
    const tick = async () => {
      try {
        // 2026-10-23：上送绝对时间 + 本机时区，业务日由中继按部署时区归并；
        // 查询窗口取近 48 小时，避免跨日/跨时区边界漏会话（窗口仅用于取数）
        const capturedAt = Date.now();
        const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
        const endDate = new Date().toISOString().slice(0, 10);
        const startDate = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
        const res = await this.rpcWithTimeout(
          this.client!.getSessionsUsage({ agentScope: 'all', startDate, endDate, limit: 1000 }),
          15000,
          'sessions.usage',
        );
        const root: any = (res as any)?.data ?? res;
        const sessions: Array<unknown> = Array.isArray(root?.sessions)
          ? root.sessions
          : Array.isArray(root?.aggregates)
            ? root.aggregates
            : [];
        if (sessions.length === 0) {
          return;
        }
        // relayId 由中继按 apiKey 补齐，这里不传
        this.usagePublisher!({ usageDate: endDate, capturedAt, timeZone, sessions });
      } catch (e) {
        this.log(`usage reporter: ${String(e)}`, 'debug');
      }
    };
    this.usageTimer = setInterval(() => { void tick(); }, 60_000);
    void tick();
  }

  log(msg: string, type: 'info' | 'warn' | 'error' | 'debug') {
    switch (type) {
      case 'info':
        this.logger.info(`✅ CmdService ${msg}`);
        break;
      case 'warn':
        this.logger.warn(`❗️CmdService ${msg}`);
        break;
      case 'error':
        this.logger.error(`❌️ CmdService ${msg}`);
        break;
      case 'debug':
        if (this.logger.debug) {
          this.logger.debug(`〰️ CmdService ${msg}`)
        } else {
          console.debug(`〰️ CmdService ${msg}`)
        }
    }
  }

  /**
   * 初始化服务
   */
  async initialize(): Promise<boolean> {
    if (this.isInitialized) {
      return true;
    }
    const channelId = this.options.channelId;
    try {
      this.client = new WSClient({
        gatewayUrl: this.options.gatewayUrl,
        token: this.options.token
      });
      // 2026-09-06 适配 openclaw 2026.9.1：注入 Gateway RPC 客户端（配对审批等宿主 RPC 用）
      setGatewayClient(this.client);

      this.client!.on('onConnected', () => {
        this.log(`ws连接成功`, 'info');
        this.emit('onConnectState', true);
      });
      this.client!.on('onDisconnect', () => {
        this.log(`ws连接已断开,5秒后重连...`, 'warn');
        this.emit('onConnectState', false);
        setTimeout(() => this.client?.connect(), 5000);
      });
      this.client!.on('onTick', (message) => {
        this.log(`onTick >>> ${message.ts}`, 'debug')
        message.channel = channelId;
        this.emit('onTick', message);
      })
      this.client!.on('onHealth', (message) => {
        message.channel = channelId;
        this.emit('onHealth', message)
      });
      this.client!.on('onHandshaked', (message) => {
        // WS 握手成功后订阅会话变更事件，实时感知归档/恢复/删除/新建
        this.client?.subscribeSessions()
          .then(() => this.log('已订阅 sessions.changed 事件', 'info'))
          .catch((e) => this.log(`订阅 sessions.changed 失败: ${e}`, 'warn'));
        this.emit('onHandshaked', message)
      })
      this.client.on('onAgentReply', (message) => this.emit('onAgentReply', message))
      this.client.on('onAgentChat', (message) => this.emit('onAgentChat', message))

      this.client.on('onCron', (message) => this.emit('onCron', message))
      this.client.on('onShutdown', (message) => this.emit('onShutdown', message));
      this.client.on('onSessionsChanged', (message) => this.emit('onSessionsChanged', message));
      this.client.on('onSessionMessage', (message) => this.emit('onSessionMessage', message));
      this.client.on('onHeartbeat', (message) => this.emit('onHeartbeat', message));



      this.client!.on('onError', (error) => {
        this.log('发生错误:' + String(error), 'error');
        this.emit('error', error)
      })

      await this.client.connect();
      this.isInitialized = true;
      // 2026-10-22：启动后开始周期上报用量
      this.startUsageReporter();

      return true;
    } catch (error) {
      this.log('❌ Claw-Services 初始化失败:' + String(error), 'error');
      this.isInitialized = false;
      throw error;
    }
  }

  /**
   * 检查服务是否已初始化
   */
  isReady(): boolean {
    return this.isInitialized && (this.client?.isReady() || false);
  }

  /**
   * 处理 CMD 消息
   */
  async handleCmdMessage(cmdMessage: CmdMessage): Promise<CmdResponse> {
    if (!this.isReady()) {
      throw new Error('Claw-Services 未初始化');
    }
    const startTime = Date.now();
    try {
      let result: any;
      // 根据命令类型调用相应的 API
      switch (cmdMessage.cmd as CmdType) {
        // Agent管理
        case 'agent.ask':
          result = await this.handleAskAgent(cmdMessage.params! as AskAgentParams);
          break;
        case 'agent.list':
          result = await this.handleAgentList();
          break;
        case 'agent.create':
          const agentId = cmdMessage.params!['id'];
          const agentList = await this.handleAgentList();
          if (agentList && agentList.length > 0) {
            const hasAgent = agentList.find(rec => rec.id === agentId);
            if (hasAgent) {
              result = hasAgent;
            }
          }
          if (!result) {
            result = await this.handleAgentCreate(cmdMessage.params!);
          }

          break;
        case 'agent.update':
          result = await this.handleAgentUpdate(cmdMessage.params!);

          break;
        case 'agent.delete':
          result = await this.handleAgentDelete(cmdMessage.params);
          break;
        case 'agent.get':
          result = await this.handleAgentGet(cmdMessage.params);
          break;

        // 任务管理
        case 'task.list':
          result = await this.handleTaskList(cmdMessage.params);
          break;
        case 'task.create':
          result = await this.handleTaskCreate(cmdMessage.params);
          break;
        case 'task.update':
          result = await this.handleTaskUpdate(cmdMessage.params);
          break;
        case 'task.delete':
          result = await this.handleTaskDelete(cmdMessage.params);
          break;
        case 'task.run':
          result = await this.handleTaskRun(cmdMessage.params);
          break;

        // 状态监控命令
        case 'status.health':
          result = await this.handleStatusHealth();
          break;
        case 'status.system':
          result = await this.handleStatusSystem();
          break;
        case 'status.usage':
          result = await this.handleStatusUsage();
          break;

        // 模型管理
        case 'models.list':
          // 2026-09-06 适配 openclaw 9.2：models.list 需显式 agentId（多 agent 配置下无 owner 会报 INVALID_REQUEST）
          result = await this.handleListModels(cmdMessage.params as { agentId?: string } | undefined);
          break;

        // 会话 
        case 'sessions.list':
          result = await this.handleSessionList(cmdMessage.params!)
          break;
        case 'sessions.get':
          result = await this.handleSessionGet(cmdMessage.params!);
          break;
        case 'sessions.describe':
          result = await this.handleSessionsDescribe(cmdMessage.params!);
          break;
        case 'sessions.resolve':
          result = await this.handleSessionsResolve(cmdMessage.params!);
          break;
        case 'sessions.create':
          result = await this.handleSessionCreate(cmdMessage.params!);
          break;
        case 'sessions.archive':
          result = await this.handleSessionArchive(cmdMessage.params!);
          break;
        case 'sessions.restore':
          result = await this.handleSessionRestore(cmdMessage.params!);
          break;
        case 'sessions.delete':
          result = await this.handleSessionDelete(cmdMessage.params!);
          break;
        case 'sessions.reset':
          result = await this.handleSessionReset(cmdMessage.params!);
          break;
        case 'sessions.patch':
          result = await this.handleUpdateSessionModel(cmdMessage.params as CmdParamsPatchSessionEntry);
          break;
        case 'sessions.currentModel':
          result = await this.handleCurrentSessionModel(cmdMessage.params as { sessionKey: string });
          break;

        // 当前会话聊天历史记录
        case 'chat.history':
          result = await this.handleChatHistories(cmdMessage.params!);
          break;

        // Skills 管理
        case 'skills.status':
          result = await this.handleSkillsStatus(cmdMessage.params);
          break;
        case 'skills.search':
          result = await this.handleSkillsSearch(cmdMessage.params!);
          break;
        case 'skills.detail':
          result = await this.handleSkillDetail(cmdMessage.params);
          break;
        case 'skills.install':
          result = await this.handleSkillInstall(cmdMessage.params!);
          break;
        case 'skills.update':
          result = await this.handleSkillUpdate(cmdMessage.params!);
          break;
        case 'skills.securityVerdicts':
          result = await this.handleSkillsSecurityVerdicts(cmdMessage.params);
          break;
        case 'usage.cost':
          result = await this.handleUsageCost(cmdMessage.params!);
          break;
        case 'sessions.usage':
          result = await this.handleSessionsUsage(cmdMessage.params!);
          break;
        case 'sessions.usage.logs':
          result = await this.handleSessionsUsageLogs(cmdMessage.params!);
          break;
        case 'cancelMessage':
          result = await this.handleCancelMessage(cmdMessage.params!);
          break;
        case 'agent.stop':
          result = await this.handleStopAgent(cmdMessage.params!);
          break;
        case 'chat.abort':
          // 新增 cmd 通道 chat.abort ， 以上两个/stop, /queue interrupt都不能立即终止执行中的会话
          result = await this.handlChatAbout(cmdMessage.params!);
          break;
        // 2026-10-21：终端能力（owner-only，见 CmdHandler 校验）
        case 'terminal.open':
          result = await this.terminalManager.open(cmdMessage.params as any);
          break;
        case 'terminal.input':
          result = this.terminalManager.write(cmdMessage.params?.sessionId, cmdMessage.params?.data ?? '');
          break;
        case 'terminal.resize':
          result = this.terminalManager.resize(cmdMessage.params?.sessionId, cmdMessage.params?.cols, cmdMessage.params?.rows);
          break;
        case 'terminal.close':
          result = this.terminalManager.close(cmdMessage.params?.sessionId);
          break;

        case 'pairing.approve':
          // 2026-09-06 适配 openclaw 2026.9.1：审批改按 requestId（宿主 RPC），客户端由 onPairingRequest 事件获取；
          // code 保留解析用于旧客户端兼容提示（9.1 起宿主 list 不再暴露 code，无法按 code 审批）
          const { requestId, code, empId, accountId, relayId } = cmdMessage.params ?? {};
          //注意：accountId目前只能为 DEFAULT_ACCOUNT_ID, 本插件不需要使用多账户,服务端提供多帐户服务(openId提供AGENT路由),在安装插件时需提醒使用"default"
          result = await this.handleApprove({ requestId, code, empId, relayId, accountId: accountId || DEFAULT_ACCOUNT_ID })
          break;

        // 工作区 / Artifact
        case 'artifacts.list':
          result = await this.handleArtifactsList(cmdMessage);
          break;
        case 'artifacts.get':
          result = await this.handleArtifactsGet(cmdMessage);
          break;
        case 'artifacts.download':
          result = await this.handleArtifactsDownload(cmdMessage);
          break;
        // Agent 工作区文件
        case 'agents.files.list':
          result = await this.handleAgentFilesList(cmdMessage);
          break;
        case 'agents.files.get':
          result = await this.handleAgentFilesGet(cmdMessage);
          break;

        // 扩展能力（ext_capabilities）：语音合成 TTS / 语音转录 STT
        case 'extCapabilities.status':
          result = await this.handleExtCapabilityStatus(cmdMessage.params!);
          break;
        case 'extCapabilities.check':
          result = await this.handleExtCapabilityCheck(cmdMessage.params!);
          break;
        case 'extCapabilities.install':
          result = await this.handleExtCapabilityInstall(cmdMessage.params!);
          break;

        default:
          throw new Error(`未知的命令: ${cmdMessage.cmd}`);
      }

      const duration = Date.now() - startTime;
      this.log(`CMD 处理完成: ${cmdMessage.cmd} (${duration}ms)`, 'info');

      return {
        success: true,
        data: result,
        timestamp: Date.now()
      };

    } catch (error) {
      const duration = Date.now() - startTime;
      this.log(`CMD 处理失败: ${cmdMessage.cmd} (${duration}ms), error=${String(error)}`, 'error');
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
        timestamp: Date.now()
      };
    }
  }

  private async handleAskAgent(params: AskAgentParams): Promise<any> {
    return await this.client?.askAgent(params);
  }

  /**
   * 更新
   * @param agentId 
   * @param userId 
   */
  private async handleUpdateSessionModel(params: CmdParamsPatchSessionEntry) {
    const { sessionKey, provider, model, thinkingLevel } = params;
    if (!sessionKey || sessionKey.length === 0) {
      return null;
    }
    // 2026-10-21：支持「只改推理强度」的 patch；provider/model 与 thinkingLevel 至少给一个
    if ((!provider || provider.length === 0 || !model || model.length === 0) && !thinkingLevel) {
      return null;
    }
    // 推理强度合法值校验（off/minimal/low/medium/high），非法值直接忽略
    const THINK_LEVELS = ['off', 'minimal', 'low', 'medium', 'high'];
    const thinkOverride = thinkingLevel && THINK_LEVELS.includes(thinkingLevel)
      ? thinkingLevel
      : undefined;
    const agentId = sessionKey.split(':')[1]
    const { cfg, channelId } = this.options;
    const storePath = resolveStorePath(cfg.session?.store, { agentId });
    // 2026-08-28 修复：客户端传入的 sessionKey 可能是无后缀 key（agent:<agentId>:<channelId>:direct:<empId>），
    // 而网关实际会话 key 带 chatId 后缀（agent:<agentId>:<channelId>:direct:<empId>-<botId>-<botType>）。
    // store 里同时存在两套 key 时，直接写入无后缀 key 会命中旧遗留会话，导致切模型不生效。
    // 这里先解析出真实会话 key 再 patch，保证模型覆盖写入当前真实会话。
    const realKey = this.resolveDirectSessionKey(storePath, sessionKey, agentId, channelId);
    await patchSessionEntry({
      storePath,
      sessionKey: realKey,
      update: (entry) => {
        if (provider && model) {
          applyModelOverrideToSessionEntry({
            entry,
            selection: {
              provider: provider,
              model: model,
            },
            selectionSource: 'user',
            markLiveSwitchPending: true, // 让当前 run 立即生效
          });
        }
        // 2026-10-21：会话级推理强度写入（与模型覆盖同层持久化）
        if (thinkOverride) {
          entry.thinkingLevel = thinkOverride;
        }
        return { ...entry };
      },
    });
    return { provider, model, thinkingLevel: thinkOverride };
  }

  /**
   * 2026-08-28 解析 direct 会话的真实 sessionKey（兼容 chatId 后缀）
   * 背景：客户端拼的 key 是 agent:<agentId>:<channelId>:direct:<empId>（无后缀），
   * 但网关按 chatId 生成的会话 key 带后缀（agent:<agentId>:<channelId>:direct:<empId>-<botId>-<botType>），
   * store 中两套 key 同时存在时，无后缀 key 可能命中旧遗留会话（模型覆盖过期），
   * 导致 sessions.currentModel 返回旧模型、sessions.patch 写入旧会话。
   * 策略：先精确匹配传入 key；查不到 entry 时，用前缀匹配 store 中 updatedAt 最新的 direct 会话。
   */
  private resolveDirectSessionKey(storePath: string, sessionKey: string, agentId: string, channelId: string): string {
    // 1. 传入 key 直接命中 entry → 直接用
    const exact = getSessionEntry({ storePath, sessionKey });
    if (exact) {
      return sessionKey;
    }
    // 2. 前缀匹配：agent:<agentId>:<channelId>:direct:<...> 开头的最新会话
    const prefix = `agent:${agentId}:${channelId}:direct:`;
    try {
      const summaries = listSessionEntries({ storePath });
      let bestKey = '';
      let bestUpdated = -1;
      for (const s of summaries) {
        if (!s.sessionKey.startsWith(prefix)) continue;
        const updated = s.entry?.updatedAt ?? s.entry?.lastActivityAt ?? 0;
        if (updated > bestUpdated) {
          bestUpdated = updated;
          bestKey = s.sessionKey;
        }
      }
      if (bestKey) {
        this.log(`resolveDirectSessionKey: ${sessionKey} -> ${bestKey} (前缀匹配最新会话)`, 'info');
        return bestKey;
      }
    } catch (e) {
      this.log(`resolveDirectSessionKey error: ${String(e)}`, 'error');
    }
    return sessionKey;
  }

  /**
   * 查询当前会话的模型覆盖（用于 ChatPage 恢复选中状态）
   * 2026-08-28 修复：客户端直接传 sessionKey（不再传 agentId+userId 让插件拼 key）
   */
  private async handleCurrentSessionModel(params: { sessionKey: string }) {
    const { sessionKey } = params;
    if (!sessionKey || sessionKey.length === 0) {
      return null;
    }

    const agentId = sessionKey.split(':')[1];
    const { cfg, channelId } = this.options;
    const storePath = resolveStorePath(cfg.session?.store, { agentId });
    // 兼容历史遗留的无后缀 key：精确命中失败时前缀匹配最新 direct 会话
    const realKey = this.resolveDirectSessionKey(storePath, sessionKey, agentId, channelId);
    const entry = getSessionEntry({ storePath, sessionKey: realKey });
    if (!entry) return null;

    // 只返回用户主动设置的覆盖，不返回 auto fallback
    const result: Record<string, string | undefined> = {};
    if (entry.modelOverrideSource === 'user' && entry.modelOverride) {
      result.provider = entry.providerOverride ?? '';
      result.model = entry.modelOverride;
    }
    // 2026-10-21：会话级推理强度回显
    if (entry.thinkingLevel) {
      result.thinkingLevel = entry.thinkingLevel;
    }
    return Object.keys(result).length > 0 ? result : null;
  }

  //#region ==================== Agent 管理处理器 ====================

  private async handleAgentList(): Promise<AgentSummary[]> {
    const agents = await this.client!.listAgents();

    return agents.agents.map(agent => ({
      id: agent.id,
      name: agent.name || agent.id,
      emoji: agent.identity?.emoji,
      model: agent.model?.primary,
      workspace: agent.workspace,
      fileCount: 0, // 需要额外API调用获取
      lastActivity: undefined,
      sessionCount: 0 // 需要额外API调用获取
    }));
  }

  /**
   * 2026-10-22：网关在 agents.create/update 后会做配置热加载，RPC 响应帧可能丢失，
   * 插件侧 ws-client 默认要干等 30s，导致中继先超时。
   * 这里对 RPC 加短超时，超时后由调用方回查 listAgents 确认是否已生效。
   */
  private rpcWithTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
    // 避免落败 promise 产生 unhandledRejection
    void p.catch(() => { });
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`${label} rpc timeout after ${ms}ms`)), ms);
      p.then(
        (v) => { clearTimeout(timer); resolve(v); },
        (e) => { clearTimeout(timer); reject(e); },
      );
    });
  }

  /** 回查 agent 是否已写入（热加载完成后可见） */
  private async findAgentConfirmed(params: Record<string, string>) {
    const wantedId = (params.id ?? '').toLowerCase();
    const wantedName = (params.name ?? '').toLowerCase();
    for (let i = 0; i < 6; i++) {
      try {
        const agents = await this.rpcWithTimeout(this.client!.listAgents(), 5000, 'agents.list');
        const found = agents.agents.find((a) => {
          const id = (a.id ?? '').toLowerCase();
          const nm = (a.name ?? '').toLowerCase();
          return (wantedId.length > 0 && (id === wantedId || nm === wantedId))
            || (wantedName.length > 0 && (nm === wantedName || id === wantedName));
        });
        if (found) {
          return found;
        }
      } catch {
        // 热加载期间 list 可能失败，稍后重试
      }
      await new Promise((r) => setTimeout(r, 800));
    }
    return undefined;
  }

  private async handleAgentCreate(params: Record<string, string>): Promise<{ id: string; name: string }> {
    const workspace_path = getOpenclawPath('workspace', params.id.toLowerCase().replace(/\s+/g, '-'))
    const provider = params.provider ?? ''
    // 2026-09-18：新版 agents.create 直接支持 model，这里一步写入（不再依赖 update 补写）
    const createParams: AgentCreateParams = {
      name: params.id,
      workspace: workspace_path,
      emoji: params.emoji,
      avatar: (params.avatar && params.avatar.length > 0) ? this.options.baseUrl + params.avatar : undefined,
      model: provider.length > 0 ? `${provider}/${params.model}` : params.model,
    }
    let result: { agentId: string } ;
    try {
      result = await this.rpcWithTimeout(this.client!.createAgent(createParams), 8000, 'agents.create');
    } catch (e) {
      // 响应可能因热加载丢失，但配置已写入 → 回查确认
      const confirmed = await this.findAgentConfirmed(params);
      if (!confirmed) {
        throw e;
      }
      this.log(`agents.create 响应超时但已生效：${confirmed.id}`, 'warn');
      result = { agentId: confirmed.id };
    }
    // 2026-09-18 修复（石头哥报：首次点击创建失败，且 name 未写入 openclaw.json）：
    // agents.create 后网关是「异步热加载配置」的（日志：create 186ms 成功，紧跟的
    // agents.update 报 agent "xiaoha" not found，1 秒后 config hot reload applied）。
    // 这里改用「update 快速失败重试」：agents.update 对未就绪 agent 是 2ms 快速返回 not found
    // （ws-client.send 在 WS 未连接时也快速抛错），不会挂起；热加载完成后下一次即成功。
    // 避免原 waitAgentReady 用 listAgents 轮询导致客户端 loading 超时的问题。
    // 2026-10-22：单次 update 已加 4s 超时，重试次数收紧，避免最坏情况超过中继 30s
    const MAX_UPDATE_RETRY = 3;
    const UPDATE_RETRY_MS = 500;
    let nameWritten = false;
    for (let i = 0; i < MAX_UPDATE_RETRY && !nameWritten; i++) {
      try {
        const up = await this.rpcWithTimeout(this.client!.updateAgent({
          agentId: result.agentId,
          name: params.name,
          workspace: workspace_path,
        }), 4000, 'agents.update');
        if (up?.ok) {
          nameWritten = true;
        }
      } catch {
        // not found / WS 未连接 → 快速失败，等待热加载后重试
      }
      if (!nameWritten) {
        await new Promise((r) => setTimeout(r, UPDATE_RETRY_MS));
      }
    }
    if (!nameWritten) {
      this.log(`⚠ agent ${result.agentId} 显示名写入超时（${MAX_UPDATE_RETRY * UPDATE_RETRY_MS}ms），可稍后在 openclaw.json 修改 name`, 'warn');
    }
    const sessionKey = `agent:${params.agentId}:${this.options.channelId}:direct:${params.userId.toLowerCase()}`;
    await this.handleUpdateSessionModel({
      sessionKey,
      provider: provider,
      model: params.model
    })

    return {
      id: result.agentId,
      name: params.name
    };
  }

  private async handleAgentUpdate(params: Record<string, string>): Promise<{ id: string }> {
    let agents: { agents: Array<{ id: string; name?: string }> };
    try {
      agents = await this.rpcWithTimeout(this.client!.listAgents(), 5000, 'agents.list');
    } catch {
      agents = { agents: [] };
    }
    const agent = agents.agents.find(a => a.id === params.agentId);
    const provider = params.provider ?? ''
    if (agent) {
      //agent存在直接更新
      let result: { agentId: string };
      try {
        result = await this.rpcWithTimeout(this.client!.updateAgent({
          agentId: params.agentId,
          name: params.name,
          workspace: params.workspace,
          model: provider.length > 0 ? `${provider}/${params.model}` : params.model,
          avatar: params.avatar
        }), 8000, 'agents.update');
      } catch (e) {
        // 响应可能因热加载丢失，但配置已写入 → 回查确认
        const confirmed = await this.findAgentConfirmed({ id: params.agentId, name: params.name });
        if (!confirmed) {
          throw e;
        }
        this.log(`agents.update 响应超时但已生效：${confirmed.id}`, 'warn');
        result = { agentId: confirmed.id };
      }
      // 兼容旧结构：原来的 updateAgent 调用以 result 收尾，这里保持后续逻辑
      const legacyResult = result;
      const sessionKey = `agent:${params.agentId}:${this.options.channelId}:direct:${params.userId.toLowerCase()}`;
      await this.handleUpdateSessionModel({
        sessionKey,
        provider: provider,
        model: params.model
      })
      return { id: legacyResult.agentId };
    }
    //不存在直接创建一个
    const p = {
      id: params.agentId,
      name: params.name,
      provider,
      model: params.model,
      userId:params.userId
    }
    const result = await this.handleAgentCreate(p)
    return {
      id: result.id
    }
  }

  private async handleAgentDelete(params: any): Promise<{ success: boolean }> {
    const result = await this.client!.deleteAgent({
      agentId: params.agentId,
      deleteFiles: params.deleteFiles || false
    });

    return { success: result.ok };
  }

  private async handleAgentGet(params: any): Promise<any> {
    const agents = await this.client!.listAgents();
    const agent = agents.agents.find(a => a.id === params.agentId);

    if (!agent) {
      throw new Error(`Agent ${params.agentId} 未找到`);
    }

    return agent;
  }
  //#endregion

  //#region  ==================== 任务管理处理器 ====================
  private async handleTaskList(params?: {
    agentIds?: Array<string>,
    offset?: number,
    limit?: number,
  }): Promise<CronListResponse> {
    const channelId = this.options.channelId;
    const res = await this.client!.listCronTasks({
      limit: params?.limit ?? 200,
      offset: params?.offset ?? 0,
    });
    const agentId_list = params?.agentIds ?? [];
    if (agentId_list.length > 0) {
      const jobs = res.jobs.filter(item => agentId_list.includes(item.agentId)).map(item => {
        if (item.delivery && item.delivery.to && item.delivery.to.startsWith(`${channelId}:`)) {
          return {
            ...item,
            delivery: {
              ...item.delivery,
              to: item.delivery.to.replaceAll(`${channelId}:`, '')
            }
          }
        }
        return item;
      });
      return {
        ...res,
        total: jobs.length,
        jobs
      }
    }
    const jobs = (res.jobs ?? []).map(item => {
      if (item.delivery && item.delivery.to && item.delivery.to.startsWith(`${channelId}:`)) {
        return {
          ...item,
          delivery: {
            ...item.delivery,
            to: item.delivery.to.replaceAll(`${channelId}:`, '')
          }
        }
      }
      return item;
    })
    return {
      ...res,
      total: res.jobs.length,
      jobs
    }
  }

  private async handleTaskCreate(params: any): Promise<any> {
    const res = await this.client!.addCronTask(params);
    console.log('创建任务 >>> ', JSON.stringify(res));
    return res;
  }

  // task.update — 更新定时任务（通过 OpenClaw cron.update）
  private async handleTaskUpdate(params: any): Promise<any> {
    const result = await this.client!.updateCronTask({
      jobId: params.jobId,
      patch: params.patch,
    });
    console.log('更新任务 >>> ', JSON.stringify(result));
    return result;
  }

  private async handleTaskDelete(params: any): Promise<{ success: boolean }> {
    const result = await this.client!.removeCronTask({
      jobId: params.jobId
    });
    return { success: result.ok };
  }

  private async handleTaskRun(params: any): Promise<{ success: boolean; runId?: string }> {
    const result = await this.client!.runCronTask({
      jobId: params.jobId
    });

    return {
      success: result.ok,
      runId: result.runId
    };
  }
  //#endregion

  //#region ==================== 状态监控处理器 ====================

  private async handleStatusHealth(): Promise<SystemSummary> {
    const health = await this.client!.getHealthStatus();

    return {
      status: health.status,
      version: health.version,
      uptime: this.formatUptime(health.uptime),
      agentCount: Object.keys(health.agents).length,
      channelCount: Object.keys(health.channels).length,
      memoryUsage: health.memory ? `${Math.round(health.memory.percent)}%` : '未知',
      totalTokens: 0, // 需要 usage API
      totalCost: 0    // 需要 usage API
    };
  }

  private async handleStatusSystem(): Promise<any> {
    const system = await this.client!.getSystemStatus();
    return system;
  }

  private async handleStatusUsage(): Promise<any> {
    const usage = await this.client!.getUsageStatus();
    return usage;
  }

  private async handleListModels(params?: { agentId?: string }): Promise<any> {
    // 2026-09-06 适配 openclaw 9.2：models.list RPC 要求显式 agentId（多 agent 配置无 owner 报 INVALID_REQUEST）。
    // 客户端能带则带；未带时兜底解析默认 agent：systemAgent.agentId → entries 中 main → entries 第一个 → 'main'
    let agentId = params?.agentId?.trim();
    if (!agentId) {
      const cfgAgents = (this.options.cfg as any)?.agents ?? {};
      agentId = cfgAgents?.defaults?.systemAgent?.agentId
        ?? (cfgAgents?.entries && typeof cfgAgents.entries === 'object'
          ? (cfgAgents.entries.main ? 'main' : Object.keys(cfgAgents.entries)[0])
          : undefined)
        ?? 'main';
    }
    const res = await this.client?.listModels(agentId);
    const models: Array<Record<string, unknown>> = Array.isArray(res?.models) ? res.models : (Array.isArray(res) ? res : []);
    // 2026-09-06 适配 openclaw 9.2：模型目录 JSON 结构变化——
    // 旧版每项 { id, name, provider, ... }；9.2 起 provider/model 合并为 key（如 "deepseek/deepseek-v4-flash"），
    // 不再下发独立 provider/id 字段（客户端按 provider 分组、按 id 切换模型会失效）。
    // 这里统一归一化为 7.1 语义：{ id: 纯模型名, key, provider, model: 纯模型名, name, ... }，
    // 客户端（输入框切换/群成员模型切换/RelayDetail）无需改动即可恢复。
    return models.map((m) => {
      const id = String(m.id ?? m.key ?? '');
      const key = String(m.key ?? id);
      const rawProvider = m.provider ? String(m.provider) : '';
      let provider = rawProvider;
      let model = id;
      if (!provider && key.includes('/')) {
        const idx = key.indexOf('/');
        provider = key.slice(0, idx);
        model = key.slice(idx + 1);
      }
      return { ...m, id: model || key, key, provider, model: model || key };
    });
  }
  //#endregion

  //#region ===================== 会话处理器 ======================
  private async handleSessionList(params: Record<string, unknown>): Promise<any> {
    return await this.client?.sessionsList(params);
  }
  private async handleSessionGet(params: Record<string, unknown>): Promise<any> {
    return await this.client?.sessionsGet(params);
  }
  private async handleSessionsDescribe(params: Record<string, string>): Promise<any> {
    return await this.client?.sessionsDescribe(params);
  }

  private async handleSessionsResolve(params: Record<string, unknown>): Promise<any> {
    return await this.client?.sessionsResolve(params);
  }

  /**
   * 创建新会话
   * sessionKey: agent:<agentId>:<channelId>-<suffix>:<chatType>:<userId>
   * 例: agent:main:workrelay-00001:direct:I35916630580137984
   */
  private async handleSessionCreate(params: Record<string, string>): Promise<any> {
    const { sessionKey } = params;
    if (!sessionKey) {
      throw new Error('sessions.create 缺少 sessionKey 参数');
    }
    return await this.client?.sessionsCreate({ key: sessionKey });
  }

  /**
   * 归档会话
   * 入参: { sessionKey }
   * - sessionKey: 完整的 sessionKey，如 "agent:main:workrelay-00001:direct:i35916630580137984"
   */
  private async handleSessionArchive(params: Record<string, string>): Promise<any> {
    const { sessionKey } = params;
    if (!sessionKey) {
      throw new Error('sessions.archive 缺少 sessionKey 参数');
    }
    this.log(`sessions.archive sessionKey=${sessionKey}`, 'info');
    return await this.client?.sessionsPatch({ key: sessionKey, patch: { archived: true } });
  }

  /**
   * 恢复（取消归档）会话
   * 入参: { sessionKey }
   * - sessionKey: 完整的 sessionKey
   */
  private async handleSessionRestore(params: Record<string, string>): Promise<any> {
    const { sessionKey } = params;
    if (!sessionKey) {
      throw new Error('sessions.restore 缺少 sessionKey 参数');
    }
    this.log(`sessions.restore sessionKey=${sessionKey}`, 'info');
    return await this.client?.sessionsPatch({ key: sessionKey, patch: { archived: false } });
  }

  /**
   * 删除会话
   * 入参: { sessionKey, deleteFiles? }
   * - sessionKey:  完整的 sessionKey
   * - deleteFiles: 是否同时删除会话相关文件（可选，默认 false）
   */
  private async handleSessionDelete(params: Record<string, string | boolean>): Promise<any> {
    const sessionKey = params.sessionKey as string;
    if (!sessionKey) {
      throw new Error('sessions.delete 缺少 sessionKey 参数');
    }
    this.log(`sessions.delete sessionKey=${sessionKey}`, 'info');
    const arr = sessionKey.split(':');
    const userId = arr[arr.length - 1];
    const effective_userId = userId.length <= 20 && userId.startsWith('i');
    if (sessionKey.startsWith(`agent:main:${this.options.channelId}:`) && effective_userId) {
      throw new Error('Deleting the default session is prohibited.')
    }
    return await this.client?.sessionsDelete({ key: sessionKey });
  }

  private async handleSessionReset(params: Record<string, string>): Promise<any> {
    return await this.client?.sessionReset(params);
  }

  private async handleChatHistories(params: Record<string, string>): Promise<any> {
    return await this.client?.chatHistories(params);
  }

  //#endregion

  //#region ==================== Skills 管理处理器 ====================

  private async handleSkillsStatus(params?: Record<string, unknown>): Promise<any> {
    return await this.client?.listSkills(params?.agentId as string | undefined);
  }

  private async handleSkillsSearch(params: Record<string, unknown>): Promise<any> {
    return await this.client?.searchSkills({
      query: params.query as string | undefined,
      limit: params.limit as number | undefined,
    });
  }

  private async handleSkillDetail(params?: Record<string, unknown>): Promise<any> {
    if (!params?.slug) {
      throw new Error('skills.detail 缺少 slug 参数');
    }
    return await this.client?.getSkillDetail(params.slug as string);
  }

  private async handleSkillInstall(params: Record<string, unknown>): Promise<any> {
    if (!params.slug) {
      throw new Error('skills.install 缺少 slug 参数');
    }
    return await this.client?.installSkill(
      params.slug as string,
      params.version as string | undefined,
    );
  }

  private async handleSkillUpdate(params: Record<string, unknown>): Promise<any> {
    if (!params.skillKey) {
      throw new Error('skills.update 缺少 skillKey 参数');
    }
    return await this.client?.updateSkillConfig(
      params.skillKey as string,
      params.enabled as boolean,
    );
  }

  private async handleSkillsSecurityVerdicts(params?: Record<string, unknown>): Promise<any> {
    return await this.client?.getSkillSecurityVerdicts(params?.agentId as string | undefined);
  }

  // 仪表盘：按日期范围聚合成本
  private async handleUsageCost(params: Record<string, unknown>) {
    const result = await this.client!.getUsageCost(params);
    return { data: result };
  }

  // 仪表盘：每 session 详细使用统计
  private async handleSessionsUsage(params: Record<string, unknown>) {
    const result = await this.client!.getSessionsUsage(params);
    return { data: result };
  }

  // 仪表盘：每消息级别使用日志
  private async handleSessionsUsageLogs(params: Record<string, unknown>) {
    const result = await this.client!.getSessionsUsageLogs(params);
    return { data: result };
  }

  /**
   * 取消当前Agent执行，通过Gateway /queue interrupt 中断活跃run
   */
  private async handleCancelMessage(params: Record<string, any>): Promise<any> {
    const { sessionKey } = params;
    if (!sessionKey) {
      throw new Error('cancelMessage 缺少 sessionKey 参数');
    }
    // channelId 从配置获取，不硬编码
    return await this.client?.cancelSession({ sessionKey });
  }

  /**
   * 强制停止当前Agent run（/stop，比 /queue interrupt 更快）
   * 新增 cmd 通道 agent.stop 指令
   */
  private async handleStopAgent(params: Record<string, any>): Promise<any> {
    const { sessionKey } = params;
    if (!sessionKey) {
      throw new Error('agent.stop 缺少 sessionKey 参数');
    }
    return await this.client?.stopSession({
      sessionKey
    });
  }

  private async handlChatAbout(params: Record<string, any>): Promise<void> {
    const { sessionKey, runId } = params;
    if (!sessionKey) {
      throw new Error('chat.bort 缺少 sessionKey, runId 参数');
    }
    // 2026-08-24 立即终止优化：先标记该 runId 已停止，
    // before_tool_call 钩子会 block 此 run 后续的工具调用（chat.abort 是协作式取消，无法打断正在执行的工具）
    if (runId) {
      markRunStopped(runId);
    }
    return await this.client?.chatAbort({ sessionKey, runId })
  }

  //#endregion

  //#region -----------对码审批--------------
  /**
   * 2026-09-06 适配 openclaw 2026.9.1：对码审批改走宿主 RPC channels.pairing.approve（按 requestId）
   * - 9.1 起 approveChannelPairingCode 不再从 plugin-sdk 导出（安全收敛：审批权与对码解耦、插件不再直写宿主 store）
   * - requestId 由插件创建对码时通过 channels.pairing.list 获取，随 onPairingRequest 事件下发给客户端
   * - notify=false：不触发宿主 notifyApproval（其内部 dlClient.approved 走 HTTP /guest/relayBot/approved，
   *   服务端暂无该端点会 404 噪音）；服务端回调沿用下方 onPairingResult MQTT 事件（7.1 同款链路）
   */
  private async handleApprove(params: { requestId?: string, code?: string, empId?: string, accountId: string, relayId?: string }) {
    const { requestId, code, empId, accountId, relayId } = params;
    if (!requestId) {
      // 旧客户端只传 code：9.1 无公开按 code 审批 API，提示升级（重新对码后事件会带 requestId）
      throw new Error(`审批失败:缺少 requestId${code ? `（code=${code} 已不被支持）` : ''}，请重新触发对码后重试`);
    }
    const res = await approvePairingRequest(this.options.channelId, accountId, requestId, false);
    if (res) {
      this.emit('onPairingResult', {
        approved: true,
        senderId: res.senderId,
        empId,
        requestId,
      })
      // 2026-10-22：补发该中继在未配对期间被拦截的消息；返回条数供客户端决定是否兜底重发
      const replayed = relayId ? flushPendingMessages(relayId) : 0;
      return {
        success: true,
        data: {
          ...res,
          replayed
        },
        timestamp: Date.now()
      }
    }
    throw new Error('审批失败:配对请求无效或已过期!')
  }
  //#endregion

  //#region ======================== 工作区 / Artifact 处理器 ========================

  /** artifacts.list - 列出会话工件 */
  async handleArtifactsList(cmdMessage: CmdMessage): Promise<any> {
    const { sessionKey } = cmdMessage.params || {};
    if (!sessionKey || sessionKey.length === 0) {
      throw new Error('artifacts.list 缺少 sessionKey 参数');
    }
    this.log(`artifacts.list sessionKey=${sessionKey}`, 'info');
    return await this.client?.artifactsList({ sessionKey });
  }

  /** artifacts.get - 获取单个工件详情 */
  async handleArtifactsGet(cmdMessage: CmdMessage): Promise<any> {
    const params: ArtifactGetParams = cmdMessage.params as ArtifactGetParams;
    this.log(`artifacts.get params=${JSON.stringify(params)}`, 'info');
    return await this.client?.artifactsGet(params);
  }

  /** artifacts.download - 下载工件 */
  async handleArtifactsDownload(cmdMessage: CmdMessage): Promise<any> {
    const params: ArtifactDownloadParams = cmdMessage.params as ArtifactDownloadParams;
    this.log(`artifacts.download params=${JSON.stringify(params)}`, 'info');
    const result = await this.client?.artifactsDownload(params);
    this.log(`artifacts.download result size=${result?.size ?? 'unknown'}`, 'info');
    return result;
  }

  // ======================== Agent 工作区文件处理器 ========================

  /** agents.files.list - 列出 Agent 工作区文件 */
  async handleAgentFilesList(cmdMessage: CmdMessage): Promise<any> {
    const params: AgentFilesListParams = cmdMessage.params as AgentFilesListParams;
    this.log(`agents.files.list params=${JSON.stringify(params)}`, 'info');

    // 2026-07-31 新增：优先尝试本地文件系统直读（递归扫描所有文件），
    // 目录受限/无权限时自动回退到 Gateway RPC（保留原有兜底逻辑）
    try {
      const result = await this.client?.agentFilesListLocal(params.agentId);
      this.log(`agents.files.list (local scan) result count=${result?.files?.length ?? 0}`, 'info');
      return result;
    } catch (err) {
      this.log(`agents.files.list (local scan) failed: ${err}, falling back to Gateway RPC`, 'warn');
      const result = await this.client?.agentFilesList(params.agentId);
      this.log(`agents.files.list (Gateway RPC fallback) result count=${result?.files?.length ?? 0}`, 'info');
      return result;
    }
  }

  /** agents.files.get - 获取工作区文件内容 */
  async handleAgentFilesGet(cmdMessage: CmdMessage): Promise<any> {
    const params: AgentFilesGetParams = cmdMessage.params as AgentFilesGetParams;
    this.log(`agents.files.get params=${JSON.stringify(params)}`, 'info');

    // 2026-07-31 新增：优先本地文件系统直读（绕过 Gateway 文件白名单限制），
    // 权限不足/文件不存在时自动回退到 Gateway RPC
    try {
      const result = await this.client?.agentFilesGetLocal(params.agentId, params.name);
      this.log(`agents.files.get (local) result name=${params.name}`, 'info');
      return result;
    } catch (err) {
      this.log(`agents.files.get (local) failed: ${err}, falling back to Gateway RPC`, 'warn');
      const result = await this.client?.agentFilesGet(params.agentId, params.name);
      this.log(`agents.files.get (Gateway RPC fallback) result name=${params.name}`, 'info');
      return result;
    }
  }

  //#endregion

  //#region ==================== 扩展能力处理器（ext_capabilities）====================

  /**
   * extCapabilities.status - 查询扩展能力安装状态
   * params: { name: 'workrelay-speak' | 'workrelay-transcribe' }
   * 执行 ext_capabilities/<name>/status.sh，返回 JSON 供客户端展示
   */
  async handleExtCapabilityStatus(params: Record<string, any>): Promise<any> {
    const name = params?.name;
    if (!name) {
      throw new Error('extCapabilities.status 缺少 name 参数');
    }
    const extDir = getExtCapabilitiesDir();
    const scriptPath = path.join(extDir, name, 'status.sh');
    this.log(`extCapabilities.status script=${scriptPath}`, 'info');

    if (!fs.existsSync(scriptPath)) {
      return {
        status: 'disabled',
        description: `能力 ${name} 未安装（脚本不存在）`,
        checks: {}
      };
    }

    try {
      const execAsync = promisify(exec);
      const { stdout } = await execAsync(`bash "${scriptPath}"`, { timeout: 15000, encoding: 'utf-8' });
      // status.sh 输出 JSON（尾部可能带换行/日志），取最后一个 { } 块解析
      const match = stdout.match(/\{[\s\S]*\}/);
      let result: any;
      if (match) {
        result = JSON.parse(match[0]);
      } else {
        result = { status: 'unknown', description: stdout.trim() || '状态解析失败', checks: {} };
      }
      // 2026-08-10 安装存活检测：判断 install.sh 进程是否真实在跑。
      // 客户端 store 持久化的 installing 状态在重启后可能残留（假死），
      // 客户端据此自动解除“安装中”，恢复可重新安装。
      result.installing = await this.isExtCapabilityInstalling(name);
      // 2026-08-18 日志位置随状态返回：客户端界面直接显示安装日志路径，方便排查。
      result.logFile = getOpenclawPath('logs', `ext-capabilities-${name}-install.log`);
      return result;
    } catch (err) {
      // status.sh 非 0 退出（如未安装返回 1），但 stdout 仍有 JSON
      const stdout = (err as any)?.stdout as string;
      const match = stdout?.match(/\{[\s\S]*\}/);
      if (match) {
        try {
          const result = JSON.parse(match[0]);
          result.installing = await this.isExtCapabilityInstalling(name);
          // 2026-08-18 日志位置随状态返回（与上方成功分支一致）
          result.logFile = getOpenclawPath('logs', `ext-capabilities-${name}-install.log`);
          return result;
        } catch { /* ignore */ }
      }
      this.log(`extCapabilities.status 执行失败: ${String(err)}`, 'warn');
      return { status: 'unknown', description: '状态查询失败', checks: {}, installing: false };
    }
  }

  /**
   * 2026-08-10 检测指定扩展能力的安装进程是否真实在跑（存活检测）
   * 注意：不能用 pgrep -f "...install.sh" —— 该命令经 bash -c 执行时，bash 进程
   * 自身命令行包含 install.sh 字符串，pgrep 会永远自匹配，导致 installing 恒为 true。
   * 改用 ps + grep 方括号技巧（grep 自身命令行不含字面 install.sh，不会自匹配）。
   */
  private async isExtCapabilityInstalling(name: string): Promise<boolean> {
    try {
      const extDir = getExtCapabilitiesDir();
      const installScript = path.join(extDir, name, 'install.sh');
      const execAsync = promisify(exec);
      // [i]nstall.sh 方括号技巧：grep 进程自身命令行是 "grep [i]nstall.sh"，不含字面 install.sh
      const { stdout } = await execAsync(`ps -eo args | grep "[i]nstall\\.sh" | grep -v grep`, { timeout: 3000, encoding: 'utf-8' });
      // 只认跑在脚本路径上的进程，避免匹配到其它无关 install.sh
      const lines = stdout.split('\n').filter((line) => line.trim().length > 0);
      return lines.some((line) => line.includes(installScript) || line.includes('bash ' + installScript));
    } catch {
      return false; // 出错 → 视为未在安装
    }
  }

  /**
   * extCapabilities.check - 检查扩展能力安装前置条件
   * params: { name: 'workrelay-speak' | 'workrelay-transcribe' }
   * 读取 ext_capabilities/<name>/manifest.json，逐条执行 requirements[].check（shell 表达式），
   * exit 0 = 条件满足。返回每条条件是否满足，客户端据此展示"安装条件"清单。
   * 2026-08-11 新增：通用适配——每个能力自带前置条件清单，用户安装前即可看到环境是否满足。
   */
  async handleExtCapabilityCheck(params: Record<string, any>): Promise<any> {
    const name = params?.name;
    if (!name) {
      throw new Error('extCapabilities.check 缺少 name 参数');
    }
    const extDir = getExtCapabilitiesDir();
    const manifestPath = path.join(extDir, name, 'manifest.json');
    this.log(`extCapabilities.check manifest=${manifestPath}`, 'info');

    if (!fs.existsSync(manifestPath)) {
      return { name, displayName: name, allMet: true, requirements: [], note: '该能力未提供前置条件清单' };
    }

    let manifest: any;
    try {
      manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
    } catch (err) {
      this.log(`extCapabilities.check manifest 解析失败: ${String(err)}`, 'warn');
      return { name, displayName: name, allMet: true, requirements: [], note: '前置条件清单解析失败' };
    }

    const requirements: Array<Record<string, any>> = manifest.requirements ?? [];
    const execAsync = promisify(exec);
    const results: Array<Record<string, any>> = [];

    for (const req of requirements) {
      const item: Record<string, any> = {
        id: req.id,
        label: req.label,
        expect: req.expect,
        hint: req.hint,
        met: false,
      };
      try {
        // check 是 shell 表达式，exit 0 = 满足；10s 超时防止命令卡死
        await execAsync(req.check, { timeout: 10000, encoding: 'utf-8' });
        item.met = true;
      } catch (err) {
        item.met = false;
        item.detail = String((err as any)?.message ?? err).split('\n')[0] ?? undefined;
      }
      results.push(item);
    }

    return {
      name: manifest.name ?? name,
      displayName: manifest.displayName ?? name,
      allMet: results.every((r) => r.met === true),
      requirements: results,
    };
  }

  /**
   * extCapabilities.install - 安装扩展能力（长任务，后台执行）
   * params: { name: 'workrelay-speak' | 'workrelay-transcribe' }
   * install.sh 可能需要 5-15 分钟（下载模型），后台 spawn 立即返回"已开始"，
   * 客户端通过轮询 extCapabilities.status 感知进度
   */
  async handleExtCapabilityInstall(params: Record<string, any>): Promise<any> {
    const name = params?.name;
    if (!name) {
      throw new Error('extCapabilities.install 缺少 name 参数');
    }
    const extDir = getExtCapabilitiesDir();
    const scriptPath = path.join(extDir, name, 'install.sh');
    this.log(`extCapabilities.install script=${scriptPath}`, 'info');

    if (!fs.existsSync(scriptPath)) {
      throw new Error(`能力 ${name} 的安装脚本不存在: ${scriptPath}`);
    }

    // 后台 spawn，detached 脱离父进程生命周期
    // 2026-08-10 修改：stdio 不再 ignore，stdout/stderr 重定向到日志文件，方便排查安装失败原因
    const logFile = getOpenclawPath('logs', `ext-capabilities-${name}-install.log`);
    try {
      fs.mkdirSync(path.dirname(logFile), { recursive: true });
    } catch { /* ignore */ }
    const outFd = fs.openSync(logFile, 'a');
    // 2026-09-14 镜像源区域：客户端传入（cn=国内阿里云公共仓库优先 / intl=国际 Docker Hub 优先 / auto=自动）
    // install.sh 会按该值优先拉取并自动回退到另一源。
    const region = params?.region === 'cn' || params?.region === 'intl' ? String(params.region) : 'auto';
    const child = spawn('bash', [scriptPath], {
      detached: true,
      stdio: ['ignore', outFd, outFd],
      env: { ...process.env, WR_IMAGE_REGION: region },
    });

    // 2026-08-10 修复：spawn 成功 ≠ 脚本执行成功。脚本内部立即失败（权限/依赖检查）
    // 时 error 事件不会触发，失败输出全进日志文件，客户端只看到 started:true → 错误被吞。
    // 方案：监听 exit 事件，3 秒窗口内脚本退出且退出码非 0 → 视为安装失败，读日志尾部报回。
    const quickFail = await new Promise<{ failed: boolean; code: number | null }>((resolve) => {
      let settled = false;
      const finish = (failed: boolean, code: number | null) => {
        if (settled) return;
        settled = true;
        resolve({ failed, code });
      };
      const timer = setTimeout(() => finish(false, null), 3000); // 3 秒没退出 → 长任务在跑
      child.once('error', (err: Error) => {
        clearTimeout(timer);
        this.log(`extCapabilities.install spawn 错误: ${err.message}`, 'error');
        finish(true, -1);
      });
      child.once('exit', (code, _signal) => {
        clearTimeout(timer);
        finish(code !== 0, code ?? -1);
      });
    });

    if (quickFail.failed) {
      // 读取日志尾部作为具体错误信息报回客户端（不吞错）
      const tail = this.readLogTail(logFile);
      this.log(`extCapabilities.install 执行失败(exit=${quickFail.code}): ${tail}`, 'error');
      return {
        started: false,
        name,
        error: `安装脚本执行失败(exit=${quickFail.code ?? 'unknown'}): ${tail}`,
        logFile,
      };
    }

    // 长任务在跑：监听后续 error/exit 记日志，unref 脱离父进程生命周期
    child.on('error', (err: Error) => {
      this.log(`extCapabilities.install 运行错误: ${err.message}`, 'error');
    });
    child.unref();
    // 记录日志文件位置，便于客户端/日志排查
    this.log(`extCapabilities.install 日志: ${logFile}`, 'info');

    return {
      started: true,
      name,
      message: `安装已启动，请稍后刷新状态（${name} 首次安装需下载模型，约 5-15 分钟）`,
      logFile,
    };
  }

  //#endregion

  //#region ==================== 工具函数 ==========================

  /**
   * 2026-08-10 读取日志文件尾部内容（供安装失败报错）
   */
  private readLogTail(logFile: string, maxLines = 20): string {
    try {
      const content = fs.readFileSync(logFile, 'utf-8');
      const lines = content.split('\n').filter((l) => l.trim().length > 0);
      return lines.slice(-maxLines).join('\n').trim() || '(日志为空)';
    } catch (err) {
      return `(无法读取日志: ${String(err)})`;
    }
  }
  private formatUptime(seconds: number): string {
    const days = Math.floor(seconds / 86400);
    const hours = Math.floor((seconds % 86400) / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    if (days > 0) {
      return `${days}天${hours}小时`;
    } else if (hours > 0) {
      return `${hours}小时${minutes}分钟`;
    } else {
      return `${minutes}分钟`;
    }
  }

  cleanup(): void {
    // 2026-09-06 适配 openclaw 2026.9.1：清理时同步重置 Gateway RPC 客户端引用
    setGatewayClient(null);
    if (this.client) {
      this.client.disconnect();
      this.client.removeAllListeners();
      this.client = null;
    }
    this.isInitialized = false;
  }
  //#endregion
}


export default ClawServices;