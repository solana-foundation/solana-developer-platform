import { describe, expect, it } from "vitest";
import { updateOrgSchema } from "./schemas";

describe("updateOrgSchema settings", () => {
  it("rejects a removed settings key", () => {
    expect(updateOrgSchema.safeParse({ settings: { rpcProvider: "x" } })).toMatchObject({
      success: false,
      error: {
        issues: [{ code: "unrecognized_keys", keys: ["rpcProvider"], path: ["settings"] }],
      },
    });
  });

  it("accepts the default environment", () => {
    const input = { settings: { defaultEnvironment: "sandbox" } };

    expect(updateOrgSchema.parse(input)).toEqual(input);
  });
});
