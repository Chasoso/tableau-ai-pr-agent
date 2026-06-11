import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import MessageList from "./MessageList";

describe("MessageList", () => {
  it("renders markdown assistant output and loading state", () => {
    render(
      <MessageList
        messages={[
          {
            id: "assistant-1",
            role: "assistant",
            content: "## Summary\n\n- Point A",
            createdAt: new Date().toISOString(),
          },
        ]}
        isLoading
        loadingText="データを確認しています…"
      />,
    );

    expect(screen.getByRole("heading", { name: "Summary" })).toBeVisible();
    expect(screen.getByText("Point A")).toBeVisible();
    expect(screen.getByText("データを確認しています…")).toBeVisible();
  });

  it("shows a compact job progress block without card chrome", () => {
    render(
      <MessageList
        messages={[]}
        isLoading={true}
        job={{
          status: "running",
          stage: "running_mcp_tools",
          progressMessages: [
            {
              at: new Date().toISOString(),
              stage: "queued",
              message: "分析を開始しました",
              debug: {
                provider: "chat-job",
              },
            },
            {
              at: new Date().toISOString(),
              stage: "loading_history",
              message: "会話履歴を確認中...",
              debug: {
                provider: "tableau-mcp",
                passCount: 2,
                toolCallCount: 4,
              },
            },
            {
              at: new Date().toISOString(),
              stage: "loading_dashboard_context",
              message: "ダッシュボード情報を取得中...",
            },
            {
              at: new Date().toISOString(),
              stage: "planning",
              message: "分析計画を作成中...",
            },
          ],
        }}
      />,
    );

    expect(screen.getByRole("heading", { name: "回答を生成中" })).toBeVisible();
    expect(screen.getByText("分析を開始しました")).toBeVisible();
    expect(screen.getByText("会話履歴を確認中...")).toBeVisible();
    expect(screen.getByText("ダッシュボード情報を取得中...")).toBeVisible();
    expect(screen.getByText("分析計画を作成中...")).toBeVisible();
    expect(screen.getByText("pass 2")).toBeVisible();
    expect(screen.getByText("tools 4")).toBeVisible();
    expect(screen.getByText("provider tableau-mcp")).toBeVisible();
    expect(screen.queryByText("4件")).toBeNull();
    expect(screen.queryByRole("region")).toBeNull();
  });

  it("shows notion completion details when expanded", () => {
    const onToggle = vi.fn();

    render(
      <MessageList
        messages={[]}
        isLoading={false}
        notionCompletion={{
          title: "保存メモ",
          summary: "分析メモの要約",
          pageUrl: "https://www.notion.so/example",
          expanded: true,
        }}
        onToggleNotionCompletion={onToggle}
      />,
    );

    expect(screen.getByLabelText("Notion保存結果")).toBeVisible();
    expect(screen.getByText("保存メモ")).toBeVisible();
    expect(
      screen.getByRole("link", { name: "Notionページを開く" }),
    ).toHaveAttribute("href", "https://www.notion.so/example");
  });
});
