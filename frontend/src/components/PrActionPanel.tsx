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

type VenuePhotoUsage = "context_only" | "background" | "reference";
type DriveReferenceMode = "sample_markdown" | "pasted_markdown" | "none";
type AdjustmentPreset =
  | "default"
  | "short"
  | "casual"
  | "emojiLess"
  | "invite"
  | "custom";

type VenuePhotoDraft = {
  fileName: string;
  objectUrl: string;
  sizeLabel: string;
  usage: VenuePhotoUsage;
};

type DriveReferenceDraft = {
  mode: DriveReferenceMode;
  title: string;
  markdown: string;
};

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
  posterTagline: string;
  posterTheme: string;
  venuePhotoSummary: string;
  driveReferenceSummary: string;
};

const POST_TYPES: Array<{ label: string; value: ActionRunPostType }> = [
  { label: "事前告知", value: "事前告知" },
  { label: "開催直前リマインド", value: "開催直前リマインド" },
  { label: "開催中の実況", value: "開催中の実況" },
  { label: "開催後のお礼・レポート", value: "開催後のお礼・レポート" },
  { label: "次回参加の呼びかけ", value: "次回参加の呼びかけ" },
];

const DEFAULT_TECHPLAY_URL = "https://techplay.jp/event/example";
const DEFAULT_DRIVE_REFERENCE_TITLE = "参考メモ";
const DEFAULT_DRIVE_REFERENCE_MARKDOWN = `# 参考メモ

- 会場の雰囲気をひとこと添える
- 日時や固有名詞はあとで確認する
- 断定しすぎず、自然な語り口にする
`;

const VENUE_PHOTO_USAGE_OPTIONS: Array<{
  label: string;
  value: VenuePhotoUsage;
}> = [
  { label: "状況確認", value: "context_only" },
  { label: "背景", value: "background" },
  { label: "参考", value: "reference" },
];

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
  { label: "もう少し短く", value: "short" },
  { label: "カジュアルに", value: "casual" },
  { label: "絵文字を少なめに", value: "emojiLess" },
  { label: "参加を呼びかける文を追加", value: "invite" },
];

