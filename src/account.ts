import { ChannelAccountSnapshot, ChannelSetupAdapter, ChannelSetupWizard, ChannelStatusIssue, OpenClawConfig } from "openclaw/plugin-sdk";
import { DLConfig, DLResolvedAccount } from "./client/types.js";
import { DEFAULT_ACCOUNT_ID, normalizeAccountId } from "openclaw/plugin-sdk/core";
import { ChannelSetupWizardAdapter } from "openclaw/plugin-sdk/setup";
import { ChannelStatusAdapter } from "openclaw/plugin-sdk/channel-runtime";
import { createDefaultChannelRuntimeState } from "openclaw/plugin-sdk/channel-status";
import { getDLClient } from "./client/client-manager.js";
import { getDLLogger } from "./runtime.js";
// 2026-08-23 安装默认媒体上限：写入 openclaw.json 供 OpenClaw 核心出站媒体校验读取（默认仅 5MB，导致 ⚠️ Media failed.）
import { DEFAULT_INSTALL_MEDIA_MAX_MB } from "./client/const.js";
type ChannelPluginSetupWizard = ChannelSetupWizard | ChannelSetupWizardAdapter;

const log_prefix = "[Account.ts]" as const;
function resolveDLConfig(cfg: OpenClawConfig, channelId: string): DLConfig {
    const channels = cfg.channels;
    const channelConfig = channels?.[channelId] as DLConfig | undefined;
    if (channelConfig) {
        channelConfig.accountId = channelConfig.accountId || DEFAULT_ACCOUNT_ID;
        return channelConfig;
    }
    // 首次配置时 cfg.channels 或 channels[channelId] 尚未创建，返回安全默认值
    return {
        enabled: false,
        apiKey: '',
        secret: '',
        baseUrl: '',
        accountId: DEFAULT_ACCOUNT_ID,
    };
}

/**
 * List all configured account IDs.
 */
export function listDLConfiguredAccountIds(cfg: OpenClawConfig, channelId: string): string[] {
    const config = resolveDLConfig(cfg, channelId);
    return [config.accountId!];
}

/**
 * Resolve a complete account.
 */
export function resolveDLAccount(params: {
    cfg: OpenClawConfig;
    accountId?: string | null;
}, channelId: string): DLResolvedAccount {
    const accountId = normalizeAccountId(params.accountId);
    const config = resolveDLConfig(params.cfg, channelId);
    return {
        accountId: accountId,
        accountName: config.accountName || 'DEFAULT',
        enabled: config.enabled,
        config: config
    }
}

export function listDuolinkConfiguredAccounts(cfg: OpenClawConfig, channelId: string) {
    const config = resolveDLConfig(cfg, channelId);
    const accounts: Set<DLResolvedAccount> = new Set();
    accounts.add({
        accountId: config.accountId!,
        accountName: config.accountName || config.accountId,
        enabled: config.enabled,
        config: config
    })
    return accounts;
}

export function resolveDefaultDLAccountId(cfg: OpenClawConfig, channelId: string): string {
    const ids = listDLConfiguredAccountIds(cfg, channelId);
    if (ids.includes(DEFAULT_ACCOUNT_ID)) {
        return DEFAULT_ACCOUNT_ID;
    }
    return ids[0] ?? DEFAULT_ACCOUNT_ID;
}

export function setDLChannelAccountEnabled(params: {
    cfg: OpenClawConfig;
    accountId: string;
    enabled: boolean;
}, channelId: string): OpenClawConfig {
    const { cfg, accountId, enabled } = params
    const account = resolveDLAccount({ cfg, accountId }, channelId);
    account.enabled = enabled
    const config = account.config;
    return {
        ...cfg,
        channels: {
            ...cfg.channels,
            [channelId]: {
                ...config,
                enabled: enabled,
            },
        },
    };
}

