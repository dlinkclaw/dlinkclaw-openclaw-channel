import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/**
 * 2026-10-27 读取生效执行策略，把「预设」解析成实际档位。
 * 直接读网关配置文件，避免依赖 exec.approvals.get RPC（该调用在插件里会静默失败）。
 */
export type ExecPresetId = 'read-only' | 'guarded' | 'workspace' | 'full'

function mapMode(mode?: string): ExecPresetId | undefined {
    switch (mode) {
        case 'full': return 'full'
        case 'deny': return 'read-only'
        case 'ask': return 'guarded'
        case 'auto': return 'workspace'
        case 'allowlist': return 'read-only'
        default: return undefined
    }
}

export function readEffectiveExecPreset(): ExecPresetId | undefined {
    try {
        const file = process.env.OPENCLAW_CONFIG_PATH
            || path.join(os.homedir(), '.openclaw', 'openclaw.json')
        const cfg = JSON.parse(fs.readFileSync(file, 'utf8'))
        const exec = (cfg && cfg.tools && cfg.tools.exec) || {}
        const byMode = mapMode(exec.mode)
        if (byMode) {
            return byMode
        }
        const security = exec.security
        const ask = exec.ask
        if (security === 'full') return 'full'
        if (security === 'deny') return 'read-only'
        if (security === 'allowlist') {
            return ask === 'on-miss' ? 'guarded' : 'read-only'
        }
        // OpenClaw 未配置时默认 full（与 openclaw approvals get 的 effective 一致）
        return 'full'
    } catch {
        return undefined
    }
}
