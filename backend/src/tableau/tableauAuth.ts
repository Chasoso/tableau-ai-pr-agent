import { randomUUID } from "node:crypto";
import jwt from "jsonwebtoken";
import type { TableauConnectedAppSecrets } from "../aws/secrets";

export type GenerateTableauJwtInput = {
  connectedApp: TableauConnectedAppSecrets;
  subject: string;
  scopes: string[];
  expirationSeconds?: number;
};

export function generateTableauConnectedAppJwt(
  input: GenerateTableauJwtInput,
): string {
  const expirationSeconds = Math.min(input.expirationSeconds ?? 300, 600);
  const payload = {
    iss: input.connectedApp.clientId,
    sub: input.subject,
    aud: "tableau",
    jti: randomUUID(),
    scp: input.scopes,
  };

  return jwt.sign(payload, input.connectedApp.secretValue, {
    algorithm: "HS256",
    expiresIn: expirationSeconds,
    header: {
      alg: "HS256",
      kid: input.connectedApp.secretId,
    },
  });
}
