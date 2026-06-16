import { useEffect, useMemo, useState } from "react";
import type { ChangeEvent } from "react";
import { createActionRun } from "../api/actionRunApi";
import { resolveCalendarEventContext } from "../api/calendarApi";
import { loadGoogleCalendarConnectionStatus } from "../services/googleCalendarConnection";
import { startGoogleCalendarConnection } from "../services/googleCalendarConnection";
import {
  ensureChatJobOwnerToken,
  loadChatJobOwnerToken,
  storeChatJobOwnerToken,
} from "../api/chatJobOwnerToken";
import { uploadActionRunInputImage } from "../api/actionRunImageApi";
import { env } from "../env";
import type {
  ActionRunCreateResponse,
  ActionRunPostType,
  ActionRunRequest,
} from "../types/actionRun";
import type { CalendarResolveResponse } from "../types/calendar";
import type { DashboardContext } from "../types/tableau";
import { prepareImageAnalysisPayload } from "../utils/prepareImageAnalysisPayload";

type Props = {
  dashboardContext: DashboardContext;
  userDisplayName?: string;
  authToken?: string;
};

type VenuePhotoDraft = {
  fileName: string;
  objectUrl: string;
  sizeLabel: string;
  fileId: string;
  source: "camera" | "library" | "upload";
  mimeType?: string;
  width?: number;
  height?: number;
  byteLength?: number;
  originalDataUrl?: string;
  analysisDataUrl?: string;
  analysisCompressionLabel?: string;
  inputImageObjectKey: string;
};

type DriveReferenceMode = "sample_markdown" | "pasted_markdown" | "none";
type AdjustmentPreset =
  | "default"
  | "short"
  | "casual"
  | "emojiLess"
  | "invite"
  | "custom";

type PreviewSummary = {
  title: string;
  postCopy: string;
  hashtags: string[];
  channel: string;
  checkedLabel: string;
  imageCaption: string;
  evidence: string[];
  checks: string[];
  warnings: string[];
};

const POST_TYPES: Array<{ label: string; value: ActionRunPostType }> = [
  { label: "事前告知", value: "事前告知" },
  { label: "開催直前リマインド", value: "開催直前リマインド" },
  { label: "開催中の実況", value: "開催中の実況" },
  { label: "開催後のお礼・レポート", value: "開催後のお礼・レポート" },
  { label: "次回参加の呼びかけ", value: "次回参加の呼びかけ" },
];

const DEFAULT_DRIVE_REFERENCE_TITLE = "参考メモ";
const DEFAULT_DRIVE_REFERENCE_MARKDOWN = `# 参考メモ

- 写真だけでは伝わりにくい補足
- 参加者や登壇者に触れてほしい点
- 伝えたいトーンや注意点
`;

const DRIVE_REFERENCE_MODE_OPTIONS: Array<{
  label: string;
  value: DriveReferenceMode;
}> = [
  { label: "サンプル", value: "sample_markdown" },
  { label: "貼り付け", value: "pasted_markdown" },
  { label: "使わない", value: "none" },
];

const ADJUSTMENT_BUTTONS: Array<{
  label: string;
  value: Exclude<AdjustmentPreset, "default" | "custom">;
}> = [
  { label: "もっと短く", value: "short" },
  { label: "カジュアルに", value: "casual" },
  { label: "絵文字を少なめに", value: "emojiLess" },
  { label: "参加を呼びかける", value: "invite" },
];

const INITIAL_POST_TYPE: ActionRunPostType = "開催中の実況";

