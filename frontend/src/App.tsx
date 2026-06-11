import { useEffect, useState } from "react";
import { env } from "./env";
import { isAuthPopupStart, isAuthRedirect } from "./auth/cognitoAuth";
import AuthCallback from "./components/AuthCallback";
import AuthGate from "./components/AuthGate";
import AuthPopupStart from "./components/AuthPopupStart";
import ChatPanel from "./components/ChatPanel";
import { initializeTableauExtension } from "./tableau/tableauExtension";
import type { DashboardContext } from "./types/tableau";

export default function App() {
  if (env.authRequired && isAuthPopupStart()) {
    return <AuthPopupStart />;
  }

  if (env.authRequired && isAuthRedirect()) {
    return <AuthCallback />;
  }

  return <DashboardExtensionApp />;
}

function DashboardExtensionApp() {
  const [dashboardContext, setDashboardContext] =
    useState<DashboardContext | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let isMounted = true;

    initializeTableauExtension()
      .then((context) => {
        if (isMounted) {
          setDashboardContext(context);
        }
      })
      .catch((unknownError) => {
        if (isMounted) {
          setError(
            unknownError instanceof Error
              ? unknownError.message
              : "Tableau初期化に失敗しました。",
          );
        }
      });

    return () => {
      isMounted = false;
    };
  }, []);

  if (error) {
    return <div className="app-shell error-state">{error}</div>;
  }

  if (!dashboardContext) {
    return (
      <div className="app-shell loading-state">
        ダッシュボード情報を読み込んでいます…
      </div>
    );
  }

  const renderPanel = ({
    authToken,
    userDisplayName,
    isAuthenticated,
    isAuthLoading,
    isSigningIn,
    authError,
    onSignIn,
  }: {
    authToken?: string;
    userDisplayName?: string;
    isAuthenticated: boolean;
    isAuthLoading?: boolean;
    isSigningIn?: boolean;
    authError?: string | null;
    onSignIn?: () => Promise<void>;
  }) => (
    <div className="app-shell">
      <ChatPanel
        dashboardContext={dashboardContext}
        authToken={authToken}
        userDisplayName={userDisplayName}
        isAuthenticated={isAuthenticated}
        isAuthLoading={Boolean(isAuthLoading)}
        authOverlay={
          env.authRequired
            ? {
                isSigningIn: Boolean(isSigningIn),
                error: authError ?? null,
                onSignIn: onSignIn ?? (() => Promise.resolve()),
              }
            : undefined
        }
        onDashboardContextPatch={(patch) => {
          setDashboardContext((current) =>
            current ? { ...current, ...patch } : current,
          );
        }}
      />
    </div>
  );

  if (env.authRequired) {
    return (
      <AuthGate>
        {({ session, isLoading, isSigningIn, error: authError, startSignIn }) =>
          renderPanel({
            authToken: session?.idToken,
            userDisplayName: session?.nickname,
            isAuthenticated: Boolean(session),
            isAuthLoading: isLoading,
            isSigningIn,
            authError,
            onSignIn: startSignIn,
          })
        }
      </AuthGate>
    );
  }

  return renderPanel({ isAuthenticated: true });
}
