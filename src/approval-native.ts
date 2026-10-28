import { DEFAULT_ACCOUNT_ID } from 'openclaw/plugin-sdk/core'
import { getDLClient } from './client/client-manager.js'
import { getDLLogger } from './runtime.js'

/**
 * 2026-10-27 dlink 原生审批投递能力。
 * core 产生审批请求时调用这里的 transport.deliverPending，
 * 插件把结构化请求交给中继，由中继按 agent → relayBot → founder 扇出。
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
        agentId: firstString(req.agentId, view.agentId, req.sessionKey ? '' : ''),
        sessionKey: firstString(req.sessionKey, view.sessionKey),
        command: firstString(payload.command, view.command, req.command, req.payload?.command),
        cwd: firstString(payload.cwd, view.cwd, req.cwd),
        expiresAtMs: Number(payload.expiresAtMs ?? view.expiresAtMs ?? req.expiresAtMs ?? 0)
    }
}

export function createDLApprovalCapability(): any {
    return {
        availability: {
            // dlink 是唯一通道；账号已配置即可承接审批
            isConfigured: () => true,
            shouldHandle: () => true
        },
        presentation: {
            buildPendingPayload: (ctx: AnyObj) => {
                const info = pickRequest(ctx)
                return {
                    ...info,
                    text: firstString(ctx?.view?.summary, info.command)
                }
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
                    logger.info?.(`approval forwarded to relay: id=${info.approvalId} agent=${info.agentId} kind=${info.kind}`)
                } catch (e) {
                    logger.warn?.(`approval forward failed: ${String(e)}`)
                }
                return { approvalId: info.approvalId, deliveredAt: Date.now() }
            },
            updateEntry: async () => { },
            deleteEntry: async () => { }
        },
        interactions: {}
    }
}
