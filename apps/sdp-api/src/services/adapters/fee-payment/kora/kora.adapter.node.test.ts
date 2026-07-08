import type { KoraClient } from "@solana/kora";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { KoraAdapter } from "./kora.adapter";

const signTransaction = vi.fn();
const signAndSendTransaction = vi.fn();
const fakeClient = {
  signTransaction,
  signAndSendTransaction,
} as unknown as KoraClient;

const TX = new Uint8Array([1, 2, 3, 4]);

beforeEach(() => {
  signTransaction.mockReset().mockResolvedValue({ signed_transaction: "AQIDBA==" });
  signAndSendTransaction.mockReset().mockResolvedValue({
    signature: "TEST_SIGNATURE",
    signed_transaction: "AQIDBA==",
  });
});

describe("KoraAdapter user_id forwarding", () => {
  it("forwards user_id on signAndSend when configured", async () => {
    const adapter = new KoraAdapter({
      rpcUrl: "http://kora",
      userId: "usr_abc123",
      client: fakeClient,
    });
    await adapter.signAndSend(TX);
    expect(signAndSendTransaction).toHaveBeenCalledWith(
      expect.objectContaining({ user_id: "usr_abc123" })
    );
  });

  it("forwards user_id on signAsFeePayer when configured", async () => {
    const adapter = new KoraAdapter({
      rpcUrl: "http://kora",
      userId: "usr_abc123",
      client: fakeClient,
    });
    await adapter.signAsFeePayer(TX);
    expect(signTransaction).toHaveBeenCalledWith(
      expect.objectContaining({ user_id: "usr_abc123" })
    );
  });

  it("omits user_id on signAndSend when not configured (e.g. unauthenticated / devnet)", async () => {
    const adapter = new KoraAdapter({
      rpcUrl: "http://kora",
      client: fakeClient,
    });
    await adapter.signAndSend(TX);
    const arg = signAndSendTransaction.mock.calls[0]?.[0] ?? {};
    expect(arg).not.toHaveProperty("user_id");
    expect(arg).toHaveProperty("transaction");
  });

  it("omits user_id on signAsFeePayer when not configured", async () => {
    const adapter = new KoraAdapter({
      rpcUrl: "http://kora",
      client: fakeClient,
    });
    await adapter.signAsFeePayer(TX);
    const arg = signTransaction.mock.calls[0]?.[0] ?? {};
    expect(arg).not.toHaveProperty("user_id");
    expect(arg).toHaveProperty("transaction");
  });
});
