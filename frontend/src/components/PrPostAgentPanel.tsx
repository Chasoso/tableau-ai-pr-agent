import { useEffect, useMemo, useRef, useState } from "react";
import type { ChangeEvent, FormEvent, ReactNode } from "react";
import { ensureChatJobOwnerToken } from "../api/chatJobOwnerToken";
import type {
  ActionRunGetResponse,
  ActionRunPostType,
  ActionRunResult,
} from "../types/actionRun";
import type {
  CalendarEventCandidate,
  CalendarResolveResponse,
} from "../types/calendar";
import type { DashboardContext } from "../types/tableau";
import type { GeneratedPostSuggestion } from "../types/actionRun";
import type {
  GeneratedPrPostDraft,
  PostedResult,
  ServiceConnections,
  TableauAnalysisResult,
  UploadedImage,
} from "../services/prPostAgent";
import {
  analyzePastPostsWithTableau,
  fetchTechPlayEventInfo,
  generatePrPostDraft,
  postToBluesky,
  postToSlack,
  resolveCalendarEventContext,
} from "../services/prPostAgent";
import GeneratedPostSuggestionsPanel from "./GeneratedPostSuggestionsPanel";
import {
  loadGoogleCalendarConnectionStatus,
  startGoogleCalendarConnection,
} from "../services/googleCalendarConnection";
import { uploadActionRunInputImage } from "../api/actionRunImageApi";
import { prepareImageAnalysisPayload } from "../utils/prepareImageAnalysisPayload";
import { countPostTextCharacters, POST_TEXT_LIMIT } from "../utils/postText";

type Props = {
  dashboardContext: DashboardContext;
  userDisplayName?: string;
  authToken?: string;
  connectionScopeKey?: string;
};

type ChatMessage = {
  id: string;
  role: "assistant" | "user";
  lines: string[];
};

type GenerationStatus = "idle" | "generating" | "generated" | "error";

type SelectedSuggestion = {
  id: string;
  index: number;
  suggestion: GeneratedPostSuggestion;
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
  slack: false,
};

