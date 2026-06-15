import { useEffect, useMemo, useRef, useState } from "react";
import type { ChangeEvent, FormEvent, ReactNode } from "react";
import type { ActionRunPostType } from "../types/actionRun";
import type {
  CalendarEventCandidate,
  CalendarResolveResponse,
} from "../types/calendar";
import type { DashboardContext } from "../types/tableau";
import type {
  GeneratedPrPostDraft,
  PostedResult,
  ServiceConnections,
  TableauAnalysisResult,
  UploadedImage,
} from "../services/prPostAgent";
import {
  analyzePastPostsWithTableau,
  buildPostTrendSummary,
  fetchTechPlayEventInfo,
  generatePrPostDraft,
  postToSlack,
  postToX,
  resolveCalendarEventContext,
} from "../services/prPostAgent";
import {
  loadGoogleCalendarConnectionStatus,
  startGoogleCalendarConnection,
} from "../services/googleCalendarConnection";

type Props = {
  dashboardContext: DashboardContext;
  userDisplayName?: string;
  authToken?: string;
};

type ChatMessage = {
  id: string;
  role: "assistant" | "user";
  lines: string[];
};

type GenerationStatus = "idle" | "generating" | "generated" | "error";

type PendingPost = {
  channel: "slack" | "x";
  text: string;
};

type WorkflowState = {
  postType: ActionRunPostType | null;
  calendarLookupStatus:
    | "idle"
    | "searching"
    | "found"
    | "multiple_candidates"
    | "not_found"
    | "error";
  techPlayFetchStatus: "idle" | "fetching" | "fetched" | "not_found" | "error";
  tableauAnalysisStatus: "idle" | "fetching" | "completed" | "error";
};

const SCENE_OPTIONS: Array<{ label: string; value: ActionRunPostType }> = [
  { label: "事前告知", value: "事前告知" },
  { label: "開催直前リマインド", value: "開催直前リマインド" },
  { label: "開催中の実況", value: "開催中の実況" },
  { label: "開催後のお礼・レポート", value: "開催後のお礼・レポート" },
  { label: "次回参加の呼びかけ", value: "次回参加の呼びかけ" },
];

const IMAGE_OPTIONS = [
  { label: "カメラを起動", value: "camera" as const },
  { label: "ライブラリから選択", value: "library" as const },
  { label: "画像を投稿しない", value: "none" as const },
];

const INITIAL_MESSAGES: ChatMessage[] = [
  {
    id: "assistant-intro",
    role: "assistant",
    lines: ["最適な投稿を提案します。", "まずは、投稿シーンを教えてください。"],
  },
];

const DEFAULT_CONNECTIONS: ServiceConnections = {
  google: false,
  slack: true,
  x: true,
};

