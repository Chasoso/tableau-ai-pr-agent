import { useEffect, useMemo, useState } from "react";
import type { ChangeEvent } from "react";
import { createActionRun } from "../api/actionRunApi";
import { previewTechPlayEvent } from "../api/techplayApi";
import { env } from "../env";
import type {
  ActionRunCreateResponse,
  ActionRunPostType,
  ActionRunRequest,
} from "../types/actionRun";
import type { DashboardContext } from "../types/tableau";
import type { TechPlayPreviewResponse } from "../types/techplay";

type Props = {
  dashboardContext: DashboardContext;
  userDisplayName?: string;
  authToken?: string;
};

type PreviewSummary = {
  title: string;
  postCopy: string;
  hashtags: string[];
  evidence: string[];
  checks: string[];
  posterTagline: string;
  posterTheme: string;
  venuePhotoSummary: string;
  venuePhotoSafety: string;
};

type VenuePhotoUsage = "context_only" | "background" | "reference";

type VenuePhotoDraft = {
  fileName: string;
  objectUrl: string;
  sizeLabel: string;
  usage: VenuePhotoUsage;
};

const POST_TYPES: Array<{ label: string; value: ActionRunPostType }> = [
  { label: "事前告知", value: "\u4e8b\u524d\u544a\u77e5" },
  {
    label: "開催直前リマインド",
    value: "\u958b\u50ac\u76f4\u524d\u30ea\u30de\u30a4\u30f3\u30c9",
  },
  { label: "開催中の実況", value: "\u958b\u50ac\u4e2d\u306e\u5b9f\u6cc1" },
  {
    label: "開催後のお礼・レポート",
    value: "\u958b\u50ac\u5f8c\u306e\u304a\u793c\u30fb\u30ec\u30dd\u30fc\u30c8",
  },
  {
    label: "次回参加の呼びかけ",
    value: "\u6b21\u56de\u53c2\u52a0\u306e\u547c\u3073\u304b\u3051",
  },
];

const DEFAULT_EVENT_NAME = "Tableau User Group Tokyo 2026";
const DEFAULT_TECHPLAY_URL = "https://techplay.jp/event/example";
const DEFAULT_SITUATION =
  "会場は人が集まり始めていて、登壇の熱量が高まっています。";

const DEFAULT_VENUE_PHOTO_USAGE: VenuePhotoUsage = "context_only";

const VENUE_PHOTO_USAGE_OPTIONS: Array<{
  label: string;
  value: VenuePhotoUsage;
  description: string;
}> = [
  {
    label: "Context only",
    value: "context_only",
    description: "Use the photo only to understand the venue mood.",
  },
  {
    label: "Use as background",
    value: "background",
    description: "Treat the photo as a background reference for the draft.",
  },
  {
    label: "Reference only",
    value: "reference",
    description: "Keep it as a reference and do not shape the copy from it.",
  },
];

export default function PrActionPanel({
  dashboardContext,
  userDisplayName,
  authToken,
}: Props) {
  const [postType, setPostType] = useState<ActionRunPostType>(
    "\u4e8b\u524d\u544a\u77e5",
  );
  const [eventName, setEventName] = useState(DEFAULT_EVENT_NAME);
  const [techplayUrl, setTechplayUrl] = useState(DEFAULT_TECHPLAY_URL);
  const [currentSituation, setCurrentSituation] = useState(DEFAULT_SITUATION);
  const [techplayPreview, setTechplayPreview] =
    useState<TechPlayPreviewResponse | null>(null);
  const [isLoadingTechPlay, setIsLoadingTechPlay] = useState(false);
  const [techplayPreviewError, setTechplayPreviewError] = useState<
    string | null
  >(null);
  const [venuePhotoUsage, setVenuePhotoUsage] = useState<VenuePhotoUsage>(
    DEFAULT_VENUE_PHOTO_USAGE,
  );
  const [venuePhoto, setVenuePhoto] = useState<VenuePhotoDraft | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [submissionError, setSubmissionError] = useState<string | null>(null);
  const [submissionSummary, setSubmissionSummary] =
    useState<ActionRunCreateResponse | null>(null);
  const plannedImageUrl = useMemo(
    () =>
      submissionSummary
        ? buildActionRunImageUrl(submissionSummary.actionRunId)
        : null,
    [submissionSummary],
  );

  useEffect(
    () => () => {
      if (venuePhoto?.objectUrl) {
        URL.revokeObjectURL(venuePhoto.objectUrl);
      }
    },
    [venuePhoto?.objectUrl],
  );

  const preview = useMemo(
    () =>
      buildPreview({
        postType,
        eventName,
        techplayUrl,
        currentSituation,
        dashboardContext,
        venuePhoto,
      }),
    [
      currentSituation,
      dashboardContext,
      eventName,
      postType,
      techplayUrl,
      venuePhoto,
    ],
  );

  async function handleRunAction() {
    const request: ActionRunRequest = {
      postType,
      eventName,
      techplayUrl,
      currentSituation,
      dashboardContext,
      clientContext: {
        source: "tableau-extension",
        appVersion: env.appVersion,
      },
    };

    setIsSubmitting(true);
    setSubmissionError(null);

    try {
      const response = await createActionRun(request, authToken);
      setSubmissionSummary(response);
    } catch (unknownError) {
      setSubmissionError(
        unknownError instanceof Error
          ? unknownError.message
          : "Action run request failed.",
      );
    } finally {
      setIsSubmitting(false);
    }
  }

  async function handleLoadTechPlay() {
    setIsLoadingTechPlay(true);
    setTechplayPreviewError(null);

    try {
      const preview = await previewTechPlayEvent({
        techplayUrl,
      });
      setTechplayPreview(preview);
      if (!eventName.trim() || eventName === DEFAULT_EVENT_NAME) {
        setEventName(preview.eventName);
      }
    } catch (unknownError) {
      setTechplayPreview(null);
      setTechplayPreviewError(
        unknownError instanceof Error
          ? unknownError.message
          : "TechPlay preview failed.",
      );
    } finally {
      setIsLoadingTechPlay(false);
    }
  }

  function handleVenuePhotoChange(event: ChangeEvent<HTMLInputElement>) {
    const file = event.currentTarget.files?.[0];
    if (!file) {
      return;
    }

    setVenuePhoto({
      fileName: file.name,
      objectUrl: URL.createObjectURL(file),
      sizeLabel: formatFileSize(file.size),
      usage: venuePhotoUsage,
    });
  }

  function handleVenuePhotoUsageChange(event: ChangeEvent<HTMLSelectElement>) {
    const nextUsage = event.currentTarget.value as VenuePhotoUsage;
    setVenuePhotoUsage(nextUsage);
    setVenuePhoto((previous) =>
      previous ? { ...previous, usage: nextUsage } : previous,
    );
  }

  function handleVenuePhotoClear() {
    setVenuePhoto(null);
  }

  return (
    <section className="pr-agent-shell" aria-label="AI PR Action">
      <header className="pr-agent-hero">
        <div className="pr-agent-hero-copy">
          <div className="pr-agent-eyebrow">Tableau Extension</div>
          <h1>AI PR Action</h1>
          <p>
            Build a PR post draft from Tableau context, then send the request to
            the action-runs API. This phase only prepares the request and shows
            a local preview.
          </p>
        </div>

        <div className="pr-agent-hero-badges" aria-label="Status">
          <span>Phase 2</span>
          <span>Action-runs API</span>
          <span>Slack not connected</span>
          <span>{userDisplayName ?? "Guest"}</span>
        </div>
      </header>

      <section className="pr-agent-context" aria-label="Tableau context">
        <div>
          <p className="pr-agent-context-label">Workbook</p>
          <strong>{dashboardContext.workbookName ?? "Unknown"}</strong>
        </div>
        <div>
          <p className="pr-agent-context-label">Dashboard</p>
          <strong>{dashboardContext.dashboardName}</strong>
        </div>
        <div>
          <p className="pr-agent-context-label">Captured</p>
          <strong>{formatTimestamp(dashboardContext.capturedAt)}</strong>
        </div>
      </section>

      <div className="pr-agent-grid">
        <section className="pr-agent-card" aria-label="Input">
          <div className="pr-agent-card-header">
            <div>
              <h2>Input</h2>
              <p>Choose a post type and enter the event context.</p>
            </div>
            <span className="pr-agent-card-pill">Draft only</span>
          </div>

          <div
            className="post-type-grid"
            role="radiogroup"
            aria-label="Post type"
          >
            {POST_TYPES.map((option) => (
              <button
                key={option.value}
                type="button"
                className={`post-type-chip${option.value === postType ? " active" : ""}`}
                aria-pressed={option.value === postType}
                onClick={() => setPostType(option.value)}
              >
                {option.label}
              </button>
            ))}
          </div>

          <label className="pr-agent-field">
            <span>Event name</span>
            <input
              value={eventName}
              onChange={(event) => setEventName(event.target.value)}
              placeholder="Tableau User Group Tokyo 2026"
            />
          </label>

          <label className="pr-agent-field">
            <span>TechPlay URL</span>
            <input
              value={techplayUrl}
              onChange={(event) => setTechplayUrl(event.target.value)}
              placeholder="https://techplay.jp/event/..."
              inputMode="url"
            />
          </label>

          <div className="techplay-preview-actions">
            <button
              type="button"
              className="techplay-preview-button"
              disabled={isLoadingTechPlay}
              onClick={() => void handleLoadTechPlay()}
            >
              {isLoadingTechPlay ? "Loading TechPlay..." : "Load TechPlay"}
            </button>
          </div>

          {techplayPreviewError ? (
            <div className="error-banner" role="alert">
              {techplayPreviewError}
            </div>
          ) : null}

          {techplayPreview ? (
            <section
              className="techplay-preview-card"
              aria-label="TechPlay preview"
            >
              <div className="techplay-preview-header">
                <div>
                  <h3>TechPlay preview</h3>
                  <p>Event name, date, and overview extracted from the URL.</p>
                </div>
                <span className="techplay-preview-badge">
                  {techplayPreview.extractedFrom}
                </span>
              </div>
              <dl className="techplay-preview-meta">
                <div>
                  <dt>Event name</dt>
                  <dd>{techplayPreview.eventName}</dd>
                </div>
                <div>
                  <dt>Date</dt>
                  <dd>{techplayPreview.eventDateText ?? "Unavailable"}</dd>
                </div>
              </dl>
              <p className="techplay-preview-summary">
                {techplayPreview.summary}
              </p>
            </section>
          ) : null}

          <label className="pr-agent-field">
            <span>Current situation</span>
            <textarea
              value={currentSituation}
              onChange={(event) => setCurrentSituation(event.target.value)}
              rows={5}
              placeholder="What is happening on site right now?"
            />
          </label>

          <div className="pr-agent-photo-panel" aria-label="Venue photo upload">
            <div className="pr-agent-photo-panel-header">
              <div>
                <p className="pr-agent-context-label">Venue photo</p>
                <strong>Upload a smartphone photo for context</strong>
              </div>
              <span className="pr-agent-card-pill">Optional</span>
            </div>

            <label className="pr-agent-field">
              <span>Photo usage</span>
              <select
                value={venuePhotoUsage}
                onChange={handleVenuePhotoUsageChange}
              >
                {VENUE_PHOTO_USAGE_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>

            <label className="pr-agent-field">
              <span>Photo file</span>
              <input
                type="file"
                accept="image/*"
                capture="environment"
                onChange={handleVenuePhotoChange}
              />
            </label>

            <div className="pr-agent-photo-help">
              People may be visible in the photo. We only use it as a reference
              and do not auto-post from it.
            </div>

            {venuePhoto ? (
              <div className="venue-photo-preview" aria-live="polite">
                <img
                  src={venuePhoto.objectUrl}
                  alt={`Selected venue photo: ${venuePhoto.fileName}`}
                />
                <div className="venue-photo-preview-copy">
                  <strong>{venuePhoto.fileName}</strong>
                  <span>{venuePhoto.sizeLabel}</span>
                  <span>
                    Usage:{" "}
                    {
                      VENUE_PHOTO_USAGE_OPTIONS.find(
                        (option) => option.value === venuePhoto.usage,
                      )?.label
                    }
                  </span>
                  <button
                    type="button"
                    className="venue-photo-clear-button"
                    onClick={handleVenuePhotoClear}
                  >
                    Remove photo
                  </button>
                </div>
              </div>
            ) : (
              <div className="pr-agent-photo-placeholder">
                Upload a venue photo from your phone to capture the atmosphere.
              </div>
            )}
          </div>

          <div className="pr-agent-hint">
            This phase only prepares the request and preview. No API side
            effects beyond action-runs creation.
          </div>
        </section>

        <section className="pr-agent-card" aria-label="Preview">
          <div className="pr-agent-card-header">
            <div>
              <h2>Preview</h2>
              <p>
                Show the draft Slack post, image frame, evidence, and checks.
              </p>
            </div>
            <span className="pr-agent-card-pill">Output</span>
          </div>

          <article className="slack-copy-card" aria-label="Slack draft">
            <div className="slack-copy-header">
              <span className="slack-copy-label">Slack draft</span>
              <span className="slack-copy-channel">#events-pr</span>
            </div>
            <p>{preview.postCopy}</p>
            <div className="slack-hashtags" aria-label="Hashtags">
              {preview.hashtags.map((tag) => (
                <span key={tag}>{tag}</span>
              ))}
            </div>
          </article>

          <article className="poster-preview" aria-label="Image preview">
            <div className="poster-preview-top">
              <span>{preview.posterTheme}</span>
              <span>
                {techplayPreview?.eventDateText ?? "TechPlay not loaded"}
              </span>
            </div>
            <div className="poster-preview-body">
              <p className="poster-preview-eyebrow">AI PR Action</p>
              <h3>{preview.title}</h3>
              <p>{preview.posterTagline}</p>
              <div className="poster-preview-bar">
                <span>{postType}</span>
                <span>
                  {safeHostname(techplayPreview?.techplayUrl ?? techplayUrl)}
                </span>
              </div>
            </div>
          </article>

          <section
            className="mini-output-card"
            aria-label="Venue photo summary"
          >
            <h3>Venue photo</h3>
            <p className="venue-photo-summary">{preview.venuePhotoSummary}</p>
            <p className="venue-photo-safety">{preview.venuePhotoSafety}</p>
            {venuePhoto ? (
              <div className="venue-photo-summary-chip">
                <span>{venuePhoto.fileName}</span>
                <span>{venuePhoto.sizeLabel}</span>
              </div>
            ) : null}
          </section>

          <div className="pr-agent-output-grid">
            <section className="mini-output-card" aria-label="Evidence">
              <h3>Evidence</h3>
              <ul>
                {preview.evidence.map((item) => (
                  <li key={item}>{item}</li>
                ))}
              </ul>
            </section>

            <section className="mini-output-card" aria-label="Checks">
              <h3>Checks</h3>
              <ul>
                {preview.checks.map((item) => (
                  <li key={item}>{item}</li>
                ))}
              </ul>
            </section>
          </div>
        </section>
      </div>

      <footer className="pr-agent-footer" aria-label="Run action">
        <div className="pr-agent-footer-copy">
          Submit the request to `/action-runs`. Phase 2 keeps the result queued
          and does not call Slack yet.
        </div>

        <div className="pr-agent-footer-actions">
          <button
            type="button"
            className="pr-agent-action-button"
            disabled={isSubmitting}
            onClick={() => void handleRunAction()}
          >
            {isSubmitting ? "Submitting..." : "Run action"}
          </button>
        </div>
      </footer>

      {submissionError ? (
        <div className="error-banner" role="alert">
          {submissionError}
        </div>
      ) : null}

      {submissionSummary ? (
        <section className="pr-agent-status-card" aria-live="polite">
          <div className="pr-agent-status-header">
            <h2>Action run queued</h2>
            <span>{submissionSummary.jobType}</span>
          </div>
          <dl className="pr-agent-status-grid">
            <div>
              <dt>Action Run ID</dt>
              <dd>{submissionSummary.actionRunId}</dd>
            </div>
            <div>
              <dt>Status</dt>
              <dd>{submissionSummary.status}</dd>
            </div>
            <div>
              <dt>Stage</dt>
              <dd>{submissionSummary.stage}</dd>
            </div>
            <div>
              <dt>Poll URL</dt>
              <dd>{submissionSummary.pollUrl}</dd>
            </div>
            <div>
              <dt>S3 image URL</dt>
              <dd>
                {plannedImageUrl ? (
                  <a href={plannedImageUrl} target="_blank" rel="noreferrer">
                    {plannedImageUrl}
                  </a>
                ) : (
                  "Configure VITE_PR_ACTION_IMAGE_PUBLIC_BASE_URL to display a URL."
                )}
              </dd>
            </div>
          </dl>
        </section>
      ) : null}
    </section>
  );
}

function buildPreview(input: {
  postType: ActionRunPostType;
  eventName: string;
  techplayUrl: string;
  currentSituation: string;
  dashboardContext: DashboardContext;
  venuePhoto: VenuePhotoDraft | null;
}): PreviewSummary {
  const eventName = input.eventName.trim() || DEFAULT_EVENT_NAME;
  const situation = input.currentSituation.trim() || DEFAULT_SITUATION;
  const hostname = safeHostname(input.techplayUrl);
  const postTypeLabel = getPostTypeLabel(input.postType);
  const venuePhotoUsageLabel = getVenuePhotoUsageLabel(input.venuePhoto?.usage);
  const venuePhotoSummary = input.venuePhoto
    ? `${input.venuePhoto.fileName} (${venuePhotoUsageLabel})`
    : "No venue photo uploaded yet.";

  return {
    title: `${eventName} / ${postTypeLabel}`,
    postCopy: `${eventName} の ${postTypeLabel} 用ドラフトです。${situation}`,
    hashtags: buildHashtags(eventName, ["#Tableau", "#TechPlay", "#AIPR"]),
    evidence: [
      `Workbook: ${input.dashboardContext.workbookName ?? "Unknown"}`,
      `Dashboard: ${input.dashboardContext.dashboardName}`,
      `TechPlay host: ${hostname}`,
      `Current situation: ${situation}`,
    ],
    checks: [
      "The post type matches the current timing.",
      "The event name and URL point to the same event.",
      "The wording does not expose sensitive or inaccurate details.",
      input.venuePhoto
        ? `Venue photo is set to ${venuePhotoUsageLabel}.`
        : "A venue photo can be added later for atmosphere checking.",
    ],
    posterTagline: `Draft for ${postTypeLabel} based on Tableau context.`,
    posterTheme:
      input.postType === "\u958b\u50ac\u4e2d\u306e\u5b9f\u6cc1"
        ? "Live update"
        : input.postType ===
            "\u958b\u50ac\u76f4\u524d\u30ea\u30de\u30a4\u30f3\u30c9"
          ? "Reminder"
          : input.postType ===
              "\u958b\u50ac\u5f8c\u306e\u304a\u793c\u30fb\u30ec\u30dd\u30fc\u30c8"
            ? "Wrap-up"
            : input.postType ===
                "\u6b21\u56de\u53c2\u52a0\u306e\u547c\u3073\u304b\u3051"
              ? "Next step"
              : "Pre-event",
    venuePhotoSummary,
    venuePhotoSafety: input.venuePhoto
      ? "Do not auto-post if people are clearly identifiable without approval."
      : "Use a venue photo when you want context, mood, or background reference.",
  };
}

function getPostTypeLabel(postType: ActionRunPostType): string {
  const option = POST_TYPES.find((item) => item.value === postType);
  return option?.label ?? "Post";
}

function buildHashtags(eventName: string, seeds: string[]): string[] {
  const eventKeyword = eventName
    .split(/\s+/)
    .filter(Boolean)
    .find((token) => /[A-Za-z0-9]/.test(token))
    ?.replace(/[^A-Za-z0-9]/g, "");

  const base = ["#AIPR", ...seeds];
  if (eventKeyword) {
    base.splice(1, 0, `#${eventKeyword}`);
  }

  return Array.from(new Set(base)).slice(0, 5);
}

function safeHostname(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return "techplay.jp";
  }
}

function getVenuePhotoUsageLabel(usage: VenuePhotoUsage | undefined): string {
  return (
    VENUE_PHOTO_USAGE_OPTIONS.find((option) => option.value === usage)?.label ??
    "Context only"
  );
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }

  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  let unitIndex = 0;

  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }

  return `${value.toFixed(value >= 10 || unitIndex === 0 ? 0 : 1)} ${units[unitIndex]}`;
}

function buildActionRunImageUrl(actionRunId: string): string | null {
  const baseUrl = env.prActionImagePublicBaseUrl.trim();
  if (!baseUrl) {
    return null;
  }

  const prefix = normalizeObjectKeyPrefix(env.prActionImageObjectKeyPrefix);
  return `${trimTrailingSlashes(baseUrl)}/${prefix}/${actionRunId}/poster.svg`;
}

function normalizeObjectKeyPrefix(value: string): string {
  const trimmed = value.trim().replace(/^\/+|\/+$/g, "");
  return trimmed || "action-runs";
}

function trimTrailingSlashes(value: string): string {
  return value.replace(/\/+$/g, "");
}

function formatTimestamp(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }

  return new Intl.DateTimeFormat("en-US", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}
