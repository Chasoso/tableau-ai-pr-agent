import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import MessageInput from "./MessageInput";

describe("MessageInput", () => {
  it("submits a trimmed question and clears the field", () => {
    const onSend = vi.fn();
    render(<MessageInput onSend={onSend} />);

    const textarea = screen.getByLabelText("質問");
    const submitButton = screen.getByRole("button", { name: "送信" });

    fireEvent.change(textarea, {
      target: { value: "  Tableauのポイントを教えて  " },
    });
    fireEvent.click(submitButton);

    expect(onSend).toHaveBeenCalledWith("Tableauのポイントを教えて");
    expect(textarea).toHaveValue("");
  });

  it("keeps the send button disabled for whitespace-only input", () => {
    render(<MessageInput onSend={() => undefined} />);

    const textarea = screen.getByLabelText("質問");
    const submitButton = screen.getByRole("button", { name: "送信" });

    fireEvent.change(textarea, { target: { value: "   " } });

    expect(submitButton).toBeDisabled();
  });

  it("submits on Enter but not on Shift+Enter", () => {
    const onSend = vi.fn();
    render(<MessageInput onSend={onSend} />);

    const textarea = screen.getByLabelText("質問");
    fireEvent.change(textarea, { target: { value: "週次トレンドを教えて" } });

    fireEvent.keyDown(textarea, { key: "Enter", shiftKey: true });
    expect(onSend).not.toHaveBeenCalled();

    fireEvent.keyDown(textarea, { key: "Enter", shiftKey: false });
    expect(onSend).toHaveBeenCalledWith("週次トレンドを教えて");
  });
});
