import { GetParameterCommand, SSMClient } from "@aws-sdk/client-ssm";

let client: SSMClient | null = null;
const parameterCache = new Map<string, { value: string; expiresAt: number }>();
const DEFAULT_TTL_MS = 5 * 60 * 1000;

function getSsmClient(): SSMClient {
  if (!client) {
    client = new SSMClient({});
  }

  return client;
}

export async function getSecureStringParameter(
  name: string,
  ttlMs = DEFAULT_TTL_MS,
): Promise<string> {
  const now = Date.now();
  const cached = parameterCache.get(name);
  if (cached && cached.expiresAt > now) {
    return cached.value;
  }

  const response = await getSsmClient().send(
    new GetParameterCommand({
      Name: name,
      WithDecryption: true,
    }),
  );

  const value = response.Parameter?.Value;
  if (!value) {
    throw new Error(`SSM parameter '${name}' is empty or missing.`);
  }

  parameterCache.set(name, {
    value,
    expiresAt: now + Math.max(5_000, ttlMs),
  });

  return value;
}

export function clearSsmParameterCacheForTest(): void {
  parameterCache.clear();
}
