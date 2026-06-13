import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildNotionMarkdown,
  NotionService,
  resolveNotionUserId,
} from "../src/notion/notionService";

describe("resolveNotionUserId", () => {
  const originalAuthRequired = process.env.AUTH_REQUIRED;
  const originalLocalDevUserId = process.env.NOTION_LOCAL_DEV_USER_ID;

  afterEach(() => {
    if (originalAuthRequired === undefined) {
      delete process.env.AUTH_REQUIRED;
    } else {
      process.env.AUTH_REQUIRED = originalAuthRequired;
    }

    if (originalLocalDevUserId === undefined) {
      delete process.env.NOTION_LOCAL_DEV_USER_ID;
    } else {
      process.env.NOTION_LOCAL_DEV_USER_ID = originalLocalDevUserId;
    }
  });

  it("returns cognito sub when authenticated user is present", () => {
    process.env.AUTH_REQUIRED = "true";
    const userId = resolveNotionUserId({
      userId: "sub-123",
      email: "test@example.com",
    });

    expect(userId).toBe("sub-123");
  });

  it("returns local dev user id when auth is disabled", () => {
    process.env.AUTH_REQUIRED = "false";
    process.env.NOTION_LOCAL_DEV_USER_ID = "local-dev-user";
    expect(resolveNotionUserId(undefined)).toBe("local-dev-user");
  });
});

describe("buildNotionMarkdown", () => {
  it("renders analysis memo markdown without post-idea-only sections", () => {
    const markdown = buildNotionMarkdown({
      title: "2026年5月 Favorite数ランキング",
      draftKind: "analysis_memo",
      reason: "分析結果を保存します。",
      suggestedPostText: "短い要約",
      summary: "2026年5月のFavorite数ランキングです。",
      analysisBody: "1. Viz A: 120\n2. Viz B: 80",
      datasourceName: "Tableau Public Per Day(2025/04-)",
      periodLabel: "2026年5月",
      rankingItems: [
        { label: "Viz A", value: 120 },
        { label: "Viz B", value: 80 },
      ],
      source: "Tableau MCP",
      tags: ["Tableau", "MCP", "Analysis Memo"],
    });

    expect(markdown).toContain("# 2026年5月 Favorite数ランキング");
    expect(markdown).toContain("## 分析結果");
    expect(markdown).toContain("## ランキング");
    expect(markdown).not.toContain("## 推奨投稿文");
    expect(markdown).not.toContain("## 参照ポスト");
    expect(markdown).not.toContain("n/a");
  });
});

describe("NotionService draft flow", () => {
  it("returns a draft preview without creating a Notion page", async () => {
    const repository = {
      getConnection: vi.fn(),
      putConnection: vi.fn(),
      deleteConnection: vi.fn(),
    };
    const oauthService = {
      buildAuthorizationUrl: vi.fn(),
      handleCallback: vi.fn(),
      getConnectionForUse: vi.fn().mockResolvedValue({
        connection: {
          targetParentPageId: "parent-page",
          targetDatabaseId: "database-id",
        },
        accessToken: "token",
      }),
    };

    const service = new NotionService(repository as never, oauthService as never);
    const response = await service.createPostIdea(undefined, {
      title: "Draft title",
      reason: "Why this matters",
      suggestedPostText: "Post body",
    });

    expect(response.ok).toBe(true);
    expect(response.pageTitle).toBe("Draft title");
    expect(response.pageUrl).toBeUndefined();
    expect(response.draftMarkdown).toContain("Draft title");
    expect(repository.putConnection).not.toHaveBeenCalled();
  });
});
