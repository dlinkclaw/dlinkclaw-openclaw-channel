/** 仅包含图片时的消息占位符 */
export const MEDIA_IMAGE_PLACEHOLDER = "<media:image>";

export const MEDIA_VOICE_PLACEHOLDER = "<media:audio>";
export const MEDIA_VIDEO_PLACEHOLDER = "<media:video>";

/** 仅包含文件时的消息占位符 */
export const MEDIA_DOCUMENT_PLACEHOLDER = "<media:document>";


/** 默认媒体大小上限（MB）——插件↔服务端链路（下载/上传）的兜底限制 */
export const DEFAULT_MEDIA_MAX_MB = 50;

/**
 * 2026-08-23 安装时写入 openclaw.json 的默认媒体上限（MB）
 * 注意：OpenClaw 核心出站媒体校验读取的是 channels.<id>.mediaMaxMb（默认仅 5MB），
 * 与 DEFAULT_MEDIA_MAX_MB（插件↔服务端）无关。安装向导写入本值后，核心出站即放行。
 */
export const DEFAULT_INSTALL_MEDIA_MAX_MB = 100;

/** 文本分块大小上限 */
export const TEXT_CHUNK_LIMIT = 4000;

/** 图片下载超时时间（毫秒） */
export const IMAGE_DOWNLOAD_TIMEOUT_MS = 60_000 * 2;

/** 文件下载超时时间（毫秒） */
export const FILE_DOWNLOAD_TIMEOUT_MS = 60_000 * 5;

/** 消息发送超时时间（毫秒） */
export const REPLY_SEND_TIMEOUT_MS = 15_000;

/**
 * 主动回复API
 */
export const AUTO_RELAY_API = '/guest/relayBot/sendNotification';
// 2026-10-26 人设注入：按 sessionKey 拉取 agent 人格与生效约定
export const AUTO_RELAY_PERSONA = '/guest/relayBot/persona';
export const AUTO_RELAY_UPLOAD = "/guest/relayBot/uploadMediaFiles";

// ====== 上传文件配置常量（根据服务器性能调整）=======
export const FILE_LIMITS = {
    image: { maxSize: 10 * 1024 * 1024 },      // 图片 10MB
    attachment: { maxSize: 50 * 1024 * 1024 },  // 附件 50MB
};
const IMAGE_TYPES = ['.jpg', '.jpeg', '.png', '.bmp', '.gif', '.webp']
export const IMAGE_EXTS = new Set(IMAGE_TYPES);

export type ATTACHMENT_KINK = "image" | "video" | "audio" | "document" | "unknown" | undefined;

//export const ATTACHMENT_EXTS = new Set([
//     // ====== 图片 ======
//     ...IMAGE_TYPES,

//     // ====== Office 文档 ======
//     '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx',

//     // ====== 文本/代码（AI 最常处理的） ======
//     '.txt', '.csv', '.json', '.xml', '.yaml', '.yml', '.md', '.log',

//     // ====== PDF ======
//     '.pdf',

//     // ====== 压缩包 ======
//     '.zip', '.rar', '.7z', '.tar', '.gz',

//     // ====== 代码源文件 ======
//     '.js', '.ts', '.jsx', '.tsx', '.py', '.java', '.go', '.rs',
//     '.c', '.cpp', '.h', '.hpp', '.cs', '.php', '.rb', '.swift',
//     '.kt', '.sh', '.bat', '.ps1', '.sql', '.css', '.scss', '.less',
//     '.html', '.vue', '.svelte',

//     // ====== 配置文件 ======
//     '.env', '.toml', '.ini', '.cfg',

//     // ====== 电子书/文档 ======
//     '.epub', '.mobi',

//     // ====== 音频 ======
//     '.mp3', '.wav', '.ogg', '.m4a', '.flac', '.aac', '.wma', '.opus',

//     // ====== 视频 ======
//     '.mp4', '.avi', '.mov', '.wmv', '.flv', '.mkv', '.webm', '.m4v', '.mpg', '.mpeg', '.3gp'
// 
//])

