import { runInClusterScope } from "@sdp/rpc/scope";
import type { WalletFaucetResponse } from "@sdp/types/custody";
import { SOLANA_ERROR__JSON_RPC__SERVER_ERROR_NODE_UNHEALTHY } from "@solana/kit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  installClusterRpcResponder,
  type SignatureStatusesRead,
  type StubSignatureStatus,
  signatureStatusesRead,
  signatureStatusesReply,
} from "@/test/helpers/cluster-rpc";
import { syntheticAddress, syntheticSignature } from "@/test/helpers/parsed-transactions";
import { requestDevnetFaucetAirdrop } from "./devnet-faucet";

const AIRDROP_SIGNATURE = syntheticSignature(1);
const CONFIRMATION_WINDOW_MS = 15_000;

const PROCESSED_STATUS = {
  slot: 100,
  confirmations: 0,
  confirmationStatus: "processed",
  err: null,
} as const satisfies StubSignatureStatus;

const CONFIRMED_STATUS = {
  slot: 101,
  confirmations: 1,
  confirmationStatus: "confirmed",
  err: null,
} as const satisfies StubSignatureStatus;

describe("requestDevnetFaucetAirdrop", () => {
  const rpc = installClusterRpcResponder();

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    rpc.answer("requestAirdrop", AIRDROP_SIGNATURE);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function statusReads(): SignatureStatusesRead[] {
    return rpc.requests
      .filter((request) => request.method === "getSignatureStatuses")
      .map(signatureStatusesRead);
  }

  function airdropRequestCount(): number {
    return rpc.calls.filter((call) => call.method === "requestAirdrop").length;
  }

  function respondStatusPerRead(statusForRead: (readNumber: number) => StubSignatureStatus): void {
    rpc.respond("getSignatureStatuses", () =>
      signatureStatusesReply([statusForRead(statusReads().length)])
    );
  }

  async function airdropThroughConfirmationWindow(): Promise<WalletFaucetResponse> {
    const airdrop = runInClusterScope(
      { projectId: "prj_devnet_faucet_sandbox", environment: "sandbox" },
      () => requestDevnetFaucetAirdrop(syntheticAddress(1))
    );
    await vi.advanceTimersByTimeAsync(CONFIRMATION_WINDOW_MS);
    return airdrop;
  }

  it("refuses a production scope before any RPC call", async () => {
    await expect(
      runInClusterScope(
        { projectId: "prj_devnet_faucet_production", environment: "production" },
        () => requestDevnetFaucetAirdrop(syntheticAddress(1))
      )
    ).rejects.toMatchObject({
      code: "FORBIDDEN",
      statusCode: 403,
      details: { reason: "faucet_devnet_only", cluster: "mainnet-beta" },
    });
    expect(rpc.calls).toEqual([]);
  });

  it("returns confirmed once a status read reaches confirmed commitment", async () => {
    respondStatusPerRead((readNumber) => (readNumber === 1 ? PROCESSED_STATUS : CONFIRMED_STATUS));

    await expect(airdropThroughConfirmationWindow()).resolves.toEqual({
      signature: AIRDROP_SIGNATURE,
      status: "confirmed",
      lamports: "1000000000",
    });
    expect(airdropRequestCount()).toBe(1);
    const airdropStatusRead = {
      cluster: "devnet",
      signatures: [AIRDROP_SIGNATURE],
      searchTransactionHistory: false,
    };
    expect(statusReads()).toEqual([airdropStatusRead, airdropStatusRead]);
  });

  it("returns failed when the airdrop landed with an error", async () => {
    rpc.respondSignatureStatuses(() => ({
      ...CONFIRMED_STATUS,
      err: { InstructionError: [0, "InsufficientFunds"] },
    }));

    await expect(airdropThroughConfirmationWindow()).resolves.toMatchObject({ status: "failed" });
    expect(statusReads()).toHaveLength(1);
  });

  it("keeps polling past a status read the endpoint fails", async () => {
    rpc.respond("getSignatureStatuses", () =>
      statusReads().length === 1
        ? {
            error: {
              code: SOLANA_ERROR__JSON_RPC__SERVER_ERROR_NODE_UNHEALTHY,
              message: "Node is unhealthy",
            },
          }
        : signatureStatusesReply([CONFIRMED_STATUS])
    );

    await expect(airdropThroughConfirmationWindow()).resolves.toMatchObject({
      status: "confirmed",
    });
    expect(statusReads()).toHaveLength(2);
  });

  it("returns timeout when the airdrop never confirms within the window", async () => {
    respondStatusPerRead(() => PROCESSED_STATUS);

    await expect(airdropThroughConfirmationWindow()).resolves.toMatchObject({ status: "timeout" });
    expect(airdropRequestCount()).toBe(1);
    expect(statusReads()).toHaveLength(14);
  });
});
