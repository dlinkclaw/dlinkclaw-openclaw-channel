
import fs from 'fs';
import path from 'path';

import axios, { AxiosInstance, AxiosResponse, CreateAxiosDefaults } from 'axios';
import { generateSignature, getDeviceId } from './crypto.js';
import { PluginLogger } from 'openclaw/plugin-sdk';
import { FILE_LIMITS, IMAGE_EXTS } from './const.js';
import mime from 'mime-types';
import FormData from 'form-data';
import { BotType } from './types.js';


export type HttpOpts = {
    baseUrl: string,
    apiKey: string,
    secret: string
}
type Response<T> = {
    msg?: string,
    success: boolean,
    code: number,
    data?: T
}

function getFileLimit(filePath: string): number {
    const ext = path.extname(filePath).toLowerCase();
    return IMAGE_EXTS.has(ext) ? FILE_LIMITS.image.maxSize : FILE_LIMITS.attachment.maxSize;
}


export class DLHttp {
    private readonly opts: HttpOpts;
    private readonly deviceId: string;
    private readonly client: AxiosInstance;
    private readonly logger: PluginLogger

    constructor(opts: HttpOpts, logger: PluginLogger, timeout: number = 30000) {
        this.opts = { ...opts }
        this.logger = logger
        this.deviceId = getDeviceId();
        this.client = axios.create({
            baseURL: opts.baseUrl,
            timeout: timeout,
            headers: {
                "Res-Type": "json",
                "Device-Id": this.deviceId,
                "Api-Key": opts.apiKey,
                "User-Type": "2",
                "User-From": "8",
            }
        });
        this.client.interceptors.request.use(
            (config) => {
                // ========== 【请求发送前 打印日志】 ==========
                const params = config.params || config.data;
                this.logger.debug ?? ("======================================");
                this.logger.debug ?? (`🚀 发送请求: ${config.method?.toUpperCase()}, ${config.baseURL}${config.url}`);
                this.logger.debug ?? (`请求参数：", ${JSON.stringify(params)}`);
                this.logger.debug ?? (`"🧾 请求头：\r\n${config.headers}`);
                this.logger.debug ?? ("======================================\n");
                return config;
            },
            (error) => {
                this.logger.debug ?? (`❌ 请求发送失败：${error}`);
                return Promise.reject(error);
            }
        );
    }
    private randomString(len: number) {
        const l = len || 32;
        const $chars = "ABCDEFGHJKMNPQRSTWXYZabcdefhijkmnprstwxyz2345678";
        const maxPos = $chars.length;
        let pwd = "";
        for (let i = 0; i < l; i++) {
            pwd += $chars.charAt(Math.floor(Math.random() * maxPos));
        }
        return pwd;
    };
    private genSign(data?: Record<string, string>) {
        const timestamp = Date.now().toString();
        const echostr = this.randomString(20);
        const params: Record<string, string> = {
            version: "1",
            echostr: echostr,
            deviceId: this.deviceId,
            timestamp: timestamp,
            timezone: Intl.DateTimeFormat().resolvedOptions().timeZone
        };
        if (data) {
            for (const key in data) {
                const value = data[key] || '';
                if (value.length > 0) {
                    params[key] = value.trim()
                }
            }
        }
        const signature = generateSignature(params, this.opts.secret);
        return { params, signature }
    }
    private response<T>(res: AxiosResponse) {
        if (res.status != 200) {
            throw new Error(`Request Get Error:${String(res.statusText)}`);
        }
        const result = res.data as Response<T>;
        if (result.success) {
            return result.data
        }
        throw new Error(String(result.msg));
    }
    async get<T>(url: string, data?: Record<string, string>) {
        const { params, signature } = this.genSign(data);
        const res = await this.client.get(url, {
            "headers": {
                "Sign": signature,
                "Content-Type": "application/x-www-form-urlencoded"
            },
            "params": params,
            "responseType": 'json'
        });
        return this.response<T>(res);
    }
    async post<T>(url: string, data?: Record<string, string>) {
        const { params, signature } = this.genSign(data);
        const res = await this.client.post(url, params, {
            "headers": {
                "Sign": signature,
                "Content-Type": "application/x-www-form-urlencoded"
            },
            "responseType": "json"
        });
        return this.response<T>(res);
    }
    async upload<T>(url: string, files: Array<string>, data?: Record<string, string>) {
        if (!files.length) {
            throw new Error('No files to upload.');
        }
        let fileCount = 0;  // 👈 用计数器代替 getLengthSync
        const { params, signature } = this.genSign(data);
        const form = new FormData();
        for (const filePath of files) {
            try {
                // 1. 校验文件是否存在
                if (!fs.existsSync(filePath)) {
                    this.logger.warn(`The file does not exist.: ${filePath}`);
                    continue;
                }

                // 2. 校验文件大小
                const stat = await fs.promises.stat(filePath);
                const maxSize = getFileLimit(filePath);
                if (stat.size > maxSize) {
                    const mb = maxSize / 1024 / 1024;
                    this.logger.warn(`The file is too large and has been skipped.: ${filePath} (超过 ${mb}MB)`);
                    continue;
                }

                // 3. 流式添加到 form
                const fileName = path.basename(filePath);
                const contentType = mime.lookup(filePath) || 'application/octet-stream';

                form.append('files', fs.createReadStream(filePath), {
                    filename: fileName,
                    contentType,
                });
                fileCount++
                this.logger.info(`Files have been added.: ${fileName} (${(stat.size / 1024 / 1024).toFixed(2)}MB)`);
            } catch (e) {
                this.logger.error(`Failed to read the file: ${filePath}, error=${e}`);
            }
        }

        // 所有文件都失败的情况
        // if (!form.getLengthSync()) {
        //     throw new Error('所有文件均无效，无法上传');
        // }

        if (fileCount === 0) {
            throw new Error('All files are invalid and cannot be uploaded.');
        }

        // 添加业务参数
        for (const [key, value] of Object.entries(params ?? {})) {
            form.append(key, value);
        }

        // 发送请求
        const res = await this.client.post(url, form, {
            headers: {
                ...form.getHeaders(),
                "Sign": signature                  // form-data 自动生成 boundary
            },
            responseType: 'json',
            maxContentLength: Infinity,                   // axios 不限制响应大小
            maxBodyLength: Infinity,                      // axios 不限制请求大小
            timeout: 5 * 60 * 1000,                       // 5 分钟超时（大文件慢网）
        });
        return this.response<T>(res);
    }

