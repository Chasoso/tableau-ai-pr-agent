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
        loadingText="繝・・繧ｿ繧堤｢ｺ隱阪＠縺ｦ縺・∪縺吮ｦ"
      />,
    );

    expect(screen.getByRole("heading", { name: "Summary" })).toBeVisible();
    expect(screen.getByText("Point A")).toBeVisible();
    expect(
      screen.getByText("繝・・繧ｿ繧堤｢ｺ隱阪＠縺ｦ縺・∪縺吮ｦ"),
    ).toBeVisible();
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
              message: "蛻・梵繧帝幕蟋九＠縺ｾ縺励◆",
              debug: {
                provider: "chat-job",
              },
            },
            {
              at: new Date().toISOString(),
              stage: "loading_history",
              message: "莨夊ｩｱ螻･豁ｴ繧堤｢ｺ隱堺ｸｭ...",
              debug: {
                provider: "tableau-mcp",
                passCount: 2,
                toolCallCount: 4,
              },
            },
            {
              at: new Date().toISOString(),
              stage: "loading_dashboard_context",
              message: "繝繝・す繝･繝懊・繝画ュ蝣ｱ繧貞叙蠕嶺ｸｭ...",
            },
            {
              at: new Date().toISOString(),
              stage: "planning",
              message: "蛻・梵險育判繧剃ｽ懈・荳ｭ...",
            },
          ],
        }}
      />,
    );

    expect(
      screen.getByRole("heading", { name: "蝗樒ｭ斐ｒ逕滓・荳ｭ" }),
    ).toBeVisible();
    expect(screen.getByText("蛻・梵繧帝幕蟋九＠縺ｾ縺励◆")).toBeVisible();
    expect(screen.getByText("莨夊ｩｱ螻･豁ｴ繧堤｢ｺ隱堺ｸｭ...")).toBeVisible();
    expect(
      screen.getByText("繝繝・す繝･繝懊・繝画ュ蝣ｱ繧貞叙蠕嶺ｸｭ..."),
    ).toBeVisible();
    expect(screen.getByText("蛻・梵險育判繧剃ｽ懈・荳ｭ...")).toBeVisible();
    expect(screen.getByText("pass 2")).toBeVisible();
    expect(screen.getByText("tools 4")).toBeVisible();
    expect(screen.getByText("provider tableau-mcp")).toBeVisible();
    expect(screen.queryByText("4莉ｶ")).toBeNull();
    expect(screen.queryByRole("region")).toBeNull();
  });

  it("shows notion completion details when expanded", () => {
    const onToggle = vi.fn();

    render(
      <MessageList
        messages={[]}
        isLoading={false}
        notionCompletion={{
          title: "菫晏ｭ倥Γ繝｢",
          summary: "蛻・梵繝｡繝｢縺ｮ隕∫ｴ・",
          pageUrl: "https://www.notion.so/example",
          expanded: true,
        }}
        onToggleNotionCompletion={onToggle}
      />,
    );

    expect(screen.getByLabelText("Notion菫晏ｭ倡ｵ先棡")).toBeVisible();
    expect(screen.getByText("菫晏ｭ倥Γ繝｢")).toBeVisible();
    expect(
      screen.getByRole("link", { name: "Notion繝壹・繧ｸ繧帝幕縺・" }),
    ).toHaveAttribute("href", "https://www.notion.so/example");
  });

  it("shows a notion draft preview when no page url is available", () => {
    render(
      <MessageList
        messages={[]}
        isLoading={false}
        notionCompletion={{
          title: "Draft title",
          summary: "Draft summary",
          draftMarkdown: "# Draft title\n\nDraft summary",
          expanded: true,
        }}
      />,
    );

    expect(
      screen.getByText(
        (_, element) =>
          element?.tagName.toLowerCase() === "pre" &&
          element.textContent?.includes("# Draft title"),
      ),
    ).toBeVisible();
    expect(screen.getByText("Draft summary")).toBeVisible();
  });
});
