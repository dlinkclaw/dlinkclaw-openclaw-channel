// 2026-09-06 适配 openclaw 2026.9.1：根入口已移除，改从 core 导入
import { OpenClawConfig, PluginLogger, PluginRuntime, ReplyPayload } from "openclaw/plugin-sdk/core";
import { BotType, DLBaseBody, DLFileBody, DLImageBody, DLKind, DLMessagePayload, DLMixedBody, DLMsgType, DLQuoteBase, DLQuoteFile, DLQuoteImage, DLQuoteMixed, DLQuoteText, DLQuoteVideo, DLQuoteVoice, DLResolvedAccount, DLTextBody, DLVideoBody, DLVoiceBody, FromPerson, ToAgent } from "./types.js";
import { DLClient } from "./dl-client.js";
import { MEDIA_DOCUMENT_PLACEHOLDER, MEDIA_IMAGE_PLACEHOLDER, MEDIA_VIDEO_PLACEHOLDER, MEDIA_VOICE_PLACEHOLDER } from "./const.js";
import { md5 } from "./crypto.js";
import { createChannelHistoryWindow, HistoryEntry } from "openclaw/plugin-sdk/reply-history";
import { buildChannelInboundEventContext, InboundMediaFacts } from "openclaw/plugin-sdk/channel-inbound";
import { uuidStr } from "../utils.js";
import { ChatType } from "openclaw/plugin-sdk/core";

export interface ParsedMessageContent {
  textParts: string[];
  imageUrls: string[];
  imageAesKeys: Map<string, string>;
  voiceUrls: string[];
  voiceAesKeys: Map<string, string>;
  videoUrls: string[];
  videoAesKeys: Map<string, string>
  fileUrls: string[];
  fileAesKeys: Map<string, string>;
  quoteContent: string | undefined;
}

export interface Accumulators {
  key: string,
  expireTime: number,
  accumulatedPayload: string;
  originalFields: Omit<DLMessagePayload, 'payload' | 'finish' | 'streamId'>
}

export type AccumulatorsStatus = Omit<Accumulators, 'expireTime' | 'relayTime' | 'originalFields'>

/**
 * 主动回复参数
 */
export type AutoReplyOpts = {
  toAgent: ToAgent,
  fromUser: FromPerson,
  botType: BotType,
  chatId: string,
  isGroup: boolean,
  relayId: string,
  notifyUrl?: string,
  contactId?: string
}

//入站队列最大数
const MESSAGE_QUEUE_SIZE = 2_000;
// Message accumulator: stores the accumulated payload and original message fields by streamId
const messageAccumulators: Map<string, Accumulators> = new Map();
//依不同的中继及通信方式获取最大等待时间(被动回复时间，如超过该时间则改用主动回复)
const getExpireTime = (botType: BotType, websocket: boolean): number => {
  switch (botType) {
    case "ewx":
      //企业微信Websocket被动回复最长24小时，Webhook 1小时
      return websocket ? (24 * 60 * 60 * 1000) : (60 * 60 * 1000);
    case "qq":
    case "dd":
    case "feishu":
    case "dLink":
      return 24 * 60 * 60 * 1000;
  }
}

/**
 * mqtt接收到消息后预处理
 * @param msg 
 * @param logger 
 */
export const messagePreviewHandler = (msg: DLMessagePayload, accountId: string, logger: PluginLogger): AccumulatorsStatus => {
  logger.info(`account[${accountId}],[Message.ts(messagePreviewHandler)] message body:${msg.payload}`);
  const now = Date.now();
  //队列最多存放1000条消息,超过会移除最早一条
  if (messageAccumulators.size >= MESSAGE_QUEUE_SIZE) {
    const first = messageAccumulators.values().next().value!;
    messageAccumulators.delete(first.key);
    logger.warn(`[messagePreviewHandler] account[${accountId}] The message [${first.key}] has been cleaned. `)
  }
  //清理超时队列
  const expireList = Array.from(messageAccumulators.values()).filter(item => now >= item.expireTime);
  if (expireList.length > 0) {
    expireList.forEach(item => {
      messageAccumulators.delete(item.key);
      logger.warn(`[messagePreviewHandler] account[${accountId}] The message [${item.key}] has been cleaned. `);
    });
  }
  //过滤重复的请求
  if (messageAccumulators.has(msg.streamId)) {
    logger.warn(`[messagePreviewHandler] account[${accountId}] The message has Multiple, Ignored`);
    return {
      key: msg.streamId,
      accumulatedPayload: ''
    };
  }
  //队列有效时间，超过该时间会自动被清理
  const time = now + getExpireTime(msg.botType, msg.websocket);
  //接收到的消息放入队列
  messageAccumulators.set(msg.streamId, {
    key: msg.streamId,
    expireTime: time,
    accumulatedPayload: '',
    originalFields: {
      toAgent: msg.toAgent,
      fromPerson: msg.fromPerson,
      msgId: msg.msgId,
      botType: msg.botType,
      contactType: msg.contactType,
      contactId: msg.contactId,
      notify: msg.notify,
      notifyUrl: msg.notifyUrl,
      chatId: msg.chatId,
      group: msg.group,
      groupIntroduction: msg.groupIntroduction,
      reqId: msg.reqId,
      websocket: msg.websocket,
      askQuestion: msg.payload,
      msgType: msg.msgType,
      relayTimeRhreshold: time,
      fromUsers: msg.fromUsers,
      relayType: 'openClaw',
      relayId: msg.relayId
    }
  })
  msg.relayTimeRhreshold = time;
  return {
    key: msg.streamId,
    accumulatedPayload: ''
  }
}

/**
 * 消息出站时构建回复消息
 * @param param0 
 * @returns 
 */
