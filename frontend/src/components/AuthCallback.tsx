import { useEffect, useState } from "react";
import { completeLoginFromRedirect } from "../auth/cognitoAuth";

export default function AuthCallback() {
  const [message, setMessage] = useState("サインイン結果を確認しています…");

  useEffect(() => {
    let cancelled = false;

    void completeLoginFromRedirect()
      .then((session) => {
        if (cancelled) {
          return;
        }

        if (!session) {
          setMessage(
            "サインイン結果を確認できませんでした。このウィンドウを閉じて、もう一度お試しください。",
          );
          return;
        }

        setMessage("サインインが完了しました。元の画面に戻ります…");
        window.setTimeout(() => {
          window.location.replace("/");
        }, 800);
      })
      .catch(() => {
        if (!cancelled) {
          setMessage(
            "サインインに失敗しました。このウィンドウを閉じて、もう一度お試しください。",
          );
        }
      });

    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="app-shell auth-state">
      <section className="auth-card">
        <h1>Tableau Assistant</h1>
        <p>{message}</p>
      </section>
    </div>
  );
}
