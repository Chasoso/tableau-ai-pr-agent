import { getConfig } from "../config";
import { getSecureStringParameter } from "../aws/ssm";
import {
  decodeAes256GcmKey,
  decryptString,
  encryptString,
} from "../security/aesGcm";
import type { EncryptedValue } from "../types/notion";

let cachedKey: Buffer | null = null;

async function getEncryptionKey(): Promise<Buffer> {
  if (cachedKey) {
    return cachedKey;
  }

  const paramName = getConfig().notion.tokenEncryptionKeyParam;
  if (!paramName) {
    throw new Error("NOTION_TOKEN_ENCRYPTION_KEY_PARAM is required.");
  }

  const rawKey = await getSecureStringParameter(paramName);
  cachedKey = decodeAes256GcmKey(rawKey);
  return cachedKey;
}

export async function encryptToken(
  plainToken: string,
): Promise<EncryptedValue> {
  const key = await getEncryptionKey();
  return encryptString(plainToken, key);
}

export async function decryptToken(encrypted: EncryptedValue): Promise<string> {
  const key = await getEncryptionKey();
  return decryptString(encrypted, key);
}

export function clearNotionTokenKeyCacheForTest(): void {
  cachedKey = null;
}
