import { describe, expect, it } from "vitest";
import { hasValidDemoSession } from "./demo-session.ts";

describe("Northstar demo session", () => {
  const token = "a-secure-demo-session-token-with-enough-entropy";

  it("accepts only the generated server-to-server token", () => {
    expect(hasValidDemoSession(token, token)).toBe(true);
    expect(hasValidDemoSession(undefined, token)).toBe(false);
    expect(hasValidDemoSession("wrong-token", token)).toBe(false);
  });
});
