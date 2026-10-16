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
});