export default function PrPostAgentPanel({
  dashboardContext,
  userDisplayName,
  authToken,
}: Props) {
  const workflowIdRef = useRef(0);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const manualTechPlayInputRef = useRef<HTMLInputElement | null>(null);

  const [messages, setMessages] = useState<ChatMessage[]>(INITIAL_MESSAGES);
  const [serviceConnections, setServiceConnections] =
    useState<ServiceConnections>(loadConnections);
  const [isServiceMenuOpen, setIsServiceMenuOpen] = useState(false);
  const [isGoogleConnecting, setIsGoogleConnecting] = useState(false);
  const [workflow, setWorkflow] = useState<WorkflowState>({
    postType: null,
    calendarLookupStatus: "idle",
    techPlayFetchStatus: "idle",
    tableauAnalysisStatus: "idle",
  });
  const [selectedCalendarEventId, setSelectedCalendarEventId] = useState<
    string | null
  >(null);
  const [calendarResult, setCalendarResult] =
    useState<CalendarResolveResponse | null>(null);
  const [analysisResult, setAnalysisResult] =
    useState<TableauAnalysisResult | null>(null);
  const [postTrendSummary, setPostTrendSummary] = useState<string[]>([]);
  const [imageMode, setImageMode] = useState<
    "camera" | "library" | "none" | null
  >(null);
  const [uploadedImage, setUploadedImage] = useState<UploadedImage | null>(
    null,
  );
  const [imagePreviewExpanded, setImagePreviewExpanded] = useState(false);
  const [noImageSituationMemo, setNoImageSituationMemo] = useState("");
  const [composerText, setComposerText] = useState("");
  const [manualTechPlayUrl, setManualTechPlayUrl] = useState("");
  const [generationStatus, setGenerationStatus] =
    useState<GenerationStatus>("idle");
  const [generatedDraft, setGeneratedDraft] =
    useState<GeneratedPrPostDraft | null>(null);
  const [draftExpanded, setDraftExpanded] = useState(true);
  const [pendingPost, setPendingPost] = useState<PendingPost | null>(null);
  const [postingStatus, setPostingStatus] = useState<{
    slack: "idle" | "posting" | "done" | "error";
    x: "idle" | "posting" | "done" | "error";
  }>({ slack: "idle", x: "idle" });
  const [completedPosts, setCompletedPosts] = useState<PostedResult[]>([]);
  const [error, setError] = useState<string | null>(null);

  const selectedPostType = workflow.postType;
  const selectedCalendarEvent =
    calendarResult?.candidates.find(
      (candidate) => candidate.eventId === selectedCalendarEventId,
    ) ??
    calendarResult?.selectedEvent ??
    calendarResult?.candidates[0] ??
    null;

  const detectedTechPlayUrl =
    calendarResult?.detectedTechPlayUrl?.trim() ||
    selectedCalendarEvent?.techplayUrls?.[0]?.trim() ||
    "";
  const hasCalendarCandidates =
    calendarResult?.calendarLookupStatus === "multiple_candidates" &&
    calendarResult.candidates.length > 1;
  const needsManualTechPlayUrl =
    Boolean(calendarResult) &&
    !detectedTechPlayUrl &&
    workflow.techPlayFetchStatus !== "fetching" &&
    workflow.techPlayFetchStatus !== "fetched";

  const canGenerate = useMemo(() => {
    if (!selectedPostType || generationStatus !== "idle") {
      return false;
    }

    if (selectedPostType === "開催中の実況" && imageMode === null) {
      return false;
    }

    if (!serviceConnections.google || !serviceConnections.slack) {
      return false;
    }

    if (!calendarResult || !analysisResult) {
      return false;
    }

    if (hasCalendarCandidates) {
      return false;
    }

    if (
      workflow.calendarLookupStatus === "searching" ||
      workflow.calendarLookupStatus === "error" ||
      workflow.tableauAnalysisStatus === "fetching" ||
      workflow.tableauAnalysisStatus === "error" ||
      workflow.techPlayFetchStatus === "error"
    ) {
      return false;
    }

    if (
      selectedPostType === "開催中の実況" &&
      imageMode !== "none" &&
      !uploadedImage
    ) {
      return false;
    }

    if (
      selectedPostType === "開催中の実況" &&
      imageMode === "none" &&
      !noImageSituationMemo.trim()
    ) {
      return false;
    }

    if (needsManualTechPlayUrl && !manualTechPlayUrl.trim()) {
      return false;
    }

    return true;
  }, [
    analysisResult,
    calendarResult,
    generationStatus,
    hasCalendarCandidates,
    imageMode,
    manualTechPlayUrl,
    needsManualTechPlayUrl,
    noImageSituationMemo,
    selectedPostType,
    serviceConnections.google,
    serviceConnections.slack,
    uploadedImage,
    workflow.calendarLookupStatus,
    workflow.techPlayFetchStatus,
    workflow.tableauAnalysisStatus,
  ]);

  useEffect(() => {
    return () => {
      if (uploadedImage?.objectUrl) {
        URL.revokeObjectURL(uploadedImage.objectUrl);
      }
    };
  }, [uploadedImage?.objectUrl]);

  useEffect(() => {
    let cancelled = false;

    void (async () => {
      try {
        const connectionStatus =
          await loadGoogleCalendarConnectionStatus(authToken);
        if (!cancelled) {
          setServiceConnections((current) => ({
            ...current,
            google: connectionStatus.connected,
          }));
        }
      } catch {
        if (!cancelled) {
          setServiceConnections((current) => ({
            ...current,
            google: false,
          }));
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [authToken]);

  useEffect(() => {
    if (
      !canGenerate ||
      !selectedPostType ||
      !calendarResult ||
      !analysisResult
    ) {
      return;
    }

    let cancelled = false;
    setGenerationStatus("generating");

    void (async () => {
      try {
        const draft = await generatePrPostDraft({
          postType: selectedPostType,
          dashboardContext,
          calendarResult,
          analysis: analysisResult,
          image: uploadedImage,
          noImageSituationMemo:
            imageMode === "none" ? noImageSituationMemo.trim() : undefined,
          manualTechPlayUrl: manualTechPlayUrl.trim() || undefined,
          authToken,
        });

        if (cancelled) {
          return;
        }

        setGeneratedDraft(draft);
        setDraftExpanded(true);
        setGenerationStatus("generated");
        setMessages((current) => [
          ...current,
          {
            id: crypto.randomUUID(),
            role: "assistant",
            lines: [
              "投稿案を生成しました。",
              "必要なら Slack や X に投稿できます。",
            ],
          },
        ]);
      } catch (draftError) {
        if (cancelled) {
          return;
        }

        setGenerationStatus("error");
        setError(
          draftError instanceof Error
            ? draftError.message
            : "投稿案の生成に失敗しました。",
        );
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [
    analysisResult,
    authToken,
    canGenerate,
    calendarResult,
    dashboardContext,
    imageMode,
    manualTechPlayUrl,
    noImageSituationMemo,
    selectedPostType,
    uploadedImage,
  ]);

  async function beginWorkflow(postType: ActionRunPostType) {
    const workflowId = ++workflowIdRef.current;
    clearWorkflowState();

    setWorkflow({
      postType,
      calendarLookupStatus: "searching",
      techPlayFetchStatus: "idle",
      tableauAnalysisStatus: "idle",
    });
    setMessages([
      INITIAL_MESSAGES[0],
      { id: crypto.randomUUID(), role: "user", lines: [postType] },
    ]);

    try {
      const calendar = await resolveCalendarEventContext(
        {
          postType,
          dashboardContext,
          now: new Date().toISOString(),
        },
        authToken,
      );

      if (workflowId !== workflowIdRef.current) {
        return;
      }

      setCalendarResult(calendar);
      setWorkflow((current) => ({
        ...current,
        calendarLookupStatus: calendar.calendarLookupStatus,
      }));

      const selectedCandidate =
        calendar.selectedEvent ?? calendar.candidates[0] ?? null;
      setSelectedCalendarEventId(selectedCandidate?.eventId ?? null);

      setMessages((current) => {
        const next = [...current];
        if (calendar.calendarLookupStatus === "multiple_candidates") {
          next.push({
            id: crypto.randomUUID(),
            role: "assistant",
            lines: [
              "今日のイベント候補が複数見つかりました。どれを使いますか？",
            ],
          });
        }

        if (
          !calendar.detectedTechPlayUrl &&
          !selectedCandidate?.techplayUrls?.[0]
        ) {
          next.push({
            id: crypto.randomUUID(),
            role: "assistant",
            lines: [
              "カレンダーからTechPlay URLを見つけられませんでした。",
              "イベントページのURLを入力しますか？",
            ],
          });
        }

        return next;
      });

      if (calendar.calendarLookupStatus === "multiple_candidates") {
        return;
      }

      await continueWorkflowWithCalendar({
        workflowId,
        postType,
        calendar,
        selectedCandidate,
        authToken,
      });
    } catch (workflowError) {
      if (workflowId !== workflowIdRef.current) {
        return;
      }

      const message =
        workflowError instanceof Error
          ? workflowError.message
          : "投稿情報の取得に失敗しました。";
      setError(message);
      setGenerationStatus("error");
      setWorkflow((current) => ({
        ...current,
        calendarLookupStatus: "error",
        tableauAnalysisStatus: "error",
      }));
      setMessages((current) => [
        ...current,
        { id: crypto.randomUUID(), role: "assistant", lines: [message] },
      ]);
    }
  }

  async function continueWorkflowWithCalendar(input: {
    workflowId: number;
    postType: ActionRunPostType;
    calendar: CalendarResolveResponse;
    selectedCandidate?: CalendarEventCandidate | null;
    authToken?: string;
  }) {
    const techplayUrl =
      input.calendar.detectedTechPlayUrl?.trim() ||
      input.selectedCandidate?.techplayUrls?.[0]?.trim() ||
      "";

    if (!techplayUrl) {
      setWorkflow((current) => ({
        ...current,
        techPlayFetchStatus: "not_found",
      }));
      return;
    }

    setWorkflow((current) => ({ ...current, techPlayFetchStatus: "fetching" }));
    const preview = await fetchTechPlayEventInfo(techplayUrl, input.authToken);
    if (input.workflowId !== workflowIdRef.current) {
      return;
    }

    const nextCalendar = {
      ...input.calendar,
      techplayPreview: preview,
      detectedTechPlayUrl: techplayUrl,
    };

    setCalendarResult(nextCalendar);
    setWorkflow((current) => ({ ...current, techPlayFetchStatus: "fetched" }));
    setWorkflow((current) => ({
      ...current,
      tableauAnalysisStatus: "fetching",
    }));

    const analysis = await analyzePastPostsWithTableau({
      postType: input.postType,
      dashboardContext,
      calendarResult: nextCalendar,
      authToken: input.authToken,
    });

    if (input.workflowId !== workflowIdRef.current) {
      return;
    }

    setAnalysisResult(analysis);
    setPostTrendSummary(buildPostTrendSummary(analysis.result, input.postType));
    setWorkflow((current) => ({
      ...current,
      tableauAnalysisStatus: "completed",
    }));
  }

  function clearWorkflowState() {
    if (uploadedImage?.objectUrl) {
      URL.revokeObjectURL(uploadedImage.objectUrl);
    }

    setSelectedCalendarEventId(null);
    setCalendarResult(null);
    setAnalysisResult(null);
    setPostTrendSummary([]);
    setImageMode(null);
    setUploadedImage(null);
    setImagePreviewExpanded(false);
    setNoImageSituationMemo("");
    setComposerText("");
    setManualTechPlayUrl("");
    setGenerationStatus("idle");
    setGeneratedDraft(null);
    setDraftExpanded(true);
    setPendingPost(null);
    setPostingStatus({ slack: "idle", x: "idle" });
    setCompletedPosts([]);
    setError(null);
  }

  function resetConversation() {
    clearWorkflowState();
    setWorkflow({
      postType: null,
      calendarLookupStatus: "idle",
      techPlayFetchStatus: "idle",
      tableauAnalysisStatus: "idle",
    });
    setMessages(INITIAL_MESSAGES);
    workflowIdRef.current += 1;
  }

  function handleSceneSelect(postType: ActionRunPostType) {
    setWorkflow((current) => ({ ...current, postType }));
    void beginWorkflow(postType);
  }

  function handleImageModeSelect(mode: "camera" | "library" | "none") {
    setImageMode(mode);
    setMessages((current) => [
      ...current,
      {
        id: crypto.randomUUID(),
        role: "user",
        lines: [
          IMAGE_OPTIONS.find((option) => option.value === mode)?.label ?? mode,
        ],
      },
    ]);

    if (mode === "none") {
      setMessages((current) => [
        ...current,
        {
          id: crypto.randomUUID(),
          role: "assistant",
          lines: [
            "画像なしで投稿文を作成します。",
            "会場の状況を一言で教えてください。",
          ],
        },
      ]);
      window.setTimeout(() => manualTechPlayInputRef.current?.focus(), 0);
      return;
    }

    fileInputRef.current?.click();
  }

  function handleUploadImage(event: ChangeEvent<HTMLInputElement>) {
    const file = event.currentTarget.files?.[0];
    if (!file) {
      return;
    }

    if (uploadedImage?.objectUrl) {
      URL.revokeObjectURL(uploadedImage.objectUrl);
    }

    const nextImage: UploadedImage = {
      fileName: file.name,
      objectUrl: URL.createObjectURL(file),
      sizeLabel: formatFileSize(file.size),
    };

    setUploadedImage(nextImage);
    setImagePreviewExpanded(false);
    setMessages((current) => [
      ...current,
      {
        id: crypto.randomUUID(),
        role: "user",
        lines: ["画像をアップロードしました。"],
      },
      {
        id: crypto.randomUUID(),
        role: "assistant",
        lines: ["画像を確認しました。会場情報と投稿案をまとめます。"],
      },
    ]);
  }

  async function handleManualTechPlaySubmit(event: FormEvent) {
    event.preventDefault();
    const nextUrl = manualTechPlayUrl.trim();
    if (!nextUrl) {
      return;
    }

    try {
      setWorkflow((current) => ({
        ...current,
        techPlayFetchStatus: "fetching",
      }));
      const preview = await fetchTechPlayEventInfo(nextUrl, authToken);
      const nextCalendar = calendarResult
        ? {
            ...calendarResult,
            detectedTechPlayUrl: nextUrl,
            techplayPreview: preview,
          }
        : null;
      setCalendarResult(nextCalendar);
      setWorkflow((current) => ({
        ...current,
        techPlayFetchStatus: "fetched",
      }));
      setMessages((current) => [
        ...current,
        { id: crypto.randomUUID(), role: "user", lines: [nextUrl] },
        {
          id: crypto.randomUUID(),
          role: "assistant",
          lines: ["TechPlay URL を確認しました。"],
        },
      ]);

      if (selectedPostType && nextCalendar) {
        setWorkflow((current) => ({
          ...current,
          tableauAnalysisStatus: "fetching",
        }));
        const analysis = await analyzePastPostsWithTableau({
          postType: selectedPostType,
          dashboardContext,
          calendarResult: nextCalendar,
          authToken,
        });
        setAnalysisResult(analysis);
        setPostTrendSummary(
          buildPostTrendSummary(analysis.result, selectedPostType),
        );
        setWorkflow((current) => ({
          ...current,
          tableauAnalysisStatus: "completed",
        }));
      }
    } catch (manualError) {
      setWorkflow((current) => ({ ...current, techPlayFetchStatus: "error" }));
      setError(
        manualError instanceof Error
          ? manualError.message
          : "TechPlay URLの取得に失敗しました。",
      );
      return;
    }
  }

  function handleNoImageMemoSubmit(event: FormEvent) {
    event.preventDefault();
    if (!noImageSituationMemo.trim()) {
      return;
    }
    setMessages((current) => [
      ...current,
      {
        id: crypto.randomUUID(),
        role: "user",
        lines: [noImageSituationMemo.trim()],
      },
      {
        id: crypto.randomUUID(),
        role: "assistant",
        lines: [
          "画像なしで投稿文を作成します。",
          "会場の状況を一言で教えてください。",
        ],
      },
    ]);
  }

  function handleComposerSubmit(event: FormEvent) {
    event.preventDefault();
    const text = composerText.trim();
    if (!text) {
      return;
    }

    setComposerText("");
    setMessages((current) => [
      ...current,
      { id: crypto.randomUUID(), role: "user", lines: [text] },
    ]);

    if (selectedPostType === "開催中の実況" && imageMode === "none") {
      setNoImageSituationMemo(text);
      setMessages((current) => [
        ...current,
        {
          id: crypto.randomUUID(),
          role: "assistant",
          lines: ["受け取りました。画像なしで投稿文を作成します。"],
        },
      ]);
      return;
    }

    setMessages((current) => [
      ...current,
      {
        id: crypto.randomUUID(),
        role: "assistant",
        lines: ["受け取りました。必要に応じて投稿案を調整します。"],
      },
    ]);
  }

  function handleChooseCalendarCandidate(candidateId: string) {
    const candidate =
      calendarResult?.candidates.find(
        ({ eventId }) => eventId === candidateId,
      ) ?? null;
    if (!candidate || !calendarResult || !selectedPostType) {
      return;
    }

    setSelectedCalendarEventId(candidateId);
    void continueWorkflowWithCalendar({
      workflowId: workflowIdRef.current,
      postType: selectedPostType,
      calendar: {
        ...calendarResult,
        selectedEvent: candidate,
      },
      selectedCandidate: candidate,
      authToken,
    });
  }

  function openPostConfirmation(channel: "slack" | "x") {
    if (!generatedDraft) {
      return;
    }

    setPendingPost({
      channel,
      text:
        channel === "slack"
          ? generatedDraft.slackPostText
          : generatedDraft.xPostText,
    });
  }

  async function confirmPendingPost() {
    if (!pendingPost || !generatedDraft) {
      return;
    }

    try {
      if (pendingPost.channel === "slack") {
        setPostingStatus((current) => ({ ...current, slack: "posting" }));
        const response = await postToSlack({
          draft: generatedDraft,
          accessToken: authToken,
          ownerToken: generatedDraft.analysis.ownerToken,
        });
        setPostingStatus((current) => ({ ...current, slack: "done" }));
        setCompletedPosts((current) => [
          ...current,
          {
            channel: "slack",
            text: generatedDraft.slackPostText,
            openLabel: "Slackを開く",
            postedAt: new Date().toISOString(),
            url: response.slackWebhook.sent ? "https://slack.com" : undefined,
          },
        ]);
        setDraftExpanded(false);
        setMessages((current) => [
          ...current,
          {
            id: crypto.randomUUID(),
            role: "assistant",
            lines: ["Slackに投稿しました。"],
          },
        ]);
      } else {
        setPostingStatus((current) => ({ ...current, x: "posting" }));
        const response = await postToX({ draft: generatedDraft });
        setPostingStatus((current) => ({ ...current, x: "done" }));
        setCompletedPosts((current) => [...current, response]);
        setDraftExpanded(false);
        setMessages((current) => [
          ...current,
          {
            id: crypto.randomUUID(),
            role: "assistant",
            lines: ["Xに投稿しました。"],
          },
        ]);
      }
      setPendingPost(null);
    } catch (postError) {
      if (pendingPost.channel === "slack") {
        setPostingStatus((current) => ({ ...current, slack: "error" }));
      } else {
        setPostingStatus((current) => ({ ...current, x: "error" }));
      }
      setError(
        postError instanceof Error ? postError.message : "投稿に失敗しました。",
      );
    }
  }

  async function handleConnectService(service: keyof ServiceConnections) {
    if (service === "google") {
      setIsServiceMenuOpen(false);
      setIsGoogleConnecting(true);
      try {
        await startGoogleCalendarConnection(
          authToken,
          window.location.pathname + window.location.search,
        );
        setServiceConnections((current) => ({ ...current, google: true }));
      } catch (googleError) {
        setError(
          googleError instanceof Error
            ? googleError.message
            : "Google接続に失敗しました。",
        );
      } finally {
        setIsGoogleConnecting(false);
      }
      return;
    }

    setServiceConnections((current) => ({ ...current, [service]: true }));
    window.localStorage.setItem(
      "tableau-ai-pr-agent.service-connections",
      JSON.stringify({ ...serviceConnections, [service]: true }),
    );
    setIsServiceMenuOpen(false);
  }

  return (
    <section className="pr-post-agent-shell" aria-label="PR投稿エージェント">
      <header className="pr-post-agent-header">
        <div className="pr-post-agent-header-copy">
          <h1>PR投稿エージェント</h1>
          <p>過去の投稿を分析し、最適な投稿を提案します。</p>
        </div>
        <div
          className="pr-post-agent-avatar"
          title={userDisplayName ?? "Guest"}
          aria-label={userDisplayName ? `User: ${userDisplayName}` : "User"}
        >
          <UserAvatarIcon />
        </div>
      </header>

      <div className="pr-post-agent-divider" />

      <p className="pr-post-agent-context">
        参照中：<strong>{dashboardContext.dashboardName}</strong>
        {dashboardContext.workbookName ? (
          <span> / {dashboardContext.workbookName}</span>
        ) : null}
      </p>

      {!serviceConnections.google ? (
        <p className="pr-post-agent-connection-note">
          Googleは + メニューから接続できます。
        </p>
      ) : null}

      {selectedPostType &&
      selectedPostType !== "開催中の実況" &&
      !generatedDraft ? (
        <div className="pr-post-agent-message-note" role="status">
          投稿シーンとイベント情報をもとに進めます。
        </div>
      ) : null}

      <section className="pr-post-agent-chat" aria-label="会話ログ">
        {messages.map((message) => (
          <ChatBubble key={message.id} role={message.role}>
            {message.lines.map((line) => (
              <p key={line}>{line}</p>
            ))}
          </ChatBubble>
        ))}

        {hasCalendarCandidates ? (
          <ChatBubble role="assistant">
            <div className="pr-post-agent-choice-block">
              <p>今日のイベント候補が複数見つかりました。どれを使いますか？</p>
              <div className="pr-post-agent-choice-row">
                {calendarResult?.candidates.map((candidate) => (
                  <button
                    key={candidate.eventId}
                    type="button"
                    className={`pr-post-agent-choice${candidate.eventId === selectedCalendarEventId ? " is-active" : ""}`}
                    onClick={() =>
                      handleChooseCalendarCandidate(candidate.eventId)
                    }
                  >
                    {candidate.summary}
                  </button>
                ))}
              </div>
            </div>
          </ChatBubble>
        ) : null}

        {selectedPostType === "開催中の実況" && imageMode === null ? (
          <ChatBubble role="assistant">
            <p>投稿する画像をアップロードしてください。</p>
          </ChatBubble>
        ) : null}

        {needsManualTechPlayUrl ? (
          <ChatBubble role="assistant">
            <form
              className="pr-post-agent-inline-form"
              onSubmit={handleManualTechPlaySubmit}
            >
              <p>カレンダーからTechPlay URLを見つけられませんでした。</p>
              <p>イベントページのURLを入力しますか？</p>
              <div className="pr-post-agent-inline-form-row">
                <input
                  ref={manualTechPlayInputRef}
                  type="url"
                  placeholder="https://techplay.jp/event/xxxxx"
                  value={manualTechPlayUrl}
                  onChange={(event) =>
                    setManualTechPlayUrl(event.currentTarget.value)
                  }
                />
                <button type="submit">送信</button>
              </div>
            </form>
          </ChatBubble>
        ) : null}

        {selectedPostType === "開催中の実況" && imageMode === "none" ? (
          <ChatBubble role="assistant">
            <form
              className="pr-post-agent-inline-form"
              onSubmit={handleNoImageMemoSubmit}
            >
              <p>画像なしで投稿文を作成します。</p>
              <p>会場の状況を一言で教えてください。</p>
              <div className="pr-post-agent-inline-form-row">
                <input
                  type="text"
                  value={noImageSituationMemo}
                  onChange={(event) =>
                    setNoImageSituationMemo(event.currentTarget.value)
                  }
                  placeholder="会場に人が集まり始めています"
                />
                <button type="submit">送信</button>
              </div>
            </form>
          </ChatBubble>
        ) : null}

        {uploadedImage ? (
          <ChatBubble role="user">
            <details
              className="pr-post-agent-upload-card"
              open={imagePreviewExpanded}
              onToggle={(event) =>
                setImagePreviewExpanded(event.currentTarget.open)
              }
            >
              <summary>
                <span>画像をアップロードしました。</span>
                <button type="button" className="pr-post-agent-link-button">
                  {imagePreviewExpanded
                    ? "プレビューを非表示"
                    : "プレビューを表示"}
                </button>
              </summary>
              <div className="pr-post-agent-upload-preview">
                <img
                  src={uploadedImage.objectUrl}
                  alt={uploadedImage.fileName}
                />
                <div>
                  <strong>{uploadedImage.fileName}</strong>
                  <span>{uploadedImage.sizeLabel}</span>
                </div>
              </div>
            </details>
          </ChatBubble>
        ) : null}

        {generationStatus === "generating" ? (
          <ChatBubble role="assistant">
            <div className="pr-post-agent-status">
              <strong>回答を生成中</strong>
              <ul>
                <li>会話履歴を確認中…</li>
                {selectedPostType ? <li>投稿シーン選択済み</li> : null}
                {selectedPostType === "開催中の実況" && uploadedImage ? (
                  <li>画像アップロード完了</li>
                ) : null}
                {selectedPostType === "開催中の実況" && imageMode === "none" ? (
                  <li>画像を投稿しないを選択済み</li>
                ) : null}
                <li>Google/Slack接続状態確認済み</li>
                <li>
                  {workflow.calendarLookupStatus === "searching"
                    ? "Googleカレンダー / TechPlay取得中…"
                    : "Googleカレンダー / TechPlay取得完了"}
                </li>
                <li>
                  {workflow.tableauAnalysisStatus === "fetching"
                    ? "過去投稿データを分析中…"
                    : "過去投稿データの分析完了"}
                </li>
                <li>投稿シーンに合う傾向を確認中…</li>
                <li>投稿文を作成中…</li>
              </ul>
            </div>
          </ChatBubble>
        ) : null}

        {generatedDraft ? (
          <ChatBubble role="assistant">
            <article className="pr-post-agent-draft">
              <div className="pr-post-agent-draft-head">
                <p className="pr-post-agent-draft-eyebrow">
                  過去投稿の傾向をもとに作成しました
                </p>
                <button
                  type="button"
                  className="pr-post-agent-link-button"
                  onClick={() => setDraftExpanded((current) => !current)}
                >
                  {draftExpanded ? "プレビューを非表示" : "プレビューを表示"}
                </button>
              </div>

              {draftExpanded ? (
                <>
                  <div className="pr-post-agent-draft-summary">
                    <ul>
                      {postTrendSummary.map((line) => (
                        <li key={line}>{line}</li>
                      ))}
                    </ul>
                  </div>

                  <div className="pr-post-agent-draft-copy">
                    <strong>投稿文</strong>
                    <pre>{generatedDraft.slackPostText}</pre>
                  </div>

                  <div className="pr-post-agent-draft-url">
                    <strong>URL</strong>
                    <a
                      href={generatedDraft.techplayUrl}
                      target="_blank"
                      rel="noreferrer"
                    >
                      {generatedDraft.techplayUrl}
                    </a>
                  </div>

                  {uploadedImage ? (
                    <div className="pr-post-agent-draft-thumb">
                      <img
                        src={uploadedImage.objectUrl}
                        alt={uploadedImage.fileName}
                      />
                    </div>
                  ) : null}

                  {generatedDraft.techplayPreview ? (
                    <p className="pr-post-agent-draft-preview-note">
                      {generatedDraft.techplayPreview.summary}
                    </p>
                  ) : null}
                </>
              ) : (
                <p className="pr-post-agent-draft-collapsed">
                  生成済みの投稿案を省略表示しています。
                </p>
              )}

              <div className="pr-post-agent-draft-actions">
                <button
                  type="button"
                  className="pr-post-agent-secondary-button"
                  disabled={
                    !serviceConnections.slack ||
                    postingStatus.slack === "posting"
                  }
                  onClick={() => openPostConfirmation("slack")}
                >
                  Slackに投稿
                </button>
                <button
                  type="button"
                  className="pr-post-agent-secondary-button"
                  disabled={postingStatus.x === "posting"}
                  onClick={() => openPostConfirmation("x")}
                >
                  Xに投稿
                </button>
              </div>

              {!serviceConnections.slack ? (
                <p className="pr-post-agent-hint">
                  Slackに接続すると、この内容を投稿できます。
                </p>
              ) : null}
            </article>
          </ChatBubble>
        ) : null}

        {completedPosts.map((post) => (
          <ChatBubble key={`${post.channel}-${post.postedAt}`} role="assistant">
            <div className="pr-post-agent-posted">
              <span>
                {post.channel === "slack"
                  ? "Slackに投稿しました。"
                  : "Xに投稿しました。"}{" "}
                <a
                  href={
                    post.url ??
                    (post.channel === "slack"
                      ? "https://slack.com"
                      : "https://x.com")
                  }
                  target="_blank"
                  rel="noreferrer"
                >
                  [{post.openLabel}]
                </a>
              </span>
              <details>
                <summary>投稿内容を開く</summary>
                <pre>{post.text}</pre>
              </details>
            </div>
          </ChatBubble>
        ))}

        {error ? (
          <ChatBubble role="assistant">
            <div className="pr-post-agent-error" role="alert">
              {error}
            </div>
          </ChatBubble>
        ) : null}

        {selectedPostType === null ? (
          <div className="pr-post-agent-choice-stack pr-post-agent-choice-stack--user">
            {SCENE_OPTIONS.map((option) => (
              <button
                key={option.value}
                type="button"
                className="pr-post-agent-choice"
                onClick={() => void handleSceneSelect(option.value)}
              >
                {option.label}
              </button>
            ))}
          </div>
        ) : null}

        {selectedPostType === "開催中の実況" && imageMode === null ? (
          <div className="pr-post-agent-choice-stack pr-post-agent-choice-stack--user">
            {IMAGE_OPTIONS.map((option) => (
              <button
                key={option.value}
                type="button"
                className="pr-post-agent-choice"
                onClick={() => handleImageModeSelect(option.value)}
              >
                {option.label}
              </button>
            ))}
          </div>
        ) : null}
      </section>

      <footer className="pr-post-agent-footer">
        <div className="pr-post-agent-plus-menu">
          <button
            type="button"
            className="pr-post-agent-plus-button"
            aria-expanded={isServiceMenuOpen}
            aria-controls="service-menu"
            onClick={() => setIsServiceMenuOpen((current) => !current)}
          >
            +
          </button>
          {isServiceMenuOpen ? (
            <div id="service-menu" className="pr-post-agent-service-menu">
              <button
                type="button"
                disabled={isGoogleConnecting || serviceConnections.google}
                onClick={() => void handleConnectService("google")}
              >
                {serviceConnections.google ? "Google 接続済" : "Googleに接続"}
              </button>
              <button
                type="button"
                disabled={serviceConnections.slack}
                onClick={() => void handleConnectService("slack")}
              >
                {serviceConnections.slack ? "Slack 接続済" : "Slackに接続"}
              </button>
              <button
                type="button"
                disabled={serviceConnections.x}
                onClick={() => void handleConnectService("x")}
              >
                {serviceConnections.x ? "X 接続済" : "Xに接続"}
              </button>
              <button type="button" onClick={() => resetConversation()}>
                会話をやり直す
              </button>
            </div>
          ) : null}
        </div>

        <form
          className="pr-post-agent-composer"
          onSubmit={handleComposerSubmit}
        >
          <textarea
            aria-label="追加メッセージ"
            rows={1}
            placeholder="追加の要望があれば入力"
            value={composerText}
            onChange={(event) => setComposerText(event.currentTarget.value)}
          />
          <button type="submit" disabled={!composerText.trim()}>
            送信
          </button>
        </form>
      </footer>

      <input
        ref={fileInputRef}
        className="pr-post-agent-hidden-input"
        type="file"
        accept="image/*"
        capture={imageMode === "camera" ? "environment" : undefined}
        onChange={handleUploadImage}
      />

      {pendingPost ? (
        <div className="pr-post-agent-modal-backdrop" role="presentation">
          <section
            className="pr-post-agent-modal"
            aria-label="投稿確認"
            role="dialog"
            aria-modal="true"
          >
            <h2>上記の内容で投稿しますか？</h2>
            <pre className="pr-post-agent-modal-preview">
              {pendingPost.text}
            </pre>
            <div className="pr-post-agent-modal-actions">
              <button
                type="button"
                className="pr-post-agent-secondary-button"
                onClick={() => setPendingPost(null)}
              >
                キャンセル
              </button>
              <button
                type="button"
                className="pr-post-agent-primary-button"
                onClick={() => void confirmPendingPost()}
              >
                {pendingPost.channel === "slack" ? "Slackに投稿" : "Xに投稿"}
              </button>
            </div>
          </section>
        </div>
      ) : null}
    </section>
  );
}

function ChatBubble({
  children,
  role,
}: {
  children: ReactNode;
  role: "assistant" | "user";
}) {
  return (
    <article className={`pr-post-agent-bubble ${role}`}>{children}</article>
  );
}

function UserAvatarIcon() {
  return (
    <svg
      className="pr-post-agent-avatar-icon"
      viewBox="0 0 24 24"
      aria-hidden="true"
    >
      <circle cx="12" cy="8" r="3.25" />
      <path d="M5 19c1.7-3.4 4.7-5.1 7-5.1S18.3 15.6 19 19" />
    </svg>
  );
}

function loadConnections(): ServiceConnections {
  try {
    const raw = window.localStorage.getItem(
      "tableau-ai-pr-agent.service-connections",
    );
    if (!raw) {
      return DEFAULT_CONNECTIONS;
    }

    const parsed = JSON.parse(raw) as Partial<ServiceConnections>;
    return {
      google: parsed.google ?? false,
      slack: parsed.slack ?? true,
      x: parsed.x ?? true,
    };
  } catch {
    return DEFAULT_CONNECTIONS;
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
