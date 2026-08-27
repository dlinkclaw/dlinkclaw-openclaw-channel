// ============================================================================
// 图片格式检测辅助函数（基于 file-type 包）
// ============================================================================

import { fileTypeFromBuffer } from "file-type";
import { OpenClawConfig, PluginLogger, PluginRuntime } from "openclaw/plugin-sdk";
import { ATTACHMENT_KINK, DEFAULT_MEDIA_MAX_MB, FILE_DOWNLOAD_TIMEOUT_MS } from "./const.js";
import { withTimeout } from "./timeout.js";
import { dlinkDecryptFile, ewxDecryptFile, md5 } from "./crypto.js";
import { DLClient } from "./dl-client.js";
import { BotType, DLResolvedAccount } from "./types.js";
import mime from 'mime-types';
import { InboundMediaFacts } from "openclaw/plugin-sdk/channel-inbound";
// 2026-08-05 语音消息：需要重命名文件为 .weba，使用 Node 原生 fs/path，跨平台（Win/Mac/Linux）行为一致
import fs from 'fs/promises';
import path from 'path';



/**
 * 检测 Buffer 的内容类型
 */
async function detectFileContentType(data: Buffer, filename?: string): Promise<string> {
    if (!data || data.length === 0) {
        return 'application/octet-stream';
    }

    // 1.根据文件名精准判断文本类型（最准）
    if (filename) {
        // 2026-08-05 修复：原来 mime.lookup 结果被丢弃（未 return），导致 .weba 语音被 file-type 误判为 video/webm
        // 现在文件名扩展名能识别时优先返回（.weba → audio/webm）
        const mimeByExt = mime.lookup(filename);
        if (mimeByExt) {
            return mimeByExt;
        }
    }

    // 2.通过Buffer识别文件类型
    const fileTypeResult = await fileTypeFromBuffer(data);
    if (fileTypeResult?.mime) {
        return fileTypeResult.mime;
    }

    // 3. 二进制未识别 → 判断是否为【纯文本文件】(txt/md/json等)
    try {
        const text = data.toString('utf8');
        if (typeof text === 'string') {
            // 简单判断是否包含不可打印字符（排除乱码二进制）
            const isBinary = /[\x00-\x08\x0B\x0C\x0E-\x1F]/.test(text);
            if (!isBinary) {
                return 'text/plain';
            }
        }
    } catch { }


    return 'application/octet-stream';
}

function detectDocument(contentType: string): ATTACHMENT_KINK {
    if (contentType.includes('json') ||
        contentType.includes('msword ') ||
        contentType.includes('pdf') ||
        contentType.includes('sql') ||
        (contentType.includes('/vnd.') && !contentType.includes("vnd.rar")) ||
        contentType.startsWith("text/") ||
        contentType.endsWith('/epub+zip') ||
        contentType.endsWith('/x-mobipocket-ebook')
    ) {
        return 'document'
    }
    return undefined
}

function detectZipPackage(contentType: string): ATTACHMENT_KINK {
    if (contentType.endsWith('/zip') ||
        contentType.endsWith('/vnd.rar') ||
        contentType.endsWith('/x-rar-compressed') ||
        contentType.endsWith('/x-7z-compressed') ||
        contentType.endsWith("/gzip") ||
        contentType.endsWith('/x-tar') ||
        contentType.endsWith('/x-bzip2') ||
        contentType.endsWith('/x-xz') ||

        contentType.endsWith('/x-compress')) {
        return 'document'
    }
    return undefined
}

function detectScript(contentType: string): ATTACHMENT_KINK {
    if (contentType.endsWith('/javascript') ||
        contentType.endsWith('/typescript')) {
        return 'document'
    }
    return undefined
}

/**
 * 下载并保存所有文件到本地，每个文件的下载带超时保护
 */
