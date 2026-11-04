import { randomUUID } from 'crypto';
import type { PluginLogger } from 'openclaw/plugin-sdk/core';
import type ClawServices from './services.js';
import type { DLClient } from '../client/dl-client.js';

const DIRECT_SESSION_RE = /^agent:([^:]+):dlink(-[A-Za-z0-9]+)?:direct:([A-Za-z0-9]+)$/;
const PAGE_SIZE = 200;
const SYNC_DEBOUNCE_MS = 1500;
const FULL_SYNC_INTERVAL_MS = 15 * 60 * 1000;

interface SessionIndexItem {
    sessionKey: string;
    empId: string;
    displayName?: string;
    lastMessageAt: number;
    archived?: boolean;
    deleted?: boolean;
    updatedAt: number;
}

function parseSessionKey(sessionKey: string): { agentId: string; empId: string } | null {
    const m = DIRECT_SESSION_RE.exec(sessionKey);
    if (!m) return null;
    return { agentId: m[1], empId: m[3].toUpperCase() };
}

function chunk<T>(list: Array<T>, size: number): Array<Array<T>> {
    const out: Array<Array<T>> = [];
    for (let i = 0; i < list.length; i += size) {
        out.push(list.slice(i, i + size));
    }
    return out;
}

/**
 * 2026-11-04 会话索引同步：插件 -> 中继。
 * 只同步 direct 会话的 key/展示名/最后消息时间/归档标记，不传聊天内容。
 */
export class SessionSync {
    private readonly services: ClawServices;
    private readonly dlClient: DLClient;
    private readonly logger: PluginLogger;
    private readonly pending = new Map<string, SessionIndexItem>();
    private flushTimer: NodeJS.Timeout | null = null;
    private fullSyncTimer: NodeJS.Timeout | null = null;
    private syncing = false;
    private stopped = false;
    /** 连续失败次数，用于重试退避，避免中继长时间不可用时每 1.5s 打一次 */
    private failureCount = 0;

    constructor(services: ClawServices, dlClient: DLClient, logger: PluginLogger) {
        this.services = services;
        this.dlClient = dlClient;
        this.logger = logger;
    }

    start(): void {
        this.stopped = false;
        void this.fullSync();
        if (!this.fullSyncTimer) {
            this.fullSyncTimer = setInterval(() => { void this.fullSync(); }, FULL_SYNC_INTERVAL_MS);
            this.fullSyncTimer.unref?.();
        }
    }

    stop(): void {
        this.stopped = true;
        if (this.flushTimer) { clearTimeout(this.flushTimer); this.flushTimer = null; }
        if (this.fullSyncTimer) { clearInterval(this.fullSyncTimer); this.fullSyncTimer = null; }
    }

    /** 立即把 pending 推给中继（归档/删除/新建等用户操作，返回前确保索引已更新） */
    async flushNow(): Promise<void> {
        if (this.flushTimer) {
            clearTimeout(this.flushTimer);
            this.flushTimer = null;
        }
        await this.flush();
    }

    /** 入站消息 / sessions.changed 时登记变化，1.5s 后批量回推 */
    touch(sessionKey: string, extra?: Partial<SessionIndexItem>): void {
        const parsed = parseSessionKey(sessionKey);
        if (!parsed) return;
        const now = Date.now();
        const prev = this.pending.get(sessionKey);
        const item: SessionIndexItem = {
            sessionKey,
            empId: parsed.empId,
            displayName: extra?.displayName ?? prev?.displayName,
            lastMessageAt: extra?.lastMessageAt ?? now,
            updatedAt: now,
        };
        // 只有明确带了归档/删除标记才写入，避免普通消息把已归档会话改回活跃
        if (extra?.archived !== undefined) item.archived = extra.archived;
        else if (prev?.archived !== undefined) item.archived = prev.archived;
        if (extra?.deleted !== undefined) item.deleted = extra.deleted;
        else if (prev?.deleted !== undefined) item.deleted = prev.deleted;
        this.pending.set(sessionKey, item);
        this.scheduleFlush();
    }

    /** 网关 sessions.changed：payload 是当前会话快照，不是全量列表 */
    observeSnapshot(payload: any): void {
        const sessionKey = payload?.sessionKey ?? payload?.key;
        if (typeof sessionKey !== 'string') return;
        this.touch(sessionKey, {
            displayName: payload?.displayName,
            archived: payload?.archived,
            lastMessageAt: payload?.lastInteractionAt ?? payload?.updatedAt,
        });
    }

    markArchived(sessionKey: string, archived: boolean): void {
        this.touch(sessionKey, { archived });
    }

    markDeleted(sessionKey: string): void {
        this.touch(sessionKey, { deleted: true });
    }

    setDisplayName(sessionKey: string, displayName: string): void {
        this.touch(sessionKey, { displayName });
    }

    private scheduleFlush(delayMs: number = SYNC_DEBOUNCE_MS): void {
        if (this.flushTimer || this.stopped) return;
        this.flushTimer = setTimeout(() => {
            this.flushTimer = null;
            void this.flush();
        }, delayMs);
        this.flushTimer.unref?.();
    }

