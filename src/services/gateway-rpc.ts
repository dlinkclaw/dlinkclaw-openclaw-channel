/**
 * 2026-09-06 适配 openclaw 2026.9.1：宿主 Gateway RPC 调用工具（配对审批等）
 *
 * 背景：9.1 起 approveChannelPairingCode 等 pairing-store 函数不再从 plugin-sdk 导出，
 * 官方改为宿主 Gateway RPC（channels.pairing.list / channels.pairing.approve），
 * 且审批按 requestId（不透明 id）进行，不再暴露配对码 code。
 * 本模块通过插件自有的 WSClient（已认证的 Gateway WebSocket）调用宿主 RPC，
 * 实例由 ClawServices 初始化后注入（setGatewayClient）。
 */
import type WSClient from './ws-client.js';

let gwClient: WSClient | null = null;

/** 注入 Gateway WebSocket 客户端（ClawServices.initialize 成功后调用） */
export function setGatewayClient(client: WSClient | null): void {
    gwClient = client;
}

export function getGatewayClient(): WSClient | null {
    return gwClient;
}

/** channels.pairing.list 返回的单个配对请求（宿主 publicRequest 结构） */
export interface PairingRequestItem {
    requestId: string;
    channel: string;
    channelLabel?: string;
    accountId?: string;
    senderId?: string;
    senderLabel?: string;
    metadata?: Record<string, string>;
    createdAt?: string;
}

/** channels.pairing.list：列出指定通道/账号下 pending 的配对请求 */
export async function listPairingRequests(channel: string, accountId: string): Promise<PairingRequestItem[]> {
    if (!gwClient) {
        throw new Error('Gateway RPC 客户端未初始化（setGatewayClient 未调用）');
    }
    const res = await gwClient.callGatewayMethod('channels.pairing.list', {
        channel,
        accountId,
    });
    // 宿主返回 { accounts: [...], requests: [...] }，requestId 在 requests 中
    const requests: PairingRequestItem[] = res?.requests ?? [];
    return requests.filter((r) => r.accountId === accountId || !r.accountId);
}

/**
 * channels.pairing.approve：审批配对请求
 * notify=true 时宿主回调本通道 pairing.notifyApproval（→ dlClient.approved(true)）
 * 返回宿主响应 { requestId, senderId, notification, commandOwnerBootstrap }
 */
export async function approvePairingRequest(
    channel: string,
    accountId: string,
    requestId: string,
    notify = true,
): Promise<{ requestId: string; senderId?: string; notification?: string; commandOwnerBootstrap?: string }> {
    if (!gwClient) {
        throw new Error('Gateway RPC 客户端未初始化（setGatewayClient 未调用）');
    }
    return await gwClient.callGatewayMethod('channels.pairing.approve', {
        channel,
        accountId,
        requestId,
        notify,
    });
}