export function setDLChannelAccountParamsValue(params: {
    cfg: OpenClawConfig,
    accountId?: string,
    param: 'apiKey' | 'secret' | 'baseUrl'
    value: string
}, channelId: string): OpenClawConfig {
    const { cfg, param, value } = params
    const account = resolveDLAccount({ cfg, accountId: params.accountId }, channelId);
    const config = account.config;
    // 自动启用：当三个必填项都已填写时
    const hasAll = !!(
        (param === 'apiKey' ? value : config.apiKey) &&
        (param === 'secret' ? value : config.secret) &&
        (param === 'baseUrl' ? value : config.baseUrl)
    );
    // 首次配置且三个必填项全齐时，同时创建默认 main agent
    const existingList = (cfg as any).agents?.list;
    const needsDefaultAgent = (!existingList || (Array.isArray(existingList) && existingList.length === 0)) && hasAll;
    const result: any = {
        ...cfg,
        channels: {
            ...cfg.channels,
            [channelId]: {
                ...config,
                [param]: value,
                enabled: hasAll ? true : config.enabled,
                // 2026-08-23 安装/配置时自动写入默认媒体上限（MB），供 OpenClaw 核心出站媒体校验读取（默认仅 5MB，会导致 ⚠️ Media failed.）
                // 不覆盖用户已设置的值
                mediaMaxMb: config.mediaMaxMb ?? DEFAULT_INSTALL_MEDIA_MAX_MB,
            },
        },
    };
    if (needsDefaultAgent) {
        result.agents = {
            ...((cfg as any).agents ?? {}),
            list: [
                ...(Array.isArray(existingList) ? existingList : []),
                { id: "main", name: "Main Agent" }
            ]
        };
    }
    return result;
}

export function deleteDLAccount({
    cfg,
    accountId
}: {
    cfg: OpenClawConfig;
    accountId: string
}, channelId: string) {
    const next = { ...cfg } as OpenClawConfig;
    const nextChannels = { ...cfg.channels };
    delete (nextChannels as Record<string, unknown>)[channelId];
    if (Object.keys(nextChannels).length > 0) {
        next.channels = nextChannels;
    } else {
        delete next.channels;
    }
    return next;
}

export function checkConfigured(config: DLConfig) {
    const apiKey = config.apiKey;
    const secret = config.secret;
    const baeUrl = config.baseUrl;
    // 三个必填项齐全、且 enabled 明确为 true，才算"已完成配置"
    if (config.enabled !== true) return false;
    if (!apiKey || apiKey.length === 0) return false;
    if (!secret || secret.length === 0) return false;
    if (!baeUrl || baeUrl.length === 0) return false;
    if (!baeUrl.startsWith("https://")) return false;
    return true;
}

/**
 * 生成设置向导引导信息（含二维码预留）
 * 
 * 发版步骤：
 * 1. npm install qrcode-terminal
 * 2. 取消顶部 import qrcode 的注释
 * 3. 取消底部 qrcode.generate 的注释
 * 4. 替换 registerUrl 为沃联实际注册地址
 */
function getDLIntroLines(registerUrl: string): string[] {
    const lines: string[] = [
        "请选择以下任一方式完成配置：",
        "",
        "━━━ 方式一：我要注册新 APIKEY ━━━",
    ];
    
    // TODO: 发版时取消注释以生成终端二维码
    // try {
    //     qrcode.generate(registerUrl, { small: true }, (qr: string) => {
    //         lines.push(...qr.split('\n'));
    //     });
    // } catch (_) {
    //     // 二维码生成失败，降级显示纯文本链接
    // }
    
    lines.push(
        "📱 扫码或在浏览器打开以下链接注册沃联账号：",
        registerUrl,
        "",
        "━━━ 方式二：已有 APIKEY ━━━",
        "直接按提示输入即可。",
    );
    
    return lines;
}

