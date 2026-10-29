import { DEFAULT_ACCOUNT_ID } from 'openclaw/plugin-sdk/core'
import { getDLClient } from './client/client-manager.js'
import { getDLLogger } from './runtime.js'

/**
 * 2026-10-29 dlink 原生审批投递能力。
 * core 产生审批请求时交给插件，插件转发中继；发起人提示由客户端弹窗负责（不改写会话气泡）。
 */

type AnyObj = Record<string, any>

function firstString(...vals: Array<unknown>): string {
    for (const v of vals) {
        if (typeof v === 'string' && v.length > 0) {
            return v
        }
    }
    return ''
}

function pickRequest(ctx: AnyObj) {
    const req = ctx?.request ?? {}
    const view = ctx?.view ?? {}
    const payload = ctx?.pendingPayload ?? {}
    return {
        approvalId: firstString(payload.approvalId, req.id, req.approvalId),
        kind: firstString(ctx?.approvalKind, req.kind, 'exec'),
        agentId: firstString(req.agentId, view.agentId),
        sessionKey: firstString(req.sessionKey, view.sessionKey),
        command: firstString(payload.command, view.command, req.command, req.payload?.command),
        cwd: firstString(payload.cwd, view.cwd, req.cwd),
        expiresAtMs: Number(payload.expiresAtMs ?? view.expiresAtMs ?? req.expiresAtMs ?? 0)
    }
}

export function createDLApprovalCapability(): any {
    return {
        availability: { isConfigured: () => true, shouldHandle: () => true },
        presentation: {
            buildPendingPayload: (ctx: AnyObj) => {
                const info = pickRequest(ctx)
                return { ...info, text: firstString(ctx?.view?.summary, info.command) }
            },
            buildResolvedResult: () => ({ kind: 'leave' }),
            buildExpiredResult: () => ({ kind: 'leave' })
        },
        transport: {
            prepareTarget: (ctx: AnyObj) => ctx?.plannedTarget ?? null,
            deliverPending: async (ctx: AnyObj) => {
                const logger = getDLLogger()
                const info = pickRequest(ctx)
                if (!info.approvalId) {
                    logger.warn?.('approval deliver skipped: no approvalId')
                    return null
                }
                const dlClient = getDLClient(ctx?.accountId || DEFAULT_ACCOUNT_ID)
                if (!dlClient) {
                    logger.warn?.('approval deliver skipped: no dlink client')
                    return null
                }
                try {
                    await dlClient.pushApprovalEvent({
                        approvalId: info.approvalId,
                        kind: info.kind,
                        agentId: info.agentId,
                        sessionKey: info.sessionKey,
                        command: info.command,
                        cwd: info.cwd,
                        expiresAtMs: info.expiresAtMs
                    })
                    logger.info?.('approval forwarded: id=' + info.approvalId + ' agent=' + info.agentId)
                } catch (e) {
                    logger.warn?.('approval forward failed: ' + String(e))
                }
                return { approvalId: info.approvalId, deliveredAt: Date.now() }
            },
            updateEntry: async () => { },
            deleteEntry: async () => { }
        },
        interactions: {}
    }
}

/**
 * 2026-10-29 轮询路径入口：把审批推给中继。
 * 发起人的等待审批提示由中继通知 + 客户端弹窗完成，这里不改写会话状态。
 */
export async function announceWaiting(dlClient: any, payload: AnyObj): Promise<void> {
    const logger = getDLLogger()
    try {
        const pushed: any = await dlClient.pushApprovalEvent(payload)
        if (!pushed) {
            await dlClient.publishEventToServer(payload, 'onApproval', '1')
        }
        logger.info?.('approval pushed: id=' + String(payload?.approvalId) + ' names=' + JSON.stringify(pushed?.approverNames ?? []))
    } catch (e) {
        logger.warn?.('announceWaiting failed: ' + String(e))
    }
}
