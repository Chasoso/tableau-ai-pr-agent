import { getConfig } from "../config";
import { logWarn } from "../logging";
import type { TechPlayPreviewResponse } from "../types/techplay";

export class TechPlayService {
  async previewTechPlayEvent(input: {
    techplayUrl: string;
  }): Promise<TechPlayPreviewResponse> {
    const url = validateTechPlayUrl(input.techplayUrl);
    if (getConfig().demoMode) {
      return buildFallbackPreview(url.toString());
    }

    try {
      const response = await fetch(url.toString(), {
        headers: {
          Accept: "text/html,application/xhtml+xml",
        },
      });

      if (!response.ok) {
        logWarn("techplay.preview.fallback", {
          techplayUrl: url.toString(),
          status: response.status,
          reason: response.status === 404 ? "not_found" : "non_success_status",
        });
        return buildFallbackPreview(url.toString());
      }

      const html = await response.text();
      const extracted = extractPreviewFromHtml(html);

      return {
        techplayUrl: url.toString(),
        eventName: extracted.eventName,
        eventDateText: extracted.eventDateText,
        summary: extracted.summary,
        sourceTitle: extracted.sourceTitle,
        sourceDescription: extracted.sourceDescription,
        extractedFrom: extracted.extractedFrom,
      };
    } catch (error) {
      logWarn("techplay.preview.fallback", {
        techplayUrl: url.toString(),
        reason: "request_failed",
        errorName: error instanceof Error ? error.name : undefined,
      });
      return buildFallbackPreview(url.toString());
    }
  }
}

function validateTechPlayUrl(input: string): URL {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new Error("techplayUrl must be a valid URL.");
  }

  const hostname = url.hostname.toLowerCase();
  if (hostname !== "techplay.jp" && !hostname.endsWith(".techplay.jp")) {
    throw new Error("TechPlay URL must point to techplay.jp.");
  }

  return url;
}

function buildFallbackPreview(techplayUrl: string): TechPlayPreviewResponse {
  return {
    techplayUrl,
    eventName: "TechPlay demo event",
    eventDateText: "Demo schedule",
    summary:
      "Demo fallback preview used because the TechPlay page could not be loaded.",
    sourceTitle: "TechPlay demo event",
    sourceDescription:
      "This preview is a deterministic fallback for demo stability.",
    extractedFrom: "text",
  };
}

function extractPreviewFromHtml(
  html: string,
): Omit<TechPlayPreviewResponse, "techplayUrl"> {
  const jsonLdEvent = extractJsonLdEvent(html);
  if (jsonLdEvent) {
    const eventName = coalesceString(jsonLdEvent.name) ?? "TechPlay event";
    const description = coalesceString(jsonLdEvent.description);
    const startDate = coalesceString(jsonLdEvent.startDate);
    const endDate = coalesceString(jsonLdEvent.endDate);

    return {
      eventName,
      eventDateText: formatDateText(startDate, endDate),
      summary:
        description ??
        "TechPlay event details were loaded, but the description was not present.",
      sourceTitle: coalesceString(jsonLdEvent.name),
      sourceDescription: description,
      extractedFrom: "jsonld",
    };
  }

  const metaTitle =
    extractMetaContent(html, "og:title") ??
    extractMetaContent(html, "twitter:title") ??
    extractTitleTag(html);
  const metaDescription =
    extractMetaContent(html, "og:description") ??
    extractMetaContent(html, "twitter:description") ??
    extractMetaContent(html, "description");
  const plainText = htmlToPlainText(html);
  const eventName = cleanEventName(
    metaTitle ?? findTitleFromPlainText(plainText) ?? "TechPlay event",
  );
  const eventDateText = findEventDateText(plainText);
  const summary =
    metaDescription ??
    extractOverviewFromPlainText(plainText) ??
    "TechPlay event details were loaded, but the summary was not present.";

  return {
    eventName,
    eventDateText,
    summary,
    sourceTitle: metaTitle ?? undefined,
    sourceDescription: metaDescription ?? undefined,
    extractedFrom: metaDescription ? "meta" : "text",
  };
}

function extractJsonLdEvent(html: string): Record<string, unknown> | undefined {
  const scripts = [
    ...html.matchAll(
      /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi,
    ),
  ];
  for (const script of scripts) {
    const raw = normalizeWhitespace(decodeHtmlEntities(script[1] ?? ""));
    if (!raw) {
      continue;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      continue;
    }

    const event = findJsonLdEvent(parsed);
    if (event) {
      return event;
    }
  }

  return undefined;
}

function findJsonLdEvent(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findJsonLdEvent(item);
      if (found) {
        return found;
      }
    }
    return undefined;
  }

  const record = value as Record<string, unknown>;
  const type = record["@type"];
  if (
    type === "Event" ||
    (Array.isArray(type) && type.some((entry) => entry === "Event"))
  ) {
    return record;
  }

  if (record["@graph"]) {
    return findJsonLdEvent(record["@graph"]);
  }

  for (const child of Object.values(record)) {
    const found = findJsonLdEvent(child);
    if (found) {
      return found;
    }
  }

  return undefined;
}

function extractMetaContent(html: string, name: string): string | undefined {
  const patterns = [
    new RegExp(
      `<meta[^>]+property=["']${escapeRegExp(name)}["'][^>]+content=["']([^"']+)["'][^>]*>`,
      "i",
    ),
    new RegExp(
      `<meta[^>]+name=["']${escapeRegExp(name)}["'][^>]+content=["']([^"']+)["'][^>]*>`,
      "i",
    ),
  ];

  for (const pattern of patterns) {
    const match = html.match(pattern);
    if (match?.[1]) {
      return cleanText(match[1]);
    }
  }

  return undefined;
}

function extractTitleTag(html: string): string | undefined {
  const match = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (!match?.[1]) {
    return undefined;
  }

  return cleanText(match[1]);
}

function htmlToPlainText(html: string): string {
  const withoutNoise = html
    .replace(/<script[\s\S]*?<\/script>/gi, "\n")
    .replace(/<style[\s\S]*?<\/style>/gi, "\n")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, "\n")
    .replace(/<(br|\/p|\/div|\/li|\/h[1-6])[^>]*>/gi, "\n")
    .replace(/<li[^>]*>/gi, "\n- ")
    .replace(/<[^>]+>/g, " ");

  return normalizeWhitespace(decodeHtmlEntities(withoutNoise));
}

function findTitleFromPlainText(plainText: string): string | undefined {
  const lines = splitLines(plainText);
  return lines.find((line) => line && !isNavigationLine(line));
}

function findEventDateText(plainText: string): string | undefined {
  const lines = splitLines(plainText);
  const directMatch = lines.find((line) =>
    /\d{4}[\/-]\d{2}[\/-]\d{2}.*(〜|~)/.test(line),
  );
  if (directMatch) {
    return directMatch;
  }

  const dateLine = lines.find((line) => /\d{4}[\/-]\d{2}[\/-]\d{2}/.test(line));
  return dateLine;
}

function extractOverviewFromPlainText(plainText: string): string | undefined {
  const lines = splitLines(plainText);
  const overviewIndex = lines.findIndex((line) =>
    /^(概要|イベント内容)$/i.test(line),
  );
  if (overviewIndex < 0) {
    return undefined;
  }

  const collected: string[] = [];
  for (let index = overviewIndex + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line) {
      if (collected.length > 0) {
        break;
      }
      continue;
    }

    if (isSectionHeading(line)) {
      break;
    }

    collected.push(line);
    if (collected.length >= 5) {
      break;
    }
  }

  return collected.length ? collected.join(" ") : undefined;
}

function isSectionHeading(line: string): boolean {
  return /^(基本情報|タイムスケジュール|参加対象|参加にあたっての注意事項|開催グループ|関連するイベント|お問い合わせ)$/i.test(
    line,
  );
}

function splitLines(value: string): string[] {
  return value
    .split(/\r?\n/)
    .map((line) => cleanText(line))
    .filter(Boolean);
}

function cleanEventName(value: string): string {
  return cleanText(
    value.replace(/\s*-\s*TECH PLAY$/i, "").replace(/\s*-\s*TECHPLAY$/i, ""),
  );
}

function cleanText(value: string): string {
  return normalizeWhitespace(decodeHtmlEntities(value)).trim();
}

function coalesceString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim()
    ? cleanText(value)
    : undefined;
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function decodeHtmlEntities(value: string): string {
  const namedEntities: Record<string, string> = {
    amp: "&",
    apos: "'",
    gt: ">",
    lt: "<",
    nbsp: " ",
    quot: '"',
  };

  return value
    .replace(/&#(\d+);/g, (_, decimal: string) =>
      String.fromCodePoint(Number(decimal)),
    )
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) =>
      String.fromCodePoint(Number.parseInt(hex, 16)),
    )
    .replace(
      /&([a-z]+);/gi,
      (_, name: string) => namedEntities[name] ?? `&${name};`,
    );
}

function formatDateText(start?: string, end?: string): string | undefined {
  if (!start) {
    return undefined;
  }

  const startDate = new Date(start);
  if (Number.isNaN(startDate.getTime())) {
    return cleanText(start);
  }

  const formatter = new Intl.DateTimeFormat("ja-JP", {
    dateStyle: "medium",
    timeStyle: "short",
  });

  if (end) {
    const endDate = new Date(end);
    if (!Number.isNaN(endDate.getTime())) {
      return `${formatter.format(startDate)} - ${formatter.format(endDate)}`;
    }
  }

  return formatter.format(startDate);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isNavigationLine(value: string): boolean {
  return /^(TOP|イベント|マガジン|動画|グループ|ログイン|新規会員登録)$/i.test(
    value,
  );
}