export default function PrActionPanel({
  dashboardContext,
  userDisplayName,
  authToken,
}: Props) {
  const [chatJobOwnerToken, setChatJobOwnerToken] = useState<string | null>(
    () => loadChatJobOwnerToken(),
  );
  const [isGoogleConnected, setIsGoogleConnected] = useState<boolean | null>(
    null,
  );
  const [isGoogleConnecting, setIsGoogleConnecting] = useState(false);
  const [postType, setPostType] =
    useState<ActionRunPostType>(INITIAL_POST_TYPE);
  const [venuePhoto, setVenuePhoto] = useState<VenuePhotoDraft | null>(null);
  const [venuePhotoExpanded, setVenuePhotoExpanded] = useState(true);
  const [calendarResult, setCalendarResult] =
    useState<CalendarResolveResponse | null>(null);
  const [selectedEventId, setSelectedEventId] = useState<string | null>(null);
  const [manualTechPlayMode, setManualTechPlayMode] = useState(false);
  const [manualTechPlayUrl, setManualTechPlayUrl] = useState("");
  const [isResolving, setIsResolving] = useState(false);
  const [calendarError, setCalendarError] = useState<string | null>(null);
  const [driveReferenceMode, setDriveReferenceMode] =
    useState<DriveReferenceMode>("sample_markdown");
  const [referenceExpanded, setReferenceExpanded] = useState(false);
  const [driveReferenceTitle, setDriveReferenceTitle] = useState(
    DEFAULT_DRIVE_REFERENCE_TITLE,
  );
  const [driveReferenceMarkdown, setDriveReferenceMarkdown] = useState(
    DEFAULT_DRIVE_REFERENCE_MARKDOWN,
  );
  const [supplementMemo, setSupplementMemo] = useState("");
  const [generated, setGenerated] = useState(false);
  const [adjustmentPreset, setAdjustmentPreset] =
    useState<AdjustmentPreset>("default");
  const [adjustmentNote, setAdjustmentNote] = useState("");
  const [showPreviewImage, setShowPreviewImage] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [submissionError, setSubmissionError] = useState<string | null>(null);
  const [submissionSummary, setSubmissionSummary] =
    useState<ActionRunCreateResponse | null>(null);

  useEffect(() => {
    if (authToken) {
      return;
    }

    if (!chatJobOwnerToken) {
      setChatJobOwnerToken(ensureChatJobOwnerToken());
    }
  }, [authToken, chatJobOwnerToken]);

  useEffect(
    () => () => {
      if (venuePhoto?.objectUrl) {
        URL.revokeObjectURL(venuePhoto.objectUrl);
      }
    },
    [venuePhoto?.objectUrl],
  );

  useEffect(() => {
    let cancelled = false;

    void (async () => {
      try {
        const status = await loadGoogleCalendarConnectionStatus(
          authToken,
          chatJobOwnerToken ?? undefined,
        );
        if (!cancelled) {
          setIsGoogleConnected(status.connected);
        }
      } catch {
        if (!cancelled) {
          setIsGoogleConnected(false);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [authToken, chatJobOwnerToken]);

  const selectedEvent =
    calendarResult?.selectedEvent ??
    (selectedEventId
      ? calendarResult?.candidates.find(
          (candidate) => candidate.eventId === selectedEventId,
        )
      : undefined);

  const resolvedEventName =
    calendarResult?.eventSource === "fallback"
      ? ""
      : calendarResult?.resolvedEventName?.trim() ||
        selectedEvent?.summary?.trim() ||
        "";

  const resolvedTechPlayUrl =
    calendarResult?.detectedTechPlayUrl?.trim() ||
    manualTechPlayUrl.trim() ||
    "";

  const resolvedSupplementMemo = supplementMemo.trim();
  const resolvedReferenceTitle = driveReferenceTitle.trim();
  const resolvedReferenceMarkdown = driveReferenceMarkdown.trim();

  const calendarLookupStatus = isResolving
    ? "searching"
    : (calendarResult?.calendarLookupStatus ?? "idle");
  const techPlayFetchStatus = isResolving
    ? "fetching"
    : (calendarResult?.techPlayFetchStatus ?? "idle");

  const canGenerateDraft = Boolean(
    resolvedEventName &&
    resolvedTechPlayUrl &&
    ((venuePhoto?.inputImageObjectKey && venuePhoto) ||
      resolvedSupplementMemo) &&
    calendarLookupStatus !== "searching" &&
    techPlayFetchStatus !== "fetching",
  );

  const preview = useMemo(
    () =>
      buildPreview({
        postType,
        eventName: resolvedEventName || "イベント名未取得",
        techplayUrl: resolvedTechPlayUrl,
        supplementMemo: resolvedSupplementMemo,
        dashboardContext,
        venuePhoto,
        calendarResult,
        driveReference: {
          mode: driveReferenceMode,
          title: resolvedReferenceTitle,
          markdown: resolvedReferenceMarkdown,
        },
        generated,
        adjustmentPreset,
        adjustmentNote,
      }),
    [
      adjustmentNote,
      adjustmentPreset,
      calendarResult,
      dashboardContext,
      driveReferenceMode,
      generated,
      postType,
      resolvedEventName,
      resolvedReferenceMarkdown,
      resolvedReferenceTitle,
      resolvedSupplementMemo,
      resolvedTechPlayUrl,
      supplementMemo,
      venuePhoto,
    ],
  );

  const warnings = useMemo(() => {
    const items = [...preview.warnings];

    if (calendarError) {
      items.unshift(calendarError);
    }

    if (submissionError) {
      items.unshift(submissionError);
    }

    if (!generated) {
      items.unshift("会場写真とイベント情報がそろうと投稿案を作れます。");
    }

    return Array.from(new Set(items));
  }, [calendarError, generated, preview.warnings, submissionError]);

  useEffect(() => {
    if (!venuePhoto) {
      return;
    }

    void resolveCalendar({
      preferredEventId: selectedEventId,
      reason: "auto",
    });
    // Venue photo or post type changes should refresh the calendar context.
  }, [postType, venuePhoto?.fileName, venuePhoto?.sizeLabel]);

  async function resolveCalendar(input?: {
    preferredEventId?: string | null;
    reason: "auto" | "manual" | "selection" | "generate";
  }) {
    setIsResolving(true);
    setCalendarError(null);
    setGenerated(false);

    const request = {
      postType,
      dashboardContext,
      venuePhoto: venuePhoto
        ? {
            fileName: venuePhoto.fileName,
            sizeLabel: venuePhoto.sizeLabel,
          }
        : null,
      manualTechPlayUrl:
        manualTechPlayMode || input?.reason === "manual"
          ? manualTechPlayUrl.trim() || null
          : null,
      preferredEventId: input?.preferredEventId ?? selectedEventId,
      now: new Date().toISOString(),
    } satisfies Parameters<typeof resolveCalendarEventContext>[0];

    console.debug("[pr-agent] calendar.resolve.start", {
      reason: input?.reason ?? "auto",
      postType,
      hasVenuePhoto: Boolean(venuePhoto),
      manualTechPlayMode,
      preferredEventId: request.preferredEventId,
    });

    try {
      const response = await resolveCalendarEventContext(
        request,
        authToken,
        chatJobOwnerToken ?? undefined,
      );
      setCalendarResult(response);
      setSelectedEventId(response.selectedEvent?.eventId ?? null);
      setManualTechPlayMode(response.manualTechPlayMode);
      if (!response.manualTechPlayMode) {
        setManualTechPlayUrl("");
      }
      setCalendarError(null);
      console.debug("[pr-agent] calendar.resolve.done", {
        calendarLookupStatus: response.calendarLookupStatus,
        techPlayFetchStatus: response.techPlayFetchStatus,
        selectedEventId: response.selectedEvent?.eventId,
        candidateCount: response.candidates.length,
      });
      return response;
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : "イベント情報の取得に失敗しました。";
      setCalendarError(message);
      setCalendarResult(null);
      setSelectedEventId(null);
      setManualTechPlayMode(true);
      console.debug("[pr-agent] calendar.resolve.failed", {
        reason: input?.reason ?? "auto",
        message,
      });
      return null;
    } finally {
      setIsResolving(false);
    }
  }

  async function handleVenuePhotoChange(event: ChangeEvent<HTMLInputElement>) {
    const file = event.currentTarget.files?.[0];
    if (!file) {
      return;
    }

    try {
      console.debug("[pr-agent] imageSelectionChanged", {
        imageMode: "library",
        selectedImageFilePresent: Boolean(file),
        selectedImageFileName: file.name,
        selectedImageContentType: file.type || undefined,
        selectedImageBytes: file.size,
      });
      if (venuePhoto?.objectUrl) {
        URL.revokeObjectURL(venuePhoto.objectUrl);
      }

      const analysisPayload = await prepareImageAnalysisPayload(file);
      const fileId = crypto.randomUUID();
      console.debug("[pr-agent] imageUploadStarted", {
        selectedImageFileName: file.name,
        selectedImageContentType: file.type || undefined,
        selectedImageBytes: file.size,
        selectedImageWidth: analysisPayload.width,
        selectedImageHeight: analysisPayload.height,
      });
      const uploadResult = await uploadActionRunInputImage(
        {
          fileName: file.name,
          dataUrl: analysisPayload.originalDataUrl,
          contentType: file.type || "image/jpeg",
          byteLength: file.size,
          width: analysisPayload.width,
          height: analysisPayload.height,
          source: "library",
        },
        authToken,
        chatJobOwnerToken ?? undefined,
      );
      const nextPhoto = {
        fileName: file.name,
        objectUrl: URL.createObjectURL(file),
        sizeLabel: formatFileSize(file.size),
        fileId,
        source: "library" as const,
        mimeType: file.type || undefined,
        width: uploadResult.width ?? analysisPayload.width,
        height: uploadResult.height ?? analysisPayload.height,
        byteLength: uploadResult.byteLength,
        originalDataUrl: analysisPayload.originalDataUrl,
        analysisDataUrl: analysisPayload.analysisDataUrl,
        analysisCompressionLabel: analysisPayload.compressionLabel,
        inputImageObjectKey: uploadResult.objectKey,
      };
      setVenuePhoto(nextPhoto);
      setVenuePhotoExpanded(true);
      setGenerated(false);
      console.debug("[pr-agent] imageUploadCompleted", {
        uploadedImageObjectKeyPresent: Boolean(uploadResult.objectKey),
        uploadedImageObjectKey: uploadResult.objectKey,
        uploadedImageContentType: uploadResult.contentType,
        uploadedImageBytes: uploadResult.byteLength,
        uploadedImageWidth: uploadResult.width,
        uploadedImageHeight: uploadResult.height,
      });
      console.debug("[pr-agent] actionRunImageLinked", {
        inputImageSource: "library",
        inputImageObjectKey: uploadResult.objectKey,
        inputImageContentType: uploadResult.contentType,
        inputImageBytes: uploadResult.byteLength,
        inputImageWidth: uploadResult.width,
        inputImageHeight: uploadResult.height,
      });
      console.debug("[pr-agent] venue.photo.added", {
        fileName: nextPhoto.fileName,
        sizeLabel: nextPhoto.sizeLabel,
        postType,
      });
    } catch (error) {
      setSubmissionError(
        error instanceof Error
          ? error.message
          : "画像のアップロードに失敗しました。もう一度アップロードしてください。",
      );
    }
  }

  function handleVenuePhotoClear() {
    if (venuePhoto?.objectUrl) {
      URL.revokeObjectURL(venuePhoto.objectUrl);
    }
    setVenuePhoto(null);
    setCalendarResult(null);
    setSelectedEventId(null);
  }

  function handleDriveReferenceModeChange(
    event: ChangeEvent<HTMLSelectElement>,
  ) {
    const nextMode = event.currentTarget.value as DriveReferenceMode;
    setDriveReferenceMode(nextMode);

    if (nextMode === "sample_markdown") {
      setDriveReferenceTitle(DEFAULT_DRIVE_REFERENCE_TITLE);
      setDriveReferenceMarkdown(DEFAULT_DRIVE_REFERENCE_MARKDOWN);
    }

    if (nextMode === "none") {
      setDriveReferenceTitle("");
      setDriveReferenceMarkdown("");
    }
  }

  async function handleGenerateDraft() {
    if (!canGenerateDraft) {
      const resolved = await resolveCalendar({ reason: "generate" });
      if (!resolved) {
        return;
      }
      if (
        !resolved.resolvedEventName?.trim() ||
        !resolved.detectedTechPlayUrl?.trim()
      ) {
        setSubmissionError("イベント情報を自動取得できませんでした。");
        setManualTechPlayMode(true);
        return;
      }
    }

    setGenerated(true);
    setSubmissionError(null);
    console.debug("[pr-agent] draft.preview.generated", {
      postType,
      eventName: resolvedEventName,
      hasVenuePhoto: Boolean(venuePhoto),
      calendarLookupStatus,
      techPlayFetchStatus,
    });
  }

  async function handleConnectGoogle() {
    try {
      setIsGoogleConnecting(true);
      setCalendarError(null);
      await startGoogleCalendarConnection(
        authToken,
        window.location.pathname + window.location.search,
        chatJobOwnerToken ?? undefined,
      );
      setIsGoogleConnected(true);
      if (venuePhoto) {
        void resolveCalendar({
          preferredEventId: selectedEventId,
          reason: "manual",
        });
      }
    } catch (error) {
      setCalendarError(
        error instanceof Error
          ? error.message
          : "Google Calendar の接続に失敗しました。",
      );
    } finally {
      setIsGoogleConnecting(false);
    }
  }

  async function handleCreateDraft() {
    const request: ActionRunRequest = {
      postType,
      eventName: resolvedEventName,
      eventSource: calendarResult?.eventSource ?? "fallback",
      techplayUrl: resolvedTechPlayUrl,
      currentSituation: buildSituation({
        supplementMemo: resolvedSupplementMemo,
        venuePhoto,
        calendarResult,
      }),
      dashboardContext,
      inputImage: venuePhoto
        ? {
            source: venuePhoto.source,
            objectKey: venuePhoto.inputImageObjectKey,
            contentType: venuePhoto.mimeType ?? "image/jpeg",
            bytes: venuePhoto.byteLength,
            width: venuePhoto.width,
            height: venuePhoto.height,
            originalFileName: venuePhoto.fileName,
            fileId: venuePhoto.fileId,
          }
        : undefined,
      clientContext: {
        source: "tableau-extension",
        appVersion: env.appVersion,
        photo: venuePhoto
          ? {
              fileName: venuePhoto.fileName,
              sizeLabel: venuePhoto.sizeLabel,
              mode: "image",
              mimeType: venuePhoto.mimeType,
              byteLength: venuePhoto.byteLength,
              width: venuePhoto.width,
              height: venuePhoto.height,
              source: "uploaded_image",
              dataUrl: venuePhoto.analysisDataUrl ?? venuePhoto.originalDataUrl,
              objectKey: venuePhoto.inputImageObjectKey,
              contentType: venuePhoto.mimeType,
            }
          : {
              mode: "none",
              source: "none",
            },
      },
    };

    setIsSubmitting(true);
    setSubmissionError(null);

    console.debug("[pr-agent] draft.submit.start", {
      postType,
      eventName: resolvedEventName,
      hasVenuePhoto: Boolean(venuePhoto),
      inputImageSource: venuePhoto ? venuePhoto.source : "none",
      inputImageObjectKeyPresent: Boolean(venuePhoto?.inputImageObjectKey),
      inputImageContentType: venuePhoto?.mimeType,
      inputImageBytes: venuePhoto?.byteLength ?? undefined,
      inputImageWidth: venuePhoto?.width ?? undefined,
      inputImageHeight: venuePhoto?.height ?? undefined,
      calendarLookupStatus,
      techPlayFetchStatus,
    });

    try {
      const response = await createActionRun(
        request,
        authToken,
        chatJobOwnerToken ?? undefined,
      );
      if (response.ownerToken) {
        storeChatJobOwnerToken(response.ownerToken);
        setChatJobOwnerToken(response.ownerToken);
      }
      setSubmissionSummary(response);
      console.debug("[pr-agent] actionRunImageLinked", {
        actionRunId: response.actionRunId,
        inputImageObjectKey: response.inputImageObjectKey,
        inputImageContentType: response.inputImageContentType,
        inputImageBytes: response.inputImageBytes,
        inputImageWidth: response.inputImageWidth,
        inputImageHeight: response.inputImageHeight,
      });
      if (response.inputImageObjectKey) {
        setSubmissionError(null);
      }
      console.debug("[pr-agent] draft.submit.done", {
        actionRunId: response.actionRunId,
        status: response.status,
        stage: response.stage,
      });
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : "下書き作成リクエストに失敗しました。";
      setSubmissionError(message);
      console.debug("[pr-agent] draft.submit.failed", {
        message,
      });
    } finally {
      setIsSubmitting(false);
    }
  }

  function handleCancelDraft() {
    setSubmissionSummary(null);
    setSubmissionError(null);
  }

  function handleCandidateSelect(candidateId: string) {
    setSelectedEventId(candidateId);
    void resolveCalendar({
      preferredEventId: candidateId,
      reason: "selection",
    });
  }

  return (
    <section className="pr-agent-shell" aria-label="Tableau PR Assistant">
      <header className="pr-agent-header">
        <div className="pr-agent-header-copy">
          <h1>Tableau PR Assistant</h1>
          <p>
            ダッシュボードを見ながら、数回の操作でPR投稿の下書きを準備します。
          </p>
        </div>
        <div
          className="pr-agent-avatar"
          aria-label={userDisplayName ? `User: ${userDisplayName}` : "User"}
          title={userDisplayName ?? "Guest"}
        >
          <UserAvatarIcon />
        </div>
      </header>

      <div className="pr-agent-divider" />

      <p className="pr-agent-context-line">
        参照中：<strong>{dashboardContext.dashboardName}</strong>
      </p>

      <section className="pr-agent-status-strip" aria-label="投稿設定の状態">
        <StatusPill label="投稿種別" value={getPostTypeLabel(postType)} />
        <StatusPill
          label="イベント情報"
          value={describeCalendarStatus(
            calendarLookupStatus,
            techPlayFetchStatus,
            calendarResult?.eventSource,
          )}
        />
        <StatusPill
          label="会場写真"
          value={venuePhoto ? "追加済み" : "未追加"}
        />
        <StatusPill
          label="参考メモ"
          value={resolvedSupplementMemo ? "追加済み" : "未追加"}
        />
      </section>

      <div className="pr-agent-body">
        <section className="pr-agent-card" aria-label="投稿設定">
          <div className="pr-agent-card-header">
            <div>
              <h2>投稿設定</h2>
              <p>写真を中心に、イベント情報と参考メモを組み合わせます。</p>
            </div>
          </div>

          <div className="pr-agent-field-group">
            <div className="pr-agent-field-label">投稿種別</div>
            <div
              className="pr-agent-chip-row"
              role="radiogroup"
              aria-label="投稿種別"
            >
              {POST_TYPES.map((option) => (
                <button
                  key={option.value}
                  type="button"
                  className={`pr-agent-chip${option.value === postType ? " is-active" : ""}`}
                  aria-pressed={option.value === postType}
                  onClick={() => {
                    setPostType(option.value);
                    console.debug("[pr-agent] postType.selected", {
                      postType: option.value,
                    });
                  }}
                >
                  {option.label}
                </button>
              ))}
            </div>
          </div>

          <section className="pr-agent-photo-hero">
            <div className="pr-agent-photo-hero-copy">
              <h3>会場写真</h3>
              <p>
                デモ体験では、まず写真を追加する流れが主役です。
                追加後にイベント情報の確認が始まります。
              </p>
            </div>
            <button
              type="button"
              className="pr-agent-photo-cta"
              onClick={() => setVenuePhotoExpanded((previous) => !previous)}
            >
              {venuePhoto ? "写真を変更する" : "＋ 会場写真を追加"}
            </button>
          </section>

          {venuePhotoExpanded ? (
            <section
              className="pr-agent-photo-panel"
              aria-label="会場写真の追加"
            >
              <label className="pr-agent-field">
                <span>写真を選ぶ</span>
                <input
                  type="file"
                  accept="image/*"
                  aria-label="写真を選ぶ"
                  onChange={handleVenuePhotoChange}
                />
              </label>

              {venuePhoto ? (
                <div className="pr-agent-photo-preview">
                  <img
                    src={venuePhoto.objectUrl}
                    alt={`Selected venue photo: ${venuePhoto.fileName}`}
                  />
                  <div className="pr-agent-photo-preview-copy">
                    <strong>{venuePhoto.fileName}</strong>
                    <span>{venuePhoto.sizeLabel}</span>
                    {venuePhoto.analysisCompressionLabel ? (
                      <span>{venuePhoto.analysisCompressionLabel}</span>
                    ) : null}
                    <button
                      type="button"
                      className="pr-agent-link-button"
                      onClick={handleVenuePhotoClear}
                    >
                      削除
                    </button>
                  </div>
                </div>
              ) : (
                <p className="pr-agent-inline-note">
                  写真を追加すると、Googleカレンダーのイベント確認を自動で始めます。
                </p>
              )}
            </section>
          ) : null}

          <section className="pr-agent-techplay-panel">
            <div className="pr-agent-field-group">
              <div className="pr-agent-field-label">イベント情報</div>

              <div className="pr-agent-inline-actions">
                <span className="pr-agent-inline-note">
                  Google接続:{" "}
                  {isGoogleConnected === null
                    ? "確認中"
                    : isGoogleConnected
                      ? "接続済み"
                      : "未接続"}
                </span>
                {isGoogleConnected !== true ? (
                  <button
                    type="button"
                    className="pr-agent-secondary-button"
                    onClick={() => void handleConnectGoogle()}
                    disabled={isGoogleConnecting}
                  >
                    {isGoogleConnecting ? "Googleに接続中..." : "Googleに接続"}
                  </button>
                ) : null}
              </div>

              <div className="pr-agent-event-status">
                <div className="pr-agent-event-status-line">
                  <span>
                    {describeCalendarProgress(
                      calendarLookupStatus,
                      techPlayFetchStatus,
                    )}
                  </span>
                </div>

                {isResolving ? (
                  <p className="pr-agent-inline-note">
                    Googleカレンダーを確認しています...
                  </p>
                ) : null}
                {isGoogleConnected === false ? (
                  <p className="pr-agent-inline-note">
                    Googleカレンダー未接続です。上のボタンから接続してください。
                  </p>
                ) : null}

                {calendarResult?.selectedEvent ? (
                  <div className="pr-agent-mini-confirm">
                    <div className="pr-agent-mini-confirm-top">
                      <span>イベント情報を取得しました</span>
                    </div>
                    <strong>{calendarResult.selectedEvent.summary}</strong>
                    <div className="pr-agent-inline-note">
                      Googleカレンダーから検出
                      {calendarResult.detectedTechPlayUrl
                        ? " / TechPlay情報 取得済み"
                        : ""}
                    </div>
                  </div>
                ) : null}

                {calendarResult?.candidates?.length &&
                calendarResult.candidates.length > 1 ? (
                  <div
                    className="pr-agent-candidate-list"
                    aria-label="候補イベント"
                  >
                    {calendarResult.candidates.map((candidate) => (
                      <button
                        key={candidate.eventId}
                        type="button"
                        className={`pr-agent-candidate${candidate.eventId === selectedEvent?.eventId ? " is-active" : ""}`}
                        onClick={() => handleCandidateSelect(candidate.eventId)}
                      >
                        <strong>{candidate.summary}</strong>
                        <span>
                          {formatCalendarTime(candidate.start, candidate.end)}
                        </span>
                        <small>
                          {candidate.techplayUrls[0] ?? "TechPlay URLなし"}
                        </small>
                      </button>
                    ))}
                  </div>
                ) : null}

                {(calendarLookupStatus === "not_found" ||
                  techPlayFetchStatus === "not_found" ||
                  manualTechPlayMode) &&
                !manualTechPlayUrl.trim() ? (
                  <div className="pr-agent-fallback">
                    <p className="pr-agent-inline-note">
                      イベント情報を自動取得できませんでした。
                    </p>
                    <button
                      type="button"
                      className="pr-agent-link-button"
                      onClick={() => setManualTechPlayMode(true)}
                    >
                      手動でTechPlay URLを入力する
                    </button>
                  </div>
                ) : null}

                {manualTechPlayMode ? (
                  <div className="pr-agent-manual-panel">
                    <label className="pr-agent-field">
                      <span>TechPlay URL</span>
                      <input
                        value={manualTechPlayUrl}
                        onChange={(event) =>
                          setManualTechPlayUrl(event.target.value)
                        }
                        placeholder="https://techplay.jp/event/..."
                      />
                    </label>
                    <div className="pr-agent-inline-actions">
                      <button
                        type="button"
                        className="pr-agent-secondary-button"
                        onClick={() =>
                          void resolveCalendar({
                            reason: "manual",
                          })
                        }
                        disabled={isResolving}
                      >
                        {techPlayFetchStatus === "fetching"
                          ? "TechPlay情報を取得しています..."
                          : "イベント情報を取得"}
                      </button>
                      <button
                        type="button"
                        className="pr-agent-link-button"
                        onClick={() => setManualTechPlayMode(false)}
                      >
                        閉じる
                      </button>
                    </div>
                  </div>
                ) : null}
              </div>
            </div>
          </section>

          <section className="pr-agent-reference-panel">
            <div className="pr-agent-additional-header">
              <span>参考メモ</span>
              <span>任意</span>
            </div>
            <button
              type="button"
              className="pr-agent-secondary-button"
              onClick={() => setReferenceExpanded((previous) => !previous)}
            >
              {referenceExpanded ? "参考メモを閉じる" : "＋ 参考メモを追加"}
            </button>

            {referenceExpanded ? (
              <div className="pr-agent-editor-shell" aria-label="参考メモ">
                <label className="pr-agent-field">
                  <span>参考メモモード</span>
                  <select
                    value={driveReferenceMode}
                    onChange={handleDriveReferenceModeChange}
                  >
                    {DRIVE_REFERENCE_MODE_OPTIONS.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                </label>

                <label className="pr-agent-field">
                  <span>参考メモタイトル</span>
                  <input
                    value={driveReferenceTitle}
                    onChange={(event) =>
                      setDriveReferenceTitle(event.target.value)
                    }
                    disabled={driveReferenceMode === "none"}
                  />
                </label>

                <label className="pr-agent-field">
                  <span>参考メモ本文</span>
                  <textarea
                    value={driveReferenceMarkdown}
                    onChange={(event) =>
                      setDriveReferenceMarkdown(event.target.value)
                    }
                    disabled={driveReferenceMode === "none"}
                    rows={4}
                  />
                </label>
              </div>
            ) : null}
          </section>

          <section className="pr-agent-memo-panel">
            <div className="pr-agent-additional-header">
              <span>補足メモ</span>
              <span>任意</span>
            </div>
            <label className="pr-agent-field">
              <span>補足メモ</span>
              <textarea
                value={supplementMemo}
                onChange={(event) => setSupplementMemo(event.target.value)}
                placeholder="写真だけでは伝わりにくいことを一言で補足できます"
                rows={3}
              />
            </label>
          </section>
        </section>

        <section className="pr-agent-action-card" aria-label="投稿案の作成">
          <div className="pr-agent-action-copy">
            <h2>主操作</h2>
            <p>写真とイベント情報から、投稿案をまとめます。</p>
          </div>

          <button
            type="button"
            className="pr-agent-primary-action"
            onClick={() => void handleGenerateDraft()}
            disabled={!canGenerateDraft}
          >
            投稿案を作成
          </button>

          {!canGenerateDraft ? (
            <p className="pr-agent-inline-note">
              投稿種別、写真、イベント情報、または補足メモがそろうと作成できます。
            </p>
          ) : null}
        </section>

        <section className="pr-agent-preview-wrap" aria-label="投稿プレビュー">
          {generated ? (
            <article className="pr-agent-preview-card">
              <div className="pr-agent-preview-header">
                <div>
                  <div className="pr-agent-field-label">投稿プレビュー</div>
                  <p className="pr-agent-inline-note">
                    Slack投稿文、投稿画像、ハッシュタグを確認できます。
                  </p>
                </div>
                <span className="pr-agent-status-pill">
                  {preview.checkedLabel}
                </span>
              </div>

              <p className="pr-agent-preview-copy">{preview.postCopy}</p>

              <div className="pr-agent-hashtags" aria-label="ハッシュタグ">
                {preview.hashtags.map((tag) => (
                  <span key={tag}>{tag}</span>
                ))}
              </div>

              <div className="pr-agent-preview-media">
                <div className="pr-agent-preview-thumb">
                  {venuePhoto ? (
                    <img src={venuePhoto.objectUrl} alt="投稿画像" />
                  ) : (
                    <div className="pr-agent-preview-thumb-empty">
                      投稿案を作成すると投稿画像が表示されます。
                    </div>
                  )}
                </div>
                <button
                  type="button"
                  className="pr-agent-link-button"
                  onClick={() => setShowPreviewImage((previous) => !previous)}
                >
                  画像を大きく見る
                </button>

                {showPreviewImage ? (
                  <div className="pr-agent-preview-expanded">
                    {venuePhoto ? (
                      <img
                        src={venuePhoto.objectUrl}
                        alt="投稿画像の拡大表示"
                      />
                    ) : (
                      <div className="pr-agent-preview-expanded-empty">
                        拡大画像はまだありません。
                      </div>
                    )}
                  </div>
                ) : null}
              </div>
            </article>
          ) : (
            <article className="pr-agent-preview-card pr-agent-preview-card--empty">
              <div className="pr-agent-field-label">投稿プレビュー</div>
              <p className="pr-agent-inline-note">
                投稿案を作成すると、Slack投稿文と投稿画像がここに表示されます。
              </p>
            </article>
          )}
        </section>

        {generated ? (
          <section className="pr-agent-confirm-card" aria-label="最終操作">
            <div className="pr-agent-action-copy">
              <h2>最終操作</h2>
              <p>
                Slackにはまだ投稿されません。確認用の下書きリクエストを作成します。
              </p>
            </div>

            <div className="pr-agent-confirm-copy">
              この内容で下書きを作成します。
            </div>

            <div className="pr-agent-confirm-actions">
              <button
                type="button"
                className="pr-agent-secondary-button"
                onClick={handleCancelDraft}
                disabled={isSubmitting}
              >
                キャンセル
              </button>
              <button
                type="button"
                className="pr-agent-primary-button"
                onClick={() => void handleCreateDraft()}
                disabled={!canGenerateDraft || isSubmitting}
              >
                {isSubmitting ? "送信中..." : "下書きを作成する"}
              </button>
            </div>
          </section>
        ) : null}

        {generated ? (
          <section
            className="pr-agent-adjustment-card"
            aria-label="投稿文の調整"
          >
            <div className="pr-agent-action-copy">
              <h2>投稿文の調整</h2>
              <p>投稿後に、少しだけ文面を変えたいときに使えます。</p>
            </div>

            <div className="pr-agent-adjustment-buttons">
              {ADJUSTMENT_BUTTONS.map((button) => (
                <button
                  key={button.value}
                  type="button"
                  className={`pr-agent-secondary-button${adjustmentPreset === button.value ? " is-selected" : ""}`}
                  onClick={() => setAdjustmentPreset(button.value)}
                >
                  {button.label}
                </button>
              ))}
            </div>

            <label className="pr-agent-field">
              <span>自由入力</span>
              <textarea
                value={adjustmentNote}
                onChange={(event) => setAdjustmentNote(event.target.value)}
                placeholder="投稿文の調整を自由に入力できます"
                rows={3}
              />
            </label>
          </section>
        ) : null}

        {submissionSummary ? (
          <div className="pr-agent-success-banner" role="status">
            下書き作成リクエストを送信しました
          </div>
        ) : null}

        {warnings.length > 0 ? (
          <section className="pr-agent-warning-card" role="alert">
            <strong>確認が必要です</strong>
            <ul>
              {warnings.map((message) => (
                <li key={message}>{message}</li>
              ))}
            </ul>
          </section>
        ) : null}

        <details className="pr-agent-details">
          <summary>根拠・チェック結果を見る</summary>
          <div className="pr-agent-details-body">
            <section className="pr-agent-detail-list">
              <h2>根拠</h2>
              <ul>
                {preview.evidence.map((item) => (
                  <li key={item}>{item}</li>
                ))}
              </ul>
            </section>

            <section className="pr-agent-detail-list">
              <h2>チェック結果</h2>
              <ul>
                {preview.checks.map((item) => (
                  <li key={item}>{item}</li>
                ))}
              </ul>
            </section>

            <section className="pr-agent-detail-list">
              <h2>action-runs 詳細</h2>
              {submissionSummary ? (
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
                </dl>
              ) : (
                <p className="pr-agent-inline-note">
                  下書き作成後に内部詳細が表示されます。
                </p>
              )}
            </section>
          </div>
        </details>
      </div>
    </section>
  );
}

function buildPreview(input: {
  postType: ActionRunPostType;
  eventName: string;
  techplayUrl: string;
  supplementMemo: string;
  dashboardContext: DashboardContext;
  venuePhoto: VenuePhotoDraft | null;
  calendarResult: CalendarResolveResponse | null;
  driveReference: {
    mode: DriveReferenceMode;
    title: string;
    markdown: string;
  };
  generated: boolean;
  adjustmentPreset: AdjustmentPreset;
  adjustmentNote: string;
}): PreviewSummary {
  const eventName = input.eventName.trim() || "イベント名未取得";
  const postTypeLabel = getPostTypeLabel(input.postType);
  const basePostCopy = `${eventName} の${postTypeLabel}です。${input.supplementMemo || "会場写真をもとに投稿案を整えます。"}`;
  const postCopy = applyAdjustment(
    basePostCopy,
    input.adjustmentPreset,
    input.adjustmentNote,
  );
  const calendarSummary =
    input.calendarResult?.selectedEvent?.summary ?? "Googleカレンダー未確認";
  const techplaySummary =
    input.calendarResult?.techplayPreview?.summary ??
    "TechPlay情報はまだ取得されていません。";

  const evidence = [
    `参照中ダッシュボード: ${input.dashboardContext.dashboardName}`,
    input.dashboardContext.workbookName
      ? `Workbook: ${input.dashboardContext.workbookName}`
      : null,
    `投稿種別: ${postTypeLabel}`,
    input.calendarResult?.selectedEvent
      ? `カレンダー予定: ${calendarSummary}`
      : null,
    input.calendarResult?.detectedTechPlayUrl
      ? `TechPlay URL: ${safeHostname(input.calendarResult.detectedTechPlayUrl)}`
      : null,
    input.venuePhoto ? `会場写真: ${input.venuePhoto.fileName}` : null,
    input.driveReference.mode !== "none" && input.driveReference.title
      ? `参考メモ: ${input.driveReference.title}`
      : null,
  ].filter((item): item is string => Boolean(item));

  const checks = [
    input.calendarResult?.calendarLookupStatus === "found" ||
    input.calendarResult?.calendarLookupStatus === "multiple_candidates"
      ? "Googleカレンダーからイベント候補を取得済み。"
      : "Googleカレンダーはまだ確認中です。",
    input.calendarResult?.techPlayFetchStatus === "fetched"
      ? "TechPlay情報を取得済み。"
      : "TechPlay情報はまだ取得されていません。",
    input.venuePhoto ? null : "会場写真が未追加です。",
    input.supplementMemo ? null : "補足メモが空でも投稿案は作れます。",
  ].filter((item): item is string => Boolean(item));

  const warnings = [
    !input.calendarResult?.selectedEvent &&
    !input.calendarResult?.detectedTechPlayUrl
      ? "イベント情報を自動取得できませんでした。"
      : null,
    !input.venuePhoto && !input.supplementMemo
      ? "会場写真または補足メモがあると投稿案の精度が上がります。"
      : null,
  ].filter((item): item is string => Boolean(item));

  return {
    title: `${eventName} / ${postTypeLabel}`,
    postCopy,
    hashtags: buildHashtags(eventName),
    channel: getSlackChannel(input.postType),
    checkedLabel: input.generated ? "チェック済み" : "未作成",
    imageCaption: input.calendarResult?.techplayPreview?.summary
      ? input.calendarResult.techplayPreview.summary
      : techplaySummary,
    evidence,
    checks,
    warnings,
  };
}

function applyAdjustment(
  baseText: string,
  preset: AdjustmentPreset,
  note: string,
): string {
  const trimmedNote = note.trim();

  switch (preset) {
    case "short":
      return shortenText(baseText);
    case "casual":
      return `${baseText} 立ち寄りやすい雰囲気です。`;
    case "emojiLess":
      return ["✨", "🎉", "📣", "😊"].reduce(
        (currentText, emoji) => currentText.replaceAll(emoji, ""),
        baseText,
      );
    case "invite":
      return `${baseText} ぜひお気軽にご参加ください。`;
    case "custom":
      return trimmedNote ? `${baseText} ${trimmedNote}` : baseText;
    default:
      return baseText;
  }
}

function shortenText(text: string): string {
  const sentenceEnd = text.indexOf("。");
  if (sentenceEnd > 0) {
    return text.slice(0, sentenceEnd + 1);
  }

  return text.length > 72 ? `${text.slice(0, 72)}…` : text;
}

function buildSituation(input: {
  supplementMemo: string;
  venuePhoto: VenuePhotoDraft | null;
  calendarResult: CalendarResolveResponse | null;
}) {
  const parts = [
    input.supplementMemo.trim() || "補足メモなし",
    input.venuePhoto ? `会場写真:${input.venuePhoto.fileName}` : "会場写真なし",
    input.calendarResult?.selectedEvent?.summary
      ? `イベント:${input.calendarResult.selectedEvent.summary}`
      : "イベント情報未取得",
    input.calendarResult?.detectedTechPlayUrl
      ? `TechPlay:${safeHostname(input.calendarResult.detectedTechPlayUrl)}`
      : "TechPlay未取得",
  ];

  return parts.join(" / ");
}

function getPostTypeLabel(postType: ActionRunPostType): string {
  const option = POST_TYPES.find((item) => item.value === postType);
  return option?.label ?? "投稿";
}

function getSlackChannel(postType: ActionRunPostType): string {
  switch (postType) {
    case "開催中の実況":
      return "#events-live";
    case "開催後のお礼・レポート":
      return "#events-report";
    default:
      return "#events-pr";
  }
}

function buildHashtags(eventName: string): string[] {
  const keyword = eventName
    .split(/\s+/)
    .find((token) => /[A-Za-z0-9]/.test(token))
    ?.replace(/[^A-Za-z0-9]/g, "");

  const tags = ["#Tableau", "#TechPlay", "#AIPR"];
  if (keyword) {
    tags.splice(1, 0, `#${keyword}`);
  }

  return Array.from(new Set(tags)).slice(0, 4);
}

function safeHostname(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return "techplay.jp";
  }
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

function formatCalendarTime(startIso: string, endIso: string): string {
  const formatter = new Intl.DateTimeFormat("ja-JP", {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });

  return `${formatter.format(new Date(startIso))} - ${formatter.format(new Date(endIso))}`;
}

function describeCalendarProgress(
  calendarLookupStatus: string,
  techPlayFetchStatus: string,
): string {
  if (calendarLookupStatus === "searching") {
    return "Googleカレンダーを確認しています...";
  }

  if (techPlayFetchStatus === "fetching") {
    return "TechPlay情報を取得しています...";
  }

  if (
    calendarLookupStatus === "found" ||
    calendarLookupStatus === "multiple_candidates"
  ) {
    return "イベント情報を取得しました";
  }

  if (calendarLookupStatus === "not_found") {
    return "イベント情報を自動取得できませんでした。";
  }

  return "イベント情報はまだ未取得です。";
}

function describeCalendarStatus(
  calendarLookupStatus: string,
  techPlayFetchStatus: string,
  eventSource?: string,
): string {
  if (eventSource === "fallback") {
    return "イベント情報は未取得です";
  }

  if (calendarLookupStatus === "searching") {
    return "確認中";
  }

  if (
    calendarLookupStatus === "found" ||
    calendarLookupStatus === "multiple_candidates"
  ) {
    return techPlayFetchStatus === "fetched" ? "取得済み" : "検出済み";
  }

  if (calendarLookupStatus === "not_found") {
    return "未検出";
  }

  return "未確認";
}

function StatusPill({ label, value }: { label: string; value: string }) {
  return (
    <div className="pr-agent-status-pill">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function UserAvatarIcon() {
  return (
    <svg
      className="pr-agent-avatar-icon"
      viewBox="0 0 24 24"
      aria-hidden="true"
    >
      <circle cx="12" cy="8" r="3.2" />
      <path d="M5 19c1.9-3.6 5-5.4 7-5.4S18.1 15.4 19 19" />
    </svg>
  );
}