export const buildDLReplyMessage = ({
  streamId,
  content,
  finish,
  kind,
  runId
}: {
  streamId: string,
  content: string,
  finish: boolean,
  kind: DLKind,
  runId?: string
}) => {
  const accumulator = messageAccumulators.get(streamId);
  if (!accumulator) {
    //已超过队例时间,已被清除了
    return undefined;
  }
  if (runId && runId.length > 0) {
    //在agent开发执行任务时首先会输出该runId
    accumulator.originalFields.runId = runId; //更新runId, 需要回传到服务端
  }
  accumulator.accumulatedPayload = content;
  const resultMessage: DLMessagePayload = {
    payload: accumulator.accumulatedPayload,
    finish: finish,
    streamId: streamId,
    msgId: accumulator.originalFields.msgId,
    fromPerson: accumulator.originalFields.fromPerson,
    toAgent: accumulator.originalFields.toAgent,
    botType: accumulator.originalFields.botType,
    contactType: accumulator.originalFields.contactType,
    contactId: accumulator.originalFields.contactId,
    notify: accumulator.originalFields.notify,
    notifyUrl: accumulator.originalFields.notifyUrl,
    chatId: accumulator.originalFields.chatId,
    group: accumulator.originalFields.group,
    reqId: accumulator.originalFields.reqId,
    websocket: accumulator.originalFields.websocket,

    askQuestion: accumulator.originalFields.askQuestion,
    msgType: accumulator.originalFields.msgType,
    timestamp: Date.now(),
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    relayTimeRhreshold: accumulator.originalFields.relayTimeRhreshold,
    fromUsers: accumulator.originalFields.fromUsers,
    kind,
    runId: accumulator.originalFields.runId,
    relayType: 'openClaw',
    relayId: accumulator.originalFields.relayId
  }
  if (finish) {
    messageAccumulators.delete(streamId)
  }
  return resultMessage;
}

/**
 * 解析消息内容（支持单条消息、图文混排和引用消息）
 * @returns 提取的文本数组、图片URL数组和引用消息内容
 */
export function parseMessageContent(payload: string): ParsedMessageContent | undefined {
  const textParts: string[] = [];
  const imageUrls: string[] = [];
  const imageAesKeys = new Map<string, string>();
  const voiceUrls: string[] = [];
  const voiceAesKeys = new Map<string, string>();
  const videoUrls: string[] = [];
  const videoAesKeys = new Map<string, string>();
  const fileUrls: string[] = [];
  const fileAesKeys = new Map<string, string>();
  let quoteContent: string | undefined;

  let msgBody: DLBaseBody;
  try {
    msgBody = JSON.parse(payload);
  } catch (e) {
    return undefined;
  }
  const msgtype: Exclude<DLMsgType, 'cmd'> = msgBody.msgType as Exclude<DLMsgType, 'cmd'>;
  // 处理图文混排消息
  switch (msgtype) {
    case "text":
      const textBody = msgBody as DLTextBody;
      if (textBody.text && textBody.text.length > 0) {
        textParts.push(textBody.text);
      }
      const textQuote = textBody.quote;
      if (textQuote) {
        quoteContent = resolveQuote({
          quote: textQuote,
          quoteContent,
          imageUrls,
          imageAesKeys,
          voiceUrls,
          voiceAesKeys,
          videoUrls,
          videoAesKeys,
          fileUrls,
          fileAesKeys
        });
      }
      break;
    case "image":
      const imageBody = msgBody as DLImageBody;
      if (imageBody.imageUrl && imageBody.imageUrl.length > 0) {
        imageUrls.push(imageBody.imageUrl);
        if (imageBody.aesKey && imageBody.aesKey.length > 0) {
          imageAesKeys.set(md5(imageBody.imageUrl), imageBody.aesKey)
        }
      }
      break;
    case "voice":
      const voiceBody = msgBody as DLVoiceBody;
      if (voiceBody.voiceUrl && voiceBody.voiceUrl.length > 0) {
        voiceUrls.push(voiceBody.voiceUrl);
        if (voiceBody.aesKey && voiceBody.aesKey.length > 0) {
          voiceAesKeys.set(md5(voiceBody.voiceUrl), voiceBody.aesKey);
        }
      }
      break;
    case "video":
      const videoBody = msgBody as DLVideoBody;
      if (videoBody.videoUrl && videoBody.videoUrl.length > 0) {
        videoUrls.push(videoBody.videoUrl);
        if (videoBody.aesKey && videoBody.aesKey.length > 0) {
          videoAesKeys.set(md5(videoBody.videoUrl), videoBody.aesKey)
        }
      }
      break;
    case "file":
      const fileBody = msgBody as DLFileBody;
      if (fileBody.fileUrl && fileBody.fileUrl.length > 0) {
        fileUrls.push(fileBody.fileUrl);
        if (fileBody.aesKey && fileBody.aesKey.length > 0) {
          fileAesKeys.set(md5(fileBody.fileUrl), fileBody.aesKey);
        }
      }
      break;
    case "mixed":
      const mixedBody = msgBody as DLMixedBody;
      for (const item of mixedBody.msgList) {
        switch (item.msgType) {
          case "text":
            const text = (item as DLTextBody).text;
            if (text && text.length > 0) {
              textParts.push(text);
            }
            break;
          case "image":
            const image = (item as DLImageBody);
            if (image.imageUrl && image.imageUrl.length > 0) {
              imageUrls.push(image.imageUrl);
              if (image.aesKey && image.aesKey.length > 0) {
                imageAesKeys.set(md5(image.imageUrl), image.aesKey);
              }
            }
            break;
          case "voice":
            const voice = (item as DLVoiceBody);
            if (voice.voiceUrl && voice.voiceUrl.length > 0) {
              voiceUrls.push(voice.voiceUrl);
              if (voice.aesKey && voice.aesKey.length > 0) {
                voiceAesKeys.set(md5(voice.voiceUrl), voice.aesKey)
              }
            }
            break;
          case "video":
            const video = (item as DLVideoBody);
            if (video.videoUrl && video.videoUrl.length > 0) {
              videoUrls.push(video.videoUrl);
              if (video.aesKey && video.aesKey.length > 0) {
                videoAesKeys.set(md5(video.videoUrl), video.aesKey)
              }
            }
            break;
          case "file":
            const file = (item as DLFileBody);
            if (file.fileUrl && file.fileUrl.length > 0) {
              fileUrls.push(file.fileUrl);
              if (file.aesKey && file.aesKey.length > 0) {
                fileAesKeys.set(md5(file.fileUrl), file.aesKey)
              }
            }
        }
      }
      const quote = mixedBody.quote;
      if (quote) {
        quoteContent = resolveQuote({
          quote,
          quoteContent,
          imageUrls,
          imageAesKeys,
          voiceUrls,
          voiceAesKeys,
          videoUrls,
          videoAesKeys,
          fileUrls,
          fileAesKeys
        });
      }
      break;
  }
  return {
    textParts,
    imageUrls,
    imageAesKeys,
    voiceUrls,
    voiceAesKeys,
    videoUrls,
    videoAesKeys,
    fileUrls,
    fileAesKeys,
    quoteContent
  };
}

