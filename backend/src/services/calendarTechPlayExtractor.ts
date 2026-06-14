export type CalendarTechPlaySource = {
  summary?: string;
  description?: string;
  location?: string;
  htmlLink?: string;
  hangoutLink?: string;
  creator?: {
    displayName?: string;
    email?: string;
    self?: boolean;
  };
  organizer?: {
    displayName?: string;
    email?: string;
    self?: boolean;
  };
  attachments?: Array<{
    fileUrl?: string;
    title?: string;
    url?: string;
  }>;
  conferenceData?: {
    entryPoints?: Array<{
      uri?: string;
    }>;
  };
};

export function extractTechPlayUrlsFromCalendarEvent(
  event: CalendarTechPlaySource,
): string[] {
  const sources = [
    event.summary,
    event.description,
    event.location,
    event.htmlLink,
    event.hangoutLink,
    event.conferenceData?.entryPoints?.map((entry) => entry.uri).join(" "),
    event.attachments
      ?.map((attachment) => attachment.fileUrl ?? attachment.url ?? "")
      .join(" "),
  ].filter((value): value is string => Boolean(value));

  const urls = new Set<string>();
  for (const source of sources) {
    for (const match of source.matchAll(/https?:\/\/[^\s"'<>]+/gi)) {
      const url = normalizeTechPlayUrl(match[0]);
      if (url) {
        urls.add(url);
      }
    }
  }

  return Array.from(urls).sort((left, right) => {
    const leftPriority = techPlayUrlPriority(left);
    const rightPriority = techPlayUrlPriority(right);
    if (leftPriority !== rightPriority) {
      return leftPriority - rightPriority;
    }
    return left.localeCompare(right);
  });
}

function normalizeTechPlayUrl(url: string): string | undefined {
  try {
    const parsed = new URL(url);
    const hostname = parsed.hostname.toLowerCase();
    if (hostname !== "techplay.jp" && !hostname.endsWith(".techplay.jp")) {
      return undefined;
    }

    return parsed.toString();
  } catch {
    return undefined;
  }
}

function techPlayUrlPriority(url: string): number {
  if (/\/event\//i.test(url)) {
    return 0;
  }

  if (/\/community\//i.test(url)) {
    return 1;
  }

  return 2;
}
