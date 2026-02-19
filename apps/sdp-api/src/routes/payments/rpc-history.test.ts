import type { Env } from "@/types/env";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  getTransactionsJsonParsedBatch,
  inferTransferFromTransaction,
  mapSignatureStatusToTransferStatus,
  touchesOwnedWallet,
  unixSecondsToIso,
} from "./rpc-history";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("payments rpc-history helpers", () => {
  it("maps signature confirmation states to transfer statuses", () => {
    expect(mapSignatureStatusToTransferStatus({ err: { code: 1 } })).toBe("failed");
    expect(mapSignatureStatusToTransferStatus({ confirmationStatus: "finalized" })).toBe(
      "finalized"
    );
    expect(mapSignatureStatusToTransferStatus({ confirmationStatus: "processed" })).toBe(
      "processing"
    );
    expect(mapSignatureStatusToTransferStatus({ confirmationStatus: "confirmed" })).toBe(
      "confirmed"
    );
    expect(mapSignatureStatusToTransferStatus({})).toBe("confirmed");
  });

  it("detects whether a transaction touches owned wallets", () => {
    const txFromAccountKeys = {
      transaction: {
        message: {
          accountKeys: [{ pubkey: "owned_wallet" }],
          instructions: [],
        },
      },
    };
    expect(touchesOwnedWallet(txFromAccountKeys, new Set(["owned_wallet"]))).toBe(true);

    const txFromInstructionInfo = {
      transaction: {
        message: {
          accountKeys: [],
          instructions: [
            {
              parsed: {
                info: {
                  authority: "owned_auth",
                },
              },
            },
          ],
        },
      },
    };
    expect(touchesOwnedWallet(txFromInstructionInfo, new Set(["owned_auth"]))).toBe(true);
    expect(touchesOwnedWallet(txFromInstructionInfo, new Set(["not_present"]))).toBe(false);
    expect(touchesOwnedWallet(txFromInstructionInfo, new Set())).toBe(false);
  });

  it("infers SOL transfers with direction and decimal formatting", () => {
    const tx = {
      meta: {
        fee: 5000,
      },
      transaction: {
        message: {
          instructions: [
            {
              parsed: {
                type: "transfer",
                info: {
                  source: "src_wallet",
                  destination: "dst_wallet",
                  lamports: "1500000000",
                },
              },
            },
          ],
        },
      },
    };

    const outbound = inferTransferFromTransaction(tx, {
      ownedAddresses: new Set(["src_wallet"]),
    });
    expect(outbound.type).toBe("transfer");
    expect(outbound.direction).toBe("outbound");
    expect(outbound.token).toBe("SOL");
    expect(outbound.amount).toBe("1.5");
    expect(outbound.fee).toBe(5000);

    const inbound = inferTransferFromTransaction(tx, {
      ownedAddresses: new Set(["dst_wallet"]),
    });
    expect(inbound.direction).toBe("inbound");
  });

  it("infers confidential SPL transfers and falls back for unknown instructions", () => {
    const confidentialTx = {
      meta: {
        fee: 1234,
      },
      transaction: {
        message: {
          instructions: [
            {
              parsed: {
                // biome-ignore lint/nursery/noSecrets: Instruction type literal used in test fixture.
                type: "confidentialTransferChecked",
                info: {
                  authority: "auth_wallet",
                  destination: "dst_wallet",
                  mint: "mint_addr",
                  tokenAmount: {
                    uiAmountString: "7.25",
                  },
                },
              },
            },
          ],
        },
      },
    };

    const parsed = inferTransferFromTransaction(confidentialTx, {
      ownedAddresses: new Set(["dst_wallet"]),
    });
    expect(parsed.type).toBe("transfer_confidential");
    expect(parsed.direction).toBe("inbound");
    expect(parsed.source).toBe("auth_wallet");
    expect(parsed.destination).toBe("dst_wallet");
    expect(parsed.token).toBe("mint_addr");
    expect(parsed.amount).toBe("7.25");
    expect(parsed.fee).toBe(1234);

    const unknownTx = {
      meta: {
        fee: 77,
      },
      transaction: {
        message: {
          instructions: [
            {
              parsed: {
                type: "noop",
                info: {},
              },
            },
          ],
        },
      },
    };

    expect(inferTransferFromTransaction(unknownTx)).toEqual({
      type: "transfer",
      direction: "outbound",
      fee: 77,
    });
  });

  it("converts unix timestamps to ISO strings", () => {
    expect(unixSecondsToIso(1_735_689_600)).toBe("2025-01-01T00:00:00.000Z");
    expect(unixSecondsToIso(null)).toBeNull();
    expect(unixSecondsToIso(undefined)).toBeNull();
  });

  it("hydrates transactions via JSON-RPC batch and de-duplicates signatures", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify([
          { jsonrpc: "2.0", id: "sig_a", result: { slot: 10 } },
          { jsonrpc: "2.0", id: "sig_b", result: null },
        ]),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }
      )
    );

    const env = { SOLANA_RPC_URL: "https://rpc.test" } as Env;
    const rpc = {} as unknown;
    const result = await getTransactionsJsonParsedBatch({
      env,
      rpc: rpc as never,
      signatures: ["sig_a", "sig_b", "sig_a"],
    });

    expect(result.size).toBe(2);
    expect(result.get("sig_a")).toEqual({ slot: 10 });
    expect(result.get("sig_b")).toBeNull();
  });

  it("falls back to sequential RPC calls when batch fetch fails", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network error"));

    const rpc = {
      getTransaction(signature: string) {
        return {
          async send() {
            if (signature === "sig_err") {
              throw new Error("rpc error");
            }
            return { signature, slot: 42 };
          },
        };
      },
    };

    const env = { SOLANA_RPC_URL: "https://rpc.test" } as Env;
    const result = await getTransactionsJsonParsedBatch({
      env,
      rpc: rpc as never,
      signatures: ["sig_ok", "sig_err"],
    });

    expect(result.get("sig_ok")).toEqual({ signature: "sig_ok", slot: 42 });
    expect(result.get("sig_err")).toBeNull();
  });
});
