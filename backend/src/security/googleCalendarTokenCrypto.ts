import { getConfig } from "../config";
import { getSecureStringParameter } from "../aws/ssm";
import { decodeAes256GcmKey, decryptString, encryptString } from "./aesGcm";
import type { EncryptedValue } from "../types/googleCalendarAuth";

let cachedKey: Buffer | null = null;

async function getEncryptionKey(): Promise<Buffer> {
  if (cachedKey) {
    return cachedKey;
  }

  const paramName = getConfig().calendar.google.tokenEncryptionKeyParam;
  if (!paramName) {
    throw new Error("GOOGLE_TOKEN_ENCRYPTION_KEY_PARAM is required.");
  }

  const rawKey = await getSecureStringParameter(paramName);
  cachedKey = decodeAes256GcmKey(rawKey);
  return cachedKey;
}

export async function encryptGoogleToken(
  plainToken: string,
): Promise<EncryptedValue> {
  const key = await getEncryptionKey();
  return encryptString(plainToken, key);
}

export async function decryptGoogleToken(
  encrypted: EncryptedValue,
): Promise<string> {
  const key = await getEncryptionKey();
  return decryptString(encrypted, key);
}

export function clearGoogleCalendarTokenKeyCacheForTest(): void {
  cachedKey = null;
}
