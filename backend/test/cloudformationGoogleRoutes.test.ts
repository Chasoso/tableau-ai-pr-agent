import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("cloudformation google auth routes", () => {
  it("defines the google status route and invoke permission", () => {
    const templatePath = resolve(
      process.cwd(),
      "..",
      "infra",
      "cloudformation.yaml",
    );
    const template = readFileSync(templatePath, "utf8");

    expect(template).toContain("GoogleStatusRoute:");
    expect(template).toContain('RouteKey: "GET /auth/google/status"');
    expect(template).toContain("GoogleStatusInvokePermission:");
    expect(template).toContain(
      'SourceArn: !Sub "arn:${AWS::Partition}:execute-api:${AWS::Region}:${AWS::AccountId}:${HttpApi}/*/*/auth/google/status"',
    );
  });
});
