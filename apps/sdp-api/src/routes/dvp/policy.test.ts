/**
 * The policy candidates DvP actions are judged on.
 *
 * These tests are about ONE number: the amount an approver is shown. Settle and
 * cancel move whole legs, so the leg's target is the right figure. Funding does
 * not — it tops a leg up to its target — and showing the target there both
 * refuses valid top-ups that sit inside an amount limit and asks a human to
 * approve money that is never going to move.
 */

import { address } from "@solana/kit";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DvpTradeRow } from "@/db/repositories";
import { env } from "@/test/helpers/env";

const getAuth = vi.hoisted(() => vi.fn());
const requireProjectId = vi.hoisted(() => vi.fn(() => "prj_x"));
const readDvpLegShortfall = vi.hoisted(() => vi.fn());
const approvedWalletOperationId = vi.hoisted(() => vi.fn());
const getWalletOperationById = vi.hoisted(() => vi.fn());
const getById = vi.hoisted(() => vi.fn());
const getByIdAsParty = vi.hoisted(() => vi.fn());
const assertFreshApiKeyCustodyWalletAccess = vi.hoisted(() => vi.fn());
const readDvpSettlementWallet = vi.hoisted(() => vi.fn());
const custodyWalletForParty = vi.hoisted(() => vi.fn());
const findOperationalWalletById = vi.hoisted(() => vi.fn());
const findWalletRow = vi.hoisted(() => vi.fn());

vi.mock("@/lib/auth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth")>()),
  getAuth,
  requireProjectId,
}));
vi.mock("@/services/policy/enforcement.service", () => ({
  walletOperationActorFromAuth: () => ({ kind: "api_key", id: "ak_1" }),
}));
// `legOfSide` stays real (the extractor builds the leg with it); only the
// chain read is stubbed.
vi.mock("@/services/dvp/fund", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/services/dvp/fund")>();
  return { ...actual, readDvpLegShortfall };
});
vi.mock("@/services/dvp/custody-party", () => ({ custodyWalletForParty }));
vi.mock("@/services/domain/signing/custody-runtime-target", () => ({
  CustodyRuntimeTargets: class {
    findOperationalWalletById = findOperationalWalletById;
  },
}));
vi.mock("@/services/policy/approved-operation-replay", () => ({ approvedWalletOperationId }));
vi.mock("@/lib/tenant-scope", () => ({ getRequestTenantScope: () => ({}) }));
vi.mock("@/db", () => ({
  getDb: () => ({
    prepare: () => ({ bind: () => ({ first: findWalletRow }) }),
  }),
}));
vi.mock("@/services/dvp/settlement-wallet", () => ({ readDvpSettlementWallet }));
vi.mock("@/services/api-key-scope.service", () => ({
  assertFreshApiKeyCustodyWalletAccess,
  getAllowedApiKeyCustodyWalletIdsForPermissions: () => null,
}));
vi.mock("@/db/repositories", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/db/repositories")>()),
  createDvpTradeRepository: () => ({ getById, getByIdAsParty }),
  createPolicyRepository: () => ({ getWalletOperationById }),
}));

const {
  buildDvpTradeActionPolicyCandidate,
  extractDvpTradeActionPolicyCandidate,
  extractDvpFundPolicyCandidate,
} = await import("./policy");

const T22 = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";

function trade(overrides: Partial<DvpTradeRow> = {}): DvpTradeRow {
  return {
    id: "dvp_policy_test",
    organizationId: "org_x",
    projectId: "prj_x",
    swapDvp: address("BXvugAaWDqgADmGTdwgdzVZUyJbagNM6w4hPrC4JQ1po"),
    settlementAuthority: address("9BvXsTHgFvS31NLpVN4hpAoHCTfwvVX1XkgFq7fJEZxY"),
    userA: address("5vJRzKtcp4b3Ptw9c8s3s2LrCC1cvJUY4Y3xvJXfj3Zn"),
    userB: address("7WLcnnT1nnPuHiWaVnAY3Uz8Y2SgFy2VMg2t7GAoxnpg"),
    mintA: address("ns7Y4h26io6zGKiuvSx1jRBWANjDytnYyxEmVPfPAk1"),
    mintB: address("AqTgvZaiZ18ykVvzaQhfB2KQ4SGDw4i1o5rQqBAMsZiE"),
    nonce: "42",
    tokenProgramA: address(T22),
    tokenProgramB: address(T22),
    decimalsA: 6,
    decimalsB: 6,
    symbolA: "ATD",
    symbolB: "USDC",
    amountA: "1000",
    amountB: "2000",
    expiryTimestamp: "1900000000",
    earliestSettlementTimestamp: null,
    userASettlementDestination: address("5vJRzKtcp4b3Ptw9c8s3s2LrCC1cvJUY4Y3xvJXfj3Zn"),
    userBSettlementDestination: address("7WLcnnT1nnPuHiWaVnAY3Uz8Y2SgFy2VMg2t7GAoxnpg"),
    refString: null,
    escrowA: address("FwQyjVB3o9UkWEEWZVLbvc3EizH3jhHp4g9HmpmuzGWU"),
    escrowB: address("6yDKQfAMjjnQCgkHJvpDc1CVPx2vPDLhDkhZYQPw7w9y"),
    counterpartyAccountIdA: null,
    counterpartyAccountIdB: null,
    status: "created",
    observedAt: null,
    idempotencyKey: null,
    idempotencyFingerprint: null,
    createSignature: null,
    createLastValidBlockHeight: null,
    closeSignature: null,
    escrowAAmount: null,
    escrowBAmount: null,
    escrowAPeakAmount: null,
    escrowBPeakAmount: null,
    escrowAFrozen: null,
    escrowBFrozen: null,
    createdAt: "2026-09-03T00:00:00.000Z",
    updatedAt: "2026-09-03T00:00:00.000Z",
    ...overrides,
  };
}