// export const ATTACHMENT_TYPE: Record<string, string> = {
//     // ====== 图片类型 ======
//     'image/jpeg': '.jpg',
//     'image/jpg': '.jpg',
//     'image/png': '.png',
//     'image/gif': '.gif',
//     'image/webp': '.webp',
//     'image/bmp': '.bmp',
//     'image/svg+xml': '.svg',
//     'image/tiff': '.tiff',
    
//     // ====== Office 文档 ======
//     'application/msword': '.doc',
//     'application/vnd.openxmlformats-officedocument.wordprocessingml.document': '.docx',
//     'application/vnd.ms-excel': '.xls',
//     'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': '.xlsx',
//     'application/vnd.ms-powerpoint': '.ppt',
//     'application/vnd.openxmlformats-officedocument.presentationml.presentation': '.pptx',
    
//     // ====== 文本/代码 ======
//     'text/plain': '.txt',
//     'text/csv': '.csv',
//     'application/json': '.json',
//     'application/xml': '.xml',
//     'text/xml': '.xml',
//     'text/yaml': '.yaml',
//     'application/x-yaml': '.yml',
//     'text/markdown': '.md',
//     'text/x-log': '.log',
    
//     // ====== PDF ======
//     'application/pdf': '.pdf',
    
//     // ====== 压缩包 ======
//     'application/zip': '.zip',
//     'application/x-rar-compressed': '.rar',
//     'application/x-7z-compressed': '.7z',
//     'application/x-tar': '.tar',
//     'application/gzip': '.gz',
    
//     // ====== 代码源文件 ======
//     'application/javascript': '.js',
//     'text/javascript': '.js',
//     'application/typescript': '.ts',
//     'text/typescript': '.ts',
//     'text/jsx': '.jsx',
//     'text/tsx': '.tsx',
//     'text/x-python': '.py',
//     'text/x-java': '.java',
//     'text/x-go': '.go',
//     'text/x-rust': '.rs',
//     'text/x-c': '.c',
//     'text/x-c++': '.cpp',
//     'text/x-csharp': '.cs',
//     'text/x-php': '.php',
//     'text/x-ruby': '.rb',
//     'text/x-swift': '.swift',
//     'text/x-kotlin': '.kt',
//     'text/x-shellscript': '.sh',
//     'application/x-bat': '.bat',
//     'text/x-powershell': '.ps1',
//     'text/x-sql': '.sql',
//     'text/css': '.css',
//     'text/scss': '.scss',
//     'text/less': '.less',
//     'text/html': '.html',
//     'application/vue': '.vue',
    
//     // ====== 配置文件 ======
//     'text/x-env': '.env',
//     'application/toml': '.toml',
//     'text/ini': '.ini',
//     'text/x-cfg': '.cfg',
    
//     // ====== 电子书/文档 ======
//     'application/epub+zip': '.epub',
//     'application/x-mobipocket-ebook': '.mobi',

//     // ====== 音频 ======
//     'audio/mpeg': '.mp3',
//     'audio/mp3': '.mp3',
//     'audio/wav': '.wav',
//     'audio/x-wav': '.wav',
//     'audio/ogg': '.ogg',
//     'audio/opus': '.opus',
//     'audio/mp4': '.m4a',
//     'audio/x-m4a': '.m4a',
//     'audio/flac': '.flac',
//     'audio/x-flac': '.flac',
//     'audio/aac': '.aac',
//     'audio/x-ms-wma': '.wma',

//     // ====== 视频 ======
//     'video/mp4': '.mp4',
//     'video/mpeg': '.mpeg',
//     'video/x-msvideo': '.avi',
//     'video/quicktime': '.mov',
//     'video/x-ms-wmv': '.wmv',
//     'video/x-flv': '.flv',
//     'video/x-matroska': '.mkv',
//     'video/webm': '.webm',
//     'video/x-m4v': '.m4v',
//     'video/3gpp': '.3gp'
// };