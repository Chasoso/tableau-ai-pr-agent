import type { ActionRunPostType } from "../types/actionRun";
import type { CalendarEventCandidate } from "../types/calendar";
import type { CalendarTechPlaySource } from "./calendarTechPlayExtractor";
import { extractTechPlayUrlsFromCalendarEvent } from "./calendarTechPlayExtractor";

export type CalendarScoringInput = CalendarTechPlaySource & {
  eventId: string;
  start: string;
  end: string;
};

export function scoreCalendarEvent(
  event: CalendarScoringInput,
  postType: ActionRunPostType,
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
    `${event.summary ?? ""} ${event.description ?? ""}`,
  );
  const containsUserGroup = /User Group/i.test(
    `${event.summary ?? ""} ${event.description ?? ""}`,
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
    summary: event.summary?.trim() || "Untitled calendar event",
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

export function getSearchWindowLabel(postType: ActionRunPostType): string {
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
