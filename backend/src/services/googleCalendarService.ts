import { getConfig } from "../config";
import { logDebug, logInfo } from "../logging";
import { GoogleCalendarRepository } from "../repositories/googleCalendarRepository";
import { decryptGoogleToken } from "../security/googleCalendarTokenCrypto";
import type { ActionRunPostType } from "../types/actionRun";
import type { AuthenticatedUser } from "../types/auth";
import type {
  GoogleCalendarAccessTokenResponse,
  GoogleCalendarDateTimeValue,
  GoogleCalendarEvent,
  GoogleCalendarEventsResponse,
} from "../types/googleCalendar";
import type { CalendarEventCandidate } from "../types/calendar";

type CalendarSearchWindow = {
  timeMin: string;
  timeMax: string;
  maxResults: number;
  orderBy: "startTime" | "updated";
};

export class GoogleCalendarService {
  constructor(private readonly repository = new GoogleCalendarRepository()) {}

  async searchCalendarEvents(input: {
    postType: ActionRunPostType;
    now: Date;
    authenticatedUser?: AuthenticatedUser;
  }): Promise<CalendarEventCandidate[]> {
    const config = getConfig();
    const googleConfig = config.calendar.google;
    if (!googleConfig.calendarId) {
      throw new Error("GOOGLE_CALENDAR_CALENDAR_ID is required.");
    }
    const authenticatedUser = requireAuthenticatedUser(input.authenticatedUser);

    const searchWindow = buildCalendarSearchWindow(input.postType, input.now);
    logDebug("calendar.google.search.started", {
      postType: input.postType,
      timeMin: searchWindow.timeMin,
      timeMax: searchWindow.timeMax,
      calendarId: safeCalendarId(googleConfig.calendarId),
    });

    const accessToken = await getGoogleAccessToken({
      googleConfig,
      repository: this.repository,
      authenticatedUser,
    });
    const events = await listGoogleCalendarEvents({
      accessToken,
      calendarId: googleConfig.calendarId,
      searchWindow,
    });

    logInfo("calendar.google.search.completed", {
      candidateCount: events.length,
      calendarId: safeCalendarId(googleConfig.calendarId),
      timeMin: searchWindow.timeMin,
      timeMax: searchWindow.timeMax,
    });

    return events.map((event) => buildGoogleCalendarEventCandidate(event));
  }
}

async function getGoogleAccessToken(input: {
  googleConfig: ReturnType<typeof getConfig>["calendar"]["google"];
  repository: GoogleCalendarRepository;
  authenticatedUser?: AuthenticatedUser;
}): Promise<string> {
  const authenticatedUser = requireAuthenticatedUser(input.authenticatedUser);
  let connection = null;
  try {
    connection = await input.repository.getConnection(authenticatedUser.userId);
  } catch {
    connection = null;
  }
  const refreshToken = connection
    ? await decryptGoogleToken({
        ciphertext: connection.refreshTokenCiphertext,
        iv: connection.refreshTokenIv,
        authTag: connection.refreshTokenAuthTag,
      })
    : null;

  if (!input.googleConfig.clientId || !input.googleConfig.clientSecret) {
    throw new Error(
      "GOOGLE_CALENDAR_CLIENT_ID and GOOGLE_CALENDAR_CLIENT_SECRET are required.",
    );
  }

  if (!refreshToken) {
    throw new Error(
      "Google Calendar is not connected for this user. Connect Google first.",
    );
  }

  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      client_id: input.googleConfig.clientId,
      client_secret: input.googleConfig.clientSecret,
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    }).toString(),
  });

  if (!response.ok) {
    throw new Error(
      `Google access token request failed with status ${response.status}.`,
    );
  }

  const body = (await response.json()) as GoogleCalendarAccessTokenResponse;
  if (!body.access_token) {
    throw new Error(
      "Google access token response did not contain access_token.",
    );
  }

  if (connection) {
    await input.repository.putConnection({
      ...connection,
      updatedAt: new Date().toISOString(),
      lastUsedAt: new Date().toISOString(),
      status: "connected",
    });
  }

  return body.access_token;
}

