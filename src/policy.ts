import { DLConfig, DLResolvedAccount } from "./client/types.js";
import { DLClient } from "./client/dl-client.js";
// 2026-09-06 适配 openclaw 2026.9.1：根入口已移除，改从 core 导入
import { OpenClawConfig, PluginLogger, PluginRuntime } from "openclaw/plugin-sdk/core";
// 2026-09-06 适配 openclaw 2026.9.1：审批改按 requestId，经宿主 RPC list 获取（9.1 起按 code 审批 API 不再公开）
import { listPairingRequests } from "./services/gateway-rpc.js";
import { resolveDLAccount } from "./account.js";
import { resolveAllowlistMatchSimple } from "openclaw/plugin-sdk/allow-from";
import { addWildcardAllowFrom } from "openclaw/plugin-sdk/setup";

export type DLGroupPolicyCheckResult = {
    allowed: boolean;
}

export type DmPolicyCheckResult = {
    allowed: boolean;
    allowFrom?: Array<string | number>
    /** 2026-10-22：因未配对被拦截（消息可暂存，配对后补发） */
    pendingPairing?: boolean;
}

/**
 * 检查群组是否在允许列表中
 */
function isInGroupAllowed(params: {
    channelId: string,
    groupPolicy: "open" | "allowlist" | "disabled";
    allowFrom: Array<string | number>;
    groupId: string;
}): boolean {
    const { channelId, groupPolicy } = params;
    if (groupPolicy === "disabled") {
        return false;
    }
    if (groupPolicy === "open") {
        return true;
    }
    // allowlist 模式：检查群组是否在允许列表中
    const normalizedAllowFrom = params.allowFrom.map((entry) =>
        String(entry).replace(new RegExp(`^${channelId}:`, "i"), "").trim()
    );
    if (normalizedAllowFrom.includes("*")) {
        return true;
    }
    const normalizedGroupId = params.groupId.trim();
    return normalizedAllowFrom.some(
        (entry) => entry === normalizedGroupId || entry.toLowerCase() === normalizedGroupId.toLowerCase()
    );
}
/**
 * 检查群组内发送者是否在允许列表中
 */
function isGroupSenderAllowed(params: {
    channelId: string,
    senderId: string;
    groupId: string;
    config: DLConfig
}): boolean {
    const { senderId, groupId, channelId, config } = params;
    const groups = config.groups;
    //不配置默认允许
    if (!groups) {
        return true;
    }
    const groupConfig = groups[groupId];
    if (!groupConfig) {
        return true;
    }
    const perGroupSenderAllowFrom = (groupConfig.allowFrom ?? []).map((v) => String(v));
    //不配置默认允许
    if (perGroupSenderAllowFrom.length === 0) {
        return true;
    }

    if (perGroupSenderAllowFrom.includes("*") || perGroupSenderAllowFrom.includes(senderId)) {
        return true;
    }

    return perGroupSenderAllowFrom.some((entry: string) => {
        const normalized = entry.replace(new RegExp(`^${channelId}:`, "i"), "").trim();
        return normalized === senderId || normalized === `user:${senderId}`;
    });


}
export function checkGroupPolicy(params: {
    chatId: string;
    senderId: string;
    account: DLResolvedAccount;
    channelId: string,
    logger: PluginLogger
}): DLGroupPolicyCheckResult {
    const { channelId, chatId, senderId, account, logger } = params;
    const { accountId } = account;
    const groupPolicy = account.config.groupPolicy ?? "open"

    const groupAllowFrom = account.config.groupAllowFrom ?? [];
    const groupAllowed = isInGroupAllowed({
        channelId,
        groupPolicy,
        allowFrom: groupAllowFrom,
        groupId: chatId,
    });

    if (!groupAllowed) {
        logger.warn(
            `account[${accountId}] Group ${chatId} not allowed (groupPolicy=${groupPolicy})`
        );
        return { allowed: false };
    }

    const senderAllowed = isGroupSenderAllowed({
        channelId,
        senderId,
        groupId: chatId,
        config: account.config,
    });

    if (!senderAllowed) {
        logger.warn(
            `account[${accountId}] Sender ${senderId} not in group ${chatId} sender allowlist`
        );
        return { allowed: false };
    }

    return { allowed: true };
}

/**
 * 检查发送者是否在允许列表中（通用）
 */
export function isSenderAllowed(senderId: string, allowFrom: string[], channelId: string): boolean {
    if (allowFrom.includes("*")) {
        return true;
    }
    return allowFrom.some((entry) => {
        const normalized = entry.replace(new RegExp(`^${channelId}:`, "i"), "").trim();
        return normalized === senderId || normalized === `user:${senderId}`;
    });
}


/**
 * 检查 DM Policy 访问控制
 * @returns 检查结果，包含是否允许继续处理
 */
