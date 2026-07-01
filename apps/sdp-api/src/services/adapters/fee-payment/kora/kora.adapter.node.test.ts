import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  signTransaction: vi.fn(),
  signAndSendTransaction: vi.fn(),
}));

// Class, not an arrow, so `new KoraClient(...)` is constructable.
vi.mock("@solana/kora", () => {
  class MockKoraClient {
    signTransaction = mocks.signTransaction;
    signAndSendTransaction = mocks.signAndSendTransaction;
  }
  return { KoraClient: MockKoraClient };
});

import { KoraAdapter } from "./kora.adapter";

const TX = new Uint8Array([1, 2, 3, 4]);

beforeEach(() => {
  mocks.signTransaction.mockReset().mockResolvedValue({ signed_transaction: "AQIDBA==" });
  mocks.signAndSendTransaction.mockReset().mockResolvedValue({
    signature: "TEST_SIGNATURE",
    signed_transaction: "AQIDBA==",
  });
});

describe("KoraAdapter user_id forwarding", () => {
  it("forwards user_id on signAndSend when configured", async () => {
    const adapter = new KoraAdapter({ rpcUrl: "http://kora", userId: "usr_abc123" });
    await adapter.signAndSend(TX);
    expect(mocks.signAndSendTransaction).toHaveBeenCalledWith(
      expect.objectContaining({ user_id: "usr_abc123" })
    );
  });

  it("forwards user_id on signAsFeePayer when configured", async () => {
    const adapter = new KoraAdapter({ rpcUrl: "http://kora", userId: "usr_abc123" });
    await adapter.signAsFeePayer(TX);
    expect(mocks.signTransaction).toHaveBeenCalledWith(
      expect.objectContaining({ user_id: "usr_abc123" })
    );
  });

  it("omits user_id on signAndSend when not configured (e.g. unauthenticated / devnet)", async () => {
    const adapter = new KoraAdapter({ rpcUrl: "http://kora" });
    await adapter.signAndSend(TX);
    const arg = mocks.signAndSendTransaction.mock.calls[0]?.[0] ?? {};
    expect(arg).not.toHaveProperty("user_id");
    expect(arg).toHaveProperty("transaction");
  });

  it("omits user_id on signAsFeePayer when not configured", async () => {
    const adapter = new KoraAdapter({ rpcUrl: "http://kora" });
    await adapter.signAsFeePayer(TX);
    const arg = mocks.signTransaction.mock.calls[0]?.[0] ?? {};
    expect(arg).not.toHaveProperty("user_id");
    expect(arg).toHaveProperty("transaction");
  });
});
