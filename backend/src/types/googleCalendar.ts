export type GoogleCalendarAccessTokenResponse = {
  access_token: string;
  expires_in?: number;
  scope?: string;
  token_type?: string;
};

export type GoogleCalendarDateTimeValue = {
  date?: string;
  dateTime?: string;
  timeZone?: string;
};

export type GoogleCalendarAttachment = {
  fileId?: string;
  fileUrl?: string;
  iconLink?: string;
  mimeType?: string;
  title?: string;
  url?: string;
};

export type GoogleCalendarPerson = {
  displayName?: string;
  email?: string;
  self?: boolean;
};

export type GoogleCalendarConferenceData = {
  entryPoints?: Array<{
    entryPointType?: string;
    label?: string;
    uri?: string;
  }>;
};

export type GoogleCalendarEvent = {
  attachments?: GoogleCalendarAttachment[];
  conferenceData?: GoogleCalendarConferenceData;
  creator?: GoogleCalendarPerson;
  description?: string;
  end?: GoogleCalendarDateTimeValue;
  hangoutLink?: string;
  htmlLink?: string;
  id: string;
  location?: string;
  organizer?: GoogleCalendarPerson;
  start?: GoogleCalendarDateTimeValue;
  summary?: string;
};

export type GoogleCalendarEventsResponse = {
  items?: GoogleCalendarEvent[];
  nextPageToken?: string;
};
