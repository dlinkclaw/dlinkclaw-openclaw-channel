import pkg from '../package.json' with{type: 'json'};
// 2026-09-06 适配 openclaw 2026.9.1：根入口已移除，ChannelPlugin 改从 core 导入
import { ChannelPlugin } from "openclaw/plugin-sdk/core";
import { monitorDuolinkProvider } from "./monitor.js";
import { DLResolvedAccount } from "./client/types.js";
import { checkConfigured, deleteDLAccount, listDLConfiguredAccountIds, resolveDefaultDLAccountId, resolveDLAccount, setDLChannelAccountEnabled, dlSetupWizard, dlSetupAdapter, dlAccountStatus, dlDescribeAccount, dlInspectAccount } from "./account.js";
import { formatPairingApproveHint } from "openclaw/plugin-sdk/core";
// 2026-09-06 适配 openclaw 2026.9.1：channel-runtime 已移除，ChannelResolveResult 改从 channel-contract 导入
import { ChannelResolveResult } from "openclaw/plugin-sdk/channel-contract";
import { getDLLogger } from "./runtime.js";
import { dlOutbound, dlPairing } from "./outbound.js";

export const channelMeta = pkg.openclaw.channel;
export const LOG_TAG = channelMeta.selectionLabel;
const channelId = channelMeta.id;

export const dlChannel: ChannelPlugin<DLResolvedAccount> = {
  id: channelId,
  meta: {
    ...channelMeta,
  },
  configSchema: {
    schema: {
      type: "object",
      additionalProperties: true,
      properties: {
        enabled: { type: "boolean" },
        apiKey: { type: "string" },
        secret: { type: "string" },
        baseUrl: { type: "string" }
      }
    }
  },
  capabilities: {
    chatTypes: ['direct', 'group'],
    reactions: true,
    polls: false,
    edit: false,
    groupManagement: false,
    threads: true,
    reply: true,
    media: true,
    nativeCommands: true,
    blockStreaming: true,
    tts:{
      voice:{
        synthesisTarget:'voice-note',
        transcodesAudio:true,
        captionedFinalText:true
      }
    }
  },
  setupWizard: dlSetupWizard(channelId),
  setup: dlSetupAdapter(channelId),
  status: dlAccountStatus(channelId),
  agentPrompt: {
    messageToolHints: () => {
      return [
        // 2026-08-24 优化：target 格式补齐第 4 段 relayId（与 message.ts fromLabel 4 段格式保持一致，
        // 否则 dl-client.ts autoReply 解析不到 relayId，出站消息无法路由到正确中继）
        `- ${channelId} targeting: omit 'target' to reply to the current conversation (auto-inferred). Explicit targets: 'user:<userId>-<botId>-<botType>-<relayId>' or 'group:<chatId>-<botId>-<botType>-<relayId>'.`,
        `- Example for user: user:I27484094711599104-I27484094749347841-{ewx|qq|dd|feishu|dLink}-<relayId> (botType varies by client).`,
        `- Example for group: group:I27484094711599104-I27484094749347841-{ewx|qq|dd|feishu|dLink}-<relayId> (botType varies by client).`,
        `- ${channelId} outbound with markdown text or media file upload can be realized.`,
        `- **Outbound delivery**: All messages MUST route through ${channelId} channel. Never use webchat.`,
        `- When creating cron jobs: always set delivery.channel: "${channelId}" and delivery.to: "${channelId}:group:<chatId>-<botId>-{dLink|ewx|qq|dd|feishu}-<relayId>" — botType depends on the client. Extract it from the current incoming message address. Omitting channel silently falls back to webchat.`,
        `- When using the message tool: always channel: "${channelId}"`,
        // 2026-08-24 新增：发送媒体/文件后必须补发一条文本确认，禁止静默（NO_REPLY）。
        // 否则客户端 UI 一直显示"工作/转圈"状态（等不到完成信号），石头哥已明确要求。
        `- **After sending media/files via the message tool, ALWAYS follow up with a short text confirmation (e.g. "✅ 已发出 3 个文件：a.png / b.pdf / c.txt"). Never reply NO_REPLY or stay silent after a media send — the client keeps showing a spinner/working state until it receives a final text reply.`,
      ]
    }
  },
  reload: {
    configPrefixes: [
      `channels.${channelId}`
    ]
  },
  config: {
    listAccountIds: (cfg) => listDLConfiguredAccountIds(cfg, channelId),
    resolveAccount: (cfg, accountId) => resolveDLAccount({ cfg, accountId }, channelId),
    defaultAccountId: (cfg) => resolveDefaultDLAccountId(cfg, channelId),
    setAccountEnabled: (params) => setDLChannelAccountEnabled(params, channelId),
    deleteAccount: (params) => deleteDLAccount(params, channelId),
    isConfigured: (account) => {
      const configured = checkConfigured(account.config);
      account.config.configured = configured;
      return configured;
    },
    describeAccount: (account, cfg) => dlDescribeAccount({ account, cfg }),
    //暂时关闭inspectAccount: (cfg, accountId) => dlInspectAccount({ cfg, accountId, channelId })
  },
  resolver: {
    //未了解其作用!,测试以观察日志
    resolveTargets: (params) => {
      const { accountId, inputs, kind, runtime } = params;
      const logger = getDLLogger();
      logger.info(`ResolveTargets account[${accountId}], kind=${kind}, input=[${inputs.join('')}]`);
      const result: Array<ChannelResolveResult> = inputs.map(item => {
        return {
          input: item,
          id: accountId || '',
          resolved: true
        }
      })
      return new Promise((ok) => {
        ok(result)
      });
    }
  },
  messaging: {
    normalizeTarget(raw) {
      const trimmed = raw.trim();
      const logger = getDLLogger();
      logger.info(`Messaging[normalizeTarget] target normalized >>> ${trimmed}`);
      if (!trimmed) return undefined;
      return trimmed;
    },
    targetResolver: {
      looksLikeId: (id) => {
        const trimmed = id?.trim();
        return Boolean(trimmed);
      },
      hint: "<userId|groupId>",
    },
    formatTargetDisplay(params) {
      getDLLogger().info('Messaging[formatTargetDisplay]:' + JSON.stringify(params))
      return `FormatTargetDisplay: ${params.target}`;
    }
  },
  security: {
    resolveDmPolicy: ({ account }) => {
      const basePath = `channels.${channelId}.`;
      return {
        policy: account.config.dmPolicy ?? "pairing",
        allowFrom: account.config.allowFrom ?? [],
        policyPath: `${basePath}dmPolicy`,
        allowFromPath: basePath,
        approveHint: formatPairingApproveHint(channelId),
        normalizeEntry: (raw) => {
          getDLLogger().info('Security[resolveDmPolicy]:' + raw)
          const result = raw.replace(new RegExp(`^${channelId}:`, "i"), "").trim();
          getDLLogger().info('Security[resolveDmPolicy]:' + result)
          return result;
        },
      };
    }
  },
  pairing: dlPairing(channelId),
  outbound: dlOutbound(),
  gateway: {
    startAccount: async (ctx) => {
      ctx.setStatus({
        accountId: ctx.accountId,
        lastStartAt: Date.now()
      });
      return monitorDuolinkProvider({
        config: ctx.cfg,
        runtime: ctx.runtime,
        abortSignal: ctx.abortSignal,
        accountId: ctx.accountId,
        channelId
      });
    },
  }
}