const context = { env } as never;
// Three identifiers, all different on purpose. A candidate's `walletId` means
// the PROVIDER's id, and a fixture that set these equal is what let the
// on-chain address be passed there unnoticed.
const settlement = {
  custodyWalletId: "cwlt_settle",
  address: "9BvXsTHgFvS31NLpVN4hpAoHCTfwvVX1XkgFq7fJEZxY",
  providerWalletId: "privy_settle_authority",
};

describe("buildDvpTradeActionPolicyCandidate (close)", () => {
  beforeEach(() => {
    getAuth.mockReturnValue({ organizationId: "org_x", apiKeyId: "ak_1" });
  });

  // Whole-leg actions: the target IS what moves.
  describe("settle and cancel", () => {
    it.each(["settle", "cancel"] as const)("evaluates %s at the leg's full target", (action) => {
      const { candidate, legs } = buildDvpTradeActionPolicyCandidate(
        context,
        trade(),
        settlement,
        action
      );

      expect(candidate.amount).toBe("1000");
      expect(legs.map((leg) => leg.amount)).toEqual(["1000", "2000"]);
    });
  });

  // There is no "our leg" to prefer any more: leg A leads as the representative
  // — chosen, not fallen into — and naming both parties is always true.
  it("leads with leg A as the representative and names both parties", () => {
    const { candidate } = buildDvpTradeActionPolicyCandidate(
      context,
      trade(),
      settlement,
      "settle"
    );

    expect(candidate.asset).toBe(trade().mintA);
    expect(candidate.amount).toBe("1000");
    expect(candidate.context).not.toHaveProperty("counterparty");
    expect(candidate.context).toMatchObject({ parties: [trade().userA, trade().userB] });
  });

  it("always evaluates both legs — nothing escapes policy by side", () => {
    const { legs } = buildDvpTradeActionPolicyCandidate(context, trade(), settlement, "cancel");

    expect(legs.map((leg) => leg.amount)).toEqual(["1000", "2000"]);
    expect(legs[0]?.asset).toBe(trade().mintA);
    expect(legs[1]?.asset).toBe(trade().mintB);
  });

  // The wallet-operations ownership check matches `custody_wallets.wallet_id`
  // (`policy.repository.postgres.ts:1044`). Passing the address instead found no
  // row, so every settle and cancel failed with "Failed to record wallet
  // operation" — on a wallet the organization plainly owns.
  it.each(["settle", "cancel"] as const)(
    "identifies the signing wallet to policy by its provider id on %s",
    (action) => {
      const { candidate } = buildDvpTradeActionPolicyCandidate(
        context,
        trade(),
        settlement,
        action
      );

      expect(candidate.walletId).toBe("privy_settle_authority");
      expect(candidate.custodyWalletId).toBe("cwlt_settle");
    }
  );
});

describe("extractDvpTradeActionPolicyCandidate (close)", () => {
  const extractContext = {
    env,
    req: { param: () => "dvp_policy_test" },
  } as never;

  beforeEach(() => {
    vi.clearAllMocks();
    getAuth.mockReturnValue({ organizationId: "org_x", apiKeyId: "ak_1" });
    requireProjectId.mockReturnValue("prj_x");
    getById.mockResolvedValue(trade());
    readDvpSettlementWallet.mockResolvedValue(settlement);
    assertFreshApiKeyCustodyWalletAccess.mockResolvedValue(undefined);
  });

  // Settle and cancel move whole legs, so neither reads a shortfall at all.
  it.each(["settle", "cancel"] as const)("does not read a shortfall for %s", async (action) => {
    const { candidate } = await extractDvpTradeActionPolicyCandidate(extractContext, action);

    expect(candidate?.amount).toBe("1000");
    expect(readDvpLegShortfall).not.toHaveBeenCalled();
  });

  // The wallet asserted is the SETTLEMENT wallet, resolved before the assert —
  // the trade row carries no wallet of its own.
  it.each(["settle", "cancel"] as const)(
    "asserts fresh key access on the settlement wallet for %s",
    async (action) => {
      await extractDvpTradeActionPolicyCandidate(extractContext, action);

      expect(readDvpSettlementWallet).toHaveBeenCalled();
      expect(assertFreshApiKeyCustodyWalletAccess).toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        "cwlt_settle",
        ["payments:write"]
      );
    }
  );
});