export default function PrActionPanel({
  dashboardContext,
  userDisplayName,
  authToken,
}: Props) {
  const [postType, setPostType] = useState<ActionRunPostType>("事前告知");
  const [techplayUrl, setTechplayUrl] = useState(DEFAULT_TECHPLAY_URL);
  const [eventName, setEventName] = useState("");
  const [showEventNameField, setShowEventNameField] = useState(false);
  const [techplayPreview, setTechplayPreview] =
    useState<TechPlayPreviewResponse | null>(null);
  const [isLoadingTechPlay, setIsLoadingTechPlay] = useState(false);
  const [techplayPreviewError, setTechplayPreviewError] = useState<
    string | null
  >(null);
  const [venuePhotoExpanded, setVenuePhotoExpanded] = useState(true);
  const [venuePhotoUsage, setVenuePhotoUsage] =
    useState<VenuePhotoUsage>("context_only");
  const [venuePhoto, setVenuePhoto] = useState<VenuePhotoDraft | null>(null);
  const [referenceExpanded, setReferenceExpanded] = useState(false);
  const [driveReferenceMode, setDriveReferenceMode] =
    useState<DriveReferenceMode>("sample_markdown");
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

  const resolvedEventName = useMemo(
    () => techplayPreview?.eventName || eventName.trim(),
    [eventName, techplayPreview?.eventName],
  );

  const resolvedSupplementMemo = useMemo(
    () => supplementMemo.trim(),
    [supplementMemo],
  );

  const canGenerateDraft = Boolean(
    resolvedEventName && (venuePhoto || resolvedSupplementMemo),
  );
  const canCreateDraft = generated && canGenerateDraft;

  const preview = useMemo(
    () =>
      buildPreview({
        postType,
        eventName: resolvedEventName || "イベント名未設定",
        techplayUrl,
        supplementMemo: resolvedSupplementMemo,
        dashboardContext,
        venuePhoto,
        driveReference: {
          mode: driveReferenceMode,
          title: driveReferenceTitle,
          markdown: driveReferenceMarkdown,
        },
        techplayPreview,
        generated,
        adjustmentPreset,
        adjustmentNote,
      }),
    [
      adjustmentNote,
      adjustmentPreset,
      dashboardContext,
      driveReferenceMarkdown,
      driveReferenceMode,
      driveReferenceTitle,
      generated,
      postType,
      resolvedEventName,
      resolvedSupplementMemo,
      techplayPreview,
      techplayUrl,
      venuePhoto,
    ],
  );

  const warningMessages = useMemo(() => {
    const warnings = [...preview.warnings];

    if (techplayPreviewError) {
      warnings.unshift(techplayPreviewError);
    }

    if (submissionError) {
      warnings.unshift(submissionError);
    }

    if (!generated) {
      warnings.unshift(
        "投稿案を作るには、写真または補足メモとイベント情報を用意してください。",
      );
    }

    return Array.from(new Set(warnings));
  }, [generated, preview.warnings, submissionError, techplayPreviewError]);

  async function handleLoadTechPlay() {
    setIsLoadingTechPlay(true);
    setTechplayPreviewError(null);

    try {
      const response = await previewTechPlayEvent({ techplayUrl });
      setTechplayPreview(response);
      if (!eventName.trim()) {
        setEventName(response.eventName);
      }
      setShowEventNameField(false);
    } catch (unknownError) {
      setTechplayPreview(null);
      setTechplayPreviewError(
        unknownError instanceof Error
          ? unknownError.message
          : "イベント情報の取得に失敗しました。",
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

    if (venuePhoto?.objectUrl) {
      URL.revokeObjectURL(venuePhoto.objectUrl);
    }

    setVenuePhoto({
      fileName: file.name,
      objectUrl: URL.createObjectURL(file),
      sizeLabel: formatFileSize(file.size),
      usage: venuePhotoUsage,
    });
    setVenuePhotoExpanded(true);
  }

  function handleVenuePhotoUsageChange(event: ChangeEvent<HTMLSelectElement>) {
    const nextUsage = event.currentTarget.value as VenuePhotoUsage;
    setVenuePhotoUsage(nextUsage);
    setVenuePhoto((previous) =>
      previous ? { ...previous, usage: nextUsage } : previous,
    );
  }

  function handleVenuePhotoClear() {
    if (venuePhoto?.objectUrl) {
      URL.revokeObjectURL(venuePhoto.objectUrl);
    }
    setVenuePhoto(null);
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

  function handleGenerateDraft() {
    setGenerated(true);
    setSubmissionError(null);
  }

  async function handleCreateDraft() {
    const request: ActionRunRequest = {
      postType,
      eventName: resolvedEventName,
      techplayUrl,
      currentSituation: buildSituation({
        supplementMemo: resolvedSupplementMemo,
        venuePhoto,
        techplayPreview,
      }),
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
          : "下書き作成リクエストに失敗しました。",
      );
    } finally {
      setIsSubmitting(false);
    }
  }

  function applyAdjustmentPreset(nextPreset: AdjustmentPreset) {
    setAdjustmentPreset(nextPreset);
  }

  function handleCancelDraft() {
    setSubmissionSummary(null);
    setSubmissionError(null);
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
          value={techplayPreview ? "取得済み" : "未取得"}
        />
        <StatusPill
          label="会場写真"
          value={venuePhoto ? "追加済み" : "未追加"}
        />
        <StatusPill
          label="参考メモ"
          value={driveReferenceMode === "none" ? "未追加" : "追加済み"}
        />
      </section>

      <div className="pr-agent-body">
        <section className="pr-agent-card" aria-label="投稿設定">
          <div className="pr-agent-card-header">
            <div>
              <h2>投稿設定</h2>
              <p>写真を中心に、イベント情報と補足メモを組み合わせます。</p>
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
                  onClick={() => setPostType(option.value)}
                >
                  {option.label}
                </button>
              ))}
            </div>
          </div>

          <section className="pr-agent-photo-hero">
            <div className="pr-agent-photo-hero-copy">
              <h3>会場写真</h3>
              <p>デモ体験では、まず写真を追加する流れが主役です。</p>
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

              <label className="pr-agent-field">
                <span>写真の用途</span>
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

              {venuePhoto ? (
                <div className="pr-agent-photo-preview">
                  <img
                    src={venuePhoto.objectUrl}
                    alt={`Selected venue photo: ${venuePhoto.fileName}`}
                  />
                  <div className="pr-agent-photo-preview-copy">
                    <strong>
                      {venuePhoto.fileName} (
                      {venuePhotoUsageLabel(venuePhoto.usage)})
                    </strong>
                    <span>{venuePhoto.sizeLabel}</span>
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
                  写真を選ぶと、投稿画像の下書きが具体的になります。
                </p>
              )}
            </section>
          ) : null}

          <section className="pr-agent-techplay-panel">
            <div className="pr-agent-field-group">
              <div className="pr-agent-field-label">イベント情報</div>
              <label className="pr-agent-field">
                <span>TechPlay URL</span>
                <input
                  value={techplayUrl}
                  onChange={(event) => setTechplayUrl(event.target.value)}
                  placeholder="https://techplay.jp/event/example"
                />
              </label>

              <div className="pr-agent-inline-actions">
                <button
                  type="button"
                  className="pr-agent-secondary-button"
                  onClick={() => void handleLoadTechPlay()}
                  disabled={isLoadingTechPlay}
                >
                  {isLoadingTechPlay ? "取得中..." : "イベント情報を取得"}
                </button>

                <button
                  type="button"
                  className="pr-agent-link-button"
                  onClick={() => setShowEventNameField((previous) => !previous)}
                >
                  {showEventNameField
                    ? "イベント名入力を閉じる"
                    : "イベント名を入力する"}
                </button>
              </div>

              {techplayPreview ? (
                <div className="pr-agent-mini-confirm">
                  <div className="pr-agent-mini-confirm-top">
                    <span>取得済み：</span>
                    <strong>{techplayPreview.eventName}</strong>
                  </div>
                  <div className="pr-agent-inline-note">
                    {techplayPreview.eventDateText ??
                      "日時情報は取得済みです。"}
                  </div>
                </div>
              ) : null}

              {showEventNameField ? (
                <label className="pr-agent-field">
                  <span>手入力イベント名</span>
                  <input
                    value={eventName}
                    onChange={(event) => setEventName(event.target.value)}
                    placeholder="イベント名を入力"
                  />
                </label>
              ) : null}
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
                  <span>参照モード</span>
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
              <span>投稿案の補足</span>
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
            onClick={handleGenerateDraft}
            disabled={!canGenerateDraft}
          >
            投稿案を作成
          </button>

          {!canGenerateDraft ? (
            <p className="pr-agent-inline-note">
              投稿種別、イベント情報または手入力イベント名、会場写真または補足メモを用意すると作成できます。
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
                  {plannedImageUrl ? (
                    <img src={plannedImageUrl} alt="投稿画像" />
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
                    {plannedImageUrl ? (
                      <img src={plannedImageUrl} alt="投稿画像の拡大表示" />
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
                disabled={!canCreateDraft || isSubmitting}
              >
                {isSubmitting ? "作成中..." : "下書きを作成する"}
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
              <h2>調整</h2>
              <p>生成後に、投稿文を少しだけ整えられます。</p>
            </div>

            <div className="pr-agent-adjustment-buttons">
              {ADJUSTMENT_BUTTONS.map((button) => (
                <button
                  key={button.value}
                  type="button"
                  className={`pr-agent-secondary-button${adjustmentPreset === button.value ? " is-selected" : ""}`}
                  onClick={() => applyAdjustmentPreset(button.value)}
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
                placeholder="投稿文の調整内容を自由に入力できます"
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

        {warningMessages.length > 0 ? (
          <section className="pr-agent-warning-card" role="alert">
            <strong>確認が必要です</strong>
            <ul>
              {warningMessages.map((message) => (
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
                  <div>
                    <dt>S3 image URL</dt>
                    <dd>
                      {plannedImageUrl ? (
                        <a
                          href={plannedImageUrl}
                          target="_blank"
                          rel="noreferrer"
                        >
                          {plannedImageUrl}
                        </a>
                      ) : (
                        "画像URLは設定されていません。"
                      )}
                    </dd>
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
  driveReference: DriveReferenceDraft;
  techplayPreview: TechPlayPreviewResponse | null;
  generated: boolean;
  adjustmentPreset: AdjustmentPreset;
  adjustmentNote: string;
}): PreviewSummary {
  const eventName = input.eventName.trim() || "イベント名未設定";
  const supplementMemo = input.supplementMemo.trim();
  const postTypeLabel = getPostTypeLabel(input.postType);
  const hostname = safeHostname(input.techplayUrl);
  const basePostCopy = `${eventName} の${postTypeLabel}です。${supplementMemo || "会場写真をもとに投稿案を整えます。"}`;
  const postCopy = applyAdjustment(
    basePostCopy,
    input.adjustmentPreset,
    input.adjustmentNote,
  );

  const venuePhotoSummary = input.venuePhoto
    ? `${input.venuePhoto.fileName} (${venuePhotoUsageLabel(input.venuePhoto.usage)})`
    : "会場写真は未追加です。";

  const driveReferenceSummary =
    input.driveReference.mode === "none"
      ? "参考メモは未使用です。"
      : `${input.driveReference.title || "参考メモ"} を投稿の参考にします。`;

  const evidence = [
    `参照中ダッシュボード: ${input.dashboardContext.dashboardName}`,
    input.dashboardContext.workbookName
      ? `Workbook: ${input.dashboardContext.workbookName}`
      : null,
    `TechPlay: ${hostname}`,
    supplementMemo ? `補足メモ: ${supplementMemo}` : null,
    input.techplayPreview?.eventDateText
      ? `イベント日時: ${input.techplayPreview.eventDateText}`
      : null,
    input.venuePhoto ? `会場写真: ${input.venuePhoto.fileName}` : null,
  ].filter((item): item is string => Boolean(item));

  const checks = [
    input.techplayPreview ? null : "イベント情報はまだ取得されていません。",
    input.venuePhoto ? null : "会場写真が未追加です。",
    supplementMemo ? null : "補足メモが空です。",
  ].filter((item): item is string => Boolean(item));

  const warnings = [
    !input.techplayPreview && !eventName
      ? "イベント情報またはイベント名を入力してください。"
      : null,
    !input.venuePhoto && !supplementMemo
      ? "会場写真または補足メモを用意すると、投稿案の精度が上がります。"
      : null,
  ].filter((item): item is string => Boolean(item));

  return {
    title: `${eventName} / ${postTypeLabel}`,
    postCopy,
    hashtags: buildHashtags(eventName),
    channel: getSlackChannel(input.postType),
    checkedLabel: input.generated ? "チェック済み" : "未作成",
    imageCaption: input.techplayPreview
      ? input.techplayPreview.summary
      : "イベント情報を取得すると、投稿文の精度が高まります。",
    evidence,
    checks,
    warnings,
    posterTagline: `${postTypeLabel}向けの投稿下書きです。`,
    posterTheme: input.postType,
    venuePhotoSummary,
    driveReferenceSummary,
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
      return `${baseText} 気軽に立ち寄れる雰囲気です。`;
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
  techplayPreview: TechPlayPreviewResponse | null;
}) {
  const parts = [
    input.supplementMemo.trim() || "補足メモなし",
    input.venuePhoto ? `会場写真:${input.venuePhoto.fileName}` : "会場写真なし",
    input.techplayPreview?.eventName
      ? `イベント:${input.techplayPreview.eventName}`
      : "イベント情報未取得",
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

function venuePhotoUsageLabel(usage: VenuePhotoUsage): string {
  const option = VENUE_PHOTO_USAGE_OPTIONS.find((item) => item.value === usage);
  return option?.label ?? "状況確認";
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
