import { generateKeyPairSync } from "node:crypto";
import { assert, describe, expect, it, vi } from "vitest";
import type { CustodyProvisioningRuntime } from "#/shared/runtime";
import { testRuntime } from "#/test/runtime";
import { cancelFireblocksTransfer } from "./transfers";

const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const access = {
  apiBaseUrl: "https://fireblocks.example.test",
  apiKey: "tenant-api-key",
  apiSecretPem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
};

describe("Fireblocks cancellation adapter", () => {
  it("POSTs only the encoded cancellation endpoint without an idempotency cache", async () => {
    const fetch = vi.fn<CustodyProvisioningRuntime["fetch"]>(async () =>
      Response.json({ success: true })
    );
    const rt = testRuntime(fetch);
    for (const transactionId of ["provider/id?part", "provider/id?part", "another-id"])
      await expect(cancelFireblocksTransfer(rt, access, transactionId)).resolves.toBe(true);
    expect(fetch.mock.calls.map(([url]) => String(url))).toEqual([
      `${access.apiBaseUrl}/v1/transactions/provider%2Fid%3Fpart/cancel`,
      `${access.apiBaseUrl}/v1/transactions/provider%2Fid%3Fpart/cancel`,
      `${access.apiBaseUrl}/v1/transactions/another-id/cancel`,
    ]);
    for (const [, init] of fetch.mock.calls) {
      assert.isDefined(init);
      expect(init.method).toBe("POST");
      expect(init.body).toBeUndefined();
      expect(new Headers(init.headers).get("X-API-Key")).toBe(access.apiKey);
      expect(new Headers(init.headers).has("Idempotency-Key")).toBe(false);
    }
  });

  it.each([true, false])(
    "accepts additive metadata with a boolean acknowledgment: %j",
    async (success) => {
      await expect(
        cancelFireblocksTransfer(
          testRuntime(async () =>
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
        testRuntime(async () => Response.json(response)),
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
    const rt = testRuntime(fetch);
    await expect(cancelFireblocksTransfer(rt, access, "provider-id")).resolves.toBe(false);
    await expect(cancelFireblocksTransfer(rt, access, "provider-id")).resolves.toBe(true);
    expect(fetch).toHaveBeenCalledTimes(2);
    for (const [, init] of fetch.mock.calls) {
      assert.isDefined(init);
      expect(new Headers(init.headers).has("Idempotency-Key")).toBe(false);
    }
  });
});
