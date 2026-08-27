


export type DLCallbackHandler = (...avg: any) => void;

export interface DLGroupConfig {
  enabled: boolean,
  //组发送者允许列表
  allowFrom?: Array<string | number>;
  topicSessionMode?: 'enabled' | 'disabled'
}

export interface DLResolvedAccount {
  accountId: string
  accountName?: string
  enabled: boolean
  config: DLConfig
}

export interface DLConfig {
  enabled: boolean
  apiKey: string
  secret: string
  baseUrl: string
  accountId?: string     //default account is 'default'
  accountName?: string
  /** open允许所有用户,allowlist[允许指定的用户],pairing需要管理员对码, disabled完全禁用*/
  dmPolicy?: "open" | "allowlist" | "pairing" | "disabled"
  allowFrom?: Array<string | number>
  /** 群组访问策略："open" = 允许所有群组（默认），"allowlist" = 仅允许 groupAllowFrom 中的群组，"disabled" = 禁用群组消息 */
  groupPolicy?: "open" | "allowlist" | "disabled"
  groupAllowFrom?: string[]
  configured?: boolean
  verificationToken?: string
  groups?: Record<string, DLGroupConfig>
  mediaMaxMb?: number
  historyLimit?: number
  dynamicAgentConfig?: DLDynamicAgentConfig
  accounts?: Map<string, DLConfig>
}

export type DLGroupMember = {
  id: string
  name: string
  /** 2026-08-13 新增：Agent 成员内部名（main/agent01 等），用于 Agent 间 sessions_send 协作路由 */
  agentId?: string
  responsibilities?: string
  type: 'agent' | 'user'
}

export type DLMsgType = 'text' | 'image' | 'voice' | 'video' | 'file' | 'mixed' | 'cmd';

/**
 * 不同渠道的Bot
 */
export type BotType = 'ewx' | 'qq' | 'dd' | 'feishu' | 'dLink'

export type ContactType = 'agent' | 'user' | 'group' | 'workflow' | 'task'

export interface DLQuoteBase {
  type: DLMsgType
}

export interface DLQuoteText extends DLQuoteBase {
  text: string
}

export interface DLQuoteImage extends DLQuoteBase {
  imageUrl: string
  aesKey?: string
}

export interface DLQuoteVoice extends DLQuoteBase {
  voiceUrl: string
  aesKey?: string
}

export interface DLQuoteVideo extends DLQuoteBase {
  videoUrl: string
  aesKey?: string
}

export interface DLQuoteFile extends DLQuoteBase {
  fileUrl: string
  aesKey?: string
}

export interface DLQuoteMixed extends DLQuoteBase {
  msgList: Array<DLTextBody | DLImageBody>
}

export interface DLBaseBody {
  msgType: DLMsgType
}

export interface DLMediaBody extends DLBaseBody {
  aesKey?: string
}

export interface DLTextBody extends DLBaseBody {
  text: string
  quote?: DLQuoteBase
}

export interface DLImageBody extends DLMediaBody {
  imageUrl: string
}

export interface DLVoiceBody extends DLMediaBody {
  voiceUrl: string
}

export interface DLVideoBody extends DLMediaBody {
  videoUrl: string
}

export interface DLFileBody extends DLMediaBody {
  fileUrl: string
}

export interface DLMixedBody extends DLBaseBody {
  msgList: Array<DLTextBody | DLImageBody | DLVoiceBody | DLVideoBody | DLFileBody>,
  quote?: DLQuoteBase
}

export type DLKind = 'block' | 'in_process' | 'tool' | 'plan' | 'patch' | 'command' | 'reasoning' | 'end_reasoning'
export type MessageStatus = 'read' | 'unRead' | undefined
export interface ChatUser {
  id: string
  nickname?: string
  avatar?: string,
  jobPost?:string
}

export interface FromUser {
  id: string,
  nickname?: string,
  chatTopic: string,
  notifyTopic: string
}

/**
 * DLinkclaw客户端定义
 * 直接发消息给客户端时使用
 */
export interface DLMessage {
  msgId: string
  streamId?: string
  chatId?: string

  sender: ChatUser
  receiver: ChatUser
  contactType: ContactType
  contactId: string
  botType: BotType

  payload: string
  createdAt: number | string,
  timezone?: string,
  status: MessageStatus
  finish: boolean
  kind?: DLKind,
  sessionKey?: string,
  runId?: string,
  relayType:'openClaw'
}

export interface ToAgent{
  sessionKey:string,
  agentId:string,
  id:string,
  nickname?:string,
  avatarUrl?:string,
  jobPost?:string,
}

export interface FromPerson{
  corpId:string,
  empId:string,
  nickname?:string,
  avatarUrl?:string,
  openId:string,
  thr3UserId?:string,
  thr3BotId?:string
}

/**
 * 服务端SpringBoot中定义
 * AgentMessage
 */
export interface DLMessagePayload {
  msgType?: Exclude<DLMsgType, 'cmd'>
  relayType:'openClaw'
  toAgent:ToAgent,
  fromPerson:FromPerson
  payload: string
  finish: boolean
  msgId: string
  streamId: string
  botType: BotType
  contactType: ContactType
  contactId: string
  notify: boolean
  notifyUrl?: string
  chatId?: string
  group: boolean,
  groupIntroduction?:string,
  reqId: string
  websocket: boolean

  askQuestion?: string
  timestamp?: number
  timezone?: string
  /** 指定会话路由: 客户端可直接指定完整的 sessionKey。
   * 不传时自动构建默认会话 (agent:main:workrelay:direct:xxx),
   * 传入时直接使用该 sessionKey 路由消息 */
  groupMembers?: Array<DLGroupMember>
  relayTimeRhreshold?: number //被动回复最后时间阀值,
  kind?: DLKind,
  runId?: string, //新增runId字段，用于回传（当前正在执行的任务runId,终止agent执行chat.abort时必填）
  fromUsers?: Array<FromUser>,
  archiveSession?: DLArchiveSession,
  relayId:string
}

export interface DLArchiveSession {
  archived: boolean,
  sessionKey: string,
  newSessionKey?: string,
  runId: string
}

export type DLIMessagePayload = {
  content: string
  userId: string
  streamId: string
  msgId: string
  timestamp: number
}


export type DLToolsConfig = {
  doc?: boolean
  wiki?: boolean
  drive?: boolean
  perm?: boolean
  scopes?: boolean
};

export type DLDynamicAgentConfig = {
  enabled?: boolean
  workspaceTemplate?: string
  agentDirTemplate?: string
  maxAgents?: number
};

export type DLMediaType = Exclude<DLMsgType, 'text' | 'mixed' | 'cmd'>

export type DLMediaInfo = {
  path: string
  contentType?: Exclude<DLMsgType, 'text' | 'mixed' | 'cmd'>
  placeholder: string
};

export type DLDownloadResourceResult = {
  buffer: Buffer
  contentType?: string
  fileName?: string
};