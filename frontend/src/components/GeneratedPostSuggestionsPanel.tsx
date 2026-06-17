import type {
  ActionRunAnalysisSection,
  ActionRunResult,
  GeneratedPostSuggestion,
  PostGenerationEvidencePack,
} from "../types/actionRun";

type Props = {
  suggestions: GeneratedPostSuggestion[];
  primaryOutputType?: ActionRunResult["primaryOutputType"];
  attachedImage?: {
    src?: string;
    alt?: string;
    label?: string;
    width?: number;
    height?: number;
  } | null;
  evidencePack?: PostGenerationEvidencePack | null;
  analysisSections?: ActionRunAnalysisSection[];
  selectedSuggestionId?: string | null;
  isPosting?: boolean;
  onSelectSuggestion: (input: {
    suggestion: GeneratedPostSuggestion;
    suggestionId: string;
    index: number;
  }) => void;
};

export default function GeneratedPostSuggestionsPanel({
  suggestions,
  primaryOutputType,
  attachedImage,
  evidencePack,
  analysisSections,
  selectedSuggestionId,
  isPosting = false,
  onSelectSuggestion,
}: Props) {
  if (!suggestions.length) {
    return null;
  }

  return (
    <section
      className="pr-post-agent-suggestions result-container"
      aria-label="生成済み投稿案"
    >
      <div className="pr-post-agent-suggestions-head">
        <div className="pr-post-agent-suggestions-title-block">
          <h3 className="pr-post-agent-field-label">生成済み投稿案</h3>
          <p className="pr-post-agent-inline-note long-text">
            {primaryOutputType === "generated_post_suggestions"
              ? "入力画像と分析結果をもとに、投稿案をカード形式で表示しています。"
              : "生成結果をカード形式で表示しています。"}
          </p>
        </div>
        <span className="pr-post-agent-status-pill">
          {suggestions.length}案
        </span>
      </div>

      <div className="suggestion-carousel" aria-label="生成済み投稿案一覧">
        {suggestions.map((suggestion, index) => {
          const suggestionId = buildSuggestionId(suggestion, index);
          const isSelected = selectedSuggestionId === suggestionId;

          return (
            <article
              key={suggestionId}
              className={`suggestion-card${isSelected ? " is-selected" : ""}`}
            >
              <div className="suggestion-card-head">
                <div className="suggestion-card-head-copy">
                  <h4>投稿案{index + 1}</h4>
                  {index === 0 ? (
                    <span className="suggestion-card-badge">最有力</span>
                  ) : null}
                </div>
              </div>

              <div className="suggestion-card-section">
                <div className="suggestion-card-section-label">投稿文</div>
                <pre className="suggestion-text long-text">
                  {suggestion.text}
                </pre>
              </div>

              {attachedImage?.src ? (
                <figure className="suggestion-image-frame">
                  <img
                    src={attachedImage.src}
                    alt={attachedImage.alt ?? "添付予定画像"}
                  />
                  <figcaption className="suggestion-image-caption long-text">
                    {attachedImage.label ?? "添付予定画像"}
                  </figcaption>
                </figure>
              ) : null}

              <div className="suggestion-chip-row" aria-label="根拠">
                {buildEvidenceChips(suggestion).map((chip) => (
                  <span key={chip} className="suggestion-chip">
                    {chip}
                  </span>
                ))}
              </div>

              {suggestion.warnings.length ? (
                <p className="suggestion-warning long-text">
                  {suggestion.warnings.join(" / ")}
                </p>
              ) : null}

              <button
                type="button"
                className="suggestion-accept-button"
                disabled={isPosting}
                onClick={() =>
                  onSelectSuggestion({ suggestion, suggestionId, index })
                }
              >
                この案を採用
              </button>
            </article>
          );
        })}
      </div>

      <details className="analysis-details" open={false}>
        <summary>詳細を見る</summary>
        <div className="analysis-details-grid">
          <AnalysisBlock
            title="画像から読み取った内容"
            body={renderPhotoContext(evidencePack?.photoContext)}
          />
          <AnalysisBlock
            title="イベント情報"
            body={renderEventContext(evidencePack?.eventContext)}
          />
          <AnalysisBlock
            title="Tableau分析結果"
            body={renderAnalysisSections(analysisSections)}
          />
        </div>
      </details>
    </section>
  );
}