    async downloadFileRaw(url: string, { timeout = 10000, botType }: { timeout?: number, botType: BotType }): Promise<{ buffer: Buffer; filename?: string }> {
        this.logger.info(`Downloading file...${url}`);
        const config: CreateAxiosDefaults<any> = {
            timeout,
            headers: {
                'Content-Type': "application/json",
            },
        }
        if (botType === 'dLink') {
            const { params, signature } = this.genSign();
            config.params = params
            config.headers = {
                ...config.headers,
                'Content-Type': 'application/x-www-form-urlencoded',
                'Sign': signature,
                'Api-Key': this.opts.apiKey,
            }
        }
        const http = axios.create(config);
        try {
            const response = await http.get(url, {
                responseType: 'arraybuffer'
            });

            // 从 Content-Disposition 头中解析文件名
            const contentDisposition = response.headers['content-disposition'] as string | undefined;
            let filename: string | undefined;
            if (contentDisposition) {
                // 优先匹配 filename*=UTF-8''xxx 格式（RFC 5987）
                const utf8Match = contentDisposition.match(/filename\*=UTF-8''([^;\s]+)/i);
                if (utf8Match) {
                    filename = decodeURIComponent(utf8Match[1]);
                } else {
                    // 匹配 filename="xxx" 或 filename=xxx 格式
                    const match = contentDisposition.match(/filename="?([^";\s]+)"?/i);
                    if (match) {
                        filename = decodeURIComponent(match[1]);
                    }
                }
            }
            if (botType === 'dLink' && (!filename || filename.length === 0)) {
                const httpUrl = new URL(decodeURIComponent(url));
                const uri = decodeURIComponent(httpUrl.pathname);
                filename = uri.substring(uri.lastIndexOf('/') + 1);
            }
            this.logger.info(`File[${filename ?? ''}] downloaded successfully`);
            return { buffer: Buffer.from(response.data), filename };
        } catch (error) {
            throw new Error(`File download failed.! error:${String(error)}`)
        }
    }
}