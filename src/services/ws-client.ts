
import {
  RequestFrame,
  AgentsListResponse,
  AgentCreateParams,
  AgentCreateResponse,
  AgentUpdateParams,
  AgentUpdateResponse,
  AgentDeleteParams,
  AgentDeleteResponse,
  CronAddParams,
  CronAddResponse,
  CronListResponse,
  CronRemoveParams,
  CronRemoveResponse,
  CronUpdateParams,
  CronUpdateResponse,
  CronRunParams,
  CronRunResponse,
  HealthStatus,
  SystemStatus,
  UsageStatus,
  ClawMessage,
  AskAgentParams
} from './types.js';
import EventEmitter from 'events';
import { WebSocket } from 'ws';
import { promises as fs, Dirent, Stats } from 'fs';
import path from 'path';
import os from 'os';
import { DeviceConfig, getDeviceConfig, reqBootstrapToken, saveDeviceConfig, signConnectPayload } from '../client/crypto.js';


/**
 * OpenClaw Gateway WebSocket 客户端
 * 用于 duolian 插件内部调用 OpenClaw API
 */
export class WSClient extends EventEmitter {
  private ws: WebSocket | null = null;
  private readonly gatewayUrl: string;
  private token?: string;
  private readonly callbacks: Map<string, {
    resolve: (value: any) => void;
    reject: (reason?: any) => void;
    timeout: NodeJS.Timeout;
  }> = new Map();

  private messageId = 0;
  private isConnected = false;
  private isHandshaked = false;
  private readonly deviceConfig: DeviceConfig;


  constructor(options: {
    gatewayUrl: string;
    token?: string
  }) {
    super();
    this.gatewayUrl = options.gatewayUrl;
    this.token = options.token;
    const conf: DeviceConfig = getDeviceConfig();
    this.deviceConfig = { ...conf }
  }

  private log(msg: string, type: 'info' | 'debug' | 'warn' | 'error') {
    switch (type) {
      case 'info':
        console.log(msg);
        break;
      case 'debug':
        if (process.env.NODE_ENV === 'dev') {
          console.debug(msg);
        }
        break;
      case 'warn':
        console.warn(msg);
        break;
      case 'error':
        console.error(msg);
        break;
    }
  }

  // ==================== 连接管理 ====================

