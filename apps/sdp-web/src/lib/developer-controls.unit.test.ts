import { describe, expect, it } from "vitest";
import { isDeveloperControlsEnabled } from "./developer-controls";

describe("isDeveloperControlsEnabled", () => {
  it("is on where the team works and off anywhere production-like", () => {
    // Vercel wins when set: preview and dev builds are ours, production is not.
    expect(isDeveloperControlsEnabled({ vercelEnvironment: "preview" })).toBe(true);
    expect(isDeveloperControlsEnabled({ vercelEnvironment: "development" })).toBe(true);
    expect(isDeveloperControlsEnabled({ vercelEnvironment: "production" })).toBe(false);
    // A self-hosted deployment declares its own environment.
    expect(isDeveloperControlsEnabled({ sdpEnvironment: "development" })).toBe(true);
    expect(isDeveloperControlsEnabled({ sdpEnvironment: "production" })).toBe(false);
    expect(isDeveloperControlsEnabled({ sdpEnvironment: "staging" })).toBe(false);
    // Falling all the way through, only local dev and the test runner qualify.
    expect(isDeveloperControlsEnabled({ nodeEnvironment: "development" })).toBe(true);
    expect(isDeveloperControlsEnabled({ nodeEnvironment: "test" })).toBe(true);
    expect(isDeveloperControlsEnabled({ nodeEnvironment: "production" })).toBe(false);
    expect(isDeveloperControlsEnabled({})).toBe(false);
  });

  it("reads the environment the way the deployment writes it", () => {
    // Casing and stray whitespace come from env files, not from us.
    expect(isDeveloperControlsEnabled({ vercelEnvironment: " PREVIEW " })).toBe(true);
    // An empty var is an unset var: fall through rather than fail closed on it.
    expect(isDeveloperControlsEnabled({ vercelEnvironment: "", nodeEnvironment: "test" })).toBe(
      true
    );
  });
});