export function dlSetupWizard(channelId: string): ChannelPluginSetupWizard {
    return {
        channel: channelId,
        status: {
            configuredLabel: "已配置 ✓",
            unconfiguredLabel: "需要 baseUrl, APIKey 和 Secret",
            configuredHint: "已配置",
            unconfiguredHint: "需要设置",
            resolveConfigured: ({ cfg, accountId }) => {
                const account = resolveDLAccount({ cfg, accountId }, channelId);
                const configured = checkConfigured(account.config);
                return configured;
            },
            resolveStatusLines: ({ configured }) => {
                return [`沃联 WorkRelay: ${configured ? "已配置" : "需要 baseUrl, APIKey 和 Secret"}`];
            },
        },
        introNote: {
            title: "🔧 沃联 WorkRelay 设置向导",
            lines: getDLIntroLines(
                process.env.DL_REGISTER_URL || "https://WorkRelay.cn/register"
            ),
            shouldShow: ({ cfg, accountId }) => {
                const account = resolveDLAccount({ cfg, accountId }, channelId);
                return !checkConfigured(account.config);
            },
        },
        credentials: [
            {
                inputKey: "url",
                providerHint: "沃联回调地址 (BaseUrl)",
                credentialLabel: "BaseUrl",
                envPrompt: "使用环境变量中的 DL_BASEURL?",
                keepPrompt: "BaseUrl 已配置，保留当前值？",
                inputPrompt: "请输入沃联回调地址 (BaseUrl):",
                inspect: ({ cfg, accountId }) => {
                    const account = resolveDLAccount({ cfg, accountId }, channelId);
                    const hasValue = Boolean(account.config.baseUrl?.trim());
                    return {
                        accountConfigured: hasValue,
                        hasConfiguredValue: hasValue,
                        resolvedValue: account.config.baseUrl || undefined,
                    };
                },
                applySet: ({ cfg, accountId, resolvedValue }) =>
                    setDLChannelAccountParamsValue({ cfg, accountId, 'param': 'baseUrl', value: resolvedValue }, channelId)
            },
            {
                inputKey: "token",
                providerHint: "沃联 API Key",
                credentialLabel: "API Key",
                envPrompt: "使用环境变量中的 DL_APIKEY?",
                keepPrompt: "API Key 已配置，保留当前值？",
                inputPrompt: "请输入沃联 API Key:",
                inspect: ({ cfg, accountId }) => {
                    const account = resolveDLAccount({ cfg, accountId }, channelId);
                    const hasValue = Boolean(account.config.apiKey?.trim());
                    return {
                        accountConfigured: hasValue,
                        hasConfiguredValue: hasValue,
                        resolvedValue: account.config.apiKey || undefined,
                    };
                },
                applySet: ({ cfg, accountId, resolvedValue }) =>
                    setDLChannelAccountParamsValue({ cfg, accountId, 'param': 'apiKey', value: resolvedValue }, channelId)
            },
            {
                inputKey: "privateKey",
                providerHint: "沃联签名密钥 (Secret)",
                credentialLabel: "Secret",
                envPrompt: "使用环境变量中的 DL_SECRET?",
                keepPrompt: "Secret 已配置，保留当前值？",
                inputPrompt: "请输入沃联签名密钥 (Secret):",
                inspect: ({ cfg, accountId }) => {
                    const account = resolveDLAccount({ cfg, accountId }, channelId);
                    const hasValue = Boolean(account.config.secret?.trim());
                    return {
                        accountConfigured: hasValue,
                        hasConfiguredValue: hasValue,
                        resolvedValue: account.config.secret || undefined,
                    };
                },
                applySet: ({ cfg, accountId, resolvedValue }) =>
                    setDLChannelAccountParamsValue({ cfg, accountId, 'param': 'secret', value: resolvedValue }, channelId)
            },
        ]
    };
}

export function dlSetupAdapter(channelId: string): ChannelSetupAdapter {
    return {
        resolveAccountId: ({ cfg, accountId }) => {
            const account = resolveDLAccount({ cfg, accountId }, channelId);
            return account.accountId;
        },
        applyAccountConfig: ({ cfg, accountId, input }) => {
            const patch: Partial<DLConfig> = {};

            if (input.url !== undefined) {
                patch.baseUrl = String(input.url).trim();
            }
            if (input.token !== undefined) {
                patch.apiKey = String(input.token).trim()
            }
            if (input.privateKey !== undefined) {
                patch.secret = String(input.privateKey).trim();
            }

            // 2026-08-23 安装时自动写入默认媒体上限（MB），供 OpenClaw 核心出站媒体校验读取（默认仅 5MB，会导致 ⚠️ Media failed.）
            // 不覆盖用户已设置的值
            const accountForPatch = resolveDLAccount({ cfg, accountId }, channelId);
            if (accountForPatch.config.mediaMaxMb === undefined || accountForPatch.config.mediaMaxMb === null) {
                patch.mediaMaxMb = DEFAULT_INSTALL_MEDIA_MAX_MB;
            }

            // 只要三个必填项全部提供，自动启用
            const account = resolveDLAccount({ cfg, accountId }, channelId);
            const hasAll = !!(
                (patch.baseUrl ?? account.config.baseUrl) &&
                (patch.apiKey ?? account.config.apiKey) &&
                (patch.secret ?? account.config.secret)
            );
            if (hasAll) {
                patch.enabled = true;
            }
            // 首次配置时，如果 agents.list 不存在，自动创建默认 main agent
            const existingList = (cfg as any).agents?.list;
            const needsDefaultAgent = !existingList || (Array.isArray(existingList) && existingList.length === 0);
            const result: any = {
                ...cfg,
                channels: {
                    ...cfg.channels,
                    [channelId]: {
                        ...account.config,
                        ...patch
                    }
                }
            };
            if (needsDefaultAgent) {
                result.agents = {
                    ...((cfg as any).agents ?? {}),
                    list: [
                        ...(Array.isArray(existingList) ? existingList : []),
                        { id: "main", name: "Main Agent" }
                    ]
                };
            }
            return result;
        },
    }
};

