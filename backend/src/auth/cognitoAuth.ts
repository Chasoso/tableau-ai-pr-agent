import {
  createPublicKey,
  type JsonWebKey as NodeJsonWebKey,
  type KeyObject,
} from "node:crypto";
import jwt, { type JwtHeader, type JwtPayload } from "jsonwebtoken";
import { getConfig } from "../config";
import type { AuthenticatedUser } from "../types/auth";

type CognitoJwk = JsonWebKey & {
  kid: string;
};

type CognitoJwks = {
  keys: CognitoJwk[];
};

let cachedKeys: Map<string, KeyObject> | null = null;

export type AuthResult =
  | { ok: true; user?: AuthenticatedUser }
  | { ok: false; statusCode: 401 | 403; message: string };

export async function authenticateRequest(
  headers: Record<string, string | undefined> | undefined,
): Promise<AuthResult> {
  const config = getConfig();

  if (!config.auth.required) {
    return { ok: true };
  }

  const authorization = getHeader(headers, "authorization");
  if (!authorization?.startsWith("Bearer ")) {
    return {
      ok: false,
      statusCode: 401,
      message: "Authentication is required.",
    };
  }

  if (
    !config.auth.cognitoUserPoolId ||
    !config.auth.cognitoClientId ||
    !config.auth.cognitoRegion
  ) {
    return {
      ok: false,
      statusCode: 403,
      message: "Authentication is not configured.",
    };
  }

  try {
    const token = authorization.slice("Bearer ".length).trim();
    const decodedHeader = jwt.decode(token, { complete: true })?.header as
      | JwtHeader
      | undefined;
    if (!decodedHeader?.kid) {
      return {
        ok: false,
        statusCode: 401,
        message: "Invalid authentication token.",
      };
    }

    const key = (await getCognitoKeys()).get(decodedHeader.kid);
    if (!key) {
      return {
        ok: false,
        statusCode: 401,
        message: "Invalid authentication token.",
      };
    }

    const issuer = getIssuer();
    const payload = jwt.verify(token, key, {
      algorithms: ["RS256"],
      issuer,
    }) as JwtPayload;

    if (!isExpectedClient(payload, config.auth.cognitoClientId)) {
      return {
        ok: false,
        statusCode: 403,
        message: "Token audience is not allowed.",
      };
    }

    const userId = typeof payload.sub === "string" ? payload.sub : "";
    if (!userId) {
      return {
        ok: false,
        statusCode: 401,
        message: "Invalid authentication token.",
      };
    }

    const email = typeof payload.email === "string" ? payload.email : undefined;
    return {
      ok: true,
      user: {
        userId,
        email,
        tableauSubject: email,
        tokenUse:
          typeof payload.token_use === "string" ? payload.token_use : undefined,
        claims: {
          token_use: payload.token_use,
        },
      },
    };
  } catch {
    return {
      ok: false,
      statusCode: 401,
      message: "Invalid authentication token.",
    };
  }
}

function getHeader(
  headers: Record<string, string | undefined> | undefined,
  name: string,
): string | undefined {
  const entry = Object.entries(headers ?? {}).find(
    ([key]) => key.toLowerCase() === name.toLowerCase(),
  );
  return entry?.[1];
}

async function getCognitoKeys(): Promise<Map<string, KeyObject>> {
  if (cachedKeys) {
    return cachedKeys;
  }

  const response = await fetch(`${getIssuer()}/.well-known/jwks.json`, {
    headers: {
      Accept: "application/json",
    },
  });

  if (!response.ok) {
    throw new Error("Failed to load Cognito JWKS.");
  }

  const jwks = (await response.json()) as CognitoJwks;
  cachedKeys = new Map(
    jwks.keys.map((key) => [
      key.kid,
      createPublicKey({ key: key as unknown as NodeJsonWebKey, format: "jwk" }),
    ]),
  );
  return cachedKeys;
}

function getIssuer(): string {
  const { cognitoRegion, cognitoUserPoolId } = getConfig().auth;
  return `https://cognito-idp.${cognitoRegion}.amazonaws.com/${cognitoUserPoolId}`;
}

function isExpectedClient(payload: JwtPayload, clientId: string): boolean {
  if (payload.token_use === "id") {
    return payload.aud === clientId;
  }

  if (payload.token_use === "access") {
    return payload.client_id === clientId;
  }

  return false;
}
