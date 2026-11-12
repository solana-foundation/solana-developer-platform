import { generateKeyPairSync, webcrypto } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { cancelFireblocksTransfer } from "./fireblocks-transfers";
import type { CustodyProvisioningRuntime } from "./runtime";

const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const access = {
  apiBaseUrl: "https://fireblocks.example.test",
  apiKey: "tenant-api-key",
  apiSecretPem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
};

function runtime(fetch: CustodyProvisioningRuntime["fetch"]): CustodyProvisioningRuntime {
  return {
    fetch,
    sleep: async () => {},
    now: Date.now,
    randomUUID: () => crypto.randomUUID(),
    getRandomValues: (data) => webcrypto.getRandomValues(new Uint8Array(data)),
    sha256: async (data) => webcrypto.subtle.digest("SHA-256", new Uint8Array(data)),
  };
}

describe("Fireblocks cancellation adapter", () => {
  it("POSTs only the encoded cancellation endpoint without an idempotency cache", async () => {
    const fetch = vi.fn<CustodyProvisioningRuntime["fetch"]>(async () =>
      Response.json({ success: true })
    );
    const rt = runtime(fetch);
    for (const transactionId of ["provider/id?part", "provider/id?part", "another-id"])
      await expect(cancelFireblocksTransfer(rt, access, transactionId)).resolves.toBe(true);
    expect(fetch.mock.calls.map(([url]) => String(url))).toEqual([
      `${access.apiBaseUrl}/v1/transactions/provider%2Fid%3Fpart/cancel`,
      `${access.apiBaseUrl}/v1/transactions/provider%2Fid%3Fpart/cancel`,
      `${access.apiBaseUrl}/v1/transactions/another-id/cancel`,
    ]);
    for (const [, init] of fetch.mock.calls) {
      expect(init?.method).toBe("POST");
      expect(init?.body).toBeUndefined();
      expect(new Headers(init?.headers).get("X-API-Key")).toBe(access.apiKey);
      expect(new Headers(init?.headers).has("Idempotency-Key")).toBe(false);
    }
  });

  it.each([true, false])(
    "accepts additive metadata with a boolean acknowledgment: %j",
    async (success) => {
      await expect(
        cancelFireblocksTransfer(
          runtime(async () =>
            Response.json({
              success,
              status: "CANCELLING",
              metadata: { requestId: "provider-request-id" },
            })
          ),
          access,
          "provider-id"
        )
      ).resolves.toBe(success);
    }
  );

  it.each([
    {},
    { status: "CANCELLED" },
    { success: "true", status: "CANCELLED" },
    { success: 1 },
    { success: null },
    { success: { value: true } },
    null,
    [],
  ])("rejects malformed cancellation acknowledgments: %j", async (response) => {
    await expect(
      cancelFireblocksTransfer(
        runtime(async () => Response.json(response)),
        access,
        "provider-id"
      )
    ).rejects.toThrow("Invalid Fireblocks cancellation response");
  });

  it("re-evaluates cancellation after a negative acknowledgment", async () => {
    const fetch = vi
      .fn<CustodyProvisioningRuntime["fetch"]>()
      .mockResolvedValueOnce(Response.json({ success: false }))
      .mockResolvedValueOnce(Response.json({ success: true }));
    const rt = runtime(fetch);
    await expect(cancelFireblocksTransfer(rt, access, "provider-id")).resolves.toBe(false);
    await expect(cancelFireblocksTransfer(rt, access, "provider-id")).resolves.toBe(true);
    expect(fetch).toHaveBeenCalledTimes(2);
    for (const [, init] of fetch.mock.calls)
      expect(new Headers(init?.headers).has("Idempotency-Key")).toBe(false);
  });
});
