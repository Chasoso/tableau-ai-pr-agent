import {
  decodeAes256GcmKey,
  decryptString,
  encryptString,
} from "../security/aesGcm";
import { getSecureStringParameter } from "../aws/ssm";
import type { FrontendAuthSessionPayload } from "../types/cognitoPopupAuth";
import type { EncryptedValue } from "../types/notion";
import { getConfig } from "../config";

let cachedKey: Buffer | null = null;

async function getPopupAuthEncryptionKey(): Promise<Buffer> {
  if (cachedKey) {
    return cachedKey;
  }

  const parameterName = getConfig().auth.popup.transactionKeyParam;
  if (!parameterName) {
    throw new Error(
      "COGNITO_AUTH_TRANSACTION_KEY_PARAM is required for Cognito popup auth.",
    );
  }

  const raw = await getSecureStringParameter(parameterName);
  cachedKey = decodeAes256GcmKey(raw);
  return cachedKey;
}

export async function encryptPopupCodeVerifier(
  codeVerifier: string,
): Promise<EncryptedValue> {
  return encryptString(codeVerifier, await getPopupAuthEncryptionKey());
}

export async function decryptPopupCodeVerifier(
  value: EncryptedValue,
): Promise<string> {
  return decryptString(value, await getPopupAuthEncryptionKey());
}

export async function encryptPopupSession(
  session: FrontendAuthSessionPayload,
): Promise<EncryptedValue> {
  return encryptString(
    JSON.stringify(session),
    await getPopupAuthEncryptionKey(),
  );
}

export async function decryptPopupSession(
  value: EncryptedValue,
): Promise<FrontendAuthSessionPayload> {
  return JSON.parse(
    decryptString(value, await getPopupAuthEncryptionKey()),
  ) as FrontendAuthSessionPayload;
}
