import { getConfig } from "../config";
import { logDebug, logInfo, logWarn } from "../logging";
import { TechPlayService } from "./techplayService";
import { GoogleCalendarService } from "./googleCalendarService";
import {
  getSearchWindowLabel,
  scoreCalendarEvent,
  selectBestCalendarEvent,
} from "./calendarScoring";
import type {
  CalendarEventCandidate,
  CalendarLookupStatus,
  CalendarResolveRequest,
  CalendarResolveResponse,
  TechPlayFetchStatus,
} from "../types/calendar";
import type { ActionRunPostType as ActionRunPostTypeFromActionRun } from "../types/actionRun";
import type { CalendarTechPlaySource } from "./calendarTechPlayExtractor";

type MockCalendarEvent = CalendarTechPlaySource & {
  eventId: string;
  start: string;
  end: string;
};

const techPlayService = new TechPlayService();
const googleCalendarService = new GoogleCalendarService();

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

    const searchWindowLabel = getSearchWindowLabel(input.postType);
    logDebug("calendar.search.started", {
      postType: input.postType,
      searchWindowLabel,
      now: now.toISOString(),
      provider: config.calendar.provider,
    });

    let rawEvents: CalendarTechPlaySource[];
    try {
      rawEvents =
        config.calendar.provider === "google"
          ? await googleCalendarService.searchCalendarEvents({
              postType: input.postType,
              now,
            })
          : createMockCalendarEvents(now);
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : "Failed to resolve calendar context.";
      logWarn("calendar.search.failed", {
        postType: input.postType,
        provider: config.calendar.provider,
        message,
      });
      return this.buildErrorResponse({
        searchWindowLabel,
        manualTechPlayUrl,
        message,
      });
    }

    const candidates = rawEvents
      .map((event) =>
        scoreCalendarEvent(
          event as MockCalendarEvent,
          input.postType,
          now,
          venuePhoto,
        ),
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
      provider: config.calendar.provider,
    });

    return {
      provider: config.calendar.provider,
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
      provider: getConfig().calendar.provider,
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

  private buildErrorResponse(input: {
    searchWindowLabel: string;
    manualTechPlayUrl?: string;
    message: string;
  }): CalendarResolveResponse {
    return {
      provider: getConfig().calendar.provider,
      calendarLookupStatus: "error",
      techPlayFetchStatus: "error",
      manualTechPlayMode: true,
      searchWindowLabel: input.searchWindowLabel,
      candidates: [],
      detectedTechPlayUrl: input.manualTechPlayUrl,
      warnings: [input.message],
      notes: [input.message],
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

function safeHostname(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return "techplay.jp";
  }
}
