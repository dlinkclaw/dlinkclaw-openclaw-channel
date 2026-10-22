// 2026-09-06 适配 openclaw 2026.9.1：根入口已移除；ClawdbotConfig 别名已移除，改 OpenClawConfig 别名；RuntimeEnv 改 runtime-env 导入
import { OpenClawConfig as ClawdbotConfig } from "openclaw/plugin-sdk/core";
import { RuntimeEnv } from "openclaw/plugin-sdk/runtime-env";
import { listDuolinkConfiguredAccounts, resolveDLAccount } from "./account.js";
import { getDLLogger, getDLRuntime } from "./runtime.js";
import { DLClient, DLMessageContext } from "./client/dl-client.js";
import { DLResolvedAccount } from "./client/types.js";
import { checkDmPolicy, checkGroupPolicy } from "./policy.js";
import { bufferPendingMessage } from "./pending-pairing.js";
import { buildMessageContext, parseMessageContent, routeAndDispatchMessage } from "./client/message.js";
import { withTimeout } from "./client/timeout.js";
import { getDLClient, removeDLClient, setDLClient } from "./client/client-manager.js";
import { downloadAndSaveFiles } from "./client/media-handler.js";
import { DEFAULT_ACCOUNT_ID } from "openclaw/plugin-sdk/core";
import { DEFAULT_GROUP_HISTORY_LIMIT, HistoryEntry, createChannelHistoryWindow } from "openclaw/plugin-sdk/reply-history";
import { resolveAllowlistMatchSimple } from "openclaw/plugin-sdk/allow-from";
import { InboundMediaFacts } from "openclaw/plugin-sdk/channel-inbound";

export type DLMonitorOpts = {
    config: ClawdbotConfig;
    runtime: RuntimeEnv;
    abortSignal: AbortSignal;
    accountId: string;
    channelId: string,
};

export type DLMonitorAccountParams = {
    cfg: ClawdbotConfig;
    account: DLResolvedAccount;
    runtime: RuntimeEnv;
    abortSignal: AbortSignal;
    channelId: string;
};


export async function monitorDuolinkProvider(opts: DLMonitorOpts): Promise<void> {
    const cfg = opts.config;
    const { accountId, channelId, runtime, abortSignal } = opts;
    if (accountId === DEFAULT_ACCOUNT_ID) {
        const account = resolveDLAccount({ cfg, accountId: accountId }, channelId);
        if (!account.enabled || !account.config.configured) {
            throw new Error(`${channelId} account "${opts.accountId}" not configured or disabled`);
        }
        return monitorSingleAccount({
            cfg,
            account,
            runtime,
            abortSignal,
            channelId,
        });
    }

    const accounts = listDuolinkConfiguredAccounts(cfg, channelId);
    if (accounts.size === 0) {
        throw new Error(`No enabled ${channelId} accounts[${accountId}] configured`);
    }
    //TODO:处理多帐号信息

}

/**
 * Monitor a single Duolian account.
 */
async function monitorSingleAccount(params: DLMonitorAccountParams): Promise<void> {
    const { account, abortSignal, cfg, channelId } = params;
    const { accountId } = account;
    const logger = getDLLogger();
    let client = getDLClient(accountId);
    if (!client) {
        client = new DLClient({
            account,
            channelId,
            cfg,
        }, logger);
        client.on('message', duolinkMessageHandler);
        setDLClient(accountId, client);
        logger.info(`DLClient account[${account.accountId}] is starting...`);
    }

    return new Promise(async (resolve, reject) => {
        const cleanup = () => {
            removeDLClient(accountId);
        };
        if (abortSignal.aborted) {
            if (client.isConnected()) {
                client.stop();
            }
            cleanup();
            resolve();
            return;
        }
        const handleAbort = () => {
            logger.error(`account[${accountId}]: abort signal received, stopping`);
            if (client.isConnected()) {
                client.stop();
            }
            removeDLClient(accountId);
        };
        abortSignal.addEventListener("abort", handleAbort, { once: true });
        if (!client.isConnected()) {
            try {
                await client.start();
                logger.info(`account[${accountId}] start successfully!`);
                //resolve(); 
            } catch (e) {
                logger.error(`account[${accountId}]:DLClient启动失败:${String(e)}`);
                cleanup();
                abortSignal?.removeEventListener("abort", handleAbort);
                reject(e);
                return;
            }
        }
    })
}

