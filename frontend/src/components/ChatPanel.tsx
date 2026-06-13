import { useEffect, useMemo, useRef, useState } from "react";
import { createChatJob, getChatJob } from "../api/chatApi";
import {
  loadChatJobOwnerToken,
  storeChatJobOwnerToken,
} from "../api/chatJobOwnerToken";
import { enrichDashboardContext } from "../api/contextApi";
import {
  getNotionStatus,
  savePostIdeaToNotion,
  startNotionConnect,
  type NotionPostIdeaDraft,
  type NotionStatusResponse,
} from "../api/notionApi";
import { env } from "../env";
import type {
  ChatJobDisplayState,
  ChatJobGetResponse,
  ChatJobProgressMessage,
  ChatMessage,
} from "../types/chat";
import type { DashboardContext } from "../types/tableau";
import MessageInput from "./MessageInput";
import MessageList, { type NotionCompletion } from "./MessageList";

type Props = {
  dashboardContext: DashboardContext;
  authToken?: string;
  userDisplayName?: string;
  isAuthenticated?: boolean;
  isAuthLoading?: boolean;
  authOverlay?: {
    isSigningIn: boolean;
    error: string | null;
    onSignIn: () => Promise<void>;
  };
  onDashboardContextPatch?: (
    patch: Partial<Pick<DashboardContext, "workbookName">>,
  ) => void;
};

type ActiveChatJob = {
  jobId: string;
  ownerToken?: string;
};

const exampleQuestions = [
  "このダッシュボードのポイントを教えてください",
  "フィルター状態を要約してください",
  "使われているデータソースを教えてください",
];

const DEFAULT_JOB_POLL_DELAY_MS = 1500;

