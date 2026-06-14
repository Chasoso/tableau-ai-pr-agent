import { useEffect, useState } from "react";
import { startLogin } from "../auth/cognitoAuth";

export default function AuthPopupStart() {
  const [message, setMessage] = useState("サインイン画面を開いています。");

  useEffect(() => {
    startLogin().catch(() => {
      setMessage(
        "サインイン画面を開けませんでした。このウィンドウを閉じて、もう一度お試しください。",
      );
    });
  }, []);

  return (
    <div className="app-shell auth-state auth-popup-state">
      <section className="auth-card auth-popup-card">
        <h1>PR投稿エージェント</h1>
        <p className="auth-popup-message">{message}</p>
        <p className="auth-popup-caption">
          数秒後に自動で認証画面へ切り替わります。
        </p>
      </section>
    </div>
  );
}
