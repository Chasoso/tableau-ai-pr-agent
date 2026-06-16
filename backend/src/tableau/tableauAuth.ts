import { randomUUID } from "node:crypto";
import jwt from "jsonwebtoken";
import type { TableauConnectedAppSecrets } from "../aws/secrets";

export type GenerateTableauJwtInput = {
  connectedApp: TableauConnectedAppSecrets;
  subject: string;
  scopes: string[];
  expirationSeconds?: number;
};

export type TableauConnectedAppJwtPreview = {
  iss: string;
  sub: string;
  aud: string;
  expRemainingSeconds: number;
  scp: string[];
};

export function generateTableauConnectedAppJwt(
  input: GenerateTableauJwtInput,
): string {
  return buildTableauConnectedAppJwt(input).token;
}

export function buildTableauConnectedAppJwt(input: GenerateTableauJwtInput): {
  token: string;
  payload: TableauConnectedAppJwtPreview;
} {
  const expirationSeconds = Math.min(input.expirationSeconds ?? 300, 600);
  const payload = {
    iss: input.connectedApp.clientId,
    sub: input.subject,
    aud: "tableau",
    jti: randomUUID(),
    scp: input.scopes,
  };

  const token = jwt.sign(payload, input.connectedApp.secretValue, {
    algorithm: "HS256",
    expiresIn: expirationSeconds,
    header: {
      alg: "HS256",
      kid: input.connectedApp.secretId,
    },
  });

  return {
    token,
    payload: {
      iss: payload.iss,
      sub: payload.sub,
      aud: payload.aud,
      expRemainingSeconds: expirationSeconds,
      scp: payload.scp,
    },
  };
}