function resolveQuote(params: {
  quote: DLQuoteBase,
  quoteContent?: string,

  imageUrls: Array<string>,
  imageAesKeys: Map<string, string>,

  voiceUrls: Array<string>,
  voiceAesKeys: Map<string, string>,

  videoUrls: Array<string>,
  videoAesKeys: Map<string, string>

  fileUrls: Array<string>,
  fileAesKeys: Map<string, string>
}) {
  const { quote, quoteContent, imageUrls, imageAesKeys, voiceUrls, voiceAesKeys, videoUrls, videoAesKeys, fileUrls, fileAesKeys } = params;
  let content = quoteContent ?? '';
  if (quote.type === 'text') {
    content = (quote as DLQuoteText).text;
  } else if (quote.type === 'image') {
    const body = (quote as DLQuoteImage);
    if (body.imageUrl && body.imageUrl.length > 0) {
      imageUrls.push(body.imageUrl);
      if (body.aesKey && body.aesKey.length > 0) {
        imageAesKeys.set(body.imageUrl, body.aesKey)
      }
    }
  } else if (quote.type === 'voice') {
    const body = quote as DLQuoteVoice;
    if (body.voiceUrl && body.voiceUrl.length > 0) {
      voiceUrls.push(body.voiceUrl);
      if (body.aesKey && body.aesKey.length > 0) {
        voiceAesKeys.set(body.voiceUrl, body.aesKey);
      }
    }
  } else if (quote.type === 'video') {
    const body = quote as DLQuoteVideo;
    if (body.videoUrl && body.videoUrl.length > 0) {
      videoUrls.push(body.videoUrl);
      if (body.aesKey && body.aesKey.length > 0) {
        videoAesKeys.set(body.videoUrl, body.aesKey)
      }
    }
  } else if (quote.type === 'file') {
    const body = quote as DLQuoteFile;
    if (body.fileUrl && body.fileUrl.length > 0) {
      fileUrls.push(body.fileUrl);
      if (body.aesKey && body.aesKey.length > 0) {
        fileAesKeys.set(body.fileUrl, body.aesKey)
      }
    }
  } else if (quote.type === 'mixed') {
    const items = (quote as DLQuoteMixed).msgList ?? [];
    for (const item of items) {
      if (item.msgType === 'text') {
        const body = item as DLTextBody;
        if (body.text && body.text.length > 0) {
          content += body.text
        }
      } else if (item.msgType === 'image') {
        const body = item as DLImageBody;
        if (body.imageUrl && body.imageUrl.length > 0) {
          imageUrls.push(body.imageUrl);
          if (body.aesKey && body.aesKey.length > 0) {
            imageAesKeys.set(body.imageUrl, body.aesKey);
          }
        }
      }
    }
  }
  return content;
}

