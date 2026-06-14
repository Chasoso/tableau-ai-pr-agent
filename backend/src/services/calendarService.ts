import { getConfig } from "../config";
import { logDebug, logInfo, logWarn } from "../logging";
import { TechPlayService } from "./techplayService";
import type {
  CalendarEventCandidate,
  CalendarLookupStatus,
  CalendarResolveRequest,
  CalendarResolveResponse,
  TechPlayFetchStatus,
} from "../types/calendar";
import type { ActionRunPostType as ActionRunPostTypeFromActionRun } from "../types/actionRun";

type MockCalendarEvent = Omit<
  CalendarEventCandidate,
  "score" | "scoreReasons" | "techplayUrls"
>;

const techPlayService = new TechPlayService();

export class CalendarService {
  async resolveEventContextFromCalendar(
    input: CalendarResolveRequest,
  ): Promise<CalendarResolveResponse> {
    const config = getConfig();
    const now = input.now ? new Date(input.now) : new Date();
    const manualTechPlayUrl = input.manualTechPlayUrl?.trim() || undefined;
    const venuePhoto = input.venuePhoto ?? null;
    const preferredEventId = input.preferredEventId?.trim() || undefined;

    logInfo("calendar.resolve.started", {
      postType: input.postType,
      dashboardName: input.dashboardContext.dashboardName,
      hasVenuePhoto: Boolean(venuePhoto),
      manualTechPlayMode: Boolean(manualTechPlayUrl),
      provider: config.calendar.provider,
    });

    if (config.calendar.provider !== "mock") {
      logWarn("calendar.resolve.provider_fallback", {
        provider: config.calendar.provider,
      });
    }

    const searchWindowLabel = getSearchWindowLabel(input.postType);
    logDebug("calendar.search.started", {
      postType: input.postType,
      searchWindowLabel,
      now: now.toISOString(),
    });

    const rawEvents = createMockCalendarEvents(now);
    const candidates = rawEvents
      .map((event) =>
        scoreCalendarEvent(event, input.postType, now, venuePhoto),
      )
      .sort((left, right) => right.score - left.score);

    logInfo("calendar.search.completed", {
      candidateCount: candidates.length,
      searchWindowLabel,
      topScores: candidates.slice(0, 3).map((candidate) => ({
        eventId: candidate.eventId,
        score: candidate.score,
      })),
    });

    if (candidates.length === 0 && !manualTechPlayUrl) {
      return this.buildNotFoundResponse({
        searchWindowLabel,
        manualTechPlayUrl,
        notes: ["No calendar candidates were available."],
      });
    }

    if (candidates.length === 0 && manualTechPlayUrl) {
      logWarn("calendar.search.no_candidates_manual_fallback", {
        searchWindowLabel,
        techplayUrlHost: safeHostname(manualTechPlayUrl),
      });
    }

    const selectedEvent =
      selectBestCalendarEvent(candidates, preferredEventId) ?? candidates[0];
    const selectedTechPlayUrl =
      selectedEvent?.techplayUrls[0] ?? manualTechPlayUrl;

    if (!selectedEvent && !selectedTechPlayUrl) {
      return this.buildNotFoundResponse({
        searchWindowLabel,
        manualTechPlayUrl,
        notes: ["No selected event and no TechPlay URL were available."],
      });
    }

    const selectedCandidates = candidates.slice(0, 3);
    const topScore = selectedCandidates[0]?.score ?? 0;
    const runnerUpScore = selectedCandidates[1]?.score ?? 0;
    const hasCloseCompetition =
      selectedCandidates.length > 1 &&
      topScore - runnerUpScore <= 4 &&
      !preferredEventId;

    let techPlayFetchStatus: TechPlayFetchStatus = "idle";
    let techplayPreview;
    const warnings: string[] = [];

    if (!selectedTechPlayUrl) {
      techPlayFetchStatus = "not_found";
      warnings.push(
        "TechPlay URL could not be detected from the calendar event.",
      );
    } else {
      techPlayFetchStatus = "fetching";
      logDebug("calendar.techplay.fetch.started", {
        eventId: selectedEvent?.eventId,
        techplayUrlHost: safeHostname(selectedTechPlayUrl),
      });
      try {
        techplayPreview = await techPlayService.previewTechPlayEvent({
          techplayUrl: selectedTechPlayUrl,
        });
        techPlayFetchStatus = "fetched";
        logInfo("calendar.techplay.fetch.completed", {
          eventId: selectedEvent?.eventId,
          techplayUrlHost: safeHostname(selectedTechPlayUrl),
          extractedFrom: techplayPreview.extractedFrom,
        });
      } catch (error) {
        techPlayFetchStatus = "error";
        warnings.push(
          error instanceof Error
            ? error.message
            : "Failed to load TechPlay event details.",
        );
        logWarn("calendar.techplay.fetch.failed", {
          eventId: selectedEvent?.eventId,
          techplayUrlHost: safeHostname(selectedTechPlayUrl),
        });
      }
    }

    const manualTechPlayMode =
      !selectedEvent ||
      !selectedTechPlayUrl ||
      techPlayFetchStatus !== "fetched";

    const calendarLookupStatus: CalendarLookupStatus =
      candidates.length === 0
        ? "not_found"
        : hasCloseCompetition
          ? "multiple_candidates"
          : "found";

    if (hasCloseCompetition) {
      warnings.push(
        "Multiple calendar candidates were found; the highest-scoring one was selected.",
      );
    }

    if (input.venuePhoto) {
      warnings.push(
        "Venue photo added; checking calendar context automatically.",
      );
    }

    const resolvedEventName =
      selectedEvent?.summary ?? techplayPreview?.eventName ?? undefined;

    logInfo("calendar.resolve.completed", {
      postType: input.postType,
      calendarLookupStatus,
      techPlayFetchStatus,
      selectedEventId: selectedEvent?.eventId,
      resolvedEventName,
      hasManualTechPlayUrl: Boolean(manualTechPlayUrl),
      candidateCount: candidates.length,
    });

    return {
      provider: "mock",
      calendarLookupStatus,
      techPlayFetchStatus,
      manualTechPlayMode,
      searchWindowLabel,
      selectedEvent,
      candidates,
      detectedTechPlayUrl: selectedTechPlayUrl,
      techplayPreview,
      resolvedEventName,
      warnings: Array.from(new Set(warnings)),
      notes: [
        `Search window: ${searchWindowLabel}`,
        `Calendar candidates: ${candidates.length}`,
        `Selected event: ${selectedEvent?.summary ?? "none"}`,
      ],
    };
  }

