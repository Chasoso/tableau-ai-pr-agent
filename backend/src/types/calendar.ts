import type { DashboardContext } from "./tableau";
import type { TechPlayPreviewResponse } from "./techplay";
import type { ActionRunPostType } from "./actionRun";

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

export type CalendarAttachment = {
  fileUrl?: string;
  title?: string;
  mimeType?: string;
  url?: string;
};

export type CalendarPerson = {
  displayName?: string;
  email?: string;
};

export type CalendarConferenceData = {
  entryPoints?: Array<{
    label?: string;
    uri?: string;
    entryPointType?: string;
  }>;
};

export type CalendarEventCandidate = {
  eventId: string;
  summary: string;
  description?: string;
  location?: string;
  start: string;
  end: string;
  htmlLink?: string;
  hangoutLink?: string;
  attachments?: CalendarAttachment[];
  creator?: CalendarPerson;
  organizer?: CalendarPerson;
  conferenceData?: CalendarConferenceData;
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
  searchWindowLabel: string;
  selectedEvent?: CalendarEventCandidate;
  candidates: CalendarEventCandidate[];
  detectedTechPlayUrl?: string;
  techplayPreview?: TechPlayPreviewResponse;
  resolvedEventName?: string;
  warnings: string[];
  notes: string[];
};