async function resetSession({
  client,
  sessionKey,
  streamId,
  agentId
}: {
  client: DLClient,
  sessionKey: string,
  streamId: string,
  agentId: string
}) {
  //拦截/new,/reset 指令
  //获取历史会话记录
  const histories = await client.exeCmd({
    cmd: 'chat.history',
    requestId: uuidStr(36),
    timestamp: Date.now(),
    params: {
      sessionKey,
      limit: 100
    }
  })

  if (!histories?.success || !histories.data) {
    client.publishToServer({
      streamId,
      content: `[tag_error_session_history_fail]${histories?.error ?? ''}`,
      finish: true,
      kind: 'block'
    });
    return true;
  }

  //const sid: string = histories.data.sessionId;
  const historyRecords = histories.data.messages ?? [];
  const msgList: Array<string> = historyRecords.map((item: any) => {
    const content = item.content;
    if (typeof content === 'string') {
      return `[${item.role}] ${item.content}`
    }
    const items: Array<string> = content.map((msg: any) => {
      try {
        if (msg.type === 'text') {
          return msg.text
        }
      } catch (e) {
      }
      return ''
    });
    const newItems = items.filter(rec => rec.length > 0);
    return `[${item.role}] ${newItems.join(';')}`
  })

  if (msgList.length === 0) {
    client.publishToServer({
      streamId,
      content: '[tag_error_session_record_empty]',
      finish: true,
      kind: 'block'
    });
    return true;
  }

  const resetResult = await client.exeCmd({
    cmd: 'sessions.reset',
    requestId: uuidStr(36),
    timestamp: Date.now(),
    params: {
      key: sessionKey,
      reason: "new"
    }
  });

  if (!resetResult?.success || !resetResult.data) {
    client.publishToServer({
      streamId,
      content: '[tag_error_reset_session_fail]' + (resetResult?.error || ''),
      kind: 'block',
      finish: true,
    });
    return true;
  }

  const prompt = `请根据以下聊天记录，生成一个不超过128字的标题，概括这次对话的主题：
          ${msgList.join('\n')}
  
          要求：
          - 标题长度 ≤ 128 字
          - 简洁准确地概括对话核心内容
          - 直接输出标题，并在标题末尾符加上标记"[tag_reset]"，不要多余文字`;

  const askAgent = await client.exeCmd({
    cmd: 'agent.ask',
    requestId: uuidStr(36),
    timestamp: Date.now(),
    params: {
      agentId,
      message: prompt,
      sessionKey,
      deliver: false,  //表示出站时不走deliver
      idempotencyKey: uuidStr(36)
    }
  })

  let askAgentError = ''
  if (!askAgent?.success || !askAgent.data) {
    askAgentError = `[tag_error_summarize_session_history_fail]\n ${askAgent?.error}`
  }
  const status = askAgent?.data.status;
  if (status !== 'accepted') {
    askAgentError = `${agentId} [tag_error_reject_session_history]`;
  }
  if (askAgentError && askAgentError.length > 0) {
    client.publishToServer({
      streamId,
      content: askAgentError,
      kind: 'block',
      finish: true,
    });
    return true;
  }
  const runId = askAgent?.data.runId
  const new_sessionId = resetResult.data.entry.sessionId;
  if (new_sessionId) {
    client.publishToServer({
      streamId,
      content: '[tag_new_session_success]',
      finish: true,
      kind: 'block',
      session: {
        sessionKey,
        runId,
        //sessionId: new_sessionId,
        archived: false
      }
    });
    return true;
  }
  return false;
}

async function archiveSession({
  client,
  sessionKey,
  streamId,
  agentId,
  chatId,
  chatType,
  channelId
}: {
  client: DLClient,
  sessionKey: string,
  streamId: string,
  agentId: string,
  chatId: string,
  chatType: ChatType,
  channelId: string
}) {
  //获取历史会话记录
  const histories = await client.exeCmd({
    cmd: 'chat.history',
    requestId: uuidStr(36),
    timestamp: Date.now(),
    params: {
      sessionKey,
      limit: 100
    }
  })
  if (!histories?.success || !histories.data) {
    client.publishToServer({
      streamId,
      content: `[tag_error_session_history_fail]${histories?.error ?? ''}`,
      finish: true,
      kind: 'block'
    });
    return;
  }
  const historyRecords = histories.data.messages ?? [];
  const msgList: Array<string> = historyRecords.map((item: any) => {
    const content = item.content;
    if (typeof content === 'string') {
      return `[${item.role}] ${item.content}`
    }
    const items: Array<string> = content.map((msg: any) => {
      try {
        if (msg.type === 'text') {
          return msg.text
        }
      } catch (e) {
      }
      return ''
    });
    const newItems = items.filter(rec => rec.length > 0);
    return `[${item.role}] ${newItems.join(';')}`
  })

  if (msgList.length === 0) {
    client.publishToServer({
      streamId,
      content: '[tag_error_session_record_empty]',
      finish: true,
      kind: 'block'
    });
    return
  }

  //调用 sessions.archive 真正归档（不 reset，保留完整对话）
  const archiveResult = await client.exeCmd({
    cmd: 'sessions.archive',
    requestId: uuidStr(36),
    timestamp: Date.now(),
    params: { sessionKey }
  });

  if (!archiveResult?.success || !archiveResult.data) {
    client.publishToServer({
      streamId,
      content: '[tag_error_archive_session_fail]' + (archiveResult?.error || ''),
      kind: 'block',
      finish: true,
    });
    return;
  }

  //自动创建新会话（带后缀），后续消息走新会话
  const newSuffix = Date.now().toString(36);
  const createResult = await client.exeCmd({
    cmd: 'sessions.create',
    requestId: uuidStr(36),
    timestamp: Date.now(),
    params: {
      agentId,
      userId: chatId,
      chatType,
      suffix: newSuffix
    }
  });

  if (!createResult?.success || !createResult.data) {
    client.publishToServer({
      streamId,
      content: '[tag_error_create_session_fail]' + (createResult?.error || ''),
      kind: 'block',
      finish: true,
    });
    return
  }

  const newSessionKey = `agent:${agentId}:${channelId}-${newSuffix}:${chatType}:${chatId.toLowerCase()}`;

  //生成标题（在新的 agent 会话中执行）
  const prompt = `请根据以下聊天记录，生成一个不超过128字的标题，概括这次对话的主题：
          ${msgList.join('\n')}
  
          要求：
          - 标题长度 ≤ 128 字
          - 简洁准确地概括对话核心内容
          - 直接输出标题，并在标题末尾符加上标记"[tag_archive]"，不要多余文字`;

  const askAgent = await client.exeCmd({
    cmd: 'agent.ask',
    requestId: uuidStr(36),
    timestamp: Date.now(),
    params: {
      agentId,
      message: prompt,
      sessionKey,
      deliver: false,
      idempotencyKey: uuidStr(36)
    }
  })

  let askAgentError = ''
  if (!askAgent?.success || !askAgent.data) {
    askAgentError = `[tag_error_summarize_session_history_fail]\n ${askAgent?.error}`
  }
  const status = askAgent?.data.status;
  if (status !== 'accepted') {
    askAgentError = `${agentId} [tag_error_reject_session_history]`;
  }
  if (askAgentError && askAgentError.length > 0) {
    client.publishToServer({
      streamId,
      content: askAgentError,
      kind: 'block',
      finish: true,
    });
    return
  }
  const runId = askAgent?.data.runId

  // 返回归档成功 + 新会话 key
  client.publishToServer({
    streamId,
    content: '[tag_archive_success]',
    finish: true,
    kind: 'block',
    session: {
      sessionKey,
      runId,
      newSessionKey,
      archived: true
    }
  });
}

