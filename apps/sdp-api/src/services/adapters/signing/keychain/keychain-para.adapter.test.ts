import { KeychainParaAdapter } from "@sdp/custody/keychain";
import { afterEach, describe, expect, it, vi } from "vitest";

const WALLET_ADDRESS = "11111111111111111111111111111111";
const WALLET_ID = "0b6f4a8e-2c1d-4e5f-9a7b-3c8d2e1f4a6b";

describe("para adapter", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("evicts failed signer creation so subsequent calls can retry", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValueOnce(new TypeError("temporary para outage"))
      .mockResolvedValueOnce(
        Response.json({ id: WALLET_ID, type: "SOLANA", address: WALLET_ADDRESS })
      );
    const adapter = new KeychainParaAdapter({ apiKey: "sk_test-key" });

    await expect(adapter.getPublicKey(`para_${WALLET_ID}`)).rejects.toThrow(
      "Para network request failed"
    );
    await expect(adapter.getPublicKey(`para_${WALLET_ID}`)).resolves.toBe(WALLET_ADDRESS);

    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(String(fetchSpy.mock.calls[1]?.[0])).toContain(`/v1/wallets/${WALLET_ID}`);
  });

  it("reuses one signer construction across successful calls", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(Response.json({ id: WALLET_ID, type: "SOLANA", address: WALLET_ADDRESS }));
    const adapter = new KeychainParaAdapter({ apiKey: "sk_test-key" });

    const first = await adapter.getTransactionSigner(`para_${WALLET_ID}`);
    const second = await adapter.getTransactionSigner(`para_${WALLET_ID}`);

    expect(second).toBe(first);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});
