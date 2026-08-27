import crypto, { createSecretKey } from "crypto";
import fs from 'fs';
import path from 'path';
import os from 'os';
import { MqttConfig } from "./dl-client.js";
import { exec } from 'child_process';
const DEVICE_FILE = '.dlinkclaw';

export type DeviceConfig = {
  deviceId: string,
  publicKey: string,
  publicKeyPem: string,
  privateKeyPem: string,
  deviceToken?: string
}

function base64url(buf: Buffer) {
  return buf.toString('base64').replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

// function generateDeviceId(): string {
//   const interfaces = os.networkInterfaces();
//   for (const name of Object.keys(interfaces)) {
//     const iface = interfaces[name];
//     if (!iface) continue;

//     for (const info of iface) {
//       if (info.mac && info.mac !== "00:00:00:00:00:00") {
//         return info.mac.replace(/:/g, "").toUpperCase();
//       }
//     }
//   }
//   return crypto.randomUUID().replace(/-/g, "").toUpperCase();
// }

function generateDeviceIdentity() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const pubPem = publicKey.export({ type: 'spki', format: 'pem' });
  const privPem = privateKey.export({ type: 'pkcs8', format: 'pem' });

  // 提取 raw public key → deviceId = sha256(公钥)
  const spki = crypto.createPublicKey(pubPem).export({ type: 'spki', format: 'der' });
  const ED25519_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');
  const rawPub = spki.subarray(ED25519_PREFIX.length);
  const deviceId = crypto.createHash('sha256').update(rawPub).digest('hex');
  const pubKeyB64Url = base64url(rawPub);
  return { deviceId, publicKey: pubKeyB64Url, privateKeyPem: privPem, publicKeyPem: pubPem };
}

export async function reqBootstrapToken(gatewayUrl: string): Promise<string> {
  const safeUrl = gatewayUrl.replace(/[^a-zA-Z0-9:/._-]/g, '');
  return new Promise((resolve, reject) => {
    exec(`openclaw qr --json --url ${safeUrl}`,
      { timeout: 10000, encoding: 'utf-8' },
      (err, stdout) => {
        if (err) return reject(new Error(`获取失败: ${err.message}`));
        try {
          const result = JSON.parse(stdout);
          const decoded = JSON.parse(Buffer.from(result.setupCode, 'base64').toString());
          resolve(decoded.bootstrapToken);
        } catch (e) {
          reject(new Error(`解析失败: ${String(e)}`));
        }
      }
    );
  });
}

export function getDeviceId(): string {
  const userDir = os.homedir();
  const filePath = path.join(userDir, DEVICE_FILE);
  try {
    const fileData = fs.readFileSync(filePath, 'utf8');
    const result: DeviceConfig = JSON.parse(fileData);
    return result.deviceId;
  } catch (e) {
    const { deviceId, publicKey, publicKeyPem, privateKeyPem } = generateDeviceIdentity();
    const model: DeviceConfig = {
      deviceId: deviceId,
      publicKey: publicKey,
      publicKeyPem: publicKeyPem,
      privateKeyPem: privateKeyPem
    }
    try {
      const userDir = os.homedir();
      const filePath = path.join(userDir, DEVICE_FILE);
      fs.writeFileSync(filePath, JSON.stringify(model), 'utf-8');
      return deviceId;
    } catch (e) {
      throw new Error(`Write file error ${String(e)}`)
    }
  }
}

export function getDeviceConfig(): DeviceConfig {
  const userDir = os.homedir();
  const filePath = path.join(userDir, DEVICE_FILE);
  try {
    const fileData = fs.readFileSync(filePath, 'utf8');
    const result: DeviceConfig = JSON.parse(fileData);
    return result
  } catch (e) {
    throw new Error(String(e))
  }
}

export function saveDeviceConfig(config: DeviceConfig) {
  try {
    const userDir = os.homedir();
    const filePath = path.join(userDir, DEVICE_FILE);
    fs.writeFile(filePath, JSON.stringify(config), 'utf-8', (err) => {
      if (err) {
        console.error(`写DeviceConfig文件[${filePath}],失败${err.message}`)
      }
    });
  } catch (e) {
    console.error(`写DeviceConfig文件失败${String(e)}`)
  }
}

export function decryptAesEcbPkcs5(encryptedData: string, key: string): MqttConfig {
  const keyBytes = Buffer.from(key, "base64");
  const keyLength = keyBytes.length;

  let algorithm: string;
  if (keyLength === 16) {
    algorithm = "aes-128-ecb";
  } else if (keyLength === 24) {
    algorithm = "aes-192-ecb";
  } else if (keyLength === 32) {
    algorithm = "aes-256-ecb";
  } else {
    throw new Error(`Invalid key length: ${keyLength}`);
  }

  const keySpec = crypto.createSecretKey(keyBytes);

  const decipher = crypto.createDecipheriv(
    algorithm,
    keySpec,
    null
  );

  decipher.setAutoPadding(true);

  let decrypted = decipher.update(encryptedData, "base64", "utf8");
  decrypted += decipher.final("utf8");

  return JSON.parse(decrypted);
}


export function signConnectPayload(params: {
  deviceId: string,
  privateKeyPem: string,
  token: string,
  clientId: string,
  clientMode: string,
  role: string, 
  scopes: Array<string>,
  platform: string,
  nonce: string,
  deviceFamily?: string
}) {
  const {
    deviceId,
    clientId,
    clientMode,
    role,
    scopes,
    token,
    platform,
    deviceFamily,
    privateKeyPem,
    nonce
  } = params
  const signedAtMs = Date.now();

  const payload = [
    'v3',
    deviceId,
    clientId,
    clientMode,
    role,
    scopes.join(','),
    String(signedAtMs),
    token,
    nonce,
    platform,
    deviceFamily ?? ''
  ].join('|');

  const key = crypto.createPrivateKey(privateKeyPem);
  const signature = base64url(crypto.sign(null, Buffer.from(payload, 'utf8'), key));

  return { signedAtMs, signature, payload };
}

