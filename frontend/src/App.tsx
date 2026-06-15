import { useEffect, useState } from "react";
import { env } from "./env";
import { isAuthPopupStart, isAuthRedirect } from "./auth/cognitoAuth";
import AuthCallback from "./components/AuthCallback";
import AuthGate from "./components/AuthGate";
import AuthPopupStart from "./components/AuthPopupStart";
import PrPostAgentPanel from "./components/PrPostAgentPanel";
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
              : "Tableau extension initialization failed.",
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
        Loading Tableau dashboard context...
      </div>
    );
  }

  const renderPanel = ({
    authToken,
    connectionScopeKey,
    userDisplayName,
  }: {
    authToken?: string;
    connectionScopeKey?: string;
    userDisplayName?: string;
  }) => (
    <div className="app-shell">
      <PrPostAgentPanel
        dashboardContext={dashboardContext}
        authToken={authToken}
        connectionScopeKey={connectionScopeKey}
        userDisplayName={userDisplayName}
      />
    </div>
  );

  if (env.authRequired) {
    return (
      <AuthGate>
        {({
          session,
          isLoading,
          isSigningIn,
          error: authError,
          startSignIn,
        }) =>
          session ? (
            renderPanel({
              authToken: session.idToken,
              connectionScopeKey: session.userId
                ? `user:${session.userId}`
                : undefined,
              userDisplayName: session.nickname ?? session.email,
            })
          ) : (
            <div className="app-shell auth-state">
              <div className="auth-card">
                <h1>PR投稿エージェント</h1>
                <p>Sign in to continue.</p>
                {authError ? (
                  <div className="error-banner">{authError}</div>
                ) : null}
                <button
                  type="button"
                  disabled={Boolean(isLoading || isSigningIn)}
                  onClick={() => void startSignIn()}
                >
                  {isSigningIn ? "Signing in..." : "Sign in"}
                </button>
              </div>
            </div>
          )
        }
      </AuthGate>
    );
  }

  return renderPanel({});
}
