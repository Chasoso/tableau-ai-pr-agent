import { getConfig } from "../config";
import { logInfo, logWarn, safeErrorDetails, safeHash } from "../logging";

export type BlueskyPostResult = {
  sent: boolean;
  skipped: boolean;
  statusCode?: number;
  error?: string;
  postUri?: string;
  cid?: string;
};

type BlueskySessionResponse = {
  accessJwt: string;
  refreshJwt?: string;
  did: string;
  handle?: string;
};

type BlueskyCreateRecordResponse = {
  uri: string;
  cid: string;
};

export class BlueskyPostService {
  constructor(
    private readonly fetchImpl: typeof fetch = globalThis.fetch.bind(
      globalThis,
    ),
  ) {}

  async postText(input: {
    text: string;
    runId?: string;
  }): Promise<BlueskyPostResult> {
    if (getConfig().demoMode) {
      logWarn("bluesky.post.skipped", {
        ...(input.runId ? { runId: input.runId } : {}),
        reason: "demo_mode",
      });
      return { sent: false, skipped: true };
    }

    const config = getConfig().bluesky;
    const identifier = config.identifier.trim();
    const appPassword = config.appPassword.trim();
    const serviceUrl = normalizeBaseUrl(config.serviceUrl);

    if (!identifier || !appPassword) {
      logWarn("bluesky.post.skipped", {
        ...(input.runId ? { runId: input.runId } : {}),
        reason: "missing_credentials",
      });
      return {
        sent: false,
        skipped: true,
        error: "Bluesky credentials are not configured.",
      };
    }

    const text = input.text.trim();
    if (!text) {
      return {
        sent: false,
        skipped: false,
        error: "Bluesky post text is required.",
      };
    }

    try {
      const session = await this.createSession({
        serviceUrl,
        identifier,
        appPassword,
      });
      const record = await this.createPostRecord({
        serviceUrl,
        accessJwt: session.accessJwt,
        did: session.did,
        text,
      });

      logInfo("bluesky.post.sent", {
        ...(input.runId ? { runId: input.runId } : {}),
        identifierHash: safeHash(identifier),
        handle: session.handle,
        postUri: record.uri,
      });

      return {
        sent: true,
        skipped: false,
        statusCode: 200,
        postUri: record.uri,
        cid: record.cid,
      };
    } catch (error) {
      const details = safeErrorDetails(error);
      logWarn("bluesky.post.failed", {
        ...(input.runId ? { runId: input.runId } : {}),
        identifierHash: safeHash(identifier),
        ...details,
      });
      return {
        sent: false,
        skipped: false,
        error: error instanceof Error ? error.message : "Bluesky post failed.",
      };
    }
  }

  private async createSession(input: {
    serviceUrl: string;
    identifier: string;
    appPassword: string;
  }): Promise<BlueskySessionResponse> {
    const response = await this.fetchImpl(
      `${input.serviceUrl}/xrpc/com.atproto.server.createSession`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          identifier: input.identifier,
          password: input.appPassword,
        }),
      },
    );

    if (!response.ok) {
      throw new Error(
        `Bluesky session creation failed with status ${response.status}.`,
      );
    }

    return (await response.json()) as BlueskySessionResponse;
  }

  private async createPostRecord(input: {
    serviceUrl: string;
    accessJwt: string;
    did: string;
    text: string;
  }): Promise<BlueskyCreateRecordResponse> {
    const response = await this.fetchImpl(
      `${input.serviceUrl}/xrpc/com.atproto.repo.createRecord`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${input.accessJwt}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          repo: input.did,
          collection: "app.bsky.feed.post",
          record: {
            $type: "app.bsky.feed.post",
            text: input.text,
            createdAt: new Date().toISOString(),
          },
        }),
      },
    );

    if (!response.ok) {
      throw new Error(
        `Bluesky post creation failed with status ${response.status}.`,
      );
    }

    return (await response.json()) as BlueskyCreateRecordResponse;
  }
}

function normalizeBaseUrl(value: string): string {
  return value.trim().replace(/\/+$/, "");
}
