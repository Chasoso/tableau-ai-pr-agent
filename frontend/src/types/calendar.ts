import type { ActionRunPostType } from "./actionRun";
import type { DashboardContext } from "./tableau";
import type { TechPlayPreviewResponse } from "./techplay";

export type CalendarLookupStatus =
  | "idle"
  | "searching"
  | "found"
  | "multiple_candidates"
  | "not_found"
  | "error";

export type TechPlayFetchStatus =
  | "idle"
  | "fetching"
  | "fetched"
  | "not_found"
  | "error";

export type CalendarEventCandidate = {
  eventId: string;
  summary: string;
  description?: string;
  location?: string;
  start: string;
  end: string;
  htmlLink?: string;
  hangoutLink?: string;
  techplayUrls: string[];
  score: number;
  scoreReasons: string[];
};

export type CalendarResolveRequest = {
  postType: ActionRunPostType;
  dashboardContext: DashboardContext;
  venuePhoto?: {
    fileName: string;
    sizeLabel?: string;
  } | null;
  manualTechPlayUrl?: string | null;
  preferredEventId?: string | null;
  now?: string;
};

export type CalendarResolveResponse = {
  provider: "mock";
  calendarLookupStatus: CalendarLookupStatus;
  techPlayFetchStatus: TechPlayFetchStatus;
  manualTechPlayMode: boolean;
  eventSource?: "resolved" | "fallback";
  isFallbackEvent?: boolean;
  searchWindowLabel: string;
  selectedEvent?: CalendarEventCandidate;
  candidates: CalendarEventCandidate[];
  detectedTechPlayUrl?: string;
  techplayPreview?: TechPlayPreviewResponse;
  resolvedEventName?: string;
  warnings: string[];
  notes: string[];
};