  private buildNotFoundResponse(input: {
    searchWindowLabel: string;
    manualTechPlayUrl?: string;
    notes: string[];
  }): CalendarResolveResponse {
    return {
      provider: "mock",
      calendarLookupStatus: "not_found",
      techPlayFetchStatus: "not_found",
      manualTechPlayMode: true,
      searchWindowLabel: input.searchWindowLabel,
      candidates: [],
      detectedTechPlayUrl: input.manualTechPlayUrl,
      warnings: [
        "Google Calendar event could not be found automatically.",
        ...(input.manualTechPlayUrl
          ? []
          : ["Please use the manual TechPlay URL fallback."]),
      ],
      notes: input.notes,
    };
  }
}

export function searchCalendarEvents(
  postType: ActionRunPostTypeFromActionRun,
  now: Date,
): MockCalendarEvent[] {
  return createMockCalendarEvents(now)
    .map((event) => ({ ...event }))
    .sort((left, right) => {
      const leftScore = scoreCalendarEvent(left, postType, now).score;
      const rightScore = scoreCalendarEvent(right, postType, now).score;
      return rightScore - leftScore;
    });
}

export function scoreCalendarEvent(
  event: MockCalendarEvent,
  postType: ActionRunPostTypeFromActionRun,
  now: Date,
  venuePhoto?: { fileName: string } | null,
): CalendarEventCandidate {
  const techplayUrls = extractTechPlayUrlsFromCalendarEvent(event);
  const scoreReasons: string[] = [];
  let score = 0;

  const start = new Date(event.start);
  const end = new Date(event.end);
  const minutesToStart = differenceInMinutes(start, now);
  const minutesToEnd = differenceInMinutes(end, now);
  const containsTableau = /Tableau/i.test(
    `${event.summary} ${event.description ?? ""}`,
  );
  const containsUserGroup = /User Group/i.test(
    `${event.summary} ${event.description ?? ""}`,
  );
  const hasLocation = Boolean(event.location?.trim());
  const isCurrent = start <= now && now <= end;
  const isToday =
    start.toDateString() === now.toDateString() ||
    end.toDateString() === now.toDateString();

  if (techplayUrls.length > 0) {
    score += 30;
    scoreReasons.push("TechPlay URL detected.");
  }
  if (containsTableau) {
    score += 18;
    scoreReasons.push("Tableau keyword detected.");
  }
  if (containsUserGroup) {
    score += 18;
    scoreReasons.push("User Group keyword detected.");
  }
  if (hasLocation) {
    score += 8;
    scoreReasons.push("Location is present.");
  }
  if (isCurrent) {
    score += 40;
    scoreReasons.push("Event is currently in progress.");
  } else if (Math.abs(minutesToStart) <= 60 || Math.abs(minutesToEnd) <= 60) {
    score += 20;
    scoreReasons.push("Event is close to the current time.");
  }

  switch (postType) {
    case "開催中の実況":
      if (isCurrent) {
        score += 35;
        scoreReasons.push("Matches live event coverage.");
      }
      if (venuePhoto) {
        score += 12;
        scoreReasons.push("Venue photo makes live coverage more likely.");
      }
      break;
    case "開催直前リマインド":
      if (minutesToStart >= -30 && minutesToStart <= 1440) {
        score += 25;
        scoreReasons.push("Matches a near-term reminder window.");
      }
      break;
    case "事前告知":
      if (minutesToStart >= 0) {
        score += 25;
        scoreReasons.push("Matches a future announcement window.");
      }
      break;
    case "開催後のお礼・レポート":
      if (minutesToEnd <= 0 && minutesToEnd >= -1440) {
        score += 25;
        scoreReasons.push("Matches a recent past event window.");
      }
      break;
    case "次回参加の呼びかけ":
      if (minutesToStart >= 0) {
        score += 18;
        scoreReasons.push("Matches a next-event invitation window.");
      }
      break;
    default:
      break;
  }

  if (isToday) {
    score += 8;
    scoreReasons.push("Event occurs today.");
  }

  return {
    ...event,
    techplayUrls,
    score,
    scoreReasons,
  };
}

