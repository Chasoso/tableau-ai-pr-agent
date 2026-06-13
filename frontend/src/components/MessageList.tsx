import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type {
  ChatJobDisplayState,
  ChatJobProgressMessage,
  ChatMessage,
} from "../types/chat";

export type NotionCompletion = {
  title: string;
  summary: string;
  pageUrl?: string | null;
  draftMarkdown?: string | null;
  expanded: boolean;
};

type Props = {
  messages: ChatMessage[];
  isLoading: boolean;
  loadingText?: string;
  job?: ChatJobDisplayState | null;
  notionCompletion?: NotionCompletion | null;
  onToggleNotionCompletion?: () => void;
};

export default function MessageList({
  messages,
  isLoading,
  loadingText = "繝・・繧ｿ繧堤｢ｺ隱阪＠縺ｦ縺・∪縺吮ｦ",
  job,
  notionCompletion,
  onToggleNotionCompletion,
}: Props) {
  const progressMessages = job?.progressMessages ?? [];
  const recentProgressMessages = progressMessages.slice(-4);

  return (
    <div className="message-list" aria-live="polite">
      {messages.map((message) => (
        <article
          key={message.id}
          className={`message-bubble ${message.role}${message.role === "assistant" ? " assistant-reply" : ""}`}
        >
          {message.role === "assistant" ? (
            <div className="markdown-content">
              <ReactMarkdown remarkPlugins={[remarkGfm]}>
                {message.content}
              </ReactMarkdown>
            </div>
          ) : (
            <p>{message.content}</p>
          )}
        </article>
      ))}

      {job ? (
        <article
          className={`message-bubble assistant job-progress-inline ${job.status}`}
          aria-label="蝗樒ｭ斐ｒ逕滓・荳ｭ"
        >
          <div className="job-progress-inline-top">
            <span className="spinner job-progress-spinner" aria-hidden />
            <div className="job-progress-inline-copy">
              <h2 className="job-progress-inline-title">蝗樒ｭ斐ｒ逕滓・荳ｭ</h2>
            </div>
          </div>

          {job.status === "failed" && job.error ? (
            <p className="job-progress-inline-error">{job.error.message}</p>
          ) : null}

          {recentProgressMessages.length ? (
            <ul className="job-progress-inline-list">
              {recentProgressMessages.map((progressMessage) => (
                <li key={`${progressMessage.at}-${progressMessage.stage}`}>
                  <p>{progressMessage.message}</p>
                  {formatDebugEntries(progressMessage).length ? (
                    <div className="job-progress-inline-meta">
                      {formatDebugEntries(progressMessage).map((entry) => (
                        <span key={entry}>{entry}</span>
                      ))}
                    </div>
                  ) : null}
                </li>
              ))}
            </ul>
          ) : null}
        </article>
      ) : null}

      {notionCompletion ? (
        <section
          className="notion-completion-row"
          aria-label="Notion菫晏ｭ倡ｵ先棡"
        >
          <button
            type="button"
            className="notion-completion-toggle"
            onClick={onToggleNotionCompletion}
            aria-expanded={notionCompletion.expanded}
            aria-label="Notion繝｡繝・そ繝ｼ繧ｸ繧帝幕髢・"
          >
            <span
              className={`toggle-icon ${notionCompletion.expanded ? "open" : ""}`}
              aria-hidden
            >
              笆ｸ
            </span>
            <span>Notion縺ｫ菫晏ｭ倥＠縺ｾ縺励◆</span>
          </button>
          {notionCompletion.expanded ? (
            <div className="notion-completion-body">
              <p>
                <strong>菫晏ｭ倥ち繧､繝医Ν:</strong> {notionCompletion.title}
              </p>
              <p>
                <strong>菫晏ｭ伜・螳ｹ縺ｮ隕∫ｴ・</strong>{" "}
                {notionCompletion.summary}
              </p>
              {notionCompletion.pageUrl ? (
                <p>
                  <a
                    href={notionCompletion.pageUrl}
                    target="_blank"
                    rel="noreferrer"
                  >
                    Notion繝壹・繧ｸ繧帝幕縺・
                  </a>
                </p>
              ) : notionCompletion.draftMarkdown ? (
                <pre className="notion-completion-markdown">
                  {notionCompletion.draftMarkdown}
                </pre>
              ) : null}
            </div>
          ) : null}
        </section>
      ) : null}

      {isLoading && !job ? (
        <article className="message-bubble assistant loading">
          <p>
            <span className="spinner" aria-hidden />
            {loadingText}
          </p>
        </article>
      ) : null}
    </div>
  );
}

function formatDebugEntries(message: ChatJobProgressMessage): string[] {
  const entries: string[] = [];
  const debug = message.debug ?? {};

  if (typeof debug.passCount === "number") {
    entries.push(`pass ${debug.passCount}`);
  }
  if (typeof debug.toolCallCount === "number") {
    entries.push(`tools ${debug.toolCallCount}`);
  }
  if (typeof debug.replanUsed === "boolean") {
    entries.push(`replan ${debug.replanUsed ? "yes" : "no"}`);
  }
  if (typeof debug.fallbackReason === "string" && debug.fallbackReason) {
    entries.push(`fallback ${debug.fallbackReason}`);
  }
  if (typeof debug.provider === "string" && debug.provider) {
    entries.push(`provider ${debug.provider}`);
  }
  if (typeof debug.intent === "string" && debug.intent) {
    entries.push(`intent ${debug.intent}`);
  }

  return entries.slice(0, 5);
}
