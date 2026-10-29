import { hashString } from "@sdp/payments/hash";
import { describe, expect, it } from "vitest";
import { hashApiKey } from "./api-key-hash";

describe("hashApiKey", () => {
  it("hashes a key with HMAC-SHA-256 under the pepper", async () => {
    const hash = await hashApiKey("sk_test_key", "pepper");
    expect(hash).toBe(await hashString("sk_test_key", "pepper"));
    expect(hash).not.toBe(await hashString("sk_test_key"));
  });

  // HOO-2219: no unpeppered SHA-256 fallback on the key path.
  it.each([undefined, "", "   "])("refuses to hash without a pepper (%j)", async (pepper) => {
    await expect(hashApiKey("sk_test_key", pepper)).rejects.toThrow(
      "API_KEY_PEPPER is required to hash API keys"
    );
  });
});