/**
 * Which amount the fund extractor puts on the candidate.
 *
 * The subtlety is the approved REPLAY. `resumeApprovedOperation` compares the
 * replayed candidate to the stored row field by field, with `amount` matched for
 * exact equality (`services/policy/enforcement.service.ts:113`). A deposit
 * landing between approval and execution shrinks a freshly-read shortfall, so
 * recomputing on replay fails that match and strands an approved top-up behind
 * a second approval it should never have needed.
 */
describe("extractDvpFundPolicyCandidate", () => {
  const extractContext = (body: { side: "a" | "b"; walletId?: string | null }) =>
    ({
      env,
      req: {
        param: () => "dvp_policy_test",
        valid: (target: string) => (target === "json" ? body : undefined),
      },
    }) as never;

  beforeEach(() => {
    vi.clearAllMocks();
    getAuth.mockReturnValue({ organizationId: "org_x", apiKeyId: "ak_1" });
    requireProjectId.mockReturnValue("prj_x");
    getByIdAsParty.mockResolvedValue(trade());
    readDvpSettlementWallet.mockResolvedValue(settlement);
    assertFreshApiKeyCustodyWalletAccess.mockResolvedValue(undefined);
    approvedWalletOperationId.mockReturnValue(undefined);
    getWalletOperationById.mockResolvedValue(null);
    readDvpLegShortfall.mockResolvedValue(600n);
    custodyWalletForParty.mockResolvedValue("cwlt_a");
    findWalletRow.mockResolvedValue({
      custody_wallet_id: "cwlt_a",
      wallet_id: "privy_wallet_a",
    });
  });

  it("uses the live per-side shortfall on a first request", async () => {
    const { candidate } = await extractDvpFundPolicyCandidate(extractContext({ side: "a" }));

    expect(candidate?.amount).toBe("600");
    expect(readDvpLegShortfall).toHaveBeenCalledWith(expect.anything(), expect.anything(), "a");
  });

  it("reads the shortfall of the NAMED side, not a stored one", async () => {
    await extractDvpFundPolicyCandidate(extractContext({ side: "b" }));

    expect(readDvpLegShortfall).toHaveBeenCalledWith(expect.anything(), expect.anything(), "b");
  });

  it("builds the candidate from the named side's leg", async () => {
    const { candidate, legs } = await extractDvpFundPolicyCandidate(extractContext({ side: "b" }));

    expect(candidate).toMatchObject({
      operationType: "dvp_fund",
      asset: trade().mintB,
      destination: trade().escrowB,
      walletId: "privy_wallet_a",
      custodyWalletId: "cwlt_a",
    });
    expect(candidate?.context).toMatchObject({ dvpLeg: "b", dvpAction: "fund" });
    // Funding moves ONE leg: the other leg describes what the counterparty
    // owes and is no part of this operation.
    expect(legs).toHaveLength(1);
    expect(legs[0]?.asset).toBe(trade().mintB);
  });

  // The case that would have stranded the top-up: approved at 600, another
  // deposit lands, a fresh read would now say 400, and 400 !== 600 fails the
  // replay match.
  it("keeps the approved amount on a replay even though the live shortfall shrank", async () => {
    approvedWalletOperationId.mockReturnValue("wop_1");
    getWalletOperationById.mockResolvedValue({ amount: "600" });
    readDvpLegShortfall.mockResolvedValue(400n);

    const { candidate, resolved } = await extractDvpFundPolicyCandidate(
      extractContext({ side: "a" })
    );

    expect(candidate?.amount).toBe("600");
    expect(resolved).toEqual({
      trade: expect.objectContaining({ id: "dvp_policy_test" }),
      funding: { side: "a", custodyWalletId: "cwlt_a", approvedAmount: 600n },
    });
    expect(readDvpLegShortfall).not.toHaveBeenCalled();
  });

  it("carries the approved amount as the execution ceiling when the live shortfall grew", async () => {
    approvedWalletOperationId.mockReturnValue("wop_1");
    getWalletOperationById.mockResolvedValue({ amount: "600" });
    readDvpLegShortfall.mockResolvedValue(900n);

    const { resolved } = await extractDvpFundPolicyCandidate(extractContext({ side: "a" }));

    expect(resolved).toEqual({
      trade: expect.objectContaining({ id: "dvp_policy_test" }),
      funding: { side: "a", custodyWalletId: "cwlt_a", approvedAmount: 600n },
    });
    expect(readDvpLegShortfall).not.toHaveBeenCalled();
  });

  // A stored row with no amount is not the operation we think it is. Falling
  // back to a live read lets the field-by-field match downstream fail loudly
  // rather than this inventing a number to satisfy it.
  it("falls back to the live shortfall when the stored operation carries no amount", async () => {
    approvedWalletOperationId.mockReturnValue("wop_1");
    getWalletOperationById.mockResolvedValue({ amount: null });

    const { candidate } = await extractDvpFundPolicyCandidate(extractContext({ side: "a" }));

    expect(candidate?.amount).toBe("600");
  });

  // Ungoverned rather than refused here: the handler produces the 403, and
  // filing a wallet operation for a trade this caller has no leg on would put
  // somebody else's trade in their approvals queue.
  it("answers ungoverned, with the trade resolved, when no wallet holds the side's address", async () => {
    custodyWalletForParty.mockResolvedValue(null);

    const extraction = await extractDvpFundPolicyCandidate(extractContext({ side: "a" }));

    expect(extraction.candidate).toBeNull();
    expect(extraction.resolved).toEqual({
      trade: expect.objectContaining({ id: "dvp_policy_test" }),
      funding: null,
    });
    // Nothing was spent on the way out: no chain read, no key assert.
    expect(readDvpLegShortfall).not.toHaveBeenCalled();
    expect(assertFreshApiKeyCustodyWalletAccess).not.toHaveBeenCalled();
  });

  it("answers ungoverned when the trade is unknown", async () => {
    getByIdAsParty.mockResolvedValue(null);

    const extraction = await extractDvpFundPolicyCandidate(extractContext({ side: "a" }));

    expect(extraction.candidate).toBeNull();
    expect(extraction.resolved).toEqual({ trade: null, funding: null });
  });

  // An explicit `walletId` narrows and never widens: it must hold the named
  // side's party address, and a mismatch or a miss is ungoverned so the
  // handler can refuse with the real reason.
  it("accepts an explicit wallet that holds the side's party address", async () => {
    findOperationalWalletById.mockResolvedValue({
      id: "cwlt_named",
      publicKey: trade().userA,
      walletId: "privy_named",
    });
    findWalletRow.mockResolvedValue({
      custody_wallet_id: "cwlt_named",
      wallet_id: "privy_named",
    });

    const { candidate, resolved } = await extractDvpFundPolicyCandidate(
      extractContext({ side: "a", walletId: "cwlt_named" })
    );

    expect(findOperationalWalletById).toHaveBeenCalledWith(
      expect.objectContaining({ custodyWalletId: "cwlt_named" })
    );
    expect(candidate?.custodyWalletId).toBe("cwlt_named");
    expect(resolved).toEqual({
      trade: expect.anything(),
      funding: { side: "a", custodyWalletId: "cwlt_named", approvedAmount: 600n },
    });
  });

  it.each([
    [
      "a wallet whose pubkey is a different address",
      { id: "cwlt_other", publicKey: trade().userB },
    ],
    ["no wallet at all", null],
  ])("refuses %s by answering ungoverned", async (_name, wallet) => {
    findOperationalWalletById.mockResolvedValue(wallet);

    const extraction = await extractDvpFundPolicyCandidate(
      extractContext({ side: "a", walletId: "cwlt_named" })
    );

    expect(extraction.candidate).toBeNull();
    expect(extraction.resolved).toEqual({
      trade: expect.objectContaining({ id: "dvp_policy_test" }),
      funding: null,
    });
  });

  // The gate's auth context is a KV snapshot and can be up to an hour old, so
  // a key whose `payments:write` was revoked in that window must be caught on
  // the wallet the side RESOLVED to.
  it("asserts fresh key access on the resolved wallet", async () => {
    await extractDvpFundPolicyCandidate(extractContext({ side: "a" }));

    expect(assertFreshApiKeyCustodyWalletAccess).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      "cwlt_a",
      ["payments:write"]
    );
  });

  // Top-ups are legal and both sides of a bilateral trade are separately
  // fundable, so a trade-keyed operation key would refuse legitimate work.
  // The (trade, side) claim CAS inside the funding path is the serialization.
  it("carries no idempotency key", async () => {
    const { idempotencyKey } = await extractDvpFundPolicyCandidate(extractContext({ side: "a" }));

    expect(idempotencyKey).toBeNull();
  });
});