export default function PrPostAgentPanel({
  dashboardContext,
  userDisplayName,
  authToken,
  connectionScopeKey,
}: Props) {
  const workflowIdRef = useRef(0);
  const tableauAnalysisInFlightRef = useRef<number | null>(null);
  const uiSuggestionLogRef = useRef<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const manualTechPlayInputRef = useRef<HTMLInputElement | null>(null);
  const [anonymousConnectionToken, setAnonymousConnectionToken] = useState<
    string | null
  >(null);
  const resolvedConnectionScopeKey =
    connectionScopeKey ??
    (anonymousConnectionToken ? `anon:${anonymousConnectionToken}` : undefined);
  const resolvedConnectionOwnerToken = useMemo(
    () => resolveConnectionOwnerToken(resolvedConnectionScopeKey),
    [resolvedConnectionScopeKey],
  );

  const [messages, setMessages] = useState<ChatMessage[]>(INITIAL_MESSAGES);
  const [serviceConnections, setServiceConnections] =
    useState<ServiceConnections>(() =>
      loadConnections(resolvedConnectionScopeKey),
    );
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
  const [selectedSuggestion, setSelectedSuggestion] =
    useState<SelectedSuggestion | null>(null);
  const [slackEditedText, setSlackEditedText] = useState("");
  const [approvedSuggestion, setApprovedSuggestion] =
    useState<SelectedSuggestion | null>(null);
  const [actionRunStatus, setActionRunStatus] =
    useState<ActionRunGetResponse | null>(null);
  const [isApprovalOpen, setIsApprovalOpen] = useState(false);
  const [slackPostStatus, setSlackPostStatus] = useState<
    "idle" | "posting" | "posted" | "failed"
  >("idle");
  const [slackPostError, setSlackPostError] = useState<string | null>(null);
  const [isBlueskyApprovalOpen, setIsBlueskyApprovalOpen] = useState(false);
  const [blueskyPostStatus, setBlueskyPostStatus] = useState<
    "idle" | "posting" | "posted" | "failed"
  >("idle");
  const [blueskyPostError, setBlueskyPostError] = useState<string | null>(null);
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
  const generatedPostSuggestions = useMemo(
    () =>
      analysisResult?.result.generatedPostSuggestions?.length
        ? analysisResult.result.generatedPostSuggestions
        : analysisResult?.result.generatedPostSuggestion
          ? [analysisResult.result.generatedPostSuggestion]
          : [],
    [
      analysisResult?.result.generatedPostSuggestions,
      analysisResult?.result.generatedPostSuggestion,
    ],
  );
  const activeSuggestion = selectedSuggestion ?? approvedSuggestion;
  const visiblePostSuggestions = activeSuggestion
    ? [activeSuggestion.suggestion]
    : generatedPostSuggestions;
  const attachedImagePreviewUrl =
    analysisResult?.result.attachedImage?.url ??
    uploadedImage?.objectUrl ??
    generatedDraft?.image?.objectUrl ??
    undefined;
  const attachedImagePreviewLabel =
    uploadedImage?.fileName ??
    analysisResult?.result.attachedImage?.objectKey?.split("/").pop() ??
    "添付予定画像";
  const visibleSelectedSuggestionId = activeSuggestion ? "suggestion-0" : null;
  const isSlackPosting = slackPostStatus === "posting";
  const isBlueskyPosting = blueskyPostStatus === "posting";
  const activeBlueskySuggestion = approvedSuggestion ?? selectedSuggestion;
  const approvalEvidenceLines =
    analysisResult?.result.evidence?.slice(0, 5) ?? [];
  const approvalCheckLines = analysisResult?.result.checks?.slice(0, 5) ?? [];
  const approvalTableauSignals = buildApprovalTableauSignals(
    analysisResult?.result.evidencePack,
  );
  const approvalDebugLines = buildApprovalDebugLines(analysisResult?.result);
  const slackApprovalTextLength = countPostTextCharacters(
    slackEditedText.trim() || selectedSuggestion?.suggestion.text.trim() || "",
  );

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
      !uploadedImage?.inputImageObjectKey
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
    if (!generatedPostSuggestions.length) {
      return;
    }

    const logKey = [
      analysisResult?.result.primaryOutputType ?? "unknown",
      generatedPostSuggestions.length,
      Boolean(attachedImagePreviewUrl),
    ].join(":");
    if (uiSuggestionLogRef.current === logKey) {
      return;
    }

    uiSuggestionLogRef.current = logKey;
    console.debug(
      "ui.primaryOutputType",
      analysisResult?.result.primaryOutputType ?? "analysis_summary",
    );
    console.debug("ui.postSuggestions.rendered", true);
    console.debug("ui.postSuggestions.count", generatedPostSuggestions.length);
    console.debug("ui.suggestionCarousel.rendered", true);
    console.debug("ui.analysisDetails.collapsedByDefault", true);
    console.debug("ui.attachedImage.present", Boolean(attachedImagePreviewUrl));
  }, [
    analysisResult?.result.primaryOutputType,
    attachedImagePreviewUrl,
    generatedPostSuggestions.length,
  ]);

  useEffect(() => {
    return () => {
      if (uploadedImage?.objectUrl) {
        URL.revokeObjectURL(uploadedImage.objectUrl);
      }
    };
  }, [uploadedImage?.objectUrl]);

  useEffect(() => {
    if (connectionScopeKey) {
      return;
    }

    setAnonymousConnectionToken(ensureChatJobOwnerToken());
  }, [connectionScopeKey]);

  useEffect(() => {
    setServiceConnections(loadConnections(resolvedConnectionScopeKey));
  }, [resolvedConnectionScopeKey]);

  useEffect(() => {
    if (!resolvedConnectionScopeKey) {
      return;
    }

    saveConnections(resolvedConnectionScopeKey, serviceConnections);
  }, [resolvedConnectionScopeKey, serviceConnections]);

  useEffect(() => {
    let cancelled = false;

    void (async () => {
      try {
        const connectionStatus = await loadGoogleCalendarConnectionStatus(
          authToken,
          resolvedConnectionOwnerToken ?? undefined,
        );
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
  }, [authToken, resolvedConnectionOwnerToken]);

  useEffect(() => {
    if (
      !selectedPostType ||
      !calendarResult ||
      workflow.techPlayFetchStatus !== "fetched" ||
      workflow.tableauAnalysisStatus === "fetching" ||
      workflow.tableauAnalysisStatus === "completed"
    ) {
      return;
    }

    if (
      selectedPostType === "開催中の実況" &&
      imageMode !== "none" &&
      !uploadedImage?.inputImageObjectKey
    ) {
      return;
    }

    void runTableauAnalysisIfReady({
      workflowId: workflowIdRef.current,
      postType: selectedPostType,
      calendar: calendarResult,
      image: uploadedImage,
    });
  }, [
    calendarResult,
    imageMode,
    selectedPostType,
    uploadedImage,
    workflow.tableauAnalysisStatus,
    workflow.techPlayFetchStatus,
  ]);

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
        if (
          selectedPostType === "開催中の実況" &&
          imageMode !== "none" &&
          !uploadedImage?.inputImageObjectKey
        ) {
          throw new Error(
            "画像のアップロードが完了していません。もう一度アップロードしてください。",
          );
        }

        const draft = await generatePrPostDraft({
          postType: selectedPostType!,
          dashboardContext,
          calendarResult,
          analysis: analysisResult,
          image: uploadedImage,
          noImageSituationMemo:
            imageMode === "none" ? noImageSituationMemo.trim() : undefined,
          manualTechPlayUrl: manualTechPlayUrl.trim() || undefined,
          authToken,
          ownerToken: resolvedConnectionOwnerToken ?? undefined,
        });

        if (cancelled) {
          return;
        }

        setGeneratedDraft(draft);
        setGenerationStatus("generated");
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
    resolvedConnectionOwnerToken,
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
        resolvedConnectionOwnerToken ?? undefined,
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
    const preview = await fetchTechPlayEventInfo(
      techplayUrl,
      input.authToken,
      resolvedConnectionOwnerToken ?? undefined,
    );
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
    await runTableauAnalysisIfReady({
      workflowId: input.workflowId,
      postType: input.postType,
      calendar: nextCalendar,
      image: uploadedImage,
    });
  }

  function clearWorkflowState() {
    if (uploadedImage?.objectUrl) {
      URL.revokeObjectURL(uploadedImage.objectUrl);
    }

    setSelectedCalendarEventId(null);
    setCalendarResult(null);
    setAnalysisResult(null);
    setImageMode(null);
    setUploadedImage(null);
    setImagePreviewExpanded(false);
    setNoImageSituationMemo("");
    setComposerText("");
    setManualTechPlayUrl("");
    setGenerationStatus("idle");
    setGeneratedDraft(null);
    setSelectedSuggestion(null);
    setApprovedSuggestion(null);
    setActionRunStatus(null);
    setIsApprovalOpen(false);
    setSlackPostStatus("idle");
    setSlackPostError(null);
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

  async function handleUploadImage(event: ChangeEvent<HTMLInputElement>) {
    const file = event.currentTarget.files?.[0];
    if (!file) {
      return;
    }

    try {
      console.debug("[pr-agent] imageSelectionChanged", {
        imageMode,
        selectedImageFilePresent: Boolean(file),
        selectedImageFileName: file.name,
        selectedImageContentType: file.type || undefined,
        selectedImageBytes: file.size,
      });
      if (uploadedImage?.objectUrl) {
        URL.revokeObjectURL(uploadedImage.objectUrl);
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
          source: imageMode === "camera" ? "camera" : "library",
        },
        authToken,
        resolvedConnectionOwnerToken ?? undefined,
      );
      const nextImage: UploadedImage = {
        fileName: file.name,
        objectUrl: URL.createObjectURL(file),
        sizeLabel: formatFileSize(file.size),
        fileId,
        source: imageMode === "camera" ? "camera" : "library",
        mimeType: file.type || undefined,
        byteLength: uploadResult.byteLength,
        width: uploadResult.width ?? analysisPayload.width,
        height: uploadResult.height ?? analysisPayload.height,
        originalDataUrl: analysisPayload.originalDataUrl,
        analysisDataUrl: analysisPayload.analysisDataUrl,
        analysisCompressionLabel: analysisPayload.compressionLabel,
        inputImageObjectKey: uploadResult.objectKey,
      };

      setUploadedImage(nextImage);
      setImagePreviewExpanded(false);
      console.debug("[pr-agent] imageUploadCompleted", {
        uploadedImageObjectKeyPresent: Boolean(uploadResult.objectKey),
        uploadedImageObjectKey: uploadResult.objectKey,
        uploadedImageContentType: uploadResult.contentType,
        uploadedImageBytes: uploadResult.byteLength,
        uploadedImageWidth: uploadResult.width,
        uploadedImageHeight: uploadResult.height,
      });
      console.debug("[pr-agent] actionRunImageLinked", {
        inputImageSource: imageMode === "camera" ? "camera" : "library",
        inputImageObjectKey: uploadResult.objectKey,
        inputImageContentType: uploadResult.contentType,
        inputImageBytes: uploadResult.byteLength,
        inputImageWidth: uploadResult.width,
        inputImageHeight: uploadResult.height,
      });
      if (selectedPostType && calendarResult) {
        void runTableauAnalysisIfReady({
          workflowId: workflowIdRef.current,
          postType: selectedPostType!,
          calendar: calendarResult,
          image: nextImage,
        });
      }
    } catch (uploadError) {
      setError(
        uploadError instanceof Error
          ? uploadError.message
          : "画像の読み込みに失敗しました。",
      );
    }
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
      const preview = await fetchTechPlayEventInfo(
        nextUrl,
        authToken,
        resolvedConnectionOwnerToken ?? undefined,
      );
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
        void runTableauAnalysisIfReady({
          workflowId: workflowIdRef.current,
          postType: selectedPostType,
          calendar: nextCalendar,
          image: uploadedImage,
        });
      }
    } catch (analysisError) {
      setWorkflow((current) => ({ ...current, techPlayFetchStatus: "error" }));
      setError(
        analysisError instanceof Error
          ? analysisError.message
          : "TechPlay URLの取得に失敗しました。",
      );
      return;
    }
  }

  async function runTableauAnalysisIfReady(input: {
    workflowId: number;
    postType: ActionRunPostType;
    calendar: CalendarResolveResponse;
    image?: UploadedImage | null;
  }) {
    if (input.workflowId !== workflowIdRef.current) {
      return;
    }

    if (tableauAnalysisInFlightRef.current !== null) {
      return;
    }

    if (workflow.tableauAnalysisStatus === "completed") {
      return;
    }

    const requiresImage =
      input.postType === "開催中の実況" && imageMode !== "none";
    if (requiresImage && !input.image?.inputImageObjectKey) {
      return;
    }

    tableauAnalysisInFlightRef.current = input.workflowId;
    setWorkflow((current) => ({
      ...current,
      tableauAnalysisStatus: "fetching",
    }));

    try {
      const analysis = await analyzePastPostsWithTableau({
        postType: input.postType,
        dashboardContext,
        calendarResult: input.calendar,
        image: input.image ?? null,
        authToken,
        ownerToken: resolvedConnectionOwnerToken ?? undefined,
        onProgress: (job) => {
          setActionRunStatus(job);
        },
      });

      if (input.workflowId !== workflowIdRef.current) {
        return;
      }

      setAnalysisResult(analysis);
      setWorkflow((current) => ({
        ...current,
        tableauAnalysisStatus: "completed",
      }));
    } catch (analysisError) {
      if (input.workflowId !== workflowIdRef.current) {
        return;
      }

      setWorkflow((current) => ({
        ...current,
        tableauAnalysisStatus: "error",
      }));
      setError(
        analysisError instanceof Error
          ? analysisError.message
          : "Tableau分析に失敗しました。",
      );
    } finally {
      if (tableauAnalysisInFlightRef.current === input.workflowId) {
        tableauAnalysisInFlightRef.current = null;
      }
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

  function handleSuggestionSelect(input: {
    suggestion: GeneratedPostSuggestion;
    suggestionId: string;
    index: number;
  }) {
    setSelectedSuggestion({
      id: input.suggestionId,
      index: input.index,
      suggestion: input.suggestion,
    });
    setSlackEditedText(input.suggestion.text);
    setApprovedSuggestion(null);
    setSlackPostError(null);
    setSlackPostStatus("idle");
    setBlueskyPostError(null);
    setBlueskyPostStatus("idle");
    setIsBlueskyApprovalOpen(false);
    setIsApprovalOpen(true);
    console.debug("ui.suggestion.selected", {
      suggestionId: input.suggestionId,
      index: input.index,
    });
    console.debug("ui.approvalModal.opened", {
      suggestionId: input.suggestionId,
    });
  }

  function handleApprovalCancel() {
    if (selectedSuggestion) {
      console.debug("ui.approvalModal.cancelled", {
        suggestionId: selectedSuggestion.id,
      });
    }

    setIsApprovalOpen(false);
    setSelectedSuggestion(null);
    setSlackEditedText("");
    setApprovedSuggestion(null);
    setSlackPostError(null);
    setSlackPostStatus("idle");
    setBlueskyPostError(null);
    setBlueskyPostStatus("idle");
    setIsBlueskyApprovalOpen(false);
  }

  async function handleSlackApprovalSubmit() {
    if (!analysisResult || !selectedSuggestion) {
      return;
    }

    setSlackPostStatus("posting");
    setSlackPostError(null);
    console.debug("ui.slackPost.started", {
      suggestionId: selectedSuggestion.id,
    });

    try {
      const response = await postToSlack({
        actionRunId: analysisResult.actionRunId,
        accessToken: authToken,
        ownerToken: analysisResult.ownerToken,
        selectedSuggestionText: selectedSuggestion.suggestion.text,
        editedText: slackEditedText,
      });
      setSlackPostStatus("posted");
      console.debug("ui.slackPost.completed", {
        suggestionId: selectedSuggestion.id,
        sent: response.slackWebhook.sent,
      });
      setCompletedPosts((current) => [
        ...current,
        {
          channel: "slack",
          text: slackEditedText.trim() || selectedSuggestion.suggestion.text,
          openLabel: "Slackを開く",
          postedAt: new Date().toISOString(),
          url: response.slackWebhook.sent ? "https://slack.com" : undefined,
        },
      ]);
      setMessages((current) => [
        ...current,
        {
          id: crypto.randomUUID(),
          role: "assistant",
          lines: ["Slackに投稿しました。続けてBlueskyにも投稿できます。"],
        },
      ]);
      setIsApprovalOpen(false);
      setApprovedSuggestion(selectedSuggestion);
      setSelectedSuggestion(null);
      setSlackEditedText("");
      setIsBlueskyApprovalOpen(true);
      setBlueskyPostError(null);
      setBlueskyPostStatus("idle");
    } catch (postError) {
      const message =
        postError instanceof Error
          ? postError.message
          : "Slackへの投稿に失敗しました。";
      setSlackPostStatus("failed");
      setSlackPostError(message);
      console.debug("ui.slackPost.failed", {
        suggestionId: selectedSuggestion.id,
        message,
      });
    }
  }

  function handleBlueskyApprovalCancel() {
    if (activeBlueskySuggestion) {
      console.debug("ui.blueskyApprovalModal.cancelled", {
        suggestionId: activeBlueskySuggestion.id,
      });
    }

    setIsBlueskyApprovalOpen(false);
    setBlueskyPostError(null);
    setBlueskyPostStatus("idle");
  }

  async function handleBlueskyApprovalSubmit() {
    if (!analysisResult || !activeBlueskySuggestion) {
      return;
    }

    setBlueskyPostStatus("posting");
    setBlueskyPostError(null);
    console.debug("ui.blueskyPost.started", {
      suggestionId: activeBlueskySuggestion.id,
    });

    try {
      const response = await postToBluesky({
        actionRunId: analysisResult.actionRunId,
        accessToken: authToken,
        ownerToken: analysisResult.ownerToken,
        selectedSuggestionText: activeBlueskySuggestion.suggestion.text,
      });
      setBlueskyPostStatus("posted");
      console.debug("ui.blueskyPost.completed", {
        suggestionId: activeBlueskySuggestion.id,
        sent: response.blueskyPost.sent,
        postUri: response.blueskyPost.postUri,
      });
      const blueskyUrl = blueskyPostUriToWebUrl(response.blueskyPost.postUri);
      setCompletedPosts((current) => [
        ...current,
        {
          channel: "bluesky",
          text: activeBlueskySuggestion.suggestion.text,
          openLabel: "Blueskyを開く",
          postedAt: new Date().toISOString(),
          url: blueskyUrl,
        },
      ]);
      setMessages((current) => [
        ...current,
        {
          id: crypto.randomUUID(),
          role: "assistant",
          lines: [
            response.blueskyPost.sent
              ? "Blueskyに投稿しました。"
              : "Blueskyへの投稿は送信されませんでした。",
          ],
        },
      ]);
      setIsBlueskyApprovalOpen(false);
      setBlueskyPostError(null);
    } catch (postError) {
      const message =
        postError instanceof Error
          ? postError.message
          : "Blueskyへの投稿に失敗しました。";
      setBlueskyPostStatus("failed");
      setBlueskyPostError(message);
      console.debug("ui.blueskyPost.failed", {
        suggestionId: activeBlueskySuggestion.id,
        message,
      });
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
          resolvedConnectionOwnerToken ?? undefined,
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
          <section
            className="pr-post-agent-upload-panel"
            aria-label="画像プレビュー"
          >
            <details
              className="pr-post-agent-upload-card"
              open={imagePreviewExpanded}
              onToggle={(event) =>
                setImagePreviewExpanded(event.currentTarget.open)
              }
            >
              <summary className="pr-post-agent-upload-summary">
                <span className="pr-post-agent-upload-summary-leading">
                  <span className="pr-post-agent-upload-summary-chevron">
                    ›
                  </span>
                  <span>画像をアップロードしました</span>
                </span>
              </summary>
              {imagePreviewExpanded ? (
                <div className="pr-post-agent-upload-preview">
                  <img
                    src={uploadedImage.objectUrl}
                    alt={uploadedImage.fileName}
                  />
                </div>
              ) : null}
            </details>
          </section>
        ) : null}

        {actionRunStatus ? (
          <section
            className="pr-post-agent-action-run-panel"
            aria-label="回答生成ステータス"
          >
            <div className="pr-post-agent-action-run-header">
              <strong>現在の回答生成ステータス</strong>
              <span>{actionRunStatus.status}</span>
            </div>
            <dl className="pr-post-agent-action-run-meta">
              <div>
                <dt>Stage</dt>
                <dd>{actionRunStatus.stage}</dd>
              </div>
              <div>
                <dt>Action Run ID</dt>
                <dd>{actionRunStatus.actionRunId}</dd>
              </div>
            </dl>
            {actionRunStatus.progressMessages.length ? (
              <ul className="pr-post-agent-action-run-progress-list">
                {actionRunStatus.progressMessages.map((message) => (
                  <li key={`${message.stage}-${message.at}`}>
                    <span className="pr-post-agent-action-run-progress-stage">
                      {message.stage}
                    </span>
                    <span className="pr-post-agent-action-run-progress-message">
                      {message.message}
                    </span>
                    <time dateTime={message.at}>
                      {new Date(message.at).toLocaleTimeString("ja-JP", {
                        hour: "2-digit",
                        minute: "2-digit",
                      })}
                    </time>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="pr-post-agent-inline-note">
                現在の回答生成メッセージを取得中です。
              </p>
            )}
          </section>
        ) : null}

        {generatedPostSuggestions.length ? (
          <ChatBubble role="assistant" className="pr-post-agent-bubble--cards">
            <GeneratedPostSuggestionsPanel
              suggestions={visiblePostSuggestions}
              primaryOutputType={analysisResult?.result.primaryOutputType}
              attachedImage={
                attachedImagePreviewUrl
                  ? {
                      src: attachedImagePreviewUrl,
                      alt: attachedImagePreviewLabel,
                      label: attachedImagePreviewLabel,
                    }
                  : null
              }
              evidencePack={analysisResult?.result.evidencePack}
              analysisSections={analysisResult?.result.analysisSections}
              selectedSuggestionId={visibleSelectedSuggestionId}
              isPosting={isSlackPosting || Boolean(activeSuggestion)}
              onSelectSuggestion={handleSuggestionSelect}
            />
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

        {completedPosts.map((post) => (
          <ChatBubble key={`${post.channel}-${post.postedAt}`} role="assistant">
            <div className="pr-post-agent-posted">
              <span>
                {post.channel === "slack"
                  ? "Slackに投稿しました"
                  : "Blueskyに投稿しました"}{" "}
                <a
                  href={
                    post.url ??
                    (post.channel === "slack"
                      ? "https://slack.com"
                      : "https://bsky.app")
                  }
                  target="_blank"
                  rel="noreferrer"
                >
                  [{post.openLabel}]
                </a>
              </span>
              <details>
                <summary>投稿文を表示</summary>
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

      {isApprovalOpen && selectedSuggestion ? (
        <section
          className="pr-post-agent-approval-bar"
          aria-label="Slack post approval"
          role="dialog"
          aria-modal="false"
        >
          <div className="pr-post-agent-approval-bar-copy">
            <p className="pr-post-agent-approval-bar-title">
              Slackに投稿しますか？
            </p>
            <p className="pr-post-agent-approval-bar-text">
              投稿文と添付画像を確認してから、Slack Incoming
              Webhookへ送信します。
            </p>
            <p className="pr-post-agent-approval-bar-text">
              字数 {slackApprovalTextLength}/{POST_TEXT_LIMIT}。
            </p>

            <label
              className="pr-post-agent-approval-text-label"
              htmlFor="slack-post-text"
            >
              投稿文
            </label>
            <textarea
              id="slack-post-text"
              className="pr-post-agent-approval-textarea"
              rows={6}
              value={slackEditedText}
              onChange={(event) =>
                setSlackEditedText(event.currentTarget.value)
              }
            />

            {attachedImagePreviewUrl ? (
              <figure className="pr-post-agent-approval-image">
                <img
                  src={attachedImagePreviewUrl}
                  alt={attachedImagePreviewLabel}
                />
              </figure>
            ) : null}

            <details className="pr-post-agent-approval-details">
              <summary>Evidence</summary>
              {approvalEvidenceLines.length ? (
                <ul>
                  {approvalEvidenceLines.map((line) => (
                    <li key={line}>{line}</li>
                  ))}
                </ul>
              ) : (
                <p>なし</p>
              )}
            </details>

            <details className="pr-post-agent-approval-details">
              <summary>Checks</summary>
              {approvalCheckLines.length ? (
                <ul>
                  {approvalCheckLines.map((line) => (
                    <li key={line}>{line}</li>
                  ))}
                </ul>
              ) : (
                <p>なし</p>
              )}
            </details>

            <details className="pr-post-agent-approval-details">
              <summary>Tableau signals / Debug info</summary>
              {approvalTableauSignals.length ? (
                <ul>
                  {approvalTableauSignals.map((line) => (
                    <li key={line}>{line}</li>
                  ))}
                </ul>
              ) : (
                <p>なし</p>
              )}
              {approvalDebugLines.length ? (
                <ul>
                  {approvalDebugLines.map((line) => (
                    <li key={line}>{line}</li>
                  ))}
                </ul>
              ) : null}
            </details>
          </div>

          <div className="pr-post-agent-approval-bar-actions">
            <button
              type="button"
              className="pr-post-agent-secondary-button"
              disabled={isSlackPosting}
              onClick={handleApprovalCancel}
            >
              キャンセル
            </button>
            <button
              type="button"
              className="pr-post-agent-primary-button"
              disabled={isSlackPosting}
              onClick={() => void handleSlackApprovalSubmit()}
            >
              {isSlackPosting ? "投稿中..." : "Slackに投稿"}
            </button>
          </div>

          {slackPostError ? (
            <div className="pr-post-agent-error" role="alert">
              {slackPostError}
            </div>
          ) : null}
        </section>
      ) : null}

      {isBlueskyApprovalOpen && activeBlueskySuggestion ? (
        <section
          className="pr-post-agent-approval-bar"
          aria-label="Bluesky投稿の承認"
          role="dialog"
          aria-modal="false"
        >
          <div className="pr-post-agent-approval-bar-copy">
            <p className="pr-post-agent-approval-bar-title">
              Blueskyへの投稿がリクエストされました
            </p>
            <p className="pr-post-agent-approval-bar-text">
              Slack 承認後の投稿案を、Bluesky App Password で API
              経由で投稿します。
            </p>
          </div>

          <div className="pr-post-agent-approval-bar-actions">
            <button
              type="button"
              className="pr-post-agent-secondary-button"
              disabled={isBlueskyPosting}
              onClick={handleBlueskyApprovalCancel}
            >
              キャンセル
            </button>
            <button
              type="button"
              className="pr-post-agent-primary-button"
              disabled={isBlueskyPosting}
              onClick={() => void handleBlueskyApprovalSubmit()}
            >
              {isBlueskyPosting ? "投稿中..." : "Blueskyに投稿"}
            </button>
          </div>

          {blueskyPostError ? (
            <div className="pr-post-agent-error" role="alert">
              {blueskyPostError}
            </div>
          ) : null}
        </section>
      ) : null}
    </section>
  );
}

function ChatBubble({
  children,
  role,
  className,
}: {
  children: ReactNode;
  role: "assistant" | "user";
  className?: string;
}) {
  return (
    <article className={`pr-post-agent-bubble ${role} ${className ?? ""}`}>
      {children}
    </article>
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

function loadConnections(scopeKey?: string): ServiceConnections {
  if (!scopeKey || typeof window === "undefined") {
    return DEFAULT_CONNECTIONS;
  }

  try {
    const raw = window.localStorage.getItem(getConnectionsStorageKey(scopeKey));
    if (!raw) {
      return DEFAULT_CONNECTIONS;
    }

    const parsed = JSON.parse(raw) as Partial<ServiceConnections>;
    return {
      google: parsed.google ?? false,
      slack: parsed.slack ?? false,
    };
  } catch {
    return DEFAULT_CONNECTIONS;
  }
}

function saveConnections(
  scopeKey: string,
  connections: ServiceConnections,
): void {
  if (typeof window === "undefined") {
    return;
  }

  window.localStorage.setItem(
    getConnectionsStorageKey(scopeKey),
    JSON.stringify(connections),
  );
}

function getConnectionsStorageKey(scopeKey: string): string {
  return `tableau-ai-pr-agent.service-connections.${scopeKey}`;
}

function resolveConnectionOwnerToken(scopeKey?: string): string | undefined {
  if (!scopeKey?.startsWith("anon:")) {
    return undefined;
  }

  return scopeKey.slice("anon:".length) || undefined;
}

function buildApprovalTableauSignals(
  evidencePack: ActionRunResult["evidencePack"] | undefined,
): string[] {
  if (!evidencePack) {
    return [];
  }

  return [
    describeInsightSection("Survey insight", evidencePack.surveyInsight),
    describeInsightSection(
      "Post performance insight",
      evidencePack.postPerformanceInsight,
    ),
    describeInsightSection(
      "Account overview insight",
      evidencePack.accountOverviewInsight,
    ),
  ].filter((line): line is string => Boolean(line));
}

function buildApprovalDebugLines(
  result: ActionRunResult | undefined,
): string[] {
  if (!result) {
    return [];
  }

  const lines = [
    result.primaryOutputType
      ? `Primary output: ${result.primaryOutputType}`
      : null,
    result.generatedPostSuggestions?.length
      ? `Generated suggestions: ${result.generatedPostSuggestions.length}`
      : null,
    result.draftReview
      ? `Draft review: ${result.draftReview.status} / ${result.draftReview.riskLevel}`
      : null,
    result.safetyReview ? `Safety review: ${result.safetyReview.status}` : null,
  ];

  return lines.filter((line): line is string => Boolean(line));
}

function describeInsightSection(
  label: string,
  section:
    | NonNullable<ActionRunResult["evidencePack"]>["surveyInsight"]
    | NonNullable<ActionRunResult["evidencePack"]>["postPerformanceInsight"]
    | NonNullable<ActionRunResult["evidencePack"]>["accountOverviewInsight"]
    | undefined,
): string | null {
  if (!section) {
    return null;
  }

  const parts = [
    `${label}: ${section.available ? "available" : "unavailable"}`,
    `status=${section.sourceStatus}`,
    `rows=${section.queryRowCount}`,
  ];

  if (section.warnings.length) {
    parts.push(`warnings=${section.warnings.join(", ")}`);
  }

  if (section.skippedReason) {
    parts.push(`skipped=${section.skippedReason}`);
  }

  if (section.failedReason) {
    parts.push(`failed=${section.failedReason}`);
  }

  return parts.join(" | ");
}

function blueskyPostUriToWebUrl(uri?: string): string | undefined {
  if (!uri?.trim()) {
    return undefined;
  }

  const match = uri.match(
    /^at:\/\/(?:did:[^/]+|[A-Za-z0-9._:-]+)\/app\.bsky\.feed\.post\/([A-Za-z0-9]+)$/,
  );
  if (!match) {
    return undefined;
  }

  const did = uri.slice("at://".length, uri.indexOf("/app.bsky.feed.post/"));
  return `https://bsky.app/profile/${did}/post/${match[1]}`;
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
