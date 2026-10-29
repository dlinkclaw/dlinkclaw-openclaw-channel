/**
 * 2026-10-29 sessionKey → 当前运行 streamId 映射。
 * 审批发生时只有 sessionKey，而推送处理状态需要 streamId。
 */
const map = new Map<string, { streamId: string; accountId: string; at: number }>()
const TTL_MS = 30 * 60 * 1000

export function rememberStream(sessionKey: string, streamId: string, accountId: string): void {
    if (!sessionKey || !streamId) {
        return
    }
    // 2026-10-29 sessionKey 大小写可能不一致，统一小写归一
    map.set(sessionKey.toLowerCase(), { streamId, accountId, at: Date.now() })
}

export function streamOf(sessionKey: string): { streamId: string; accountId: string } | undefined {
    if (!sessionKey) {
        return undefined
    }
    const hit = map.get(sessionKey.toLowerCase())
    if (!hit) {
        return undefined
    }
    if (Date.now() - hit.at > TTL_MS) {
        map.delete(sessionKey.toLowerCase())
        return undefined
    }
    return { streamId: hit.streamId, accountId: hit.accountId }
}

export function forgetStream(sessionKey: string): void {
    if (sessionKey) {
        map.delete(sessionKey.toLowerCase())
    }
}