async function duolinkMessageHandler(dlCtx: DLMessageContext, client: DLClient) {
    const { cfg, account, channelId, rbotId } = dlCtx.ctx;

    const accountLogInfo = `account[${account.accountId}-${rbotId}],[Monitor.ts]`;
    const { msg, accStatus } = dlCtx;
    const { config } = account;

    const relayId = rbotId!;
    const botType = msg.botType;
    const logger = getDLLogger();
    //const relayTimeRhreshold = msg.relayTimeRhreshold ?? 5 * 60 * 1000;


    //TODO:群组历史
    const chatHistories = new Map<string, HistoryEntry[]>();
    const historyLimit = Math.max(
        0,
        config.historyLimit ?? cfg.messages?.groupChat?.historyLimit ?? DEFAULT_GROUP_HISTORY_LIMIT,
    );

    //Step 1: 解析消息内容
    const msgContext = parseMessageContent(msg.payload);
    if (!msgContext) {
        logger.error(`${accountLogInfo} resolve payload entity error!`);
        client.publishToServer({
            streamId: msg.streamId,
            content: '[tag_error_resolve_payload_entity]',
            finish: true,
            kind: 'block'
        })
        return;
    }
    const {
        textParts,
        quoteContent,
        imageUrls,
        imageAesKeys,
        voiceUrls,
        voiceAesKeys,
        videoUrls,
        videoAesKeys,
        fileUrls,
        fileAesKeys
    } = msgContext;

    let textBody = textParts.join("\n").trim();
    if (textBody.length === 0 && quoteContent && quoteContent.length > 0) {
        textBody = quoteContent;
    }

    //Step 2: 群组及DM策略
    const isGroup = msg.group;
    //const mentionTargets: DLMentionTarget[] = [];
    if (isGroup) {
        //这里暂时移除提及,可能需要提取提及
        //textBody = textBody.replace(/@\S+/g, "").trim();
        //群组策略
        const groupPolicy = checkGroupPolicy({
            chatId: msg.chatId!,
            senderId: rbotId!,
            account,
            channelId,
            logger
        })
        if (!groupPolicy.allowed) {
            logger.error(`${accountLogInfo} group policy is not allowed`)
            client.publishToServer({
                streamId: msg.streamId,
                content: '[tag_error_group_prolicy_not_allow]',
                finish: true,
                kind: 'block'
            })
            return;
        }
        if (chatHistories && textBody.length > 0) {
            const senderId = msg.fromPerson.empId;
            createChannelHistoryWindow({
                historyMap: chatHistories
            }).record({
                historyKey: msg.chatId!,
                limit: historyLimit,
                entry: {
                    sender: senderId,
                    body: `${senderId}: ${textBody}`,
                    timestamp: Date.now(),
                    messageId: senderId, //群组发信人,回复时可提及
                }
            })
        }
    }

    const core = getDLRuntime();
    const dmPolicy = await checkDmPolicy({
        core,
        senderId: relayId, //单聊对码使用中继ID效验，只要效验一次，使用该中继的用户均不需要重新对码
        account,
        client,
        channelId,
        streamId: msg.streamId,
        logger
    })

    if (!dmPolicy.allowed) {
        // 2026-10-22：首次未配对时原消息会被配对码回复取代而丢失，这里暂存，
        // 由 pairing.approve 审批通过后补发（见 services.ts handleApprove）。
        if (dmPolicy.pendingPairing) {
            bufferPendingMessage(relayId, () => duolinkMessageHandler(dlCtx, client));
            logger.info(`${accountLogInfo} message buffered until pairing approved, relayId=${relayId}`);
        }
        client.publishToServer(
            {
                streamId: msg.streamId,
                content: '[tag_error_policy_refuse]',
                kind: 'block',
                finish: true
            }
        )
        return;
    }
    //const msgInfo = textBody.length > 50 ? textBody.slice(0, 50) + "..." : textBody
    //logger.info(`${accountLogInfo} received message from ${senderId} in ${msg.botType}, message >>> ${msgInfo}`);


    //Step 3: 斜扛“/”命令授权检测
    let commandAuthorized: boolean | undefined = undefined;
    if (textBody.length > 0) {
        //是否应该授权命令行
        const shouldComputeCommandAuthorized = core.channel.commands.shouldComputeCommandAuthorized(
            textBody,
            cfg
        );
        logger.info(`${accountLogInfo} shouldComputeCommandAuthorized >>> ${shouldComputeCommandAuthorized}`);

        const effectiveDmAllowFrom = [...dmPolicy.allowFrom ?? []];
        const commandAllowFrom = isGroup ? (config.groupAllowFrom ?? [rbotId!]) : effectiveDmAllowFrom;

        logger.info(`${accountLogInfo} commandAllowFrom=[${commandAllowFrom.join(',')}]`);

        const senderAllowedForCommands = resolveAllowlistMatchSimple({
            allowFrom: commandAllowFrom,
            senderId: relayId, //使用中继器ID所以命令行效验，即使用该中继的人都可以使用/命令
            allowNameMatching: false,
        }).allowed;

        logger.warn(`${accountLogInfo} senderAllowedForCommands >>> ${senderAllowedForCommands}`);

        // 2026-09-06 适配 openclaw 2026.9.1：CommandsConfig 类型已移除 useAccessGroups 字段，
        // 运行时配置值仍可能由 openclaw.json 下发，这里保持兼容读取（缺省 true）
        const useAccessGroups = (cfg.commands as { useAccessGroups?: boolean } | undefined)?.useAccessGroups ?? true;
        commandAuthorized = shouldComputeCommandAuthorized
            ? core.channel.commands.resolveCommandAuthorizedFromAuthorizers({
                useAccessGroups,
                authorizers: [
                    { configured: commandAllowFrom.length > 0, allowed: senderAllowedForCommands },
                ],
            })
            : undefined;
    }

    logger.warn(`${accountLogInfo} commandAuthorized >>> ${commandAuthorized}`);

    //Step 4: 下载媒体文
    const [imageMediaList, voiceMediaList, videoMediaList, fileMediaList] = await Promise.all([
        downloadAndSaveFiles({
            client,
            fileUrls: imageUrls,
            fileAesKeys: imageAesKeys,
            account,
            clawConfig: cfg,
            core,
            channelId,
            streamId: msg.streamId,
            logger,
            botType
        }),
        downloadAndSaveFiles({
            client,
            fileUrls: voiceUrls,
            fileAesKeys: voiceAesKeys,
            account,
            clawConfig: cfg,
            core,
            channelId,
            streamId: msg.streamId,
            logger,
            botType,
            // 2026-08-05 语音消息：强制按音频处理（.weba + audio/webm），避免被识别为 video
            forceAudio: true
        }),
        downloadAndSaveFiles({
            client,
            fileUrls: videoUrls,
            fileAesKeys: videoAesKeys,
            account,
            clawConfig: cfg,
            core,
            channelId,
            streamId: msg.streamId,
            logger,
            botType
        }),
        downloadAndSaveFiles({
            client,
            fileUrls: fileUrls,
            fileAesKeys: fileAesKeys,
            account,
            clawConfig: cfg,
            core,
            channelId,
            streamId: msg.streamId,
            logger,
            botType
        }),
    ]);

    const mediaList: Array<InboundMediaFacts> = [...imageMediaList, ...voiceMediaList, ...videoMediaList, ...fileMediaList];
    if (mediaList.length === 0 && textBody.length === 0) {
        client.publishToServer({ streamId: msg.streamId, content: '[tag_error_empty_content]', kind: 'block', finish: true });
        return;
    }

    //Step 5: 构建上下文并路由到核心处理流程
    const ctxPayload = await buildMessageContext({
        core,
        channelId,
        account,
        clawConfig: cfg,
        msg,
        imageList: imageMediaList,
        voiceList: voiceMediaList,
        videoList: videoMediaList,
        fileList: fileMediaList,
        textBody,
        quoteContent,
        commandAuthorized,
        chatHistories,
        historyLimit,
        logger,
        client,
        streamId: msg.streamId,
        relayId
    });

    if (!ctxPayload) {
        logger.warn("上下文为空,未进入方法routeAndDispatchMessage...")
        return;
    }

    try {
        await withTimeout(routeAndDispatchMessage({
            ctxPayload,
            core,
            cfg,
            client,
            logger,
            commandAuthorized,
            channelId,
            accountId: account.accountId,
            streamId: msg.streamId,
            accStatus,
            chatOpts: {
                toAgent:msg.toAgent,
                fromUser:msg.fromPerson,
                botType: msg.botType,
                contactId:msg.contactId,
                relayId,
                chatId: isGroup ? msg.chatId! : msg.fromPerson.empId,
                isGroup,
                notifyUrl: msg.notifyUrl
            }
        }),
            0,  //1_800_000, //30分钟不设置超时
            `[tag_error_processing_timed_out](streamId=${msg.streamId})`,
        )

    } catch (e) {
        client.publishToServer({
            streamId: msg.streamId,
            content: `[tag_error_build_ctx]\n${e}`,
            kind: 'block',
            finish: true
        })
    }
}
