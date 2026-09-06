// 2026-09-06 适配 openclaw 2026.9.1：根入口已移除，改从 core 导入
import type { PluginLogger, PluginRuntime } from "openclaw/plugin-sdk/core";
let runtime: PluginRuntime | null = null;
let logger: PluginLogger | null = null;
export function setDLRuntime(next: PluginRuntime) {
    runtime = next;
}

export function getDLRuntime(): PluginRuntime {
    if (!runtime) {
        throw new Error("DLink runtime not initialized");
    }
    return runtime;
}

export function setDLLogger(coreLogger: PluginLogger, msgPrefix: string) {
    const log: PluginLogger = {
        info: (msg: string) => {
            coreLogger.info(`${msgPrefix} ${msg}`);
        },
        warn: (msg: string) => {
            coreLogger.warn(`${msgPrefix} ${msg}`);
        },
        error: (msg: string) => {
            coreLogger.error(`${msgPrefix} ${msg}`);
        },
        debug: (msg) => {
            if (coreLogger.debug) {
                coreLogger.debug(`${msgPrefix} ${msg}`);
                return;
            }
            if(process.env.NODE_ENV === 'dev'){
                coreLogger.info(`DEBUG-${msgPrefix} ${msg}`);
            }
        }
    };
    logger = log;
}

export function getDLLogger(): PluginLogger {
    if (!logger) {
        return console;
    }
    return logger;
}

// 2026-08-24 停止标记集合：客户端点“停止”触发 chat.abort 命令时记录 runId，
// before_tool_call 钩子据此 block 该 run 的后续工具调用，实现“立即终止”。
// 用 TTL 过期清理，防止 runId 无限堆积（runId 为网关唯一 ID，过期后不可能再命中）。
const stoppedRuns = new Map<string, number>();
const STOPPED_RUN_TTL_MS = 10 * 60 * 1000; // 10 分钟过期

/** 记录一个已停止的 runId（客户端点停止后由 services.ts 调用） */
export function markRunStopped(runId: string) {
    if (!runId) return;
    stoppedRuns.set(runId, Date.now());
    getDLLogger().info(`markRunStopped: ${runId}`);
}

/** 检查 runId 是否处于已停止状态（before_tool_call 钩子调用） */
export function isRunStopped(runId?: string): boolean {
    if (!runId) return false;
    const ts = stoppedRuns.get(runId);
    if (!ts) return false;
    if (Date.now() - ts > STOPPED_RUN_TTL_MS) {
        stoppedRuns.delete(runId); // 过期自动清理
        return false;
    }
    return true;
}