import { UpdateItemCommand } from "@aws-sdk/client-dynamodb";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CognitoAuthTransactionRepository } from "../src/repositories/cognitoAuthTransactionRepository";

const sendMock = vi.fn();

vi.mock("../src/aws/dynamodb", () => ({
  getDynamoDbClient: () => ({
    send: sendMock,
  }),
}));

describe("CognitoAuthTransactionRepository", () => {
  const originalTableName = process.env.COGNITO_AUTH_TRANSACTIONS_TABLE;

  beforeEach(() => {
    sendMock.mockReset();
    sendMock.mockResolvedValue({});
    process.env.COGNITO_AUTH_TRANSACTIONS_TABLE = "popup-auth-transactions";
  });

  afterEach(() => {
    if (originalTableName === undefined) {
      delete process.env.COGNITO_AUTH_TRANSACTIONS_TABLE;
    } else {
      process.env.COGNITO_AUTH_TRANSACTIONS_TABLE = originalTableName;
    }
  });

  it("omits undefined values from markCompleted update expressions", async () => {
    const repository = new CognitoAuthTransactionRepository();

    await repository.markCompleted({
      transactionId: "txn-1",
      session: {
        ciphertext: "cipher",
        iv: "iv",
        authTag: "tag",
      },
    });

    expect(sendMock).toHaveBeenCalledTimes(1);
    const command = sendMock.mock.calls[0][0] as UpdateItemCommand;
    expect(command.input.UpdateExpression).toContain("#status = :status");
    expect(command.input.UpdateExpression).toContain("#session = :session");
    expect(command.input.UpdateExpression).toContain("#updatedAt = :updatedAt");
    expect(command.input.UpdateExpression).not.toContain(":errorCode");
    expect(command.input.UpdateExpression).not.toContain(":errorMessageSafe");
  });
});