    private async flush(): Promise<void> {
        if (this.pending.size === 0) return;
        const items = Array.from(this.pending.values());
        this.pending.clear();
        const byAgent = new Map<string, Array<SessionIndexItem>>();
        for (const item of items) {
            const parsed = parseSessionKey(item.sessionKey);
            if (!parsed) continue;
            const list = byAgent.get(parsed.agentId) ?? [];
            list.push(item);
            byAgent.set(parsed.agentId, list);
        }
        let failed = false;
        for (const [agentId, list] of byAgent) {
            for (const batch of chunk(list, PAGE_SIZE)) {
                try {
                    await this.dlClient.syncAgentSessions({
                        agentId,
                        payload: JSON.stringify({
                            agentId,
                            fullSync: false,
                            finalBatch: false,
                            sessions: batch,
                        }),
                    });
                } catch (e) {
                    failed = true;
                    this.failureCount += 1;
                    this.logger.warn('[SessionSync] 增量同步失败 agent=' + agentId
                        + '，批次放回队列等待重试: ' + e);
                    for (const item of batch) this.pending.set(item.sessionKey, item);
                }
            }
        }
        if (!failed) {
            this.failureCount = 0;
        }
        if (this.pending.size > 0) {
            // 1.5s -> 3s -> 6s -> 12s -> 24s -> 48s -> 5min 封顶
            const delay = Math.min(SYNC_DEBOUNCE_MS * Math.pow(2, Math.min(this.failureCount, 8)), 5 * 60 * 1000);
            if (this.failureCount > 0) {
                this.logger.warn('[SessionSync] ' + delay + 'ms 后重试，pending=' + this.pending.size);
            }
            this.scheduleFlush(delay);
        }
    }

    async fullSync(): Promise<void> {
        if (this.syncing || this.stopped) return;
        this.syncing = true;
        try {
            const agentIds = await this.services.listAgentIdsForSync();
            let total = 0;
            for (const agentId of agentIds) {
                total += await this.syncAgent(agentId);
            }
            this.logger.info('[SessionSync] 全量同步完成 agents=' + agentIds.length + ' sessions=' + total);
        } catch (e) {
            this.logger.warn('[SessionSync] 全量同步失败: ' + e);
        } finally {
            this.syncing = false;
        }
    }

    private async syncAgent(agentId: string): Promise<number> {
        const all: Array<any> = [];
        let offset = 0;
        let complete = false;
        try {
            while (true) {
                const res: any = await this.services.listSessionsForSync({
                    agentId,
                    limit: PAGE_SIZE,
                    offset,
                    // 2026-11-04 关键：必须带 all，否则网关只返回活跃会话，全量同步会把非活跃会话软删
                    archived: "all",
                    includeLastMessage: false,
                });
                const list: Array<any> = res?.sessions ?? [];
                all.push(...list);
                if (list.length < PAGE_SIZE) {
                    complete = true;
                    break;
                }
                offset += PAGE_SIZE;
                if (offset > 20000) {
                    this.logger.warn('[SessionSync] agent=' + agentId + ' 会话超过 20000，停止翻页');
                    break;
                }
            }
        } catch (e) {
            this.logger.warn('[SessionSync] 枚举 agent=' + agentId + ' 失败，跳过本轮全量: ' + e);
            return 0;
        }
        // 只有完整翻页成功才允许软删，避免枚举失败把索引误删
        if (!complete) return 0;

        const items: Array<SessionIndexItem> = [];
        for (const s of all) {
            const key = s?.key ?? s?.sessionKey;
            if (typeof key !== 'string') continue;
            const parsed = parseSessionKey(key);
            if (!parsed) continue;
            const now = Date.now();
            items.push({
                sessionKey: key,
                empId: parsed.empId,
                // 网关的 label 是 origin 标签（user:xxx-dLink-xxx），不是会话标题，不能当 displayName
                displayName: s?.displayName,
                lastMessageAt: Number(s?.lastInteractionAt ?? s?.updatedAt ?? now),
                archived: !!s?.archived,
                deleted: false,
                updatedAt: Number(s?.updatedAt ?? now),
            });
        }

        const syncId = randomUUID();
        const batches = chunk(items, PAGE_SIZE);
        if (batches.length === 0) {
            await this.pushFullBatch(agentId, syncId, [], true);
            return 0;
        }
        for (let i = 0; i < batches.length; i++) {
            await this.pushFullBatch(agentId, syncId, batches[i], i === batches.length - 1);
        }
        return items.length;
    }

    private async pushFullBatch(agentId: string, syncId: string, sessions: Array<SessionIndexItem>, finalBatch: boolean): Promise<void> {
        await this.dlClient.syncAgentSessions({
            agentId,
            payload: JSON.stringify({ agentId, fullSync: true, finalBatch, syncId, sessions }),
        });
    }
}