export async function downloadAndSaveFiles(params: {
    client: DLClient,
    fileUrls: string[];
    fileAesKeys?: Map<string, string>;
    account: DLResolvedAccount;
    clawConfig: OpenClawConfig;
    core: PluginRuntime,
    channelId: string,
    streamId: string,
    botType: BotType,
    logger: PluginLogger,
    /** 2026-08-05 语音消息：为 true 时强制按音频处理（webm → .weba，contentType=audio/webm） */
    forceAudio?: boolean
}): Promise<Array<InboundMediaFacts>> {
    const { client, fileUrls, fileAesKeys, account, clawConfig, core, channelId, streamId, botType, logger, forceAudio } = params;
    const { config } = account;
    const mediaList: Array<InboundMediaFacts> = [];
    for (const fileUrl of fileUrls) {
        try {
            let buffer: Buffer;
            let contentType: string;
            let originalFilename: string | undefined;
            let kind: ATTACHMENT_KINK
            const mediaMaxMb = config.mediaMaxMb || clawConfig.agents?.defaults?.mediaMaxMb || DEFAULT_MEDIA_MAX_MB;
            const maxBytes = mediaMaxMb * 1024 * 1024;

            const key = fileAesKeys?.get(md5(fileUrl));
            try {
                logger.info(`account[${account.accountId}] Downloading file from: ${fileUrl}, aseKey: ${key}`);
                const res = await withTimeout(
                    downloadFile(client, {
                        url: fileUrl,
                        aesKey: key,
                        channelId,
                        logger,
                        botType
                    }),
                    FILE_DOWNLOAD_TIMEOUT_MS,
                    `${channelId} account[${account.accountId}] Manual file download timed out: ${fileUrl}`,
                )
                buffer = res.buffer;
                contentType = await detectFileContentType(buffer, res.filename);
                originalFilename = res.filename;
            } catch (err) {
                logger.error(`${channelId} account[${account.accountId}] Failed to Manual download file: ${String(err)}`);
                logger.info(`${channelId} account[${account.accountId}] use runtime api download..`)

                const fetched = await withTimeout(
                    core.channel.media.fetchRemoteMedia({ url: fileUrl }),
                    FILE_DOWNLOAD_TIMEOUT_MS,
                    `${channelId} account[${account.accountId}] use runtime api download timed out: ${fileUrl}`,
                ) as {
                    buffer: Buffer;
                    contentType?: string;
                    fileName?: string;
                };

                buffer = fetched.buffer;
                contentType = fetched.contentType ?? "application/octet-stream";
                originalFilename = fetched.fileName;
            }

            if (contentType.startsWith('image/')) {
                kind = 'image'
            } else if (contentType.startsWith('audio/')) {
                kind = 'audio';
            } else if (contentType.startsWith('video/')) {
                kind = 'video';
            } else {
                kind = detectDocument(contentType);
                if (!kind) {
                    kind = detectZipPackage(contentType);
                }
                if (!kind) {
                    kind = detectScript(contentType);
                }
                if (!kind) {
                    kind = 'unknown'
                }
            }

            if (!kind) {
                logger.warn(`禁止接收该类型[${contentType}]文件`);
                client.publishToServer({ streamId, content: `[tag_error_not_allow_file_type]:${contentType}-${originalFilename}!`, kind:'block', finish: true });
                continue;
            }

            const saved = await core.channel.media.saveMediaBuffer(
                buffer,
                contentType,
                "inbound",
                maxBytes,
                originalFilename,
                'The received file is saved in. [user directory]/.openclaw/media/inbound'
            );

            // 2026-08-05 语音消息：forceAudio 时强制按音频处理
            // 背景1：webm 容器即使只有 Opus 音频轨，file-type 也识别为 video/webm，
            //       openclaw 运行时 detectMime 优先用嗅探结果，导致 source_modality=video。
            // 背景2：SenseAudio STT 不认 .weba 扩展名（返回 500），但认 .webm。
            // 处理：保持 .webm 文件名（SenseAudio 能转写），仅把 contentType 强制为 audio/webm
            //       （OpenClaw 的 source_modality 看 contentType，不看扩展名）。
            //       不重命名文件，避免 .weba 导致 SenseAudio 500。
            let savedPath = saved.path;
            let savedContentType = saved.contentType;
            if (forceAudio) {
                savedContentType = 'audio/webm';
                logger.info(`${channelId} account[${account.accountId}] voice file contentType forced to audio/webm: ${savedPath}`);
            }
            mediaList.push({ path: savedPath, contentType: savedContentType, messageId: streamId });
            //logger.info(`${channelId} account[${account.accountId}] file saved to ${saved.path}, contentType=${saved.contentType}`);
        } catch (e) {
            logger.error(`${channelId} account[${account.accountId}] Failed to download file: ${String(e)}`);
        }
    }
    logger.info(`${channelId} account[${account.accountId}], mediaList = ${JSON.stringify(mediaList)}`)
    return mediaList;
}

const downloadFile = async (client: DLClient, params: { url: string, aesKey?: string, channelId: string, logger: PluginLogger, botType: BotType }): Promise<{ buffer: Buffer, filename?: string }> => {
    const { url, aesKey, channelId, logger, botType } = params;
    logger.debug ?? (`${channelId} downloadFile: url=${url}, hasAesKey=${!!aesKey}`);
    logger.info('Downloading and decrypting file...');

    try {
        // 下载加密的文件数据
        const { buffer, filename } = await client.downloadFileRaw(url, botType);
        // 如果没有提供 aesKey，直接返回原始数据
        if (!aesKey || aesKey.length === 0) {
            logger.warn(`${channelId} No aesKey provided, returning raw file data`);
            return { buffer: buffer, filename };
        }

        // 使用独立的解密模块进行 AES-256-CBC 解密
        let decryptedBuffer;
        switch (botType) {
            case "ewx":
                decryptedBuffer = ewxDecryptFile(buffer, aesKey);
                break;
            case "qq":
            case "dd":
            case "feishu":
            case "dLink":
                decryptedBuffer = dlinkDecryptFile(buffer, aesKey);
                break;
        }
        logger.info(`${channelId} File downloaded and decrypted successfully`);
        return { buffer: decryptedBuffer, filename };
    } catch (error) {
        throw new Error(`解密失败!,${error}`)
    }
}
