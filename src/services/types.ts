/**
 * OpenClaw Gateway API 类型定义
 * 用于 duolian 插件中的 claw-services
 */

// 2026-09-06 适配 openclaw 2026.9.1：根入口已移除，改从 core 导入
import { OpenClawConfig } from "openclaw/plugin-sdk/core";

// ==================== 基础类型 ====================

export interface ErrorShape {
  code: string;
  message: string;
  details?: unknown;
  retryable?: boolean;
  retryAfterMs?: number;
}

export interface RequestFrame {
  type: "req";
  id: string;
  method: string;
  params?: unknown;
}

export interface ResponseFrame {
  type: "res";
  id: string;
  ok: boolean;
  payload?: unknown;
  error?: ErrorShape;
}

export interface EventFrame {
  type: "event";
  event: string;
  payload?: unknown;
  seq?: number;
  stateVersion?: number;
}

// ==================== Agent 管理 API 类型 ====================

export interface AgentIdentity {
  name?: string;
  theme?: string;
  emoji?: string;
  avatar?: string;
  avatarUrl?: string;
}

export interface AgentModelConfig {
  primary?: string;
  fallbacks?: string[];
}

export interface AgentInfo {
  id: string;
  name?: string;
  identity?: AgentIdentity;
  workspace?: string;
  model?: AgentModelConfig;
}


export interface AgentsListResponse {
  defaultId: string;
  mainKey: string;
  scope: "per-sender" | "global";
  agents: AgentInfo[];
}

export interface AskAgentParams {
  agentId: string,
  message: string,
  sessionKey: string,
  deliver?: false
}

export interface AskAgentReply {
  runId: string,
  stream: 'lifecycle' | 'assistant',
  data: Record<string, any>
  sessionKey: string,
  seq: number,
  ts: number,
  spawnedBy?:string
}


export interface AgentCreateParams {
  name: string;
  workspace?: string;
  emoji?: string;
  avatar?: string;
  // 2026-09-18：新版 agents.create 直接支持 model（旧版不支持，需 create 后 update 补写）
  model?: string;
}

export interface AgentCreateResponse {
  ok: boolean;
  agentId: string;
  name: string;
  workspace: string;
}

export interface AgentUpdateParams {
  agentId: string;
  name?: string;
  workspace?: string;
  model?: string;
  avatar?: string;
}

export interface AgentUpdateResponse {
  ok: boolean;
  agentId: string;
}

export interface AgentDeleteParams {
  agentId: string;
  deleteFiles?: boolean;
}

export interface AgentDeleteResponse {
  ok: boolean;
}

// ==================== 任务管理 API 类型 ====================

export interface CronState{
  nextRunAtMs:number,
  lastRunAtMs:number,
  lastRunStatus:string,
  lastStatus:string,
  lastDurationMs:number,
  lastError?:string,
  lastDiagnosticSummary:string,
  lastDiagnostics?:Record<string, any>,
  lastDeliveryStatus:string,
  lastFailureNotificationDeliveryStatus:string,
  consecutiveErrors:number,
  consecutiveSkipped:number
}

export interface CronTask {
  id: string;
  name:string,
  enabled: boolean;
  deleteAfterRun:boolean,
  createdAtMs:number

  schedule: {
    kind:string
    expr:string
  };
  sessionTarget:string
  wakeMode:string
  payload:{
    kind:string
    message:string
  }
  delivery:{
    mode:string
    channel?:string
    to?:string
    bestEffort?:boolean
  },
  updatedAtMs:number
  agentId: string,
  state:CronState
}


export interface CronAddParams {
  name: string;
  description?: string;
  schedule: Record<string, unknown>;
  payload: Record<string, unknown>;
  delivery: Record<string, unknown>;
  sessionTarget?: string;
  wakeMode?: string;
  enabled?: boolean;
  deleteAfterRun?: boolean;
}

export interface CronAddResponse {
  ok: boolean
}

export interface CronListResponse {
  jobs: CronTask[];
  total:number,
  offset:number,
  limit:number,
  hasMore:boolean,
  nextOffset:number,

}

export interface CronRemoveParams {
  jobId: string;
}

export interface CronRemoveResponse {
  ok: boolean;
}