export function generateSignature(params: Record<string, string>, secret: string): string {
  const sortedKeys = Object.keys(params).sort((a, b) =>
    a.toLowerCase().localeCompare(b.toLowerCase(), undefined, {
      numeric: true,
      sensitivity: 'base'
    })
  );

  const signString = sortedKeys
    .map(key => `${key}=${params[key]}`)
    .join("&") + `&key=${secret}`;
  const signStr = signString.toUpperCase();
  //console.log("签名字符串 >>> ", signStr);
  return crypto.createHash("md5").update(signStr).digest("hex");
}

export function md5(str: string) {
  return crypto.createHash("md5").update(str).digest("hex");
}

/**
 * 使用 AES-256-CBC 解密文件
 *
 * @param encryptedBuffer - 加密的文件数据
 * @param aesKey - Base64 编码的 AES-256 密钥
 * @returns 解密后的文件 Buffer
 */
export function ewxDecryptFile(encryptedBuffer: Buffer, aesKey: string): Buffer {
  // 参数验证
  if (!encryptedBuffer || encryptedBuffer.length === 0) {
    throw new Error('decryptFile: encryptedBuffer is empty or not provided');
  }

  if (!aesKey || typeof aesKey !== 'string') {
    throw new Error('decryptFile: aesKey must be a non-empty string');
  }

  // 将 Base64 编码的 aesKey 解码为 Buffer
  const key = Buffer.from(aesKey, 'base64');

  // IV 取 aesKey 解码后的前 16 字节
  const iv = key.subarray(0, 16);

  try {
    const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
    // 关闭自动 padding，因为文档要求 PKCS#7 填充至 32 字节的倍数，
    // 而 Node.js 默认按 16 字节 block 去除 padding，会导致 bad decrypt 错误
    decipher.setAutoPadding(false);

    const decrypted = Buffer.concat([
      decipher.update(encryptedBuffer),
      decipher.final(),
    ]);

    // 手动去除 PKCS#7 填充（支持 32 字节 block）
    const padLen = decrypted[decrypted.length - 1];
    if (padLen < 1 || padLen > 32 || padLen > decrypted.length) {
      throw new Error(`Invalid PKCS#7 padding value: ${padLen}`);
    }
    // 验证所有 padding 字节是否一致
    for (let i = decrypted.length - padLen; i < decrypted.length; i++) {
      if (decrypted[i] !== padLen) {
        throw new Error('Invalid PKCS#7 padding: padding bytes mismatch');
      }
    }

    return decrypted.subarray(0, decrypted.length - padLen);
  } catch (error: any) {
    throw new Error(`decryptFile: Decryption failed - ${error.message}. This may indicate corrupted data or an incorrect aesKey.`);
  }
}


/**
 * 使用 AES-256-CBC 解密文件
 *
 * @param encryptedBuffer - 加密的文件数据
 * @param aesKey - Base64 编码的 AES-256 密钥
 * @returns 解密后的文件 Buffer
 */
export function dlinkDecryptFile(encryptedBuffer: Buffer, aesKey: string): Buffer {
  // 参数验证
  if (!encryptedBuffer || encryptedBuffer.length === 0) {
    throw new Error('dlinkDecryptFile: encryptedBuffer is empty or not provided');
  }

  if (!aesKey || typeof aesKey !== 'string') {
    throw new Error('dlinkDecryptFile: aesKey must be a non-empty string');
  }

  // 将 Base64 编码的 aesKey 解码为 Buffer
  const key = Buffer.from(aesKey, 'base64');

  // IV 取 aesKey 解码后的前 16 字节
  //const iv = key.subarray(0, 16);

  const iv = encryptedBuffer.subarray(0, 16);
  const encryptedData = encryptedBuffer.subarray(16);

  try {
    const keyObj = createSecretKey(new Uint8Array(key));
    const decipher = crypto.createDecipheriv('aes-256-cbc', keyObj, new Uint8Array(iv));
    // 关闭自动 padding，因为文档要求 PKCS#7 填充至 32 字节的倍数，
    // 而 Node.js 默认按 16 字节 block 去除 padding，会导致 bad decrypt 错误
    decipher.setAutoPadding(false);

    // const decrypted = Buffer.concat([
    //   decipher.update(encryptedBuffer),
    //   decipher.final(),
    // ]);
    const a =  decipher.update(new Uint8Array(encryptedData));
    const decrypted = Buffer.concat([
      new Uint8Array(a),
      new Uint8Array(decipher.final()),
    ]);

    // 手动去除 PKCS#7 填充（支持 32 字节 block）
    const padLen = decrypted[decrypted.length - 1];
    if (padLen < 1 || padLen > 32 || padLen > decrypted.length) {
      throw new Error(`dlinkDecryptFile Invalid PKCS#7 padding value: ${padLen}`);
    }
    // 验证所有 padding 字节是否一致
    
    for (let i = decrypted.length - padLen; i < decrypted.length; i++) {
      if (decrypted[i] !== padLen) {
        throw new Error('dlinkDecryptFile Invalid PKCS#7 padding: padding bytes mismatch');
      }
    }
    return decrypted.subarray(0, decrypted.length - padLen);
  } catch (error: any) {
    throw new Error(`dlinkDecryptFile: Decryption failed - ${error.message}. This may indicate corrupted data or an incorrect aesKey.`);
  }
}

