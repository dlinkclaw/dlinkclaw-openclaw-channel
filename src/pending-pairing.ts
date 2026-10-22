/**
 * 2026-10-22：未配对消息暂存。
 * 场景：用户首次给 agent 发消息时，若中继尚未配对，插件会回配对码并丢弃原消息；
 * 这里把原消息暂存，配对通过后补发，避免「首次身份介绍丢失」。
 * 约束：按 senderKey（中继ID）分组，每组最多 20 条，10 分钟过期，最多 100 组。
 */
type PendingEntry = {
    replay: () => Promise<void>;
    at: number;
};

const MAX_PER_KEY = 20;
const MAX_KEYS = 100;
const TTL_MS = 10 * 60 * 1000;

const pending = new Map<string, Array<PendingEntry>>();

function purgeExpired(now = Date.now()) {
    for (const [key, list] of pending) {
        const alive = list.filter((entry) => now - entry.at <= TTL_MS);
        if (alive.length === 0) {
            pending.delete(key);
        } else {
            pending.set(key, alive);
        }
    }
}

export function bufferPendingMessage(key: string, replay: () => Promise<void>) {
    if (!key) {
        return;
    }
    const now = Date.now();
    purgeExpired(now);
    const list = pending.get(key) ?? [];
    list.push({ replay, at: now });
    while (list.length > MAX_PER_KEY) {
        list.shift();
    }
    pending.set(key, list);
    while (pending.size > MAX_KEYS) {
        const oldest = pending.keys().next().value;
        if (oldest === undefined) {
            break;
        }
        pending.delete(oldest);
    }
}

/**
 * 补发暂存消息，返回补发条数。
 * key 为空时补发所有（兜底场景）。
 */
export function flushPendingMessages(key?: string): number {
    purgeExpired();
    const keys = key ? [key] : Array.from(pending.keys());
    let count = 0;
    for (const k of keys) {
        const list = pending.get(k);
        if (!list || list.length === 0) {
            continue;
        }
        pending.delete(k);
        for (const entry of list) {
            count += 1;
            // 串行补发，避免同时打爆消息链路
            Promise.resolve()
                .then(() => entry.replay())
                .catch(() => { });
        }
    }
    return count;
}

export function pendingMessageCount(key?: string): number {
    purgeExpired();
    if (key) {
        return pending.get(key)?.length ?? 0;
    }
    let total = 0;
    for (const list of pending.values()) {
        total += list.length;
    }
    return total;
}
