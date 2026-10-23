import type { MockInstance } from "vitest";
import { beforeEach, describe, expect, it, vi } from "vitest";

/** Every argument every console sink received, as one searchable string. */
function collectLogLines(...sinks: MockInstance[]): string {
  return sinks
    .flatMap((sink) => sink.mock.calls)
    .map((call) => call.map((argument) => JSON.stringify(argument)).join(" "))
    .join("\n");
}

const fireblocksSignerMock = vi.hoisted(() => ({
  constructorConfigs: [] as unknown[],
  /** Every signer the adapter built, typed by the surface the tests drive. */
  instances: [] as Array<{
    request: (method: string, uri: string, body?: unknown) => Promise<unknown>;
  }>,
  init: vi.fn<() => Promise<void>>(),
  request: vi.fn(async (): Promise<{ id: string; note: string }> => ({
    id: "tx-1",
    note: "response-secret-value",
  })),
}));

vi.mock("@solana/keychain-fireblocks", () => ({
  FireblocksSigner: class FireblocksSigner {
    readonly address = "11111111111111111111111111111111";

    request(method: string, uri: string, body?: unknown): Promise<unknown> {
      return fireblocksSignerMock.request();
    }

    constructor(config: unknown) {
      fireblocksSignerMock.constructorConfigs.push(config);
      fireblocksSignerMock.instances.push(this);
    }

    init(): Promise<void> {
      return fireblocksSignerMock.init();
    }
  },
}));

describe("fireblocks adapter", () => {
  beforeEach(() => {
    vi.resetModules();
    fireblocksSignerMock.constructorConfigs.length = 0;
    fireblocksSignerMock.instances.length = 0;
    fireblocksSignerMock.init.mockReset();
    fireblocksSignerMock.request.mockReset();
    fireblocksSignerMock.request.mockImplementation(async () => ({
      id: "tx-1",
      note: "response-secret-value",
    }));
  });

  it("evicts failed signer initialization so subsequent calls can retry", async () => {
    const { KeychainFireblocksAdapter } = await import("./keychain-fireblocks.adapter");
    const adapter = new KeychainFireblocksAdapter({
      apiKey: "api-key",
      apiSecretPem: "api-secret",
      vaultAccountId: "default-vault",
    });

    fireblocksSignerMock.init
      .mockRejectedValueOnce(new Error("temporary fireblocks outage"))
      .mockResolvedValueOnce();

    await expect(adapter.getPublicKey("fb_vault-1")).rejects.toThrow("temporary fireblocks outage");
    await expect(adapter.getPublicKey("fb_vault-1")).resolves.toBe(
      "11111111111111111111111111111111"
    );

    expect(fireblocksSignerMock.init).toHaveBeenCalledTimes(2);
    expect(fireblocksSignerMock.constructorConfigs).toEqual([
      expect.objectContaining({ vaultAccountId: "vault-1" }),
      expect.objectContaining({ vaultAccountId: "vault-1" }),
    ]);
  });

  it("keeps a Fireblocks exchange's request and response bodies off the console sinks", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    try {
      const { KeychainFireblocksAdapter } = await import("./keychain-fireblocks.adapter");
      const adapter = new KeychainFireblocksAdapter({
        apiKey: "api-key",
        apiSecretPem: "api-secret",
        vaultAccountId: "default-vault",
      });
      await adapter.getTransactionSigner();
      const [signer] = fireblocksSignerMock.instances;

      await signer.request("POST", "/v1/transactions/raw", {
        message: "secret-signing-payload",
      });
      fireblocksSignerMock.request.mockRejectedValueOnce(new Error("fireblocks is unavailable"));
      await expect(
        signer.request("POST", "/v1/transactions/raw", { message: "secret-signing-payload" })
      ).rejects.toThrow("fireblocks is unavailable");

      // A request or response body is provider- and tenant-shaped and bounded
      // only by the redaction denylist, so nothing about the exchange may
      // reach an info-level sink: neither the signing payload nor the
      // provider's answer, on the success path or the failure path.
      const logged = collectLogLines(info, error);
      expect(logged).not.toContain("secret-signing-payload");
      expect(logged).not.toContain("response-secret-value");
      expect(logged).not.toContain("fireblocks is unavailable");
    } finally {
      info.mockRestore();
      error.mockRestore();
    }
  });
});
