import { describe, expect, it } from "vitest";
import { resolveAnonymousEarnEnvironment } from "./environment";

describe("resolveAnonymousEarnEnvironment", () => {
  it("maps the deployment runtime to an Earn product environment", () => {
    expect(resolveAnonymousEarnEnvironment("development")).toBe("sandbox");
    expect(resolveAnonymousEarnEnvironment("production")).toBe("production");
  });

  it("fails closed for an unknown deployment runtime", () => {
    expect(() => resolveAnonymousEarnEnvironment("preview" as never)).toThrow(
      "Unsupported deployment environment: preview"
    );
  });
});
