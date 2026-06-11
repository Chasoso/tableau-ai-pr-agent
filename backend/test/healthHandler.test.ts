import { describe, expect, it } from "vitest";
import { handler } from "../src/handlers/healthHandler";

describe("healthHandler", () => {
  it("returns a simple ok response", async () => {
    const response = await handler();

    expect(response.statusCode).toBe(200);
    expect(response.headers["Content-Type"]).toBe("application/json");
    expect(JSON.parse(response.body)).toEqual({ status: "ok" });
  });
});