export async function buildMessageContext(params: {
  core: PluginRuntime,
  channelId: string,
  account: DLResolvedAccount,
  clawConfig: OpenClawConfig,
  msg: DLMessagePayload,
  imageList: Array<InboundMediaFacts>
  voiceList: Array<InboundMediaFacts>
  videoList: Array<InboundMediaFacts>
  fileList: Array<InboundMediaFacts>
  textBody?: string,
  quoteContent?: string,
  commandAuthorized?: boolean,
  chatHistories: Map<string, HistoryEntry[]>,
  historyLimit: number,
  logger: PluginLogger,
  client: DLClient;
  streamId: string,
  relayId: string,
}): Promise<any> {
  const { core,
    channelId,
    account,
    clawConfig,
    msg,
    imageList, voiceList, videoList, fileList,
    textBody,
    quoteContent,
    commandAuthorized,
    chatHistories,
    historyLimit,
    logger,
    client,
    streamId,
    relayId
  } = params;
  const toAgent = msg.toAgent;
  const fromUser = msg.fromPerson;
  const isGroup = msg.group;
  const groupIntroduction = msg.groupIntroduction;
  const chatType: ChatType = isGroup ? "group" : "direct";
  // 构建会话标签
  let chatId, fromLabel, from, to;
  if (isGroup) {
    chatId = msg.chatId!
    fromLabel = `group:${chatId}-${toAgent.id}-${msg.botType}-${relayId}`;
  } else {
    chatId = fromUser.empId; //CorpEmployee.id
    fromLabel = `user:${chatId}-${toAgent.id}-${msg.botType}-${relayId}`;
  }
  // 当客户端指定了 sessionKey 时，将其编码到 from/to 中（# 分隔），
  // 便于 autoReply 主动出站时解析当前会话

  const sessionLabel = (toAgent.sessionKey && toAgent.sessionKey.length > 0) ? `#${toAgent.sessionKey}` : '';
  from = `${channelId}:${fromLabel}${sessionLabel}`;
  to = `${channelId}:${fromLabel}${sessionLabel}`;

  let messageBody = (textBody && textBody.length > 0) ? textBody : "";

  const media_placeholder = [];
  if (imageList.length > 0) {
    media_placeholder.push(MEDIA_IMAGE_PLACEHOLDER)
  }
  if (voiceList.length > 0) {
    media_placeholder.push(MEDIA_VOICE_PLACEHOLDER)
  }
  if (videoList.length > 0) {
    media_placeholder.push(MEDIA_VIDEO_PLACEHOLDER)
  }
  if (fileList.length > 0) {
    media_placeholder.push(MEDIA_DOCUMENT_PLACEHOLDER)
  }

  messageBody = media_placeholder.join('') + messageBody;
  const mediaList: Array<InboundMediaFacts> = [...imageList, ...voiceList, ...videoList, ...fileList];

  //会话路由
  // let route = core.channel.routing.resolveAgentRoute({
  //   cfg: clawConfig,
  //   channel: channelId,
  //   accountId: account.accountId!,
  //   peer: {
  //     kind: chatType,
  //     id: chatId,
  //   },
  // });
  const agentId = toAgent.agentId;
  // 客户端传了 sessionKey 则直接使用，否则自动构建默认会话
  const sessionKey = toAgent.sessionKey || core.channel.routing.buildAgentSessionKey({
    agentId: agentId,
    channel: channelId,
    accountId: account.accountId,
    peer: {
      kind: chatType,
      id: chatId
    },
    dmScope: 'per-channel-peer'
  })

  //拦截 /archive 指令：真正归档当前会话 + 自动新建
  if ("/archive" === messageBody.toLowerCase()) {
    await archiveSession({
      client,
      sessionKey,
      streamId,
      agentId,
      chatId,
      chatType,
      channelId
    })
    return undefined;
  }

  //拦截/new,/reset 指令
  if (commandAuthorized && "/new" === messageBody.toLowerCase() || "/reset" === messageBody.toLowerCase()) {
    const res = await resetSession({
      client,
      sessionKey,
      streamId,
      agentId
    })
    if (res) {
      return undefined
    }
  }

  //重启openclaw gateway restart
  if (commandAuthorized && "/restart" === messageBody.toLowerCase()) {
    await client.publishToServer({
      streamId,
      content: '[tag_gateway_restart]',
      finish: true,
      kind: 'block'
    })
  }

  // 强制停止当前 Agent run（/stop 指令，比 /queue interrupt 更快）
  // 新增 cmd 通道 /stop 指令
  if (commandAuthorized && "/stop" === messageBody.toLowerCase()) {
    await client.exeCmd({
      cmd: 'agent.stop',
      requestId: uuidStr(36),
      timestamp: Date.now(),
      params: {
        agentId,
        userId: chatId,
        chatType
      }
    });
    await client.publishToServer({
      streamId,
      content: '[tag_agent_stop]',
      finish: true,
      kind: 'block'
    });
    return undefined;
  }

  // Dynamic agent creation for DM users
  // When enabled, creates a unique agent instance with its own workspace for each DM user.
  // const config = account.config;
  let effectiveCfg = clawConfig
  // if (!isGroup && route.matchedBy === "default") {
  //   const dynamicCfg = config?.dynamicAgentConfig;
  //   //是否为当前chatId创建动态agent
  //   if (dynamicCfg?.enabled) {
  //     const result = await maybeCreateDynamicAgent({
  //       cfg: clawConfig,
  //       runtime: core,
  //       senderId: chatId,
  //       channelId: channelId,
  //       dynamicCfg,
  //       log: (msg) => logger.info(msg),
  //     });
  //     if (result.created) {
  //       //如果创建成功，则当前来自chatId的请求使用该路由
  //       effectiveCfg = result.updatedCfg;
  //       // Re-resolve route with updated config
  //       route = core.channel.routing.resolveAgentRoute({
  //         cfg: result.updatedCfg,
  //         channel: channelId,
  //         accountId: account.accountId,
  //         peer: { kind: "direct", id: chatId },
  //       });
  //       logger.info(
  //         `${channelId} account[${account.accountId}]: dynamic agent created, new route: ${route.sessionKey}`
  //       );
  //     }
  //   }
  // }

  const preview = messageBody.replace(/\s+/g, " ").slice(0, 160);
  const inboundLabel = `${channelId}:${account.accountId}:${chatId}`

  const isEnqueueEvent = core.system.enqueueSystemEvent(`${inboundLabel}:${preview}`, {
    sessionKey: sessionKey, //route.sessionKey,
    contextKey: `${channelId}:message:${msg.streamId}`,
  });


  const envelopeOptions = core.channel.reply.resolveEnvelopeFormatOptions(effectiveCfg);

  // Include a readable speaker label so the model can attribute instructions.
  // (DMs already have per-sender sessions, but the prefix is still useful for clarity.)
  if (!messageBody.startsWith('/')) {
    const speaker = `${chatId}`
    messageBody = `${speaker}:${messageBody}`;
    await client.publishProcessingState({
      streamId,
      content: '[tag_start_ctx]',
      status: 'read',
      kind: 'block',
    })

  }
  // If there are mention targets, inform the agent that replies will auto-mention them
  if (isGroup) {
    // Build a lookup-friendly member map
    const groupMembers = msg.groupMembers ?? []
    if (groupMembers.length > 0) {
      const memberMapStr = groupMembers
        .map((t) => `${t.name} -> ${t.id} -> AgentId:${t.agentId ?? 'n/a'} -> Resp.:${t.responsibilities ?? 'unknown'} -> UserType:${t.type}`)
        .join("\n");
      messageBody += `\n\nSystem: This is a group chat. Group members (Nickname -> ID -> AgentId -> Responsibilities -> UserType):\n${memberMapStr}\n\n`;
      messageBody += `When mentioning someone, use: @[Nickname](ID:UserType)\n`;
      messageBody += `Example: @[John](12345:agent) Hello, please check this\n\n`;
      messageBody += `Rules:\n`;
      messageBody += `- If the user's request relates to a specific responsibility, prioritize mentioning the member(s) whose responsibility matches.`;
      messageBody += `- ID must come from the member list above, do not fabricate\n`;
      messageBody += `- If the member isn't in the list or ID is uncertain, do not use the @ format\n`;
      messageBody += `- Always include the full @[Nickname](ID:UserType) format`;
      // 2026-08-13 群组 Agent 协作：当群内有其他 Agent 成员（type=agent 且 agentId 非空）时，
      // 告知当前 Agent 可以用 sessions_send 工具以自身身份向对方 Agent 发协作消息（isUser=false），
      // 消息不会伪装成人类，对方 Agent 会把它当作 Agent 间协作消息处理。
      // 目标 sessionKey 固定为群会话：agent:<对方agentId>:<channelId>:group:<chatId>
      const agentMembers = groupMembers.filter((m) => m.type === 'agent' && m.agentId && m.agentId.length > 0);
      if (agentMembers.length > 0) {
        const agentRoutes = agentMembers
          .map((m) => `- ${m.name} (agentId=${m.agentId}): sessions_send -> agent:${m.agentId}:${channelId}:group:${chatId.toLowerCase()}`)
          .join("\n");
        messageBody += `\n\nSystem: Group agent-to-agent collaboration:\n`;
        messageBody += `You may collaborate with other Agent members in this group using the sessions_send tool. `;
        messageBody += `When you need another Agent's input, call sessions_send with its group session key below; `;
        messageBody += `the message arrives as an inter-agent message (isUser=false), NOT as a human instruction. `;
        messageBody += `Your final reply is still broadcast to the whole group as usual. Routes:\n${agentRoutes}\n`;
      }
      if (groupIntroduction && groupIntroduction.length > 0) {
        messageBody += `\n\nSystem: Below is an introduction to this group:\n`;
        messageBody += groupIntroduction
      }
    }
  }

  // logger.info(
  //   `${channelId} account[${account.accountId}]: message body: ${messageBody}`
  // )

  const body = core.channel.reply.formatAgentEnvelope({
    channel: channelId,
    from: chatId,
    timestamp: Date.now(),
    envelope: envelopeOptions,
    body: messageBody,
  });
  let combinedBody = body;
  const historyKey = isGroup ? chatId : undefined;
  if (isGroup && historyKey && chatHistories) {
    combinedBody = createChannelHistoryWindow({
      historyMap: chatHistories
    }).buildPendingContext({
      historyKey,
      limit: historyLimit,
      currentMessage: combinedBody,
      formatEntry(entry) {
        return core.channel.reply.formatAgentEnvelope({
          channel: channelId,
          // Preserve speaker identity in group history as well.
          from: `${chatId}:${entry.sender}`,
          timestamp: entry.timestamp,
          body: entry.body,
          envelope: envelopeOptions,
        });
      },
    })
  }

  const inboundHistory =
    isGroup && historyKey && historyLimit > 0 && chatHistories
      ? (chatHistories.get(historyKey) ?? []).map((entry) => ({
        sender: entry.sender,
        body: entry.body,
        timestamp: entry.timestamp,
      }))
      : undefined;

  logger.info(`${channelId} account[${account.accountId}], agentId=${agentId},sessionKey=${sessionKey}, isEnqueueEvent=${isEnqueueEvent}`)
  logger.info(`combined body:${combinedBody}\n`)
  logger.info(`inbound History:${JSON.stringify(inboundHistory)}\n`)


  // 构建标准消息上下文
  return buildChannelInboundEventContext({
    channel: channelId,
    provider: channelId,
    surface: channelId,
    timestamp: Date.now(),
    accountId: account.accountId,
    messageId: msg.streamId,
    from: from,
    sender: {
      id: fromUser.empId
    },
    conversation: {
      kind: chatType,
      id: chatId,
      label: fromLabel + '_' + streamId //加上流ID要在session.message件事中获取
    },
    route: {
      agentId: agentId,//route.agentId,
      routeSessionKey: sessionKey //route.sessionKey
    },
    reply: {
      to: to,
      originatingTo: to,
      replyToId: to
    },
    message: {
      rawBody: messageBody,
      body: combinedBody,
      commandBody: combinedBody,
      bodyForAgent: combinedBody,
      inboundHistory: inboundHistory,
    },
    messageIdFull: msg.msgId,
    access: {
      commands: {
        // 2026-09-06 适配 openclaw 2026.9.1：access.commands.authorized 由可选改为必填 boolean
        authorized: commandAuthorized ?? false
      }
    },
    command: {
      kind: 'text-slash',
      body: messageBody,
      authorized: commandAuthorized
    },
    commandTurn: {
      kind: "native",
      source: "native",
      authorized: commandAuthorized || false
    },
    media: mediaList,
    supplemental: {
      quote: {
        body: quoteContent
      }
    },
    contextVisibility: 'all',
    //finalize: FinalizeInboundContextFn,
    finalizeOptions: {
      forceBodyForAgent: true,
      forceChatType: true
      // 2026-09-06 适配 openclaw 2026.9.1：forceConversationLabel 选项已移除，conversation.label 直接生效
    }
    //extra?: Record<string, unknown>;
  })
}