export async function checkDmPolicy(params: {
    core: PluginRuntime,
    senderId: string;
    account: DLResolvedAccount;
    client: DLClient;
    channelId: string;
    streamId: string;
    logger: PluginLogger;
}): Promise<DmPolicyCheckResult> {
    const { core, senderId, account, client, logger, channelId, streamId } = params;
    const logPreTag = `account[${account.accountId}],Policy.ts[checkDmPolicy],`

    const dmPolicy = account.config.dmPolicy ?? "pairing"; //默认需要配对

    logger.warn(`${logPreTag}Blocked DM from [${senderId}] (dmPolicy=${dmPolicy})`);

    const configAllowFrom = (account.config.allowFrom ?? []).map((v) => String(v));

    // 如果 dmPolicy 是 disabled直接拒绝
    if (dmPolicy === "disabled") {
        logger.warn(`未配对，直接拒绝...`);
        return { allowed: false };
    }

    // 如果是 open 模式，允许所有人
    if (dmPolicy === "open") {
        return { allowed: true, allowFrom: [...configAllowFrom] };
    }

    // Compatibility fallback for newer OpenClaw implementations.
    const storeAllowFrom = await core.channel.pairing
        .readAllowFromStore({ channel: channelId, accountId: account.accountId })
        .catch((e) => {
            logger.error(`${logPreTag}get allow from store, error=[${String(e)}]`);
            return []
        });

    const effectiveAllowFrom = [...configAllowFrom, ...storeAllowFrom];
    const senderAllowedResult = resolveAllowlistMatchSimple({
        allowFrom: effectiveAllowFrom,
        senderId: senderId,
        allowNameMatching: false
    })

    logger.info(`${logPreTag}senderAllowedResult = ${JSON.stringify(senderAllowedResult)}, effectiveAllowFrom=[${effectiveAllowFrom.join(',')}]`);

    if (senderAllowedResult && senderAllowedResult.allowed) {
        return { allowed: true, allowFrom: [...effectiveAllowFrom] };
    }

    // 处理未授权用户
    if (dmPolicy === "pairing") {
        const { code, created } = await core.channel.pairing.upsertPairingRequest({
            channel: channelId,
            id: senderId,
            accountId: account.accountId,
            meta: { name: senderId },
        });

        if (created) {
            logger.info(`${logPreTag}pairing request created for sender=${senderId}`);
            const replayContent = core.channel.pairing.buildPairingReply({
                channel: channelId,
                idLine: `Your account[${account.accountId}] sedner=${senderId}`,
                code
            });
            await client.publishToServer({
                streamId,
                content: replayContent,
                kind: 'block',
                finish: true
            });
        } else {
            logger.error(`${logPreTag}blocked unauthorized sender=${senderId} (dmPolicy=${dmPolicy})`);
        }

        // 2026-09-06 适配 openclaw 2026.9.1：审批改按 requestId（宿主 RPC），
        // 通过 channels.pairing.list 获取本次 requestId 随事件下发；
        // 同 sender 幂等 upsert(id=senderId)，pending 中按 senderId 唯一定位
        let pairingRequestId: string | undefined;
        try {
            const pending = await listPairingRequests(channelId, account.accountId);
            pairingRequestId = pending.find(r => r.senderId === senderId)?.requestId;
            if (!pairingRequestId) {
                logger.warn(`${logPreTag}list 未匹配到 sender=${senderId} 的配对请求`);
            }
        } catch (e) {
            logger.error(`${logPreTag}获取 requestId 失败:${String(e)}`);
        }

        // 对码请求已创建/已存在，通过MQTT通知客户端可一键对码（带 requestId 供 9.1 审批使用）
        const pairingEvent = {
            code,           // 对码验证码
            requestId: pairingRequestId, // 2026-09-06 新增：宿主配对请求 id（9.1 起审批必需）
            channelId,      // 通道ID
            senderId,       // 发送者ID,实质是relayBotId
            relayType: "OpenClaw"
        };
        client.publishEventToDLClient(pairingEvent, 'onPairingRequest', '0').catch(err =>
            logger.error(`${logPreTag}发送对码事件失败:${String(err)}`)
        );
    }
    logger.warn(`account[${account.accountId}] sender=${senderId} access denied`)
    // 2026-10-22：pairing 模式下拦截的消息可暂存，审批通过后补发
    return { allowed: false, pendingPairing: dmPolicy === "pairing" };
}


/**
 * 设置 dmPolicy
 */
export function setDmPolicy(
    cfg: OpenClawConfig,
    dmPolicy: "pairing" | "allowlist" | "open" | "disabled",
    channelId: string,
): OpenClawConfig {
    const account = resolveDLAccount({ cfg }, channelId);
    const existingAllowFrom = account.config.allowFrom ?? [];
    const allowFrom =
        dmPolicy === "open"
            ? addWildcardAllowFrom(existingAllowFrom.map((x) => String(x)))
            : existingAllowFrom.map((x) => String(x));

    return setAccount(cfg, {
        dmPolicy,
        allowFrom,
    }, channelId);
}

/**
 * 设置企业微信账户配置
 */
export function setAccount(
    cfg: OpenClawConfig,
    account: Partial<DLConfig>,
    channelId: string
): OpenClawConfig {
    const existing = (cfg.channels?.[channelId] ?? {}) as DLConfig;
    const merged: DLConfig = {
        enabled: account.enabled ?? existing?.enabled ?? true,
        apiKey: account.apiKey ?? existing?.apiKey ?? "",
        secret: account.secret ?? existing?.secret ?? "",
        baseUrl: account.baseUrl ?? existing?.baseUrl ?? "",
        allowFrom: account.allowFrom ?? existing?.allowFrom,
        dmPolicy: account.dmPolicy ?? existing?.dmPolicy,

        ...(account.accountName || existing?.accountName
            ? { name: account.accountName ?? existing?.accountName }
            : {})
    };

    return {
        ...cfg,
        channels: {
            ...cfg.channels,
            [channelId]: merged,
        },
    };
}
