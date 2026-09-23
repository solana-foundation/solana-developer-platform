import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  EarnVaultWithdrawalRequestActionRow,
  EarnVaultWithdrawalRequestRow,
  EarnVaultWithdrawalRequestsRepository,
} from "@/db/repositories/earn-vault-withdrawal-requests.repository";
import { env } from "@/test/helpers/env";
import {
  assertClosingIdentity,
  findClosingEventInHistoryPage,
  findClosingParEventInHistoryPage,
  nextQueuedWithdrawalCheckAt,
  projectClosingEvent,
  reconcileAction,
  reconcileParRequest,
  visitOpenRequestsJustInTime,
} from "./vault-queued-withdrawal-reconciliation.service";

const provider = vi.hoisted(() => ({ client: null as Record<string, unknown> | null }));
const parProvider = vi.hoisted(() => ({ client: null as Record<string, unknown> | null }));
const sweepRpc = vi.hoisted(() => ({ current: null as Record<string, unknown> | null }));

vi.mock("@/services/earn/execution-registry", () => ({
  earnClusterFor: () => "devnet",
  resolveClusterRpcUrl: () => "http://rpc.invalid",
  resolveVaultQueuedWithdrawClient: () => provider.client,
  resolveVaultParRedemptionClient: () => parProvider.client,
}));

vi.mock("@sdp/rpc/solana", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, createRpc: () => sweepRpc.current };
});

const OWNER = "7YfVedaQueueOwner111111111111111111111111111";
const VAULT = "8VfVedaQueueVault111111111111111111111111111";
const TOKEN_MINT = "9VfVedaQueueToken111111111111111111111111111";
const SHARE_MINT = "AVfVedaQueueShare111111111111111111111111111";
const REQUEST_ADDRESS = "QueueRequestAddress11111111111111111111";
const PAR_REQUEST_ADDRESS = "11111111111111111111111111111111";
const INTERMEDIATE_MINT = "BVfHastraWylds1111111111111111111111111111";

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
    mechanism: "solver_queue",
    shares: "10",
    quoted_assets: "9.9",
    share_decimals: 6,
    asset_decimals: 6,
    intermediate_mint: null,
    intermediate_amount: null,
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
    next_check_at: null,
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

function parRequest(
  overrides: Partial<EarnVaultWithdrawalRequestRow> = {}
): EarnVaultWithdrawalRequestRow {
  return request({
    provider: "hastra",
    mechanism: "operator_redemption",
    request_address: PAR_REQUEST_ADDRESS,
    intermediate_mint: INTERMEDIATE_MINT,
    intermediate_amount: "10.25",
    quoted_assets: "10.25",
    discount_bps: null,
    maturity_timestamp: null,
    deadline_timestamp: null,
    ...overrides,
  });
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
    parProvider.client = null;
    sweepRpc.current = null;
  });

  it("backs pending provider reads off without adding delay past maturity", () => {
    const now = Date.parse("2026-09-22T12:00:00.000Z");
    expect(nextQueuedWithdrawalCheckAt("pending", String(now / 1_000 + 30), now)).toBe(
      "2026-09-22T12:01:00.000Z"
    );
    expect(nextQueuedWithdrawalCheckAt("pending", String(now / 1_000 + 600), now)).toBe(
      "2026-09-22T12:10:00.000Z"
    );
    expect(nextQueuedWithdrawalCheckAt("pending", String(now / 1_000 + 3_600), now)).toBe(
      "2026-09-22T12:15:00.000Z"
    );
    expect(nextQueuedWithdrawalCheckAt("fulfillable", "0", now)).toBe("2026-09-22T12:01:00.000Z");
    expect(nextQueuedWithdrawalCheckAt("fulfilled", "0", now)).toBeNull();
  });

  it("claims each open request only when the prior request has finished", async () => {
    const events: string[] = [];
    const due = [request({ id: "request-1" }), request({ id: "request-2" })];
    const claimOpenRequests = vi.fn(async () => {
      events.push("claim");
      return due.splice(0, 1);
    });

    await expect(
      visitOpenRequestsJustInTime({ claimOpenRequests }, 3, async (row) => {
        events.push(`start:${row.id}`);
        await Promise.resolve();
        events.push(`finish:${row.id}`);
      })
    ).resolves.toBe(2);

    expect(claimOpenRequests).toHaveBeenCalledTimes(3);
    expect(claimOpenRequests).toHaveBeenCalledWith(1);
    expect(events).toEqual([
      "claim",
      "start:request-1",
      "finish:request-1",
      "claim",
      "start:request-2",
      "finish:request-2",
      "claim",
    ]);
  });

  it("decodes closing history with bounded parallel transaction reads", async () => {
    let active = 0;
    let maxActive = 0;
    const rpc = {
      getTransaction: vi.fn((signature: string) => ({
        send: async () => {
          active += 1;
          maxActive = Math.max(maxActive, active);
          await new Promise((resolve) => setTimeout(resolve, 1));
          active -= 1;
          return { meta: { err: null, logMessages: [signature] } };
        },
      })),
      getSignaturesForAddress: vi.fn(),
    };
    const client = {
      decodeQueuedWithdrawalLifecycleEvents: vi.fn(
        async (_ctx: unknown, input: { logs: readonly string[] }) =>
          input.logs[0] === "history-9"
            ? [
                {
                  kind: "withdrawalFulfilled",
                  requestAddress: REQUEST_ADDRESS,
                  owner: OWNER,
                  nonce: "7",
                  assetMint: TOKEN_MINT,
                  sharesBurned: "10",
                  assetsPaid: "9.8",
                  fulfilledAt: "1700000200",
                },
              ]
            : []
      ),
    };
    const history = Array.from({ length: 12 }, (_, index) => ({
      signature: `history-${index}`,
      err: null,
    }));

    await expect(
      findClosingEventInHistoryPage(env, rpc as never, request(), client as never, history)
    ).resolves.toMatchObject({ signature: "history-9" });
    expect(maxActive).toBe(8);
    expect(rpc.getTransaction).toHaveBeenCalledTimes(12);
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

  it("projects a finalized par request without changing its quoted asset amount", async () => {
    const current = parRequest();
    const ledger = fakeLedger(current);
    const decodeParRedemptionLifecycleEvents = vi.fn().mockResolvedValue([
      {
        kind: "redemptionRequested",
        requestAddress: PAR_REQUEST_ADDRESS,
        owner: OWNER,
        intermediateMint: INTERMEDIATE_MINT,
        intermediateAmount: "10.25",
        occurredAt: "1800000100",
      },
    ]);
    parProvider.client = { decodeParRedemptionLifecycleEvents };
    const rpc = {
      getTransaction: vi.fn().mockReturnValue({
        send: vi.fn().mockResolvedValue({
          blockTime: 1_800_000_100,
          meta: { err: null, logMessages: ["authenticated Hastra lifecycle log"] },
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
        { rpc: rpc as never, rpcUrl: "http://rpc.invalid", currentHeight: null }
      )
    ).resolves.toBe("advanced");

    expect(decodeParRedemptionLifecycleEvents).toHaveBeenCalledWith(
      expect.objectContaining({ environment: "sandbox" }),
      expect.objectContaining({
        providerReference: VAULT,
        requestAddress: PAR_REQUEST_ADDRESS,
        blockTime: "1800000100",
        logs: ["authenticated Hastra lifecycle log"],
      })
    );
    const projection = vi.mocked(ledger.advanceRequest).mock.calls.at(-1)?.[0];
    expect(projection).toMatchObject({
      toStatus: "pending",
      creationTimestamp: "1800000100",
    });
    expect(projection).not.toHaveProperty("quotedAssets");
  });

  it("makes an expired unknown par cancellation retryable when its PDA remains live", async () => {
    const current = parRequest({ status: "cancelling" });
    const ledger = fakeLedger(current);
    parProvider.client = {
      readParRedemptionRequest: vi.fn().mockResolvedValue({
        requestAddress: PAR_REQUEST_ADDRESS,
        status: "pending",
        request: {
          requestAddress: PAR_REQUEST_ADDRESS,
          providerReference: VAULT,
          owner: OWNER,
          intermediateMint: INTERMEDIATE_MINT,
          intermediateAmount: "10.25",
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
    expect(ledger.failActionAndRecoverRequest).toHaveBeenCalledWith({
      actionId: "earn_vault_withdrawal_action_test",
      organizationId: "org_test",
      failureReason: "Cancellation blockhash expired while the par redemption remained open",
      lastIndexError: null,
    });
  });

  it("bounds reusable par-request history at creation and records operator fulfillment", async () => {
    const current = parRequest({ status: "pending" });
    const ledger = fakeLedger(current);
    const decodeParRedemptionLifecycleEvents = vi.fn().mockResolvedValue([
      {
        kind: "redemptionFulfilled",
        requestAddress: PAR_REQUEST_ADDRESS,
        owner: OWNER,
        intermediateMint: INTERMEDIATE_MINT,
        intermediateAmount: "10.25",
        assetsPaid: "10.25",
        occurredAt: "1800000200",
      },
    ]);
    parProvider.client = {
      readParRedemptionRequest: vi.fn().mockResolvedValue({
        requestAddress: PAR_REQUEST_ADDRESS,
        status: "closedOrUnknown",
        request: null,
      }),
      decodeParRedemptionLifecycleEvents,
    };
    const getSignaturesForAddress = vi.fn().mockReturnValue({
      send: vi.fn().mockResolvedValue([{ signature: "operator-fulfillment", err: null }]),
    });
    const rpc = {
      getSignaturesForAddress,
      getTransaction: vi.fn().mockReturnValue({
        send: vi.fn().mockResolvedValue({
          blockTime: 1_800_000_200,
          meta: { err: null, logMessages: ["authenticated Hastra completion log"] },
        }),
      }),
    };

    await expect(
      reconcileAction(env, ledger, action(), null, {
        rpc: rpc as never,
        rpcUrl: "http://rpc.invalid",
        currentHeight: 2n,
      })
    ).resolves.toBe("advanced");

    expect(getSignaturesForAddress).toHaveBeenCalledWith(
      PAR_REQUEST_ADDRESS,
      expect.objectContaining({ until: "request-signature" })
    );
    expect(ledger.advanceRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        toStatus: "fulfilled",
        closingSignature: "operator-fulfillment",
        assetsPaid: "10.25",
        fulfilledAt: "2027-01-15T08:03:20.000Z",
      })
    );
  });

  it("decodes par closing history with bounded parallel transaction reads", async () => {
    let active = 0;
    let maxActive = 0;
    const rpc = {
      getTransaction: vi.fn((signature: string) => ({
        send: async () => {
          active += 1;
          maxActive = Math.max(maxActive, active);
          await new Promise((resolve) => setTimeout(resolve, 1));
          active -= 1;
          return { blockTime: 1_800_000_200, meta: { err: null, logMessages: [signature] } };
        },
      })),
      getSignaturesForAddress: vi.fn(),
    };
    const client = {
      decodeParRedemptionLifecycleEvents: vi.fn(
        async (_ctx: unknown, input: { logs: readonly string[] }) =>
          input.logs[0] === "history-9"
            ? [
                {
                  kind: "redemptionFulfilled",
                  requestAddress: PAR_REQUEST_ADDRESS,
                  owner: OWNER,
                  intermediateMint: INTERMEDIATE_MINT,
                  intermediateAmount: "10.25",
                  assetsPaid: "10.25",
                  occurredAt: "1800000200",
                },
              ]
            : []
      ),
    };
    const history = Array.from({ length: 12 }, (_, index) => ({
      signature: `history-${index}`,
      err: null,
    }));

    await expect(
      findClosingParEventInHistoryPage(env, rpc as never, parRequest(), client as never, history)
    ).resolves.toMatchObject({ signature: "history-9" });
    expect(maxActive).toBe(8);
    expect(rpc.getTransaction).toHaveBeenCalledTimes(12);
  });

  it("schedules the next provider read for a live par request instead of recycling the claim", async () => {
    const ledger = fakeLedger(parRequest({ status: "pending" }));
    parProvider.client = {
      readParRedemptionRequest: vi.fn().mockResolvedValue({
        requestAddress: PAR_REQUEST_ADDRESS,
        status: "pending",
        request: {
          requestAddress: PAR_REQUEST_ADDRESS,
          providerReference: VAULT,
          owner: OWNER,
          intermediateMint: INTERMEDIATE_MINT,
          intermediateAmount: "10.25",
        },
      }),
    };

    const before = Date.now();
    await expect(reconcileParRequest(env, ledger, parRequest({ status: "pending" }))).resolves.toBe(
      "unchanged"
    );
    expect(ledger.advanceRequest).toHaveBeenCalledWith(
      expect.objectContaining({ toStatus: "pending", lastIndexError: null })
    );
    const nextCheckAt = vi.mocked(ledger.advanceRequest).mock.calls[0]?.[0]?.nextCheckAt;
    expect(typeof nextCheckAt).toBe("string");
    // A live operator request must keep a retry schedule: without one the
    // claim lease is dropped and the same request is re-claimed immediately.
    expect(Date.parse(nextCheckAt as string)).toBeGreaterThanOrEqual(before + 59_000);
    expect(Date.parse(nextCheckAt as string)).toBeLessThanOrEqual(Date.now() + 61_000);
  });

  it("backs off a closed par request whose history has no closing event yet", async () => {
    const ledger = fakeLedger(parRequest({ status: "closed_or_unknown" }));
    parProvider.client = {
      readParRedemptionRequest: vi.fn().mockResolvedValue({
        requestAddress: PAR_REQUEST_ADDRESS,
        status: "closedOrUnknown",
        request: null,
      }),
    };
    sweepRpc.current = {
      getSignaturesForAddress: vi.fn().mockReturnValue({
        send: vi.fn().mockResolvedValue([]),
      }),
    };

    await expect(
      reconcileParRequest(env, ledger, parRequest({ status: "closed_or_unknown" }))
    ).resolves.toBe("closedUnknown");
    expect(ledger.advanceRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        toStatus: "closed_or_unknown",
        lastIndexError: "Par-redemption PDA closed without a matching finalized event yet",
        nextCheckAt: expect.any(String),
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