  /**
   * 连接到 OpenClaw Gateway
   */
  async connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      try {
        this.ws = new WebSocket(this.gatewayUrl);
        this.ws.on('open', () => {
          this.isConnected = true;
          this.emit('onConnected');
        });

        this.ws.on('message', (data: Buffer) => {
          try {
            const message = JSON.parse(data.toString());
            this.handleMessage(message);
          } catch (error) {
            this.emit('onError', error as Error);
          }
        });

        this.ws.on('close', () => {
          this.isConnected = false;
          this.isHandshaked = false;
          this.emit('onDisconnect');
        });

        this.ws.on('error', (error: Error) => {
          this.emit('onError', error);
        });

        resolve();

      } catch (error) {
        reject(error);
      }
    });
  }

  /**
   * 断开连接
   */
  disconnect(): void {
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }

    // 清理所有pending的回调
    for (const [, callback] of this.callbacks) {
      clearTimeout(callback.timeout);
      callback.reject(new Error('Client disconnected'));
    }
    this.callbacks.clear();
    this.isConnected = false;
  }

  /**
   * 检查是否已连接
   */
  isReady(): boolean {
    return this.isConnected && this.isHandshaked;
  }

  // ==================== Agent 管理 API ====================
  async askAgent(params: AskAgentParams): Promise<any> {
    return this.sendRequest({
      type: 'req',
      method: 'agent',
      params
    })
  }
  /**
   * 列出所有 Agents
   */
  async listAgents(): Promise<AgentsListResponse> {
    return this.sendRequest({
      type: 'req',
      method: 'agents.list',
      params: {}
    });
  }

  /**
   * 创建新的 Agent
   */
  async createAgent(params: AgentCreateParams): Promise<AgentCreateResponse> {
    return this.sendRequest({
      type: 'req',
      method: 'agents.create',
      params
    });
  }

  /**
   * 更新 Agent 信息
   */
  async updateAgent(params: AgentUpdateParams): Promise<AgentUpdateResponse> {
    return this.sendRequest({
      type: 'req',
      method: 'agents.update',
      params
    });
  }

  /**
   * 删除 Agent
   */
  async deleteAgent(params: AgentDeleteParams): Promise<AgentDeleteResponse> {
    return this.sendRequest({
      type: 'req',
      method: 'agents.delete',
      params
    });
  }

  // ==================== 任务管理 API ====================

  /**
   * 添加定时任务
   */
  async addCronTask(params: CronAddParams): Promise<CronAddResponse> {
    return this.sendRequest({
      type: 'req',
      method: 'cron.add',
      params
    });
  }

  /**
   * 列出所有定时任务
   */
  async listCronTasks({
    limit,
    offset
  }: {
    limit: number,
    offset: number,
  }): Promise<CronListResponse> {
    return this.sendRequest({
      type: 'req',
      method: 'cron.list',
      params: {
        includeDisabled: true,
        enabled: 'all',
        limit,
        offset
      }
    });
  }


  /**
   * 更新定时任务
   */
  async updateCronTask(params: CronUpdateParams): Promise<CronUpdateResponse> {
    return this.sendRequest({
      type: 'req',
      method: 'cron.update',
      params
    });
  }

  /**
   * 删除定时任务
   */
  async removeCronTask(params: CronRemoveParams): Promise<CronRemoveResponse> {
    return this.sendRequest({
      type: 'req',
      method: 'cron.remove',
      params
    });
  }

  /**
   * 运行定时任务
   */
  async runCronTask(params: CronRunParams): Promise<CronRunResponse> {
    return this.sendRequest({
      type: 'req',
      method: 'cron.run',
      params
    });
  }

  // ==================== 状态监控 API ====================

  /**
   * 获取健康状态
   */
  async getHealthStatus(): Promise<HealthStatus> {
    return this.sendRequest({
      type: 'req',
      method: 'health',
      params: {}
    });
  }

  /**
   * 获取系统状态
   */
  async getSystemStatus(): Promise<SystemStatus> {
    return this.sendRequest({
      type: 'req',
      method: 'status',
      params: {}
    });
  }

  /**
   * 获取使用情况统计
   */
  async getUsageStatus(): Promise<UsageStatus> {
    return this.sendRequest({
      type: 'req',
      method: 'usage.status',
      params: {}
    });
  }

  async listModels(agentId?: string): Promise<any> {
    // 2026-09-06 适配 openclaw 9.2：models.list 需显式 agentId（多 agent 配置下无 owner 会报 INVALID_REQUEST）
    const params: Record<string, unknown> = {};
    if (agentId) {
      params.agentId = agentId;
    }
    return this.sendRequest({
      type: 'req',
      method: 'models.list',
      params
    });
  }

  async sessionsList(params: Record<string, unknown>): Promise<any> {
    const p: Record<string, unknown> = {
      //limit:params.limit,   //number
      activeMinutes: params.activeMinutes, //number
      includeGlobal: params.includeGlobal,//bool
      includeDerivedTitles: params.includeDerivedTitles, //bool
      includeLastMessage: params.includeLastMessage, //bool,
      label: params.label, //string,
      spawnedBy: params.spawnedBy,
      agentId: params.agentId, //必填
      search: params.search, //string关键字
      archived: params.archived //bool: true=归档会话, false/omit=活跃会话
    }
    if (params.limit) {
      p.limit = params.limit
    }
    // ⚠️ 2026-10-09 修复（石头哥确认：客户端非活跃会话/旧会话显示不出来）：
    // 原来 offset 没透传——客户端请求第二页(offset=20)时被丢弃，网关永远返回第一页。
    // openclaw 侧活跃会话多时，第一页 20 条被活跃会话占满，排在后面的非活跃旧会话
    // 客户端永远拿不到 → 客户端会话列表看不到历史会话。补上 offset 让客户端翻页真正生效。
    if (params.offset !== undefined) {
      p.offset = params.offset
    }
    return this.sendRequest({
      type: 'req',
      method: 'sessions.list',
      params: p
    })
  }

  async sessionsGet(params: Record<string, unknown>): Promise<any> {
    const p: Record<string, unknown> = {
      sessionKey: params.sessionKey,
      key: params.key,
      limit: params.limit
    }
    return this.sendRequest({
      type: 'req',
      method: 'sessions.get',
      params: p
    })
  }

  async sessionsDescribe(params: Record<string, string>): Promise<any> {
    return this.sendRequest({
      type: 'req',
      method: 'sessions.describe',
      params
    })
  }
  async sessionsResolve(params: Record<string, unknown>): Promise<any> {
    const p: Record<string, unknown> = {
      key: params.sessionKey,
      sessionId: params.sessionId,
      agentId: params.agentId,
      includeGlobal: params.includeGlobal,   //Bool
      includeUnknown: params.includeUnknown // Bool
    }
    if (params.sessionLabel) {
      p.label = params.sessionLabel
    }
    if (params.spawnedBy) {
      p.spawnedBy = params.spawnedBy
    }
    return this.sendRequest({
      type: 'req',
      method: 'sessions.resolve',
      params: p
    })
  }

  async sessionReset(params: Record<string, string>): Promise<any> {
    return this.sendRequest({
      type: 'req',
      method: 'sessions.reset',
      params
    })
  }

  async chatHistories(params: Record<string, string>): Promise<any> {
    return this.sendRequest({
      type: 'req',
      method: 'chat.history',
      params
    })
  }

  // ==================== Skills API ====================

  async listSkills(agentId?: string): Promise<any> {
    const params: Record<string, unknown> = {};
    if (agentId) params.agentId = agentId;
    return this.sendRequest({
      type: 'req',
      method: 'skills.status',
      params
    });
  }

  async searchSkills(params: { query?: string; limit?: number }): Promise<any> {
    return this.sendRequest({
      type: 'req',
      method: 'skills.search',
      params: params.query ? { query: params.query, limit: params.limit || 20 } : { limit: params.limit || 20 }
    });
  }

  async getSkillDetail(slug: string): Promise<any> {
    return this.sendRequest({
      type: 'req',
      method: 'skills.detail',
      params: { slug }
    });
  }

  async installSkill(slug: string, version?: string): Promise<any> {
    return this.sendRequest({
      type: 'req',
      method: 'skills.install',
      params: { source: 'clawhub', slug, ...(version ? { version } : {}) }
    });
  }

  async updateSkillConfig(skillKey: string, enabled: boolean): Promise<any> {
    return this.sendRequest({
      type: 'req',
      method: 'skills.update',
      params: { skillKey, enabled }
    });
  }

  /**
   * 取消当前Session的Agent执行
   * 发送 /queue interrupt 到Gateway中断活跃run
   * @param channelId 频道ID（如 dlink），由services层传入，避免硬编码
   * @param chatType 会话类型 direct | group，由WorkRelay客户端传入
   */
  // ==================== 会话管理 API（CRUD） ====================

  /**
   * 创建新会话
   * @param params.key - 完整的 sessionKey
   */
  async sessionsCreate(params: { key: string }): Promise<any> {
    return this.sendRequest({
      type: 'req',
      method: 'sessions.create',
      params: { key: params.key }
    });
  }

  /**
   * 更新会话元数据（归档/恢复等）
   * @param params.key - sessionKey
   * @param params.patch - 要更新的字段，如 { archived: true }
   */
  async sessionsPatch(params: { key: string; patch: Record<string, unknown> }): Promise<any> {
    return this.sendRequest({
      type: 'req',
      method: 'sessions.patch',
      params: { key: params.key, ...params.patch }
    });
  }

  /**
   * 删除会话
   * @param params.key - sessionKey
   * @param params.deleteFiles - 是否同时删除会话相关文件(貌似不支持该参数)
   */
  async sessionsDelete(params: { key: string }): Promise<any> {
    return this.sendRequest({
      type: 'req',
      method: 'sessions.delete',
      params: { key: params.key, emitLifecycleHooks: true }
    });
  }

  /** 订阅会话变更事件（需在握手成功后调用） */
  async subscribeSessions(): Promise<any> {
    return this.sendRequest({
      type: 'req',
      method: 'sessions.subscribe'
    });
  }

  async cancelSession({ sessionKey }: {
    sessionKey: string
  }): Promise<any> {
    //const sessionKey = `agent:${agentId}:${channelId}:${chatType}:${userId.toLowerCase()}`;
    const agentId = sessionKey.split(':')[1];
    const messageId = `cancel_${Date.now()}`;
    return this.sendRequest({
      type: 'req',
      method: 'agent',
      params: {
        agentId,
        message: '/queue interrupt',
        sessionKey,
        deliver: false,
        idempotencyKey: messageId
      }
    });
  }

  /**
   * 发送 /stop 到Gateway，强制中止活跃run（比 /queue interrupt 更快）
   * 对应 cmd 通道 agent.stop 指令
   */
  async stopSession({ sessionKey }: {
    sessionKey: string
  }): Promise<any> {
    //const sessionKey = `agent:${agentId}:${channelId}:${chatType}:${userId.toLowerCase()}`;
    const agentId = sessionKey.split(':')[1];
    const messageId = `stop_${Date.now()}`;
    return this.sendRequest({
      type: 'req',
      method: 'agent',
      params: {
        agentId,
        message: '/stop',
        sessionKey,
        deliver: false,
        idempotencyKey: messageId
      }
    });
  }

  async chatAbort(params: { sessionKey: string, runId?: string }) {
    const { sessionKey, runId } = params
    return this.sendRequest({
      type: 'req',
      method: 'chat.abort',
      params: {
        sessionKey,
        ...(runId ? { runId } : {})
      }
    });
  }

  /** 2026-10-27 审批决议：放行一次 / 永久放行 / 拒绝（网关 schema: id/kind/decision） */
  async resolveApproval(params: { id: string, kind: 'exec' | 'plugin' | 'system-agent', decision: 'allow-once' | 'allow-always' | 'deny' }): Promise<any> {
    return this.sendRequest({ type: 'req', method: 'approval.resolve', params })
  }

  /** 2026-10-27 读取生效执行策略：把「预设」解析成实际档位 */
  async execApprovalsGet(): Promise<any> {
    return this.sendRequest({ type: 'req', method: 'exec.approvals.get', params: {} })
  }

  /** 2026-10-27 审批队列（只读）：三类审批分别取列表，core 已做过期过滤 */
  async approvalList(kind: 'exec' | 'plugin' | 'system-agent'): Promise<any> {
    const method = kind === 'exec'
      ? 'exec.approval.list'
      : kind === 'plugin'
        ? 'plugin.approval.list'
        : 'openclaw.approval.list'
    return this.sendRequest({ type: 'req', method, params: {} })
  }

  /** 2026-10-24：会话级中止（无 runId 时使用），同时丢弃排队后续 */
  async sessionsAbort(params: { sessionKey?: string, key?: string, runId?: string, clearQueued?: boolean }) {
    // 2026-10-27 修正：sessions.abort 的参数字段是 key（不是 sessionKey），网关 schema 为 key/runId/agentId/clearQueued；
    // clearQueued 丢弃排队后续，避免中止后不到一秒又被排队任务拉起。
    const key = params.key ?? params.sessionKey
    return this.sendRequest({
      type: 'req',
      method: 'sessions.abort',
      params: {
        key,
        clearQueued: params.clearQueued ?? true,
        ...(params.runId ? { runId: params.runId } : {})
      }
    });
  }

  async getSkillSecurityVerdicts(agentId?: string): Promise<any> {
    const params: Record<string, unknown> = {};
    if (agentId) params.agentId = agentId;
    return this.sendRequest({
      type: 'req',
      method: 'skills.securityVerdicts',
      params
    });
  }

  // 仪表盘：按日期范围聚合成本
  async getUsageCost(params: Record<string, unknown>) {
    return this.sendRequest({
      type: 'req',
      method: 'usage.cost',
      params
    });
  }

  // 仪表盘：每 session 详细使用统计
  async getSessionsUsage(params: Record<string, unknown>) {
    return this.sendRequest({
      type: 'req',
      method: 'sessions.usage',
      params
    });
  }

  // 仪表盘：每消息级别使用日志
  async getSessionsUsageLogs(params: Record<string, unknown>) {
    return this.sendRequest({
      type: 'req',
      method: 'sessions.usage.logs',
      params
    });
  }

  // ==================== 工作区 / Artifact API ====================

  async artifactsList(params: any) {
    return this.sendRequest({
      type: 'req',
      method: 'artifacts.list',
      params
    });
  }

  async artifactsGet(params: any) {
    return this.sendRequest({
      type: 'req',
      method: 'artifacts.get',
      params
    });
  }

  async artifactsDownload(params: any) {
    return this.sendRequest({
      type: 'req',
      method: 'artifacts.download',
      params
    });
  }

  /** 列出 Agent 工作区文件（agents.files.list） */
  async agentFilesList(agentId: string) {
    return this.sendRequest({
      type: 'req',
      method: 'agents.files.list',
      params: { agentId }
    });
  }

  /** 获取 Agent 工作区文件内容（agents.files.get） */
  async agentFilesGet(agentId: string, filePath: string) {
    return this.sendRequest({
      type: 'req',
      method: 'agents.files.get',
      params: { agentId, name: filePath }
    });
  }

  // ===== 2026-07-31 新增：本地文件系统直接读写（绕过 Gateway RPC 的文件白名单限制） =====

  /** 跳过 Gateway RPC，直接用 Node.js fs 读取 agent 工作区文件内容
   *  2026-07-31 base64 fix：文本文件 utf-8，二进制文件 base64 编码避免损坏 */
  async agentFilesGetLocal(agentId: string, filePath: string): Promise<any> {
    const workspaceDir = this.resolveWorkspaceDir(agentId);
    const fullPath = path.join(workspaceDir, filePath);
    const stat = await fs.stat(fullPath);
    const isText = this.isTextFile(filePath);
    const encoding: 'utf-8' | 'base64' = isText ? 'utf-8' : 'base64';
    let content: string;
    if (isText) {
      content = await fs.readFile(fullPath, 'utf-8');
    } else {
      const buffer = await fs.readFile(fullPath);
      content = buffer.toString('base64');
    }
    return {
      agentId,
      workspace: workspaceDir,
      file: {
        name: filePath,
        path: fullPath,
        missing: false,
        size: stat.size,
        updatedAtMs: Math.floor(stat.mtimeMs),
        content,
        encoding,
      },
    };
  }

  /** 根据扩展名判断是否文本文件 */
  private isTextFile(filename: string): boolean {
    const ext = path.extname(filename).slice(1).toLowerCase();
    const textExts = new Set([
      'md', 'mdx', 'txt', 'log', 'json', 'xml', 'yaml', 'yml', 'toml',
      'ts', 'tsx', 'js', 'jsx', 'jsm', 'py', 'java', 'go', 'rs', 'c', 'cpp', 'h', 'hpp',
      'css', 'scss', 'less', 'html', 'htm', 'svg', 'csv', 'env', 'cfg', 'ini',
      'sh', 'bash', 'zsh', 'sql', 'rb', 'php', 'swift', 'kt', 'r', 'lua',
      'conf', 'properties', 'gitignore', 'editorconfig',
    ]);
    return textExts.has(ext);
  }

  /** 跳过 Gateway RPC，直接用 Node.js fs 递归扫描 agent 工作区目录 */
  async agentFilesListLocal(agentId: string): Promise<any> {
    const workspaceDir = this.resolveWorkspaceDir(agentId);
    const files = await this.scanWorkspaceDir(workspaceDir);
    return {
      agentId,
      workspace: workspaceDir,
      files,
    };
  }

  /** 根据 agentId 推断 workspace 目录路径 */
  private resolveWorkspaceDir(agentId: string): string {
    const home = os.homedir();
    if (agentId === 'main') {
      return path.join(home, '.openclaw', 'workspace');
    }
    // 其他 agent 尝试 workspace-{agentId} 命名
    return path.join(home, '.openclaw', `workspace-${agentId}`);
  }

  /**
   * 2026-09-01 扫描工作区时跳过的重型目录黑名单。
   * agent 在工作区创建软件项目时会产生 node_modules/dist/build 等海量文件（几万~几十万），
   * 全量递归扫描会导致 MQTT 返回超大 JSON，客户端工作区列表 30s 超时。
   */
  private static readonly SKIP_WORKSPACE_DIRS = new Set([
    'node_modules', 'dist', 'build', '.next', 'target',
    '.git', '.clawhub',
  ]);

  /** 递归扫描工作区目录，跳过隐藏目录（.git, .clawhub, .openclaw 等） */
  private async scanWorkspaceDir(
    dirPath: string,
    relativePrefix: string = '',
  ): Promise<Array<{
    name: string;
    path: string;
    relativePath: string;
    type: 'file' | 'directory';
    size: number;
    modifiedAt: number;
  }>> {
    const results: Array<any> = [];
    let entries: Dirent[];
    try {
      entries = await fs.readdir(dirPath, { withFileTypes: true });
    } catch {
      // 目录不存在或无权限 → 返回空
      return results;
    }

    for (const entry of entries) {
      // 跳过隐藏目录
      if (entry.isDirectory() && entry.name.startsWith('.')) continue;
      // 2026-09-01 跳过软件项目重型目录（node_modules/dist/build 等），避免全量扫描卡死客户端
      if (entry.isDirectory() && WSClient.SKIP_WORKSPACE_DIRS.has(entry.name)) {
        this.log(`[workspace] 跳过重型目录: ${relativePrefix ? relativePrefix + '/' : ''}${entry.name}`, 'debug');
        continue;
      }

      const fullPath = path.join(dirPath, entry.name);
      const relativePath = relativePrefix
        ? path.join(relativePrefix, entry.name)
        : entry.name;

      let stat: Stats;
      try {
        stat = await fs.stat(fullPath);
      } catch {
        continue; // 无法 stat 的文件跳过
      }

      if (entry.isDirectory()) {
        // 先注册目录自身（方便客户端导航）
        results.push({
          name: entry.name,
          path: fullPath,
          relativePath,
          type: 'directory' as const,
          size: 0,
          modifiedAt: stat.mtimeMs,
        });
        // 递归子目录
        const subFiles = await this.scanWorkspaceDir(fullPath, relativePath);
        results.push(...subFiles);
      } else {
        results.push({
          name: entry.name,
          path: fullPath,
          relativePath,
          type: 'file' as const,
          size: stat.size,
          modifiedAt: stat.mtimeMs,
        });
      }
    }

    return results;
  }

  // ==================== 私有方法 ====================
  private send(message: any): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error('WebSocket is not connected');
    }
    this.ws.send(JSON.stringify(message));
  }

  //握手
  private async sendHandshake(nonce: string) {
    const { deviceToken, deviceId, publicKey, privateKeyPem } = this.deviceConfig;
    const opts = {
      type: 'req',
      id: this.generateId(),
      method: 'connect',
      params: {
        minProtocol: 3,
        maxProtocol: 4,
        client: {
          id: 'gateway-client', //cli->mode=operator,gateway-client->node,
          instanceId: "dlink-cmd-channel",
          version: '1.0.0',
          platform: 'web',
          mode: 'backend' //'node'
        },
        role: 'operator',
        scopes: ['operator.read', 'operator.write'],
        auth: {},
        device: {}
      }
    }

    const extScopes = ['operator.approvals', 'operator.talk.secrets', 'operator.admin']
    if (this.token && this.token.length > 0) {
      //console.log("使用共享Token握手 >>> ")
      const { signature, signedAtMs, } = signConnectPayload({
        deviceId,
        privateKeyPem,
        token: this.token,
        clientId: opts.params.client.id,
        clientMode: opts.params.client.mode,
        role: opts.params.role,
        scopes: [...opts.params.scopes, ...extScopes],
        platform: opts.params.client.platform,
        nonce: nonce!
      })

      opts.params = {
        ...opts.params,
        scopes: [...opts.params.scopes, ...extScopes],
        auth: { token: this.token },
        device: {
          id: deviceId,
          publicKey,
          signature,
          signedAt: signedAtMs,
          nonce
        }
      }

    } else if (!deviceToken || deviceToken.length === 0) {
      const bootstrapToken = await reqBootstrapToken(this.gatewayUrl);
      this.log("使用bootstrapToken握手", 'debug')
      const { signature, signedAtMs, } = signConnectPayload({
        deviceId,
        privateKeyPem,
        token: bootstrapToken,
        clientId: opts.params.client.id,
        clientMode: opts.params.client.mode,
        role: opts.params.role,
        scopes: [...opts.params.scopes],
        platform: opts.params.client.platform,
        nonce: nonce!
      })

      opts.params = {
        ...opts.params,
        auth: { bootstrapToken: bootstrapToken },
        device: {
          id: deviceId,
          publicKey,
          signature,
          signedAt: signedAtMs,
          nonce
        }
      }

    } else {
      this.log('使用deviceToken握手..', 'debug')
      const { signature, signedAtMs, } = signConnectPayload({
        deviceId,
        privateKeyPem,
        token: deviceToken,
        clientId: opts.params.client.id,
        clientMode: opts.params.client.mode,
        role: opts.params.role,
        scopes: [...opts.params.scopes, ...extScopes],
        platform: opts.params.client.platform,
        nonce: nonce!
      })
      opts.params = {
        ...opts.params,
        scopes: [...opts.params.scopes, ...extScopes],
        auth: {
          deviceToken: deviceToken
        },
        device: {
          id: deviceId,
          publicKey,
          signature,
          signedAt: signedAtMs,
          nonce
        }
      }
    }


    this.send(opts);
  }

  /**
   * 2026-09-06 适配 openclaw 2026.9.1：通用 Gateway 方法调用（配对审批等宿主 RPC）
   * 9.1 起部分能力（如 channels.pairing.approve）只以宿主 RPC 形式提供，
   * 插件通过已认证的 Gateway WebSocket 调用，参数透传宿主 handler。
   */
  async callGatewayMethod(method: string, params?: unknown): Promise<any> {
    if (!this.isReady()) {
      throw new Error(`Gateway WebSocket 未连接，无法调用 ${method}`);
    }
    return this.sendRequest({ type: 'req', method, params });
  }

  private sendRequest(message: Omit<RequestFrame, 'id'>): Promise<any> {
    const id = this.generateId();
    const fullMessage: RequestFrame = { ...message, id };
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.callbacks.delete(id);
        reject(new Error('Request timeout after 30 seconds'));
      }, 30000);
      this.callbacks.set(id, { resolve, reject, timeout });
      this.send(fullMessage);
    });
  }

  private async handleMessage(message: ClawMessage): Promise<void> {
    if (message.type === 'event') {
      const event = message.event;
      switch (event) {
        case 'tick':
          //心跳消息
          this.emit('onTick', message.payload);
          break;
        case 'health':
          //健康装态消息
          this.emit('onHealth', message.payload);
          break;
        case 'connect.challenge':
          //WS连接成功,开始握手
          //console.log('gateway token >>> ', this.token)
          this.log('WS连接成功,开始握手...', 'info')
          this.sendHandshake(message.payload.nonce);
          break;
        case 'agent':
          //agent回复
          this.log(`onAgentReply >>> ${message.payload}`, 'warn')
          this.emit('onAgentReply', message.payload);
          break;
        case 'chat':
          this.log(`onAgentChat >>> ${message.payload}`, 'warn')
          this.emit('onAgentChat', message.payload);
          break;
        case 'cron':
          // 定时任务生命周期事件（创建/更新/删除/执行完成等）
          this.log(`CRON事件 >>> ${message.payload}`, 'warn');
          this.emit('onCron', message.payload);
          break;
        case 'shutdown':
          // 网关关闭通知
          this.log('收到网关关闭通知', 'warn');  //好像没有效果
          this.emit('onShutdown', message.payload);
          break;
        case 'sessions.changed':
          // 会话变更通知
          this.log(`会话变更通知 >>> ${message.payload}`, 'warn');
          this.emit('onSessionsChanged', message.payload);
          break;
        case 'session.message':
          this.log(`会话消息,含中间回复 >>> ${message.payload}`, 'warn');
          this.emit('onSessionMessage', message.payload);
          break
        case 'presence':
          //该事件触发频率密度高，一些平台及环境信息,可以忽略
          break;
        case 'heartbeat':
          this.emit('onHeartbeat', message.payload);
          break;  
        default:
          this.log(`Ws监听未知/未处理的事件 >>> ${event}, payload=${JSON.stringify(message.payload)}`, 'warn')
      }
      return;
    }

    if (message.type === 'res') {
      const callback = this.callbacks.get(message.id);
      if (message.ok) {
        const payload = message.payload;
        if (payload) {
          const type = payload.type;
          switch (type) {
            case 'hello-ok':
              this.log('WS握手成功...', 'info');
              const dToken: string = payload.auth.deviceToken;
              if (dToken && dToken.length > 0) {
                if (!this.deviceConfig.deviceToken || this.deviceConfig.deviceToken.length === 0) {
                  saveDeviceConfig({
                    ...this.deviceConfig,
                    deviceToken: dToken
                  });
                }
              }
              this.isHandshaked = true;
              this.isConnected = true;
              this.emit('onHandshaked', payload);
              break;
          }
        }
        callback?.resolve(payload);
      } else {
        const error = message.error;
        if (error) {
          callback?.reject(new Error(`${error.code}, ${error.message}`));
        } else {
          callback?.reject(new Error('Request failed'));
        }
      }
      this.callbacks.delete(message.id);
    }
  }

  private generateId(): string {
    return `msg_${this.messageId++}_${Date.now()}`;
  }
}

export default WSClient;