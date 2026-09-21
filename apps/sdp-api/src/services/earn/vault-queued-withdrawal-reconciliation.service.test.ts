import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  EarnVaultWithdrawalRequestActionRow,
  EarnVaultWithdrawalRequestRow,
  EarnVaultWithdrawalRequestsRepository,
} from "@/db/repositories/earn-vault-withdrawal-requests.repository";
import { env } from "@/test/helpers/env";
import {
  assertClosingIdentity,
  projectClosingEvent,
  reconcileAction,
} from "./vault-queued-withdrawal-reconciliation.service";

const provider = vi.hoisted(() => ({ client: null as Record<string, unknown> | null }));

vi.mock("@/services/earn/execution-registry", () => ({
  earnClusterFor: () => "devnet",
  resolveClusterRpcUrl: () => "http://rpc.invalid",
  resolveVaultQueuedWithdrawClient: () => provider.client,
}));

const OWNER = "7YfVedaQueueOwner111111111111111111111111111";
const VAULT = "8VfVedaQueueVault111111111111111111111111111";
const TOKEN_MINT = "9VfVedaQueueToken111111111111111111111111111";
const SHARE_MINT = "AVfVedaQueueShare111111111111111111111111111";
const REQUEST_ADDRESS = "QueueRequestAddress11111111111111111111";

function request(
  overrides: Partial<EarnVaultWithdrawalRequestRow> = {}
): EarnVaultWithdrawalRequestRow {
  return {
    id: "earn_vault_withdrawal_request_test",
    organization_id: "org_test",
    project_id: "prj_test",
    environment: "sandbox",
    provider: "veda",
    position_id: "earn_position_test",
    custody_wallet_id: "cwlt_test",
    owner_address: OWNER,
    vault_address: VAULT,
    token_mint: TOKEN_MINT,
    share_mint: SHARE_MINT,
    request_address: REQUEST_ADDRESS,
    status: "creating",
    shares: "10",
    quoted_assets: "9.9",
    share_decimals: 6,
    asset_decimals: 6,
    discount_bps: 25,
    nonce: null,
    creation_timestamp: null,
    maturity_timestamp: "1700000060",
    deadline_timestamp: "1700000120",
    client_request_id: "request-key",
    idempotency_fingerprint: "request-fingerprint",
    creation_signature: "request-signature",
    cancel_signature: null,
    closing_signature: null,
    assets_paid: null,
    failure_reason: null,
    last_index_error: null,
    fulfilled_at: null,
    cancelled_at: null,
    created_by: "usr_test",
    initiated_by_key_id: null,
    created_at: "2026-09-18T00:00:00.000Z",
    updated_at: "2026-09-18T00:00:00.000Z",
    last_checked_at: null,
    ...overrides,
  };
}

function action(
  overrides: Partial<EarnVaultWithdrawalRequestActionRow> = {}
): EarnVaultWithdrawalRequestActionRow {
  return {
    id: "earn_vault_withdrawal_action_test",
    organization_id: "org_test",
    project_id: "prj_test",
    environment: "sandbox",
    withdrawal_request_id: "earn_vault_withdrawal_request_test",
    action: "request",
    status: "requested",
    signature: "request-signature",
    signed_transaction: "AQ==",
    last_valid_block_height: "1",
    client_request_id: "request-key",
    idempotency_fingerprint: "request-fingerprint",
    failure_reason: null,
    confirmed_at: null,
    settled_at: null,
    created_by: "usr_test",
    initiated_by_key_id: null,
    created_at: "2026-09-18T00:00:00.000Z",
    updated_at: "2026-09-18T00:00:00.000Z",
    last_checked_at: null,
    unknown_signature_observed_at: "2026-09-18T00:00:00.000Z",
    ...overrides,
  };
}

function fakeLedger(current: EarnVaultWithdrawalRequestRow) {
  return {
    getById: vi.fn().mockResolvedValue(current),
    observeExpiredUnknownSignature: vi.fn().mockResolvedValue("repeat"),
    advanceAction: vi.fn().mockResolvedValue(null),
    advanceRequest: vi.fn().mockResolvedValue(null),
    failActionAndRecoverRequest: vi.fn().mockResolvedValue(null),
  } as unknown as EarnVaultWithdrawalRequestsRepository;
}

const emptyRpc = {
  getTransaction: vi.fn(),
  getSignaturesForAddress: vi.fn(),
};

describe("queued withdrawal reconciliation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    provider.client = null;
  });

  it("recovers a live request PDA when signature history is missing after expiry", async () => {
    const current = request();
    const ledger = fakeLedger(current);
    provider.client = {
      readQueuedWithdrawalRequest: vi.fn().mockResolvedValue({
        requestAddress: REQUEST_ADDRESS,
        status: "pending",
        request: {
          requestAddress: REQUEST_ADDRESS,
          providerReference: VAULT,
          owner: OWNER,
          nonce: "7",
          assetMint: TOKEN_MINT,
          shares: "10",
          assets: "9.8",
          creationTimestamp: "1700000001",
          maturityTimestamp: "1700000061",
          deadlineTimestamp: "1700000121",
          status: "pending",
        },
      }),
    };

    await expect(
      reconcileAction(env, ledger, action(), null, {
        rpc: emptyRpc as never,
        rpcUrl: "http://rpc.invalid",
        currentHeight: 2n,
      })
    ).resolves.toBe("advanced");
    expect(ledger.advanceAction).toHaveBeenCalledWith(
      expect.objectContaining({ toStatus: "submitted" })
    );
    expect(ledger.advanceRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        toStatus: "pending",
        nonce: "7",
        quotedAssets: "9.8",
        maturityTimestamp: "1700000061",
        deadlineTimestamp: "1700000121",
      })
    );
  });

  it("makes an expired unknown cancellation retryable only after proving the PDA is live", async () => {
    const current = request({ status: "cancelling", nonce: "7" });
    const ledger = fakeLedger(current);
    provider.client = {
      readQueuedWithdrawalRequest: vi.fn().mockResolvedValue({
        requestAddress: REQUEST_ADDRESS,
        status: "expiredCancelable",
        request: {
          requestAddress: REQUEST_ADDRESS,
          providerReference: VAULT,
          owner: OWNER,
          nonce: "7",
          assetMint: TOKEN_MINT,
          shares: "10",
          assets: "9.9",
          creationTimestamp: "1700000000",
          maturityTimestamp: "1700000060",
          deadlineTimestamp: "1700000120",
          status: "expiredCancelable",
        },
      }),
    };

    await expect(
      reconcileAction(env, ledger, action({ action: "cancel" }), null, {
        rpc: emptyRpc as never,
        rpcUrl: "http://rpc.invalid",
        currentHeight: 2n,
      })
    ).resolves.toBe("failed");
    expect(ledger.failActionAndRecoverRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        actionId: "earn_vault_withdrawal_action_test",
        nonce: "7",
        quotedAssets: "9.9",
      })
    );
    expect(ledger.advanceAction).not.toHaveBeenCalled();
    expect(ledger.advanceRequest).not.toHaveBeenCalled();
  });

  it("recovers a submitted cancel that disappeared from signature history", async () => {
    const current = request({ status: "cancelling", nonce: "7" });
    const ledger = fakeLedger(current);
    provider.client = {
      readQueuedWithdrawalRequest: vi.fn().mockResolvedValue({
        requestAddress: REQUEST_ADDRESS,
        status: "expiredCancelable",
        request: {
          requestAddress: REQUEST_ADDRESS,
          providerReference: VAULT,
          owner: OWNER,
          nonce: "7",
          assetMint: TOKEN_MINT,
          shares: "10",
          assets: "9.9",
          creationTimestamp: "1700000000",
          maturityTimestamp: "1700000060",
          deadlineTimestamp: "1700000120",
          status: "expiredCancelable",
        },
      }),
    };

    await expect(
      reconcileAction(env, ledger, action({ action: "cancel", status: "submitted" }), null, {
        rpc: emptyRpc as never,
        rpcUrl: "http://rpc.invalid",
        currentHeight: 2n,
      })
    ).resolves.toBe("failed");
    expect(ledger.observeExpiredUnknownSignature).not.toHaveBeenCalled();
    expect(ledger.failActionAndRecoverRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        actionId: "earn_vault_withdrawal_action_test",
        nonce: "7",
        quotedAssets: "9.9",
      })
    );
    expect(ledger.advanceAction).not.toHaveBeenCalled();
    expect(ledger.advanceRequest).not.toHaveBeenCalled();
  });

  it("handles a rejected transaction with one atomic action/request transition", async () => {
    const ledger = fakeLedger(request());
    await expect(
      reconcileAction(
        env,
        ledger,
        action(),
        { err: "program rejected the queued request" } as never,
        {
          rpc: emptyRpc as never,
          rpcUrl: "http://rpc.invalid",
          currentHeight: 2n,
        }
      )
    ).resolves.toBe("failed");
    expect(ledger.failActionAndRecoverRequest).toHaveBeenCalledWith({
      actionId: "earn_vault_withdrawal_action_test",
      organizationId: "org_test",
      failureReason: "program rejected the queued request",
    });
    expect(ledger.advanceAction).not.toHaveBeenCalled();
    expect(ledger.advanceRequest).not.toHaveBeenCalled();
  });

  it("dispatches finalized lifecycle decoding through a non-Veda provider capability", async () => {
    const current = request({ provider: "upshift" });
    const ledger = fakeLedger(current);
    const decodeQueuedWithdrawalLifecycleEvents = vi.fn().mockResolvedValue([
      {
        kind: "withdrawalRequested",
        requestAddress: REQUEST_ADDRESS,
        owner: OWNER,
        assetMint: TOKEN_MINT,
        nonce: "7",
        shares: "10",
        assets: "9.8",
        creationTimestamp: "1700000001",
        maturityTimestamp: "1700000061",
        deadlineTimestamp: "1700000121",
      },
    ]);
    provider.client = { decodeQueuedWithdrawalLifecycleEvents };
    const rpc = {
      getTransaction: vi.fn().mockReturnValue({
        send: vi.fn().mockResolvedValue({
          meta: { err: null, logMessages: ["provider-owned lifecycle log"] },
        }),
      }),
      getSignaturesForAddress: vi.fn(),
    };

    await expect(
      reconcileAction(
        env,
        ledger,
        action(),
        { err: null, confirmationStatus: "finalized" } as never,
        {
          rpc: rpc as never,
          rpcUrl: "http://rpc.invalid",
          currentHeight: null,
        }
      )
    ).resolves.toBe("advanced");

    expect(decodeQueuedWithdrawalLifecycleEvents).toHaveBeenCalledWith(
      expect.objectContaining({ environment: "sandbox" }),
      {
        providerReference: VAULT,
        requestAddress: REQUEST_ADDRESS,
        logs: ["provider-owned lifecycle log"],
        shareDecimals: 6,
        assetDecimals: 6,
      }
    );
    expect(ledger.advanceRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        toStatus: "expired_cancelable",
        nonce: "7",
        quotedAssets: "9.8",
      })
    );
  });

  it("refuses terminal lifecycle events whose nonce or settled shares disagree", () => {
    const current = request({ nonce: "7" });
    expect(() =>
      assertClosingIdentity(current, {
        kind: "withdrawalFulfilled",
        requestAddress: REQUEST_ADDRESS,
        owner: OWNER,
        nonce: "7",
        assetMint: TOKEN_MINT,
        sharesBurned: "9",
        assetsPaid: "9.8",
        fulfilledAt: "1700000200",
      } as never)
    ).toThrow(/foreign identity/i);
    expect(() =>
      assertClosingIdentity(current, {
        kind: "withdrawalCancelled",
        requestAddress: REQUEST_ADDRESS,
        owner: OWNER,
        nonce: "8",
        assetMint: TOKEN_MINT,
        sharesReturned: "10",
        cancelledAt: "1700000200",
      } as never)
    ).toThrow(/foreign identity/i);
  });

  it("persists authoritative fulfillment and cancellation timestamps from lifecycle events", async () => {
    const current = request({ status: "cancelling", nonce: "7" });
    const ledger = fakeLedger(current);
    await projectClosingEvent(ledger, current, {
      signature: "solver-fulfillment-signature",
      event: {
        kind: "withdrawalFulfilled",
        requestAddress: REQUEST_ADDRESS,
        owner: OWNER,
        nonce: "7",
        assetMint: TOKEN_MINT,
        sharesBurned: "10",
        assetsPaid: "9.8",
        fulfilledAt: "1700000200",
      } as never,
    });
    expect(ledger.advanceRequest).toHaveBeenLastCalledWith(
      expect.objectContaining({
        toStatus: "fulfilled",
        closingSignature: "solver-fulfillment-signature",
        assetsPaid: "9.8",
        fulfilledAt: "2023-11-14T22:16:40.000Z",
      })
    );

    await projectClosingEvent(ledger, current, {
      signature: "cancel-signature",
      event: {
        kind: "withdrawalCancelled",
        requestAddress: REQUEST_ADDRESS,
        owner: OWNER,
        nonce: "7",
        assetMint: TOKEN_MINT,
        sharesReturned: "10",
        cancelledAt: "1700000300",
      } as never,
    });
    expect(ledger.advanceRequest).toHaveBeenLastCalledWith(
      expect.objectContaining({
        toStatus: "cancelled",
        closingSignature: "cancel-signature",
        cancelledAt: "2023-11-14T22:18:20.000Z",
      })
    );
  });
});
