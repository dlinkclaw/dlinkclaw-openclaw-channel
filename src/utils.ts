import fs from 'fs';
import path, { join } from 'path';
import os, { tmpdir } from 'os';
import readline from 'readline';
import { fileURLToPath } from 'url';
import { copyFile, unlink } from 'fs/promises'
export const readlineHandle = async (filename: string, callback: (line: string) => void) => {
  //被免文件被锁导致gateway重启，需要复制一份副本
  const tmpFile = join(tmpdir(), `traj-${uuidStr(36)}.jsonl`)
  await copyFile(filename, tmpFile)

  //直接读取副本内容
  const rl = readline.createInterface({
    input: fs.createReadStream(tmpFile),
    crlfDelay: Infinity,
  });
  for await (const line of rl) {
    if (!line.trim()) continue;
    callback(line);
  }
  callback('---end---');
  //清理副本文件
  await unlink(tmpFile).catch(() => { })
}

export const getOpenclawPath = (...paths: string[]) => {
  return path.join(os.homedir(), '.openclaw', ...paths)
}

/**
 * 2026-08-10 扩展能力（ext_capabilities）目录定位。
 * 优先从插件包目录找（开发/本地路径），找不到则退回 ~/.openclaw/ext_capabilities。
 */
/**
 * 2026-08-10 扩展能力（ext_capabilities）目录定位。
 * 注意：插件是 ESM（"type": "module"），__dirname 未定义，必须用 import.meta.url 定位。
 * 从当前文件向上查找含 package.json + ext_capabilities 的插件根目录，
 * 同时保留 cwd / ~/.openclaw 作为兜底，兼容不同启动方式。
 */
export const getExtCapabilitiesDir = (): string => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  // 从当前文件（src/ 或 dist/src/）向上查找插件根目录（含 package.json 且含 ext_capabilities）
  let dir = here;
  for (let i = 0; i < 6; i++) {
    try {
      if (fs.existsSync(path.join(dir, 'package.json')) && fs.existsSync(path.join(dir, 'ext_capabilities'))) {
        return path.join(dir, 'ext_capabilities');
      }
    } catch { /* ignore */ }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  // 兜底：cwd / ~/.openclaw
  const fallbacks = [
    path.resolve(process.cwd(), 'ext_capabilities'),
    getOpenclawPath('ext_capabilities'),
  ];
  for (const dir2 of fallbacks) {
    try {
      if (fs.existsSync(dir2)) return dir2;
    } catch { /* ignore */ }
  }
  return fallbacks[0];
}

export const dtFormat = (dt: Date, fmt: string) => {
  const o: Record<string, number> = {
    "M+": dt.getMonth() + 1, //月份
    "d+": dt.getDate(), //日
    "h+": dt.getHours(), //小时
    "m+": dt.getMinutes(), //分
    "s+": dt.getSeconds(), //秒
    "q+": Math.floor((dt.getMonth() + 3) / 3), //季度
    "S": dt.getMilliseconds() //毫秒
  };

  // 处理年份
  const yearMatch = fmt.match(/(y+)/);
  if (yearMatch) {
    const yearStr = dt.getFullYear().toString();
    const pattern = yearMatch[0];
    const len = pattern.length;
    fmt = fmt.replace(pattern, yearStr.slice(-len));
  }

  // 处理其他格式
  for (const k in o) {
    const regex = new RegExp("(" + k + ")");
    const match = fmt.match(regex);
    if (match) {
      const pattern = match[0];
      const value = o[k].toString();
      const replacement = pattern.length === 1
        ? value
        : ("00" + value).slice(-pattern.length);
      fmt = fmt.replace(pattern, replacement);
    }
  }

  return fmt;
};

/**
 * 生成指定长度的uuid
 * @param {Object} len
 * @param {Object} radix 2,10,16进制
 */
export const uuidStr = (len: number, radix?: number) => {
  const chars =
    "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz".split("");
  const uuid: Array<string> = []
  let i: number;
  radix = radix || chars.length;

  if (len) {
    // Compact form
    for (i = 0; i < len; i++) uuid[i] = chars[0 | (Math.random() * radix)];
  } else {
    let r;

    uuid[8] = uuid[13] = uuid[18] = uuid[23] = "-";
    uuid[14] = "4";

    for (i = 0; i < 36; i++) {
      if (!uuid[i]) {
        r = 0 | (Math.random() * 16);
        uuid[i] = chars[i == 19 ? (r & 0x3) | 0x8 : r];
      }
    }
  }
  return uuid.join("");
};