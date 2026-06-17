import type {
  ActionRunResult,
  GeneratedPostSuggestion,
} from "../types/actionRun";

type Props = {
  suggestions: GeneratedPostSuggestion[];
  primaryOutputType?: ActionRunResult["primaryOutputType"];
};

export default function GeneratedPostSuggestionsPanel({
  suggestions,
  primaryOutputType,
}: Props) {
  if (!suggestions.length) {
    return null;
  }

  return (
    <section className="pr-post-agent-suggestions" aria-label="生成済み投稿案">
      <div className="pr-post-agent-suggestions-head">
        <div>
          <h3 className="pr-post-agent-field-label">生成済み投稿案</h3>
          <p className="pr-post-agent-inline-note">
            {primaryOutputType === "generated_post_suggestions"
              ? "画像分析とイベント文脈を踏まえて、投稿案を優先表示しています。"
              : "下書き候補として表示しています。"}
          </p>
        </div>
        <span className="pr-post-agent-status-pill">
          {suggestions.length}案
        </span>
      </div>

      <div className="pr-post-agent-suggestions-list">
        {suggestions.map((suggestion, index) => (
          <article
            key={`${index}-${suggestion.text.slice(0, 24)}`}
            className={`pr-post-agent-suggestion${index === 0 ? " is-primary" : ""}`}
          >
            <div className="pr-post-agent-suggestion-head">
              <strong>{index === 0 ? "案1" : `案${index + 1}`}</strong>
              {index === 0 ? (
                <span className="pr-post-agent-suggestion-badge">優先表示</span>
              ) : null}
            </div>

            <pre className="pr-post-agent-suggestion-text">
              {suggestion.text}
            </pre>

            {suggestion.rationale ? (
              <p className="pr-post-agent-suggestion-rationale">
                {suggestion.rationale}
              </p>
            ) : null}

            <dl className="pr-post-agent-suggestion-evidence">
              <div>
                <dt>根拠</dt>
                <dd>{describeEvidence(suggestion.usedEvidence)}</dd>
              </div>
              <div>
                <dt>注意</dt>
                <dd>
                  {suggestion.warnings.length
                    ? suggestion.warnings.join(" / ")
                    : "なし"}
                </dd>
              </div>
            </dl>
          </article>
        ))}
      </div>
    </section>
  );
}

function describeEvidence(
  evidence: GeneratedPostSuggestion["usedEvidence"],
): string {
  const items = [
    evidence.photo ? "画像" : null,
    evidence.event ? "イベント" : null,
    evidence.survey ? "アンケート" : null,
    evidence.postPerformance ? "過去投稿" : null,
    evidence.accountOverview ? "アカウント概要" : null,
  ].filter((item): item is string => Boolean(item));

  return items.length ? items.join(" / ") : "なし";
}
