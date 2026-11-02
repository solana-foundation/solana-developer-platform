import { describe, expect, it } from "vitest";
import { updateOrgSchema } from "./schemas";

describe("updateOrgSchema settings", () => {
  it("rejects a removed settings key", () => {
    expect(
      updateOrgSchema.safeParse({ settings: { defaultEnvironment: "production" } })
    ).toMatchObject({
      success: false,
      error: {
        issues: [{ code: "unrecognized_keys", keys: ["defaultEnvironment"], path: ["settings"] }],
      },
    });
  });
});