export interface CronUpdateParams {
  jobId: string;
  patch: {
    name?: string;
    description?: string;
    schedule?: Record<string, unknown>;
    payload?: Record<string, unknown>;
    delivery?: Record<string, unknown>;
    enabled?: boolean;
    deleteAfterRun?: boolean;
  };
}

export interface CronUpdateResponse {
  ok: boolean;
}

export interface CronRunParams {
  jobId: string;
}

export interface CronRunResponse {
  ok: boolean;
  runId?: string;
}

// ==================== 状态监控 API 类型 ====================

export interface HealthStatus {
  status: "healthy" | "degraded" | "unhealthy";
  version: string;
  uptime: number;
  agents: Record<string, { status: string }>;
  channels: Record<string, { status: string }>;
  memory?: {
    used: number;
    total: number;
    percent: number;
  };
}

export interface SystemStatus {
  gateway: {
    version: string;
    uptime: number;
    status: string;
  };
  memory: {
    used: number;
    total: number;
    percent: number;
  };
  agents: {
    total: number;
    active: number;
  };
  channels: {
    total: number;
    connected: number;
  };
  models: {
    primary: string;
    provider: string;
  };
}

export interface UsageStatus {
  totalTokens: number;
  totalCost: number;
  todayTokens: number;
  todayCost: number;
  byModel: Record<string, {
    tokens: number;
    cost: number;
    requests: number;
  }>;
  byAgent: Record<string, {
    tokens: number;
    cost: number;
    requests: number;
  }>;
}

// ==================== 服务层类型 ====================

export interface ClawServiceOptions {
  cfg: OpenClawConfig,
  channelId: string,
  baseUrl: string,
  gatewayUrl: string;
  token?: string
}

export interface AgentSummary {
  id: string;
  name: string;
  emoji?: string;
  model?: string;
  workspace?: string;
  fileCount: number;
  lastActivity?: string;
  sessionCount: number;
}

export interface TaskSummary {
  id: string;
  label: string;
  schedule: string;
  agentId:string,
  agentName: string;
  status: 'enabled' | 'disabled' | 'running';
  nextRun?: string;
  lastRun?: string;
}

export interface SystemSummary {
  status: 'healthy' | 'degraded' | 'unhealthy';
  version: string;
  uptime: string;
  agentCount: number;
  channelCount: number;
  memoryUsage: string;
  totalTokens: number;
  totalCost: number;
}

// ==================== CMD 消息类型 ====================

export interface CmdMessage {
  requestId: string;
  from?: string,
  cmd: CmdType;
  params?: Record<string, any>;
  timestamp: number;
}

export interface CmdResponse {
  requestId?: string,
  success: boolean;
  data?: any;
  error?: string;
  timestamp: number;
}

export interface CmdResult {
  apiKey: string,
  type: 'cmd' | 'event',
  event?: EventType,
  payload?: any,
  agentBrand: 'openClaw',
  timestamp:string | number,
  timezone:string
}



// 支持的CMD命令
export type CmdType =
  | 'agent.ask'
  | 'agent.list'
  | 'agent.create'
  | 'agent.update'
  | 'agent.delete'
  | 'agent.get'
  | 'agent.stop'
  | 'chat.abort'

  | 'task.list'
  | 'task.create'
  | 'task.update'
  | 'task.delete'
  | 'task.run'

  | 'status.health'
  | 'status.system'
  | 'status.usage'

  | 'models.list'

  | 'sessions.list'
  | 'sessions.get'
  | 'sessions.describe'
  | 'sessions.resolve'
  | 'sessions.create'
  | 'sessions.archive'
  | 'sessions.restore'
  | 'sessions.delete'
  | 'sessions.reset'
  | 'sessions.patch'
  | 'sessions.currentModel'

  // 2026-10-21：终端能力（品牌中立协议，owner-only）
  | 'terminal.open'
  | 'terminal.input'
  | 'terminal.resize'
  | 'terminal.close'

  | 'chat.history'
  | 'chat.trajectory' //会话聊天内容轨迹,加载的是sessionId.jsonl文件, 不是sessionId.trajectory.jsonl

  | 'skills.status'
  | 'skills.search'
  | 'skills.detail'
  | 'skills.install'
  | 'skills.update'
  | 'skills.securityVerdicts'
  | 'cancelMessage' // 取消当前Agent执行

  | 'usage.cost'
  | 'sessions.usage'
  | 'sessions.usage.logs'

  | 'pairing.approve' //客户端发送对码审批指令

  // 工作区 / 会话工件
  | 'artifacts.list'
  | 'artifacts.get'
  | 'artifacts.download'

  // Agent 工作区文件
  | 'agents.files.list'
  | 'agents.files.get'

  // 扩展能力（ext_capabilities）：语音合成 TTS / 语音转录 STT 等
  | 'extCapabilities.status' //查询扩展能力安装状态（执行对应 status.sh）
  | 'extCapabilities.check' //检查扩展能力安装前置条件（执行 manifest.json 中的检测命令）
  | 'extCapabilities.install' //安装扩展能力（后台执行对应 install.sh，长任务）

