import { beforeEach, describe, expect, it, vi } from "vitest";

const fireblocksSignerMock = vi.hoisted(() => ({
  constructorConfigs: [] as unknown[],
  init: vi.fn<() => Promise<void>>(),
}));

vi.mock("@solana/keychain-fireblocks", () => ({
  FireblocksSigner: class FireblocksSigner {
    readonly address = "11111111111111111111111111111111";

    constructor(config: unknown) {
      fireblocksSignerMock.constructorConfigs.push(config);
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
    fireblocksSignerMock.init.mockReset();
  });

  it("evicts failed signer initialization so subsequent calls can retry", async () => {
    const { KeychainFireblocksAdapter } = await import(
      "@/services/adapters/signing/keychain/keychain-fireblocks.adapter"
    );
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
});