async function listGoogleCalendarEvents(input: {
  accessToken: string;
  calendarId: string;
  searchWindow: CalendarSearchWindow;
}): Promise<GoogleCalendarEvent[]> {
  const url = new URL(
    `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(input.calendarId)}/events`,
  );
  url.searchParams.set("singleEvents", "true");
  url.searchParams.set("showDeleted", "false");
  url.searchParams.set("orderBy", input.searchWindow.orderBy);
  url.searchParams.set("maxResults", String(input.searchWindow.maxResults));
  url.searchParams.set("timeMin", input.searchWindow.timeMin);
  url.searchParams.set("timeMax", input.searchWindow.timeMax);
  url.searchParams.set(
    "fields",
    "items(id,summary,description,location,start,end,htmlLink,hangoutLink,attachments(fileUrl,title,url),creator(displayName,email),organizer(displayName,email),conferenceData(entryPoints(uri,label,entryPointType))),nextPageToken",
  );

  const response = await fetch(url.toString(), {
    headers: {
      Authorization: `Bearer ${input.accessToken}`,
      Accept: "application/json",
    },
  });

  if (!response.ok) {
    throw new Error(
      `Google Calendar events request failed with status ${response.status}.`,
    );
  }

  const body = (await response.json()) as GoogleCalendarEventsResponse;
  return body.items ?? [];
}

function buildGoogleCalendarEventCandidate(
  event: GoogleCalendarEvent,
): CalendarEventCandidate {
  const start = pickDateTime(event.start);
  const end = pickDateTime(event.end);
  return {
    eventId: event.id,
    summary: event.summary?.trim() || "Untitled Google Calendar event",
    description: event.description?.trim() || undefined,
    location: event.location?.trim() || undefined,
    start,
    end,
    htmlLink: event.htmlLink?.trim() || undefined,
    hangoutLink: event.hangoutLink?.trim() || undefined,
    attachments: event.attachments?.map((attachment) => ({
      fileUrl: attachment.fileUrl,
      title: attachment.title,
      url: attachment.url,
    })),
    creator: event.creator,
    organizer: event.organizer,
    conferenceData: event.conferenceData,
    techplayUrls: [],
    score: 0,
    scoreReasons: [],
  };
}

function buildCalendarSearchWindow(
  postType: ActionRunPostType,
  now: Date,
): CalendarSearchWindow {
  const base = new Date(now);
  switch (postType) {
    case "事前告知":
      return {
        timeMin: base.toISOString(),
        timeMax: new Date(
          base.getTime() + 30 * 24 * 60 * 60 * 1000,
        ).toISOString(),
        maxResults: 20,
        orderBy: "startTime",
      };
    case "開催直前リマインド":
      return {
        timeMin: new Date(base.getTime() - 6 * 60 * 60 * 1000).toISOString(),
        timeMax: new Date(
          base.getTime() + 2 * 24 * 60 * 60 * 1000,
        ).toISOString(),
        maxResults: 20,
        orderBy: "startTime",
      };
    case "開催中の実況":
      return {
        timeMin: new Date(base.getTime() - 12 * 60 * 60 * 1000).toISOString(),
        timeMax: new Date(base.getTime() + 12 * 60 * 60 * 1000).toISOString(),
        maxResults: 25,
        orderBy: "startTime",
      };
    case "開催後のお礼・レポート":
      return {
        timeMin: new Date(
          base.getTime() - 14 * 24 * 60 * 60 * 1000,
        ).toISOString(),
        timeMax: base.toISOString(),
        maxResults: 20,
        orderBy: "updated",
      };
    case "次回参加の呼びかけ":
      return {
        timeMin: base.toISOString(),
        timeMax: new Date(
          base.getTime() + 90 * 24 * 60 * 60 * 1000,
        ).toISOString(),
        maxResults: 20,
        orderBy: "startTime",
      };
    default:
      return {
        timeMin: base.toISOString(),
        timeMax: new Date(
          base.getTime() + 30 * 24 * 60 * 60 * 1000,
        ).toISOString(),
        maxResults: 20,
        orderBy: "startTime",
      };
  }
}

function pickDateTime(value?: GoogleCalendarDateTimeValue): string {
  if (!value) {
    return new Date().toISOString();
  }

  if (value.dateTime) {
    return value.dateTime;
  }

  if (value.date) {
    return new Date(value.date).toISOString();
  }

  return new Date().toISOString();
}

function safeCalendarId(calendarId: string): string {
  return calendarId.includes("@") ? calendarId.slice(0, 4) + "***" : calendarId;
}

function requireAuthenticatedUser(
  authenticatedUser: AuthenticatedUser | undefined,
): AuthenticatedUser {
  if (!authenticatedUser?.userId) {
    throw new Error(
      "Google Calendar lookup requires a signed-in user. Connect Google after signing in.",
    );
  }

  return authenticatedUser;
}