export type ReadlineType = Extract<CmdType, 'chat.trajectory'>

export interface ClawMessage {
  type: 'res' | 'event';
  event?: 'health' 
  | 'connect.challenge' 
  | 'tick' 
  | 'agent' 
  | 'chat' 
  | 'cron' 
  | 'shutdown' 
  | 'sessions.changed' 
  | 'presence'
  | 'session.message'
  | 'heartbeat'
  id: string,
  ok: boolean,
  payload: any,
  error?: any
}

export type EventType =
  | 'onTick'
  | 'onHealth'
  | 'onHandshaked'
  | 'onConnectState'
  | 'onError'
  | 'onAgentReply'
  | 'onAgentChat'
  | 'onChatTrajectory'
  | 'onCron'
  | 'onShutdown'
  | 'onSessionsChanged'
  | 'onSkillInstalled'
  | 'onSkillInstalling'
  | 'onSkillError'
  | 'onPairingRequest'
  | 'onPairingResult'
  | 'onTerminal'


export type CmdParamsPatchSessionEntry = {
  sessionKey:string
  provider?: string,
  model?: string,
  /** 2026-10-21：会话级推理强度（off/minimal/low/medium/high），与模型选择同通道 */
  thinkingLevel?: string,
}

// ==================== Skill 类型 ====================

export interface SkillInfo {
  name: string;
  version?: string;
  description?: string;
  enabled: boolean;
  configured: boolean;
  eligibility?: string;
  missingRequirements?: string[];
  configCheck?: Record<string, any>;
  source?: string;
  // ClawHub 返回的字段
  slug?: string;
  author?: string;
  installs?: number;
  category?: string;
}

export interface SkillSearchParams {
  query?: string;
  limit?: number;
}

export interface SkillInstallParams {
  slug: string;
  version?: string;
  force?: boolean;
}

// ==================== 工作区 / Artifact API 类型 ====================

/** 工件（Artifact）：Agent 在会话中操作文件产生的记录 */
export interface ArtifactInfo {
  id: string;
  type: string;
  action: string;
  path?: string;
  title?: string;
  mimeType?: string;
  size?: number;
  displayed: boolean;
  timestamp: number;
  sessionKey: string;
  runId?: string;
}

/** artifacts.list 返回 */
export interface ArtifactsListResponse {
  artifacts: ArtifactInfo[];
  stats?: {
    changedCount: number;
    readCount: number;
    artifactCount: number;
    displayedCount: number;
  };
}

/** artifacts.list / artifacts.get 参数 */
export interface ArtifactsQuery {
  sessionKey?: string;
  runId?: string;
  taskId?: string;
}

export interface ArtifactGetParams {
  artifactId: string;
}

export interface ArtifactDownloadParams {
  artifactId: string;
}

/** agents.files 参数 */
export interface AgentFilesListParams {
  agentId: string;
}

export interface AgentFilesGetParams {
  agentId: string;
  name: string;
}

// ==================== 终端（2026-10-21，协议级能力） ====================
export type TerminalOpenParams = { sessionId: string; cwd?: string; cols?: number; rows?: number };
export type TerminalInputParams = { sessionId: string; data: string };
export type TerminalResizeParams = { sessionId: string; cols: number; rows: number };
export type TerminalCloseParams = { sessionId: string };