export function selectBestCalendarEvent(
  events: CalendarEventCandidate[],
  preferredEventId?: string,
): CalendarEventCandidate | undefined {
  if (preferredEventId) {
    const preferred = events.find(
      (event) => event.eventId === preferredEventId,
    );
    if (preferred) {
      return preferred;
    }
  }

  return events[0];
}

export function extractTechPlayUrlsFromCalendarEvent(
  event: MockCalendarEvent,
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

function createMockCalendarEvents(now: Date): MockCalendarEvent[] {
  const base = new Date(now);
  const currentStart = new Date(base.getTime() - 30 * 60 * 1000);
  const currentEnd = new Date(base.getTime() + 90 * 60 * 1000);
  const nearStart = new Date(base.getTime() + 4 * 60 * 60 * 1000);
  const nearEnd = new Date(base.getTime() + 6 * 60 * 60 * 1000);
  const tomorrowStart = new Date(base.getTime() + 24 * 60 * 60 * 1000);
  const tomorrowEnd = new Date(base.getTime() + 26 * 60 * 60 * 1000);
  const yesterdayStart = new Date(base.getTime() - 26 * 60 * 60 * 1000);
  const yesterdayEnd = new Date(base.getTime() - 24 * 60 * 60 * 1000);

  return [
    {
      eventId: "mock-current-tableau-user-group",
      summary: "Tableau User Group Tokyo 2026",
      description:
        "Live session with photos and notes. TechPlay: https://techplay.jp/event/example",
      location: "Tokyo",
      start: currentStart.toISOString(),
      end: currentEnd.toISOString(),
      htmlLink:
        "https://calendar.google.com/calendar/u/0/r/eventedit/mock-current",
      hangoutLink: "https://meet.google.com/mock-current",
      attachments: [
        {
          title: "TechPlay event page",
          fileUrl: "https://techplay.jp/event/example",
        },
      ],
      creator: { displayName: "Demo Creator", email: "creator@example.com" },
      organizer: {
        displayName: "Demo Organizer",
        email: "organizer@example.com",
      },
    },
    {
      eventId: "mock-future-community",
      summary: "Tableau Community Night 2026",
      description:
        "Community talk and networking. https://techplay.jp/community/12345",
      location: "Osaka",
      start: nearStart.toISOString(),
      end: nearEnd.toISOString(),
      htmlLink:
        "https://calendar.google.com/calendar/u/0/r/eventedit/mock-future",
      attachments: [
        {
          title: "Community event",
          fileUrl: "https://techplay.jp/community/12345",
        },
      ],
      creator: { displayName: "Community Bot", email: "bot@example.com" },
    },
    {
      eventId: "mock-tomorrow-reminder",
      summary: "Tableau Hands-on Workshop",
      description:
        "Workshop details are available at https://techplay.jp/event/workshop-2026",
      location: "Nagoya",
      start: tomorrowStart.toISOString(),
      end: tomorrowEnd.toISOString(),
      htmlLink:
        "https://calendar.google.com/calendar/u/0/r/eventedit/mock-reminder",
      attachments: [
        {
          title: "Workshop event page",
          fileUrl: "https://techplay.jp/event/workshop-2026",
        },
      ],
      organizer: { displayName: "Workshop Organizer" },
    },
    {
      eventId: "mock-yesterday-report",
      summary: "Tableau User Group After Party",
      description:
        "Thanks for joining. TechPlay https://techplay.jp/event/after-party",
      location: "Tokyo",
      start: yesterdayStart.toISOString(),
      end: yesterdayEnd.toISOString(),
      htmlLink:
        "https://calendar.google.com/calendar/u/0/r/eventedit/mock-report",
      attachments: [
        {
          title: "After party",
          fileUrl: "https://techplay.jp/event/after-party",
        },
      ],
      organizer: { displayName: "After Party Organizer" },
    },
  ];
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

function safeHostname(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return "techplay.jp";
  }
}

function getSearchWindowLabel(
  postType: ActionRunPostTypeFromActionRun,
): string {
  switch (postType) {
    case "事前告知":
      return "from today forward";
    case "開催直前リマインド":
      return "today or tomorrow";
    case "開催中の実況":
      return "today and around now";
    case "開催後のお礼・レポート":
      return "recent past events";
    case "次回参加の呼びかけ":
      return "next future events";
    default:
      return "default";
  }
}

function differenceInMinutes(left: Date, right: Date): number {
  return Math.round((left.getTime() - right.getTime()) / (60 * 1000));
}
