export type TechPlayPreviewRequest = {
  techplayUrl: string;
};

export type TechPlayPreviewResponse = {
  techplayUrl: string;
  eventName: string;
  eventDateText?: string;
  summary: string;
  sourceTitle?: string;
  sourceDescription?: string;
  hashtags?: string[];
  extractedFrom: "jsonld" | "meta" | "text";
};