export default function ChatPanel({
  dashboardContext,
  authToken,
  userDisplayName,
  isAuthenticated = true,
  isAuthLoading = false,
  authOverlay,
  onDashboardContextPatch,
}: Props) {
  const enrichmentStartedKey = useRef<string | null>(null);
  const notionPopupRef = useRef<Window | null>(null);
  const notionPopupPollerRef = useRef<number | undefined>(undefined);
  const actionMenuRef = useRef<HTMLDivElement | null>(null);
  const jobPollTimerRef = useRef<number | undefined>(undefined);
  const jobPollGenerationRef = useRef(0);

  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [sessionId, setSessionId] = useState<string | undefined>();
  const [isAnswerLoading, setIsAnswerLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [activeJob, setActiveJob] = useState<ActiveChatJob | null>(null);
  const [jobView, setJobView] = useState<ChatJobDisplayState | null>(null);
  const [chatJobOwnerToken, setChatJobOwnerToken] = useState<string | null>(
    () => loadChatJobOwnerToken(),
  );

  const [notionStatus, setNotionStatus] = useState<NotionStatusResponse | null>(
    null,
  );
  const [isNotionConnecting, setIsNotionConnecting] = useState(false);
  const [isNotionSaving, setIsNotionSaving] = useState(false);
  const [notionActionMenuOpen, setNotionActionMenuOpen] = useState(false);
  const [notionDraft, setNotionDraft] = useState<NotionPostIdeaDraft | null>(
    null,
  );
  const [notionCompletion, setNotionCompletion] =
    useState<NotionCompletion | null>(null);

  const isSendLocked =
    isAnswerLoading || isNotionSaving || !isAuthenticated || isAuthLoading;
  const isBackgroundLocked = !isAuthenticated;

  useEffect(() => {
    if (dashboardContext.workbookName) {
      return;
    }

    if (env.authRequired && !authToken) {
      return;
    }

    const enrichmentKey = `${dashboardContext.dashboardName}:${dashboardContext.capturedAt}`;
    if (enrichmentStartedKey.current === enrichmentKey) {
      return;
    }

    enrichmentStartedKey.current = enrichmentKey;
    enrichDashboardContext(
      {
        dashboardContext,
        clientContext: {
          source: "tableau-extension",
          appVersion: env.appVersion,
        },
      },
      authToken,
    )
      .then((response) => {
        if (response.dashboardContextPatch?.workbookName) {
          onDashboardContextPatch?.(response.dashboardContextPatch);
        }
      })
      .catch(() => {
        // Keep chat usable even when context enrichment fails.
      });
  }, [authToken, dashboardContext, onDashboardContextPatch]);

  async function refreshNotionStatus() {
    try {
      const status = await getNotionStatus(authToken);
      setNotionStatus(status);
    } catch {
      setNotionStatus({
        connected: false,
        status: "disconnected",
        targetParentPageIdConfigured: false,
        targetDatabaseIdConfigured: false,
      });
    }
  }

  useEffect(() => {
    if (env.authRequired && !authToken) {
      return;
    }
    void refreshNotionStatus();
  }, [authToken]);

  useEffect(() => {
    const handleNotionCompleteMessage = (event: MessageEvent) => {
      if (event.origin !== window.location.origin) {
        return;
      }

      const payload = event.data as
        | { type?: string; ok?: boolean; error?: string }
        | undefined;
      if (!payload || payload.type !== "tableau-chat.notion.complete") {
        return;
      }

      if (notionPopupPollerRef.current) {
        window.clearInterval(notionPopupPollerRef.current);
      }
      notionPopupPollerRef.current = undefined;
      notionPopupRef.current = null;

      if (payload.ok) {
        setError(null);
      } else if (payload.error) {
        setError(payload.error);
      }

      void refreshNotionStatus();
      setIsNotionConnecting(false);
    };

    window.addEventListener("message", handleNotionCompleteMessage);

    return () => {
      window.removeEventListener("message", handleNotionCompleteMessage);
      if (notionPopupPollerRef.current) {
        window.clearInterval(notionPopupPollerRef.current);
      }
      notionPopupPollerRef.current = undefined;
      notionPopupRef.current = null;
    };
  }, []);

  useEffect(() => {
    const handleWindowFocus = () => {
      if (env.authRequired && !authToken) {
        return;
      }
      void refreshNotionStatus();
    };

    window.addEventListener("focus", handleWindowFocus);
    return () => {
      window.removeEventListener("focus", handleWindowFocus);
    };
  }, [authToken]);

  useEffect(() => {
    const handleDocumentClick = (event: MouseEvent) => {
      if (!actionMenuRef.current) {
        return;
      }
      if (!actionMenuRef.current.contains(event.target as Node)) {
        setNotionActionMenuOpen(false);
      }
    };

    window.addEventListener("mousedown", handleDocumentClick);
    return () => {
      window.removeEventListener("mousedown", handleDocumentClick);
    };
  }, []);

  useEffect(() => {
    if (!activeJob) {
      if (jobPollTimerRef.current) {
        window.clearTimeout(jobPollTimerRef.current);
      }
      jobPollTimerRef.current = undefined;
      return;
    }

    const pollGeneration = ++jobPollGenerationRef.current;
    let cancelled = false;

    const ownerToken = activeJob.ownerToken ?? chatJobOwnerToken ?? undefined;

    const pollJob = async () => {
      try {
        const response = await getChatJob(
          activeJob.jobId,
          authToken,
          ownerToken,
        );

        if (cancelled || pollGeneration !== jobPollGenerationRef.current) {
          return;
        }

        setJobView(mapJobResponseToDisplayState(response));

        if (response.status === "completed" && response.result) {
          await handleCompletedJob(response);
          return;
        }

        if (response.status === "failed") {
          setError(response.error?.message ?? "回答の生成に失敗しました。");
          setIsAnswerLoading(false);
          setActiveJob(null);
          return;
        }

        const delayMs = DEFAULT_JOB_POLL_DELAY_MS;

        if (jobPollTimerRef.current) {
          window.clearTimeout(jobPollTimerRef.current);
        }
        jobPollTimerRef.current = window.setTimeout(() => {
          void pollJob();
        }, delayMs);
      } catch (unknownError) {
        if (cancelled || pollGeneration !== jobPollGenerationRef.current) {
          return;
        }

        const message =
          unknownError instanceof Error
            ? unknownError.message
            : "ジョブの進捗取得に失敗しました。";
        setError(message);

        if (/not found|access|unauthorized|forbidden/i.test(message)) {
          setIsAnswerLoading(false);
          setActiveJob(null);
          return;
        }

        if (jobPollTimerRef.current) {
          window.clearTimeout(jobPollTimerRef.current);
        }
        jobPollTimerRef.current = window.setTimeout(() => {
          void pollJob();
        }, DEFAULT_JOB_POLL_DELAY_MS * 2);
      }
    };

    void pollJob();

    return () => {
      cancelled = true;
      if (jobPollTimerRef.current) {
        window.clearTimeout(jobPollTimerRef.current);
      }
      jobPollTimerRef.current = undefined;
    };
  }, [activeJob, authToken, chatJobOwnerToken]);

  async function handleSend(question: string) {
    const trimmedQuestion = question.trim();
    if (!trimmedQuestion || isSendLocked) {
      return;
    }

    const userMessage: ChatMessage = {
      id: crypto.randomUUID(),
      role: "user",
      content: trimmedQuestion,
      createdAt: new Date().toISOString(),
    };

    setMessages((current) => [...current, userMessage]);
    setIsAnswerLoading(true);
    setError(null);
    setNotionDraft(null);
    setActiveJob(null);
    setJobView(null);

    try {
      const response = await createChatJob(
        {
          question: trimmedQuestion,
          dashboardContext,
          clientContext: {
            source: "tableau-extension",
            appVersion: env.appVersion,
          },
          sessionId,
        },
        authToken,
        chatJobOwnerToken ?? undefined,
      );

      if (response.ownerToken) {
        storeChatJobOwnerToken(response.ownerToken);
        setChatJobOwnerToken(response.ownerToken);
      } else if (!authToken) {
        const storedOwnerToken = loadChatJobOwnerToken();
        if (storedOwnerToken) {
          setChatJobOwnerToken(storedOwnerToken);
        }
      }

      const createdAt = new Date().toISOString();
      const progressMessages = buildPendingProgressMessages(createdAt);
      setActiveJob({
        jobId: response.jobId,
        ownerToken: response.ownerToken ?? chatJobOwnerToken ?? undefined,
      });
      setJobView({
        status: response.status,
        stage: response.stage,
        progressMessages,
      });
      setError(null);
    } catch (unknownError) {
      setIsAnswerLoading(false);
      const message =
        unknownError instanceof Error
          ? unknownError.message
          : "回答ジョブの作成に失敗しました。";
      setError(message);
    }
  }

  async function handleCompletedJob(response: ChatJobGetResponse) {
    setError(null);
    setSessionId(response.result?.sessionId);

    if (response.result?.dashboardContextPatch) {
      onDashboardContextPatch?.(response.result.dashboardContextPatch);
    }

    if (response.result?.notionPostIdeaDraft) {
      setNotionDraft(response.result.notionPostIdeaDraft);
    } else {
      setNotionDraft(null);
    }

    setMessages((current) => [
      ...current,
      {
        id: response.result?.messageId ?? crypto.randomUUID(),
        role: "assistant",
        content: response.result?.answer ?? "",
        createdAt: new Date().toISOString(),
      },
    ]);

    setIsAnswerLoading(false);
    setActiveJob(null);
    setJobView(null);
  }

  async function handleConnectNotion() {
    try {
      setIsNotionConnecting(true);
      setNotionActionMenuOpen(false);
      setError(null);

      const popup = window.open(
        "about:blank",
        "tableau-chat-notion-connect",
        "popup,width=520,height=720",
      );
      if (!popup) {
        throw new Error(
          "ポップアップを開けませんでした。ブラウザのポップアップ設定を確認してください。",
        );
      }
      notionPopupRef.current = popup;
      popup.focus();

      const authorizationUrl = await startNotionConnect(
        {
          redirectAfter: window.location.href,
        },
        authToken,
      );
      popup.location.assign(authorizationUrl);

      if (notionPopupPollerRef.current) {
        window.clearInterval(notionPopupPollerRef.current);
      }
      notionPopupPollerRef.current = window.setInterval(() => {
        const currentPopup = notionPopupRef.current;
        if (!currentPopup) {
          return;
        }

        if (currentPopup.closed) {
          window.clearInterval(notionPopupPollerRef.current);
          notionPopupPollerRef.current = undefined;
          notionPopupRef.current = null;
          void refreshNotionStatus();
          setIsNotionConnecting(false);
          return;
        }

        try {
          const popupUrl = currentPopup.location.href;
          if (
            popupUrl.startsWith(window.location.origin) &&
            popupUrl.includes("/notion/callback")
          ) {
            return;
          }
          if (
            popupUrl.startsWith(window.location.origin) &&
            !popupUrl.includes("/notion/callback")
          ) {
            currentPopup.close();
            window.clearInterval(notionPopupPollerRef.current);
            notionPopupPollerRef.current = undefined;
            notionPopupRef.current = null;
            void refreshNotionStatus();
            setIsNotionConnecting(false);
          }
        } catch {
          // Ignore cross-origin access errors while popup stays on Notion domain.
        }
      }, 500);
    } catch (unknownError) {
      setError(
        unknownError instanceof Error
          ? unknownError.message
          : "Notion接続に失敗しました。",
      );
      if (notionPopupPollerRef.current) {
        window.clearInterval(notionPopupPollerRef.current);
      }
      notionPopupPollerRef.current = undefined;
      notionPopupRef.current?.close();
      notionPopupRef.current = null;
      setIsNotionConnecting(false);
    }
  }

  async function handleSaveToNotion() {
    if (!notionDraft) {
      return;
    }

    try {
      setIsNotionSaving(true);
      setError(null);
      const saved = await savePostIdeaToNotion(notionDraft, authToken);
      setNotionCompletion({
        title: notionDraft.title,
        summary: buildDraftSummary(notionDraft),
        pageUrl: saved.pageUrl ?? null,
        draftMarkdown: saved.draftMarkdown ?? null,
        expanded: false,
      });
      setNotionDraft(null);
    } catch (unknownError) {
      setError(
        unknownError instanceof Error
          ? unknownError.message
          : "Notion保存に失敗しました。",
      );
    } finally {
      setIsNotionSaving(false);
    }
  }

  const notionActionLabel = useMemo(() => {
    if (isNotionConnecting) {
      return "Notionに接続中…";
    }
    if (notionStatus?.connected) {
      return "Notion接続済み";
    }
    return "Notionに接続";
  }, [isNotionConnecting, notionStatus?.connected]);

  const notionActionDisabled =
    isNotionConnecting || Boolean(notionStatus?.connected);

  return (
    <section className="chat-panel" aria-label="Tableau Chat Panel">
      <header className="chat-header">
        <div>
          <h1>Tableau Assistant</h1>
          <p>ダッシュボードを分析し、次のアクションにつなげます。</p>
        </div>
        <div
          className={`user-avatar${isBackgroundLocked ? " disabled" : ""}`}
          data-tooltip={userDisplayName || "Guest"}
          aria-label="ユーザー情報"
          title={userDisplayName || "Guest"}
        >
          <svg className="avatar-icon" viewBox="0 0 24 24" aria-hidden="true">
            <circle cx="12" cy="8" r="3.6" />
            <path d="M5.5 18.3c1.7-3 4-4.5 6.5-4.5s4.8 1.5 6.5 4.5" />
          </svg>
        </div>
      </header>

      <div
        className={`${messages.length === 0 ? "chat-body has-starters" : "chat-body no-starters"}${isBackgroundLocked ? " locked" : ""}`}
      >
        {messages.length === 0 ? (
          <section
            className="question-starters"
            aria-label="suggested questions"
          >
            <p>たとえば、このような質問ができます。</p>
            <div className="starter-user-row">
              {exampleQuestions.map((question) => (
                <button
                  key={question}
                  className="starter-user-bubble"
                  disabled={isSendLocked}
                  type="button"
                  onClick={() => void handleSend(question)}
                >
                  {question}
                </button>
              ))}
            </div>
          </section>
        ) : null}

        <MessageList
          messages={messages}
          isLoading={isAnswerLoading}
          loadingText="Tableau MCPでデータを確認しています…"
          job={jobView}
          notionCompletion={notionCompletion}
          onToggleNotionCompletion={() =>
            setNotionCompletion((current) =>
              current ? { ...current, expanded: !current.expanded } : current,
            )
          }
        />
      </div>

      <div className={`chat-footer${isBackgroundLocked ? " locked" : ""}`}>
        {isNotionSaving ? (
          <div className="operation-status" aria-live="polite">
            <span className="spinner" aria-hidden />
            Notionに登録しています…
          </div>
        ) : null}

        {error ? <div className="error-banner">{error}</div> : null}

        <div className="compose-row">
          <div className="action-row" ref={actionMenuRef}>
            <button
              type="button"
              className="plus-action-button"
              aria-expanded={notionActionMenuOpen}
              aria-controls="external-action-menu"
              disabled={isBackgroundLocked}
              onClick={() => setNotionActionMenuOpen((open) => !open)}
              aria-label="外部サービス連携を開く"
            >
              <svg className="plus-icon" viewBox="0 0 24 24" aria-hidden="true">
                <path d="M12 5v14M5 12h14" />
              </svg>
            </button>
            {notionActionMenuOpen && !isBackgroundLocked ? (
              <div
                id="external-action-menu"
                className="action-menu"
                role="menu"
                aria-label="外部連携メニュー"
              >
                <button
                  type="button"
                  className="action-menu-item"
                  disabled={notionActionDisabled}
                  onClick={() => void handleConnectNotion()}
                >
                  {notionActionLabel}
                </button>
              </div>
            ) : null}
          </div>
          <MessageInput disabled={isSendLocked} onSend={handleSend} />
        </div>
      </div>

      {notionDraft ? (
        <div className="notion-modal-backdrop" role="presentation">
          <section
            className="notion-confirm-card notion-confirm-modal"
            aria-label="Notion保存前確認"
          >
            <h2>外部サービス連携アクション</h2>
            <div className="notion-confirm-row">
              <p className="notion-confirm-label">保存タイトル:</p>
              <p className="notion-confirm-value">{notionDraft.title}</p>
            </div>
            <div className="notion-confirm-row">
              <p className="notion-confirm-label">保存内容の要約:</p>
              <p className="notion-confirm-value notion-confirm-summary">
                {buildDraftSummary(notionDraft)}
              </p>
            </div>
            <div className="notion-confirm-row">
              <p className="notion-confirm-label">保存先:</p>
              <p className="notion-confirm-value">Notion</p>
            </div>
            <div className="notion-confirm-actions">
              <button
                type="button"
                className="secondary"
                disabled={isNotionSaving}
                onClick={() => setNotionDraft(null)}
              >
                キャンセル
              </button>
              <button
                type="button"
                className="primary"
                disabled={isNotionSaving || !notionStatus?.connected}
                onClick={() => void handleSaveToNotion()}
              >
                Notionに登録
              </button>
            </div>
            {!notionStatus?.connected ? (
              <p className="hint">Notion接続後に保存できます。</p>
            ) : null}
          </section>
        </div>
      ) : null}

      {!isAuthenticated ? (
        <div className="auth-overlay" role="presentation">
          <div className="auth-overlay-backdrop" />
          <section className="auth-overlay-card" aria-label="ログイン案内">
            <h2>Tableau Assistant</h2>
            <p>利用するには、ログインが必要です。</p>
            {authOverlay?.error ? (
              <div className="error-banner">{authOverlay.error}</div>
            ) : null}
            <button
              type="button"
              disabled={Boolean(authOverlay?.isSigningIn)}
              onClick={() => void authOverlay?.onSignIn()}
            >
              {authOverlay?.isSigningIn ? "ログイン中…" : "ログイン"}
            </button>
          </section>
        </div>
      ) : null}
    </section>
  );
}

function mapJobResponseToDisplayState(
  response: ChatJobGetResponse,
): ChatJobDisplayState {
  return {
    status: response.status,
    stage: response.stage,
    progressMessages: response.progressMessages,
    error: response.error,
  };
}

function buildPendingProgressMessages(
  createdAt: string,
): ChatJobProgressMessage[] {
  return [
    {
      at: createdAt,
      stage: "queued",
      message: "分析を開始しました",
      debug: {
        provider: "chat-job",
      },
    },
  ];
}

function buildDraftSummary(draft: NotionPostIdeaDraft): string {
  const parts =
    draft.draftKind === "analysis_memo"
      ? [
          draft.summary,
          draft.periodLabel ? `対象期間: ${draft.periodLabel}` : undefined,
          draft.datasourceName
            ? `対象データソース: ${draft.datasourceName}`
            : undefined,
        ]
      : [draft.reason, draft.suggestedPostText];
  const compact = parts.filter(Boolean).join(" ").replace(/\s+/g, " ").trim();
  if (!compact) {
    return "保存内容の要約はありません。";
  }
  return compact.length > 140 ? `${compact.slice(0, 140)}…` : compact;
}