export function dlAccountStatus(channelId: string): ChannelStatusAdapter<DLResolvedAccount, unknown, unknown> {
    return {
        defaultRuntime: createDefaultChannelRuntimeState(DEFAULT_ACCOUNT_ID, { port: null }),
        collectStatusIssues: (accounts): ChannelStatusIssue[] =>
            accounts.flatMap((entry) => {
                const accountId = String(entry.accountId ?? DEFAULT_ACCOUNT_ID);
                const enabled = entry.enabled !== false;
                const configured = entry.configured === true;
                if (!enabled) {
                    return [];
                }
                const issues: ChannelStatusIssue[] = [];
                if (!configured) {
                    issues.push({
                        channel: channelId,
                        accountId,
                        kind: "config",
                        message: "沃联 baseUrl, apiKey, secret 未配置",
                        fix: `Run: openclaw channels add ${channelId} --base-url <baseUrl> --apiKey <apiKey> --secret <secret>`,
                    });
                }
                return issues;
            }),
        buildChannelSummary: ({ snapshot }) => ({
            configured: snapshot.configured ?? false,
            running: snapshot.running ?? false,
            lastStartAt: snapshot.lastStartAt ?? null,
            lastStopAt: snapshot.lastStopAt ?? null,
            lastError: snapshot.lastError ?? null,
        }),
        buildAccountSnapshot: ({ account, runtime }) => {
            const config = account.config;
            const configured = Boolean(
                config.baseUrl?.trim() &&
                config.apiKey?.trim() &&
                config.secret?.trim()
            );
            return {
                accountId: account.accountId,
                name: account.accountName,
                enabled: account.enabled,
                configured,
                running: runtime?.running ?? false,
                lastStartAt: runtime?.lastStartAt ?? null,
                lastStopAt: runtime?.lastStopAt ?? null,
                lastError: runtime?.lastError ?? null,
            };
        },
        probeAccount: async ({ account }) => {
            const accountId = account.accountId;
            const client = getDLClient(accountId);
            if (!client || !client.isConnected) {
                return { ok: false, error: `DLClient is not connected` };
            }
            return { ok: true };
        },
    };
}

/**
 * 解释Account
 * 打开WebUI -> 频道时 回调
 * @param params 
 * @returns 
 */
export function dlDescribeAccount(params: {
    account: DLResolvedAccount,
    cfg: OpenClawConfig
}): ChannelAccountSnapshot {
    const { account } = params;
    const accountId = account.accountId || DEFAULT_ACCOUNT_ID;
    //const logger = getDLLogger();
    //logger.info(`${log_prefix} DescribeAccount account[${accountId}]...`)
    const config = account.config;
    const configured = checkConfigured(config);
    const dlClient = getDLClient(accountId);
    return {
        "accountId": accountId,
        "name": account.accountName || accountId,
        "enabled": account.enabled,
        "configured": configured,
        "connected": dlClient?.isConnected(),
        "lastInboundAt": dlClient?.getLastInboundAt(),
        "busy":true
    }
}

export function dlInspectAccount(params: {
    cfg: OpenClawConfig,
    accountId?: string | null,
    channelId: string
}) {
    const {accountId} = params;
    const accId = accountId || DEFAULT_ACCOUNT_ID;
    const logger = getDLLogger();
    logger.info(`${log_prefix}InspectAccount account[${accId}]..`)
    
}