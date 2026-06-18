export type HashtagSource =
  | "web_page"
  | "event_description"
  | "user_input"
  | "community_default"
  | "content_inference"
  | "fallback";

export type HashtagCandidate = {
  tag: string;
  source: HashtagSource;
  confidence: number;
  reason?: string;
};

export type HashtagChannel = "x" | "linkedin" | "slack" | "notion" | "email";

export type HashtagQualityIssue = {
  code:
    | "explicit_hashtag_not_used"
    | "unsupported_platform_tag"
    | "machine_generated_hashtag"
    | "too_many_hashtags"
    | "duplicate_hashtag"
    | "hashtag_not_needed_for_channel";
  severity: "error" | "warning";
  message: string;
  matchedTag?: string;
};

const HASHTAG_PATTERN =
  /(?<![\p{L}\p{N}_@%/-])#[\p{L}\p{N}_\u3040-\u309F\u30A0-\u30FF\u3400-\u9FFF\uFF66-\uFF9D\u30FC]+/gu;

const PLATFORM_TAGS = new Set([
  "#techplay",
  "#connpass",
  "#peatix",
  "#doorkeeper",
]);

const COMMUNITY_DEFAULT_TAGS = ["#ほくたぐ", "#HokuTUG", "#Tableau"];
const DEFAULT_ORDER: HashtagSource[] = [
  "web_page",
  "event_description",
  "user_input",
  "community_default",
  "content_inference",
  "fallback",
];

const CHANNEL_LIMITS: Record<HashtagChannel, { max: number; min: number }> = {
  x: { max: 4, min: 2 },
  linkedin: { max: 5, min: 3 },
  slack: { max: 0, min: 0 },
  notion: { max: 0, min: 0 },
  email: { max: 0, min: 0 },
};

export function buildHashtagCandidates(input: {
  webPageTexts?: string[];
  eventDescriptionTexts?: string[];
  userInputTexts?: string[];
  explicitHashtags?: string[];
  eventName?: string;
  eventUrl?: string;
  extraTexts?: string[];
}): HashtagCandidate[] {
  const candidates: HashtagCandidate[] = [];

  for (const text of input.webPageTexts ?? []) {
    candidates.push(
      ...extractCandidatesFromText(
        text,
        "web_page",
        0.98,
        "Detected from web page text",
      ),
    );
  }

  for (const text of input.eventDescriptionTexts ?? []) {
    candidates.push(
      ...extractCandidatesFromText(
        text,
        "event_description",
        0.9,
        "Detected from event description",
      ),
    );
  }

  for (const text of input.userInputTexts ?? []) {
    candidates.push(
      ...extractCandidatesFromText(
        text,
        "user_input",
        0.8,
        "Detected from user input",
      ),
    );
  }

  for (const tag of input.explicitHashtags ?? []) {
    const normalized = normalizeHashtag(tag);
    if (!normalized) {
      continue;
    }
    candidates.push({
      tag: normalized,
      source: "web_page",
      confidence: 0.99,
      reason: "Explicit hashtag provided by upstream event metadata",
    });
  }

  const inferenceSourceText = [
    input.eventName,
    input.eventUrl,
    ...(input.extraTexts ?? []),
  ]
    .filter((value): value is string => Boolean(value && value.trim()))
    .join(" ");

  candidates.push(
    ...inferGeneralHashtags(inferenceSourceText).map((tag) => ({
      tag,
      source: "content_inference" as const,
      confidence: 0.45,
      reason: "Inferred from event name / supporting text",
    })),
  );

  candidates.push(
    ...COMMUNITY_DEFAULT_TAGS.map((tag) => ({
      tag,
      source: "community_default" as const,
      confidence: 0.72,
      reason: "Default community hashtag",
    })),
  );

  if (candidates.length === 0) {
    candidates.push({
      tag: "#Tableau",
      source: "fallback",
      confidence: 0.2,
      reason: "Fallback tag",
    });
  }

  return dedupeCandidates(candidates);
}

export function selectHashtags(input: {
  candidates: HashtagCandidate[];
  channel: HashtagChannel;
}): string[] {
  const limits = CHANNEL_LIMITS[input.channel];
  if (limits.max === 0) {
    return [];
  }

  const ordered = sortCandidates(input.candidates);
  const explicit = ordered.filter(
    (candidate) =>
      candidate.source === "web_page" ||
      candidate.source === "event_description" ||
      candidate.source === "user_input",
  );
  const fallbackPool = ordered.filter(
    (candidate) =>
      candidate.source === "community_default" ||
      candidate.source === "content_inference" ||
      candidate.source === "fallback",
  );

  const selected: HashtagCandidate[] = [];
  const seen = new Set<string>();

  const pushCandidate = (candidate: HashtagCandidate) => {
    const normalized = normalizeHashtag(candidate.tag);
    if (!normalized || seen.has(canonicalHashtagKey(normalized))) {
      return;
    }
    if (
      isUnsupportedPlatformTag(normalized) ||
      isMachineGeneratedTag(normalized)
    ) {
      return;
    }
    selected.push({ ...candidate, tag: normalized });
    seen.add(canonicalHashtagKey(normalized));
  };

  for (const candidate of explicit) {
    pushCandidate(candidate);
  }

  const targetCount =
    explicit.length > 0
      ? Math.min(limits.max, Math.max(limits.min, selected.length))
      : Math.min(limits.max, Math.max(3, limits.min));

  for (const candidate of fallbackPool) {
    if (selected.length >= targetCount || selected.length >= limits.max) {
      break;
    }
    pushCandidate(candidate);
  }

  if (selected.length === 0) {
    for (const candidate of ordered) {
      if (selected.length >= limits.min || selected.length >= limits.max) {
        break;
      }
      pushCandidate(candidate);
    }
  }

  return selected.map((candidate) => candidate.tag);
}

export function buildHashtagLine(input: {
  candidates: HashtagCandidate[];
  channel: HashtagChannel;
}): string {
  return selectHashtags(input).join(" ");
}

export function extractExplicitHashtagsFromText(
  text: string | undefined,
): string[] {
  return extractCandidatesFromText(
    text,
    "web_page",
    0.98,
    "Detected from raw text",
  ).map((candidate) => candidate.tag);
}

export function buildHashtagQualityIssues(input: {
  hashtags: string[];
  candidates: HashtagCandidate[];
  channel: HashtagChannel;
}): HashtagQualityIssue[] {
  const issues: HashtagQualityIssue[] = [];
  const limits = CHANNEL_LIMITS[input.channel];
  const normalized = input.hashtags
    .map((tag) => normalizeHashtag(tag))
    .filter((tag): tag is string => Boolean(tag));

  if (limits.max === 0 && normalized.length > 0) {
    issues.push({
      code: "hashtag_not_needed_for_channel",
      severity: "warning",
      message: `Hashtags are usually unnecessary for ${input.channel}.`,
      matchedTag: normalized[0],
    });
  }

  if (normalized.length > limits.max) {
    issues.push({
      code: "too_many_hashtags",
      severity: "warning",
      message: `Too many hashtags for ${input.channel}.`,
      matchedTag: normalized[limits.max],
    });
  }

  const seen = new Set<string>();
  for (const tag of normalized) {
    const key = canonicalHashtagKey(tag);
    if (seen.has(key)) {
      issues.push({
        code: "duplicate_hashtag",
        severity: "warning",
        message: `Duplicate hashtag: ${tag}`,
        matchedTag: tag,
      });
    }
    seen.add(key);
  }

  for (const candidate of input.candidates) {
    if (isUnsupportedPlatformTag(candidate.tag)) {
      issues.push({
        code: "unsupported_platform_tag",
        severity: "error",
        message: `Unsupported platform tag: ${candidate.tag}`,
        matchedTag: candidate.tag,
      });
    }

    if (isMachineGeneratedTag(candidate.tag)) {
      issues.push({
        code: "machine_generated_hashtag",
        severity: "error",
        message: `Machine-generated hashtag: ${candidate.tag}`,
        matchedTag: candidate.tag,
      });
    }
  }

  const explicit = input.candidates.filter(
    (candidate) =>
      candidate.source === "web_page" ||
      candidate.source === "event_description" ||
      candidate.source === "user_input",
  );
  if (explicit.length > 0 && explicit.length <= limits.max) {
    const selectedKeys = new Set(
      normalized.map((tag) => canonicalHashtagKey(tag)),
    );
    const missing = explicit
      .map((candidate) => normalizeHashtag(candidate.tag))
      .filter((tag): tag is string => Boolean(tag))
      .filter((tag) => !selectedKeys.has(canonicalHashtagKey(tag)));
    if (missing.length > 0) {
      issues.push({
        code: "explicit_hashtag_not_used",
        severity: "error",
        message: `Explicit hashtags were available but not used: ${missing.join(" ")}`,
        matchedTag: missing[0],
      });
    }
  }

  return issues;
}

export function formatHashtagLine(input: {
  candidates: HashtagCandidate[];
  channel: HashtagChannel;
}): string {
  return buildHashtagLine(input);
}

function extractCandidatesFromText(
  text: string | undefined,
  source: HashtagSource,
  confidence: number,
  reason: string,
): HashtagCandidate[] {
  if (!text?.trim()) {
    return [];
  }

  const candidates: HashtagCandidate[] = [];
  for (const match of text.matchAll(HASHTAG_PATTERN)) {
    const normalized = normalizeHashtag(match[0]);
    if (!normalized) {
      continue;
    }
    candidates.push({
      tag: normalized,
      source,
      confidence,
      reason,
    });
  }

  return candidates;
}

function inferGeneralHashtags(text: string | undefined): string[] {
  if (!text?.trim()) {
    return [];
  }

  const lowered = text.toLowerCase();
  const tags = new Set<string>();
  if (lowered.includes("tableau")) {
    tags.add("#Tableau");
  }
  if (/\bai\b/i.test(text) || /AI/u.test(text)) {
    tags.add("#AI");
  }
  if (/community|コミュニティ|ユーザー会/i.test(text)) {
    tags.add("#Community");
  }
  if (/datafam/i.test(text)) {
    tags.add("#DataFam");
  }

  return [...tags];
}

function dedupeCandidates(candidates: HashtagCandidate[]): HashtagCandidate[] {
  const seen = new Set<string>();
  const result: HashtagCandidate[] = [];
  for (const candidate of sortCandidates(candidates)) {
    const normalized = normalizeHashtag(candidate.tag);
    if (!normalized) {
      continue;
    }
    const key = canonicalHashtagKey(normalized);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push({ ...candidate, tag: normalized });
  }
  return result;
}

function sortCandidates(candidates: HashtagCandidate[]): HashtagCandidate[] {
  return [...candidates].sort((a, b) => {
    const sourceDiff =
      DEFAULT_ORDER.indexOf(a.source) - DEFAULT_ORDER.indexOf(b.source);
    if (sourceDiff !== 0) {
      return sourceDiff;
    }
    if (b.confidence !== a.confidence) {
      return b.confidence - a.confidence;
    }
    return 0;
  });
}

function normalizeHashtag(value: string | undefined): string | undefined {
  if (!value?.trim()) {
    return undefined;
  }

  let tag = value.trim().replace(/^＃/u, "#");
  if (!tag.startsWith("#")) {
    tag = `#${tag}`;
  }

  tag = tag
    .replace(/[。、,.!?;:，．）」』】\]]+$/u, "")
    .replace(/^[#＃\s]+/u, "#")
    .trim();

  if (tag.length < 2) {
    return undefined;
  }

  if (/\s/u.test(tag) || /[@/\\]|:\/\//u.test(tag)) {
    return undefined;
  }

  const body = tag.slice(1);
  if (!body) {
    return undefined;
  }

  if (
    !/^[\p{L}\p{N}_\u3040-\u309F\u30A0-\u30FF\u3400-\u9FFF\uFF66-\uFF9D\u30FC]+$/u.test(
      body,
    )
  ) {
    return undefined;
  }

  return tag;
}

function canonicalHashtagKey(tag: string): string {
  return tag.toLocaleLowerCase("en-US");
}

function isUnsupportedPlatformTag(tag: string): boolean {
  return PLATFORM_TAGS.has(tag.toLowerCase());
}

function isMachineGeneratedTag(tag: string): boolean {
  return (
    /^#\d{4,}$/.test(tag) ||
    /^#\d{4,}tableau$/i.test(tag) ||
    /^#tableau\d+$/i.test(tag)
  );
}