function buildSuggestionId(
  suggestion: GeneratedPostSuggestion,
  index: number,
): string {
  void suggestion;
  return `suggestion-${index}`;
}

function buildEvidenceChips(suggestion: GeneratedPostSuggestion): string[] {
  const chips: string[] = [];

  if (suggestion.usedEvidence.photo) {
    chips.push("画像");
  }
  if (suggestion.usedEvidence.event) {
    chips.push("イベント");
  }
  if (suggestion.usedEvidence.survey) {
    chips.push("アンケート");
  }
  if (suggestion.usedEvidence.postPerformance) {
    chips.push("投稿実績");
  }
  if (suggestion.usedEvidence.accountOverview) {
    chips.push("アカウント概要");
  }

  return chips.length ? chips : ["根拠あり"];
}

function renderPhotoContext(
  photoContext: PostGenerationEvidencePack["photoContext"] | undefined,
): string[] {
  if (!photoContext) {
    return ["未取得"];
  }

  const lines = [
    photoContext.summary,
    photoContext.observedItems?.length
      ? `観察項目: ${photoContext.observedItems.join(" / ")}`
      : undefined,
    photoContext.visibleText?.length
      ? `読み取った文字: ${photoContext.visibleText.join(" / ")}`
      : undefined,
    photoContext.ocrText?.trim()
      ? `OCR: ${photoContext.ocrText.trim()}`
      : undefined,
    photoContext.sceneInference?.trim()
      ? `状況推定: ${photoContext.sceneInference.trim()}`
      : undefined,
    photoContext.eventFeel?.trim()
      ? `雰囲気: ${photoContext.eventFeel.trim()}`
      : undefined,
    photoContext.postableElements?.length
      ? `投稿に使える要素: ${photoContext.postableElements.join(" / ")}`
      : undefined,
    photoContext.subjectCandidates?.length
      ? `候補: ${photoContext.subjectCandidates.join(" / ")}`
      : undefined,
  ].filter((line): line is string => Boolean(line?.trim()));

  return lines.length ? lines : ["未取得"];
}

function renderEventContext(
  eventContext: PostGenerationEvidencePack["eventContext"] | undefined,
): string[] {
  if (!eventContext) {
    return ["未取得"];
  }

  const lines = [
    eventContext.eventName
      ? `イベント名: ${eventContext.eventName}`
      : undefined,
    eventContext.eventDateText
      ? `開催日時: ${eventContext.eventDateText}`
      : undefined,
    eventContext.venue ? `会場: ${eventContext.venue}` : undefined,
    eventContext.eventUrl ? `URL: ${eventContext.eventUrl}` : undefined,
    eventContext.eventDescription
      ? `概要: ${eventContext.eventDescription}`
      : undefined,
    eventContext.skippedReason
      ? `補足: ${eventContext.skippedReason}`
      : undefined,
  ].filter((line): line is string => Boolean(line?.trim()));

  return lines.length ? lines : ["未取得"];
}

function renderAnalysisSections(
  analysisSections: ActionRunAnalysisSection[] | undefined,
): string[] {
  if (!analysisSections?.length) {
    return ["未取得"];
  }

  return analysisSections.map((section) => {
    const summary = section.summary.trim();
    const rows = section.rows
      .filter((row) => row.label || row.value !== null)
      .slice(0, 3)
      .map(
        (row) => `${row.label}${row.value === null ? "" : `: ${row.value}`}`,
      );

    const details = [section.title, summary, ...rows]
      .filter(Boolean)
      .join("\n");

    return details.trim();
  });
}

function AnalysisBlock({ title, body }: { title: string; body: string[] }) {
  return (
    <article className="analysis-block">
      <h4>{title}</h4>
      <ul className="analysis-block-list">
        {body.map((line) => (
          <li key={line} className="analysis-text long-text">
            {line}
          </li>
        ))}
      </ul>
    </article>
  );
}
