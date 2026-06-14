import { useEffect, useRef, useState } from "react";
import type React from "react";
import {
  getPopupAuthStatus,
  startPopupAuth,
  type PopupAuthStartResponse,
} from "../api/authApi";
import {
  getStoredSession,
  openLoginPopupWindow,
  storeSession,
} from "../auth/cognitoAuth";
import type { AuthSession } from "../types/auth";

const popupWaitTimeoutMs = 90_000;
const popupPollIntervalMs = 750;
const authDebugStorageKey = "tableau-ai-pr-agent.auth.debug";

export type AuthGateRenderState = {
  session: AuthSession | null;
  isLoading: boolean;
  isSigningIn: boolean;
  error: string | null;
  startSignIn: () => Promise<void>;
};

type Props = {
  children: (state: AuthGateRenderState) => React.ReactNode;
};

type PopupTransactionState = PopupAuthStartResponse & {
  startedAt: number;
  popupClosedLoggedAt?: number;
};

export default function AuthGate({ children }: Props) {
  const mountedRef = useRef(false);
  const popupRef = useRef<Window | null>(null);
  const pollTimerRef = useRef<number | undefined>(undefined);
  const transactionRef = useRef<PopupTransactionState | null>(null);
  const [session, setSession] = useState<AuthSession | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isSigningIn, setIsSigningIn] = useState(false);

  function clearPollTimer(): void {
    if (pollTimerRef.current) {
      window.clearInterval(pollTimerRef.current);
      pollTimerRef.current = undefined;
    }
  }

  function resetPopupState(): void {
    popupRef.current = null;
    transactionRef.current = null;
  }

  function stopSignIn(message?: string): void {
    logAuthDebug("popup_sign_in_stopped", {
      hasMessage: Boolean(message),
      message,
    });
    clearPollTimer();
    resetPopupState();
    setIsSigningIn(false);
    if (message) {
      setError(message);
    }
  }

  function acceptSession(nextSession: AuthSession): void {
    logAuthDebug("popup_sign_in_completed", {
      email: nextSession.email,
      nickname: nextSession.nickname,
    });
    storeSession(nextSession);
    clearPollTimer();
    try {
      popupRef.current?.close();
    } catch {
      // Ignore popup close failures after auth completion.
    }
    resetPopupState();
    setSession(nextSession);
    setError(null);
    setIsSigningIn(false);
  }

  async function pollPopupTransaction(): Promise<void> {
    const transaction = transactionRef.current;
    if (!transaction) {
      return;
    }

    try {
      logAuthDebug("popup_status_poll", {
        transactionId: transaction.transactionId,
      });
      const response = await getPopupAuthStatus(
        transaction.transactionId,
        transaction.pollToken,
      );
      if (response.status === "completed") {
        acceptSession(response.session);
        return;
      }

      if (response.status === "failed" || response.status === "consumed") {
        logAuthDebug("popup_status_failed", {
          transactionId: transaction.transactionId,
          message: response.message,
        });
        stopSignIn(
          response.message || "�T�C���C���Ɏ��s���܂����B������x���������������B",
        );
        return;
      }
    } catch (unknownError) {
      stopSignIn(
        unknownError instanceof Error
          ? unknownError.message
          : "�T�C���C����Ԃ̊m�F�Ɏ��s���܂����B������x���������������B",
      );
      return;
    }

    const popup = popupRef.current;
    if (popup?.closed && !transaction.popupClosedLoggedAt) {
      transaction.popupClosedLoggedAt = Date.now();
      logAuthDebug("popup_closed_observed_while_waiting_for_status", {
        transactionId: transaction.transactionId,
      });
    }

    if (Date.now() - transaction.startedAt >= popupWaitTimeoutMs) {
      stopSignIn(
        "�T�C���C�����^�C���A�E�g���܂����B������x�T�C���C�����Ă��������B",
      );
    }
  }

  useEffect(() => {
    mountedRef.current = true;
    setSession(getStoredSession());
    setIsLoading(false);

    return () => {
      mountedRef.current = false;
      clearPollTimer();
    };
  }, []);

  async function handleSignIn() {
    setIsSigningIn(true);
    setError(null);
    logAuthDebug("popup_sign_in_started");

    let popup: Window | null = null;
    try {
      popup = openLoginPopupWindow();
      popupRef.current = popup;

      const startResponse = await startPopupAuth({
        redirectAfter: window.location.pathname + window.location.search,
      });

      transactionRef.current = {
        ...startResponse,
        startedAt: Date.now(),
      };
      logAuthDebug("popup_auth_transaction_created", {
        transactionId: startResponse.transactionId,
        expiresAt: startResponse.expiresAt,
      });

      popup.location.replace(startResponse.authorizationUrl);
      clearPollTimer();
      pollTimerRef.current = window.setInterval(() => {
        void pollPopupTransaction();
      }, popupPollIntervalMs);
      void pollPopupTransaction();
    } catch (unknownError) {
      try {
        popup?.close();
      } catch {
        // Ignore popup close failures on startup error.
      }
      stopSignIn(
        unknownError instanceof Error
          ? unknownError.message
          : "�T�C���C���̊J�n�Ɏ��s���܂����B������x���������������B",
      );
    }
  }

  return (
    <>
      {children({
        session,
        isLoading,
        isSigningIn,
        error,
        startSignIn: handleSignIn,
      })}
    </>
  );
}

function logAuthDebug(
  event: string,
  details: Record<string, unknown> = {},
): void {
  const shouldLog =
    typeof window !== "undefined" &&
    (localStorage.getItem(authDebugStorageKey) === "true" ||
      import.meta.env.DEV);
  if (!shouldLog) {
    return;
  }

  console.debug("[tableau-auth]", event, details);
}
