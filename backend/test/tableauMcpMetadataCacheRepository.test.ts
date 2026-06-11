import { GetItemCommand, PutItemCommand } from "@aws-sdk/client-dynamodb";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TableauMcpMetadataCacheRepository } from "../src/repositories/tableauMcpMetadataCacheRepository";

const sendMock = vi.fn();

vi.mock("../src/aws/dynamodb", () => ({
  getDynamoDbClient: () => ({
    send: sendMock,
  }),
}));

describe("TableauMcpMetadataCacheRepository", () => {
  const originalTableName = process.env.TABLEAU_MCP_METADATA_CACHE_TABLE_NAME;

  beforeEach(() => {
    sendMock.mockReset();
    process.env.TABLEAU_MCP_METADATA_CACHE_TABLE_NAME =
      "tableau-mcp-metadata-cache";
  });

  afterEach(() => {
    if (originalTableName === undefined) {
      delete process.env.TABLEAU_MCP_METADATA_CACHE_TABLE_NAME;
    } else {
      process.env.TABLEAU_MCP_METADATA_CACHE_TABLE_NAME = originalTableName;
    }
  });

  it("stores cached results using PutItem", async () => {
    sendMock.mockResolvedValue({});
    const repository = new TableauMcpMetadataCacheRepository();

    await repository.put({
      cacheKey: "user:list-workbooks:abc",
      subjectHash: "userhash",
      toolName: "list-workbooks",
      argsHash: "argshash",
      result: { content: [] },
      createdAt: "2026-06-07T00:00:00.000Z",
      expiresAt: 1_999_999_999,
    });

    expect(sendMock).toHaveBeenCalledTimes(1);
    const command = sendMock.mock.calls[0][0] as PutItemCommand;
    expect(command.input.TableName).toBe("tableau-mcp-metadata-cache");
    expect(command.input.Item).toBeTruthy();
  });

  it("treats expired cache entries as misses", async () => {
    sendMock.mockResolvedValue({
      Item: {
        cacheKey: { S: "user:list-workbooks:abc" },
        subjectHash: { S: "userhash" },
        toolName: { S: "list-workbooks" },
        argsHash: { S: "argshash" },
        result: { M: { content: { L: [] } } },
        createdAt: { S: "2026-06-07T00:00:00.000Z" },
        expiresAt: { N: "1" },
      },
    });
    const repository = new TableauMcpMetadataCacheRepository();

    await expect(repository.get("user:list-workbooks:abc")).resolves.toBe(null);

    expect(sendMock).toHaveBeenCalledTimes(1);
    const command = sendMock.mock.calls[0][0] as GetItemCommand;
    expect(command.input.TableName).toBe("tableau-mcp-metadata-cache");
  });
});
