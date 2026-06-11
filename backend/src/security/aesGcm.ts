import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import type { EncryptedValue } from "../types/notion";

const IV_LENGTH = 12;

export function decodeAes256GcmKey(encodedKey: string): Buffer {
  const trimmed = encodedKey.trim();
  const decoded = Buffer.from(trimmed, "base64");
  if (decoded.length === 32) {
    return decoded;
  }

  if (trimmed.length === 32) {
    return Buffer.from(trimmed, "utf8");
  }

  throw new Error("Encryption key must be 32 bytes (base64 or plain text).");
}

export function encryptString(plainText: string, key: Buffer): EncryptedValue {
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([
    cipher.update(plainText, "utf8"),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();

  return {
    ciphertext: ciphertext.toString("base64"),
    iv: iv.toString("base64"),
    authTag: authTag.toString("base64"),
  };
}

export function decryptString(value: EncryptedValue, key: Buffer): string {
  const decipher = createDecipheriv(
    "aes-256-gcm",
    key,
    Buffer.from(value.iv, "base64"),
  );
  decipher.setAuthTag(Buffer.from(value.authTag, "base64"));
  const plain = Buffer.concat([
    decipher.update(Buffer.from(value.ciphertext, "base64")),
    decipher.final(),
  ]);

  return plain.toString("utf8");
}
