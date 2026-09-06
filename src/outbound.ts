import { ChannelOutboundAdapter, DEFAULT_ACCOUNT_ID } from "openclaw/plugin-sdk/core";
import { getDLLogger, getDLRuntime } from "./runtime.js";
import { TEXT_CHUNK_LIMIT } from "./client/const.js";
import { getDLClient } from "./client/client-manager.js";
// 2026-09-06 适配 openclaw 2026.9.1：channel-runtime 已移除且 ChannelPairingAdapter 不再公开导出，
// 通过 9.1 channel-pairing 工厂的返回类型派生（import type 仅类型引用，无运行时成本）
import type { createTextPairingAdapter } from "openclaw/plugin-sdk/channel-pairing";
type ChannelPairingAdapter = ReturnType<typeof createTextPairingAdapter>;

const log_prefix = "[Outbound.ts]" as const;

const getClient = (accountId: string) => {
    const dlClient = getDLClient(accountId);
    if (!dlClient) {
        throw new Error(`${log_prefix} DLClient account[${accountId}] is null!`);
    }
    return dlClient;
}

export const dlOutbound = (): ChannelOutboundAdapter => {
    const logger = getDLLogger();
    return {
        deliveryMode: "direct",
        chunker: (text, limit) => getDLRuntime().channel.text.chunkMarkdownText(text, limit),
        chunkerMode: "markdown",
        textChunkLimit: TEXT_CHUNK_LIMIT,
        async sendMedia(ctx) {
            const { to, text, accountId, replyToId, threadId, mediaUrl } = ctx;
            const accId = accountId || DEFAULT_ACCOUNT_ID;
            logger.info(`${log_prefix} Notify[sendMedia] to[${to}], accountId=${accId}, replyToId=${replyToId}, threadId=${threadId}, text=${text}`);
            logger.info(`${log_prefix} Media files = [${mediaUrl}]..`);
            return await getClient(accId).autoReply({
                to,
                text,
                mediaFiles: mediaUrl && mediaUrl.length > 0 ? [mediaUrl] : []
            })
        },
        async sendPayload(ctx) {
            //主动出站(文本与媒体文件)
            const { to, accountId, replyToId, threadId, payload } = ctx;
            const accId = accountId || DEFAULT_ACCOUNT_ID;
            logger.info(`${log_prefix} Notify[sendPayload] to[${to}], accountId=${accId}, replyToId=${replyToId}, threadId=${threadId}, text=${payload.text}`);
            // 2026-09-01 修复：mediaUrl 与 mediaUrls 可能同时携带同一文件（语音场景），去重避免重复发送导致空语音
            const mediaFile: Array<string> = [...new Set([...(payload.mediaUrl ? [payload.mediaUrl] : []), ...(payload.mediaUrls ?? [])])];
            const text = payload.text ?? ''
            const dlClient = getClient(accId);
            return await dlClient.autoReply({
                to,
                text,
                mediaFiles: [...mediaFile]
            })
        },
        async sendText(ctx) {
            //主动出站(文本)
            const { cfg, to, text, accountId, replyToId, threadId } = ctx;
            const accId = accountId || DEFAULT_ACCOUNT_ID;
            logger.info(`${log_prefix} Notify[sendText] to[${to}], accountId=${accId}, replyToId=${replyToId}, threadId=${threadId}, text=${text}`);
            const dlClient = getClient(accId);
            return await dlClient.autoReply({
                to,
                text
            })
        }
    }
}

export const dlPairing = (channelId: string): ChannelPairingAdapter => {
    const logger = getDLLogger();
    return {
        idLabel: channelId,
        normalizeAllowEntry: (entry) =>{
            const trimmed = entry?.trim();
            logger.info(`${log_prefix} NormalizeAllowEntry: ${trimmed}`)
            return trimmed.replace(new RegExp(`^(${channelId}|user):`, "i"), "").trim()
        },
        notifyApproval: async ({cfg, accountId }) => {
            const accId = accountId || DEFAULT_ACCOUNT_ID;
            logger.info('对码成功回调通知...')
            const dlClient = getDLClient(accId);
            if (dlClient) {
                await dlClient.approved(true);
            }
            throw new Error(`${channelId} account[${accId}] DLClient is null!`)
        }
    };
}