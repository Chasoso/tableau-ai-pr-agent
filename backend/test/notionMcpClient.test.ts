import { describe, expect, it } from "vitest";
import {
  buildParentCandidates,
  extractNotionPageRef,
  normalizeNotionIdentifier,
} from "../src/notion/notionMcpClient";

describe("normalizeNotionIdentifier", () => {
  it("normalizes collection:// prefix for data source style identifiers", () => {
    expect(normalizeNotionIdentifier("collection://abc-123")).toBe("abc-123");
  });

  it("extracts page id-like token from notion.so url", () => {
    expect(
      normalizeNotionIdentifier(
        "https://www.notion.so/My-Page-123456781234123412341234567890ab?pvs=4",
      ),
    ).toBe("123456781234123412341234567890ab");
  });

  it("returns trimmed raw value when not a Notion URL", () => {
    expect(normalizeNotionIdentifier("  abc-def  ")).toBe("abc-def");
  });
});

describe("buildParentCandidates", () => {
  it("prefers datasource target before page target when both are configured", () => {
    const candidates = buildParentCandidates({
      targetParentPageId: "page-1",
      targetDatabaseId: "collection://ds-1",
    });

    expect(candidates).toEqual([
      { type: "data_source_id", value: "ds-1" },
      { type: "page_id", value: "page-1" },
    ]);
  });

  it("throws when neither parent nor datasource target is configured", () => {
    expect(() => buildParentCandidates({})).toThrow(
      /Notion target is not configured/i,
    );
  });
});

describe("extractNotionPageRef", () => {
  it("extracts a nested notion page url and page id", () => {
    const ref = extractNotionPageRef({
      content: [
        {
          page: {
            id: "12345678-1234-1234-1234-1234567890ab",
            url: "https://www.notion.so/example-page",
          },
        },
      ],
    });

    expect(ref).toEqual({
      pageUrl: "https://www.notion.so/example-page",
      pageId: "12345678-1234-1234-1234-1234567890ab",
    });
  });
});