/**
 * 路由消息到核心处理流程并处理回复
 */
export async function routeAndDispatchMessage(ctx: {
  ctxPayload: ReturnType<typeof buildMessageContext>;
  core: PluginRuntime
  cfg: OpenClawConfig
  client: DLClient
  channelId: string
  accountId: string
  streamId: string
  accStatus: AccumulatorsStatus
  commandAuthorized?: boolean
  chatOpts?: AutoReplyOpts
  logger: PluginLogger
}): Promise<void> {
  const { ctxPayload, core, cfg, client, accountId, streamId, accStatus, commandAuthorized, chatOpts, logger } = ctx;
  if (!commandAuthorized) {
    await client.publishProcessingState({
      streamId,
      content: '[tag_status_running]',
      status: 'read',
      kind: 'in_process'
    })
  }
  try {
    const ctx = await ctxPayload;
    const mediaFiles: Array<string> = []
    // 2026-10-17 方案A（小朵）：改走「配置驱动分发管线」dispatchReplyFromConfig，
    // 因为 TTS 合成应用点在 dispatch-from-config 管线内，而原
    // dispatchReplyWithBufferedBlockDispatcher 路径不含该环节（已用探针证实零触发）。
    const __dispatcherOptions: Parameters<typeof core.channel.reply.createReplyDispatcherWithTyping>[0] = {
        onReplyStart: async () => {
          await client.publishProcessingState({
            streamId,
            content: '[tag_agent_doing]',
            status: 'read',
            kind: 'block'
          })
        },
        deliver: async (payload, info) => {
          if (payload.isError) {
            logger.error(`account[${accountId}], payload error!`);
          }
          //info.kind='block'
          const contents: string[] = payload.text ? [payload.text] : [];
          if (payload.mediaUrl || (payload.mediaUrls && payload.mediaUrls.length > 0)) {
            //处理媒体文件
            // 2026-09-01 修复：mediaUrl 与 mediaUrls 可能同时携带同一文件（语音场景），去重避免重复发送导致空语音
            let files: Array<string> = [...new Set([...(payload.mediaUrl ? [payload.mediaUrl] : []), ...(payload.mediaUrls ?? [])])]
            files.forEach(item => mediaFiles.push(item));
            logger.info(`account[${accountId}], reply media file >>> ${files.join(',')}`)
          }

          if (contents.length === 0) {
            return;
          }
          const content = contents.join(',');
          accStatus.accumulatedPayload += content;
          if (info.kind === 'tool') {
            logger.info(`account[${accountId}] 正在调用工具.🔧${content}`);
            await client.publishProcessingState({
              streamId,
              content: `[tag_status_call_tool]`,
              status: 'read',
              kind: 'block',
            });
          }
        },
        onSettled: async () => {
          if ((accStatus.accumulatedPayload && accStatus.accumulatedPayload.length > 0) || mediaFiles.length > 0) {
            //发送结束状态
            await client.publishProcessingState({
              streamId,
              content: '[tag_status_completed]',
              status: 'read',
              kind: 'in_process'
            })
            //处理完成整体回复
            await client.publishToServer({
              streamId,
              content: accStatus.accumulatedPayload,
              finish: true,
              kind: 'block',
              mediaFiles
            }, chatOpts);
          }
        },
        onError: async (err, info) => {
          const errorStr = String(err);
          await client.publishProcessingState({
            streamId,
            content: `[tag_status_error] ${errorStr}`,
            status: 'read',
            kind: 'in_process'
          })
          client.publishToServer({
            streamId,
            content: `[tag_error_pross]\n${errorStr}`,
            finish: info.kind === 'final',
            kind: 'block',
            mediaFiles
          }, chatOpts);
        },
    };
    const __replyOptions: any = {
        suppressDefaultToolProgressMessages: true,
        allowProgressCallbacksWhenSourceDeliverySuppressed: true,
        enableHeartbeatTool: true,
        onAgentRunStart: (runId: string) => {
          logger.info(`Agent run start ... runId = ${runId}`)
          client.publishProcessingState({
            streamId,
            content: '[tag_agent_doing]',
            status: 'read',
            kind: 'in_process',
            runId
          })
        },
        async onReplyStart() {
          await client.publishProcessingState({
            streamId,
            content: '[tag_agent_to_reply]',
            status: 'read',
            kind: 'in_process'
          })
        },
        onReasoningStream: async (payload: ReplyPayload) => {
          await client.publishProcessingState({
            streamId,
            content: `[tag_status_start_reasoning]${payload.text ?? ''}`,
            status: 'read',
            kind: 'reasoning'
          });
        },
        onReasoningEnd: async () => {
          await client.publishProcessingState({
            streamId,
            content: '[tag_status_end_reasoning]',
            status: 'read',
            kind: 'end_reasoning'
          });
        },
        onToolStart: async (payload: any) => {
          if (!payload.name) {
            return;
          }
          const messages: Array<string> = [
            `[tag_status_call_tool]`,
            `[tag_status_phase_${payload.phase}]`,
            payload.name ?? payload.toolCallId
          ]
          await client.publishProcessingState({
            streamId,
            content: messages.join('\n'),
            status: 'read',
            kind: 'tool'
          });
        },
        onToolResult: async (payload: any) => {
          if (payload.isError) {
            await client.publishProcessingState({
              streamId,
              content: `[tag_status_error_tool]`,
              status: 'read',
              kind: 'tool',
            });
            return;
          }
          const content = payload.text || payload.spokenText || payload.btw?.question || '';
          if (content.length > 0) {
            await client.publishProcessingState({
              streamId,
              content,
              status: 'read',
              kind: 'plan',
            });
          }
        },
        async onItemEvent(payload: any) {
          const kind = payload.kind;
          if (!kind) {
            return;
          }
          const content = [];
          if (payload.name) {
            content.push(payload.name)
          }
          if (payload.title) {
            content.push(payload.title)
          }
          if (payload.progressText) {
            content.push(payload.progressText)
          }
          if (payload.summary) {
            content.push(payload.summary)
          }
          const messages: Array<string> = [
            `[tag_status_call_${kind}]`,
            `[tag_status_phase_${payload.phase}]`,
            `[tag_status_${payload.status}]`,
            ...content
          ];
          await client.publishProcessingState({
            streamId,
            content: messages.join('>'),
            status: 'read',
            kind: kind as DLKind
          });
          logger.info(`onItemEvent >>> kind=${payload.kind}, phase=${payload.phase}, status =${payload.status}, content=${content.join('>')}`)
        },
        onCommandOutput: async (payload: any) => {
          if (!payload.phase) {
            return;
          }
          const messages: Array<string> = [
            `[tag_status_call_command]`,
            `[tag_status_phase_${payload.phase}]`,
            `[tag_status_${payload.status}]`,
            payload.name ?? '',
            payload.output ?? ''
          ]
          await client.publishProcessingState({
            streamId,
            content: messages.join('>'),
            status: 'read',
            kind: 'command'
          });
        },
        onPatchSummary: async (payload: any) => {
          const strs: Array<string> = [];
          if (payload.title) {
            strs.push(payload.title);
          }
          if (payload.summary) {
            strs.push(payload.summary)
          }
          if (strs.length > 0)
            logger.info(`onPatchSummary 输出 >>> ${strs.join('')}`)
          await client.publishProcessingState({
            streamId,
            content: strs.join(''),
            status: 'read',
            kind: 'patch'
          })
        },
        async onPlanUpdate(payload: any) {
          const strs: Array<string> = [];
          if (payload.explanation) {
            strs.push(payload.explanation)
          }
          if (payload.steps) {
            strs.push('\n\n');
            payload.steps.forEach((str: any) => strs.push(`- ${str}`));
          }
          if (strs.length > 0) {
            logger.info(`onPlanUpdate 输出 >>> ${strs.join('')}`)
            await client.publishProcessingState({
              streamId,
              content: strs.join(''),
              status: 'read',
              kind: 'plan'
            })
          }
        },
        onCompactionStart: async () => {
          await client.publishProcessingState({
            streamId,
            content: '[tag_status_compaction_start]',
            status: 'read',
            kind: 'block'
          })
        },
        onCompactionEnd: async () => {
          await client.publishProcessingState({
            streamId,
            content: '[tag_status_compaction_end]',
            status: 'read',
            kind: 'block'
          })
        },
    };
    // 2026-10-17 方案A（小朵）：改走配置驱动分发管线 dispatchReplyFromConfig，
    // TTS 合成在 dispatch-from-config 管线内应用。
    const __dispatcher = core.channel.reply.createReplyDispatcherWithTyping(__dispatcherOptions);
    await core.channel.reply.withReplyDispatcher({
      dispatcher: __dispatcher as any,
      run: async () => await core.channel.reply.dispatchReplyFromConfig({
        ctx,
        cfg,
        dispatcher: __dispatcher,
        replyOptions: __replyOptions
      } as any)
    });
  } catch (err) {
    logger.error(`account[${accountId}] Failed to process message: ${String(err)}`);
    client.publishToServer({
      streamId,
      content: `[tag_error_reply_fail]:${String(err)}`,
      finish: true,
      kind: 'block'
    }, chatOpts);
  }
}