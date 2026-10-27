import { describe, expect, it } from "vitest";
import { updateProjectSchema } from "./schemas";

describe("updateProjectSchema settings", () => {
  it("rejects a removed settings key", () => {
    expect(updateProjectSchema.safeParse({ settings: { rpcProvider: "x" } })).toMatchObject({
      success: false,
      error: {
        issues: [{ code: "unrecognized_keys", keys: ["rpcProvider"], path: ["settings"] }],
      },
    });
  });

  it("accepts the webhook URL and metadata", () => {
    const input = {
      settings: { webhookUrl: "https://hooks.example.com/x", metadata: { team: "payments" } },
    };

    expect(updateProjectSchema.parse(input)).toEqual(input);
  });

  // A webhook URL is a stored tenant-controlled endpoint — where a future
  // dispatcher would POST the project's events — so it is https-only even
  // while nothing dials it yet.
  it("rejects a non-https webhook URL", () => {
    for (const webhookUrl of [
      "http://hooks.example.com/x",
      "ftp://hooks.example.com/x",
      "javascript:alert(1)",
    ]) {
      expect(updateProjectSchema.safeParse({ settings: { webhookUrl } }).success, webhookUrl).toBe(
        false
      );
    }
  });
});
