import { FormEvent, KeyboardEvent, useMemo, useState } from "react";

type Props = {
  disabled?: boolean;
  onSend: (question: string) => void;
};

export default function MessageInput({ disabled, onSend }: Props) {
  const [question, setQuestion] = useState("");

  const canSend = useMemo(
    () => Boolean(question.trim()) && !disabled,
    [question, disabled],
  );

  function submitQuestion() {
    const trimmedQuestion = question.trim();
    if (!trimmedQuestion || disabled) {
      return;
    }

    onSend(trimmedQuestion);
    setQuestion("");
  }

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    submitQuestion();
  }

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      submitQuestion();
    }
  }

  return (
    <form className="message-input" onSubmit={handleSubmit}>
      <textarea
        aria-label="質問"
        disabled={disabled}
        placeholder="このダッシュボードについて質問する"
        rows={1}
        value={question}
        onChange={(event) => setQuestion(event.target.value)}
        onKeyDown={handleKeyDown}
      />
      <button
        className={canSend ? "send-active" : ""}
        disabled={!canSend}
        type="submit"
      >
        <span className="sr-only">送信</span>
        <svg className="send-icon" viewBox="0 0 24 24" aria-hidden="true">
          <path d="M3 11.5 20.5 3l-4.2 18-5.1-6.2-4.1-3.3L3 11.5Z" />
          <path d="M20.5 3 7.1 11.5" />
        </svg>
      </button>
    </form>
  );
}
