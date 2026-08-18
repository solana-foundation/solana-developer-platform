/**
 * How a workflow mint is counted against `maxSupply`.
 *
 * The preflight supply check reads a snapshot loaded at prepareOnchain time, so two
 * concurrent mints (rule + rule, or rule + HTTP) can both pass it. The cap is only
 * enforceable at the effect boundary: `reserveMintSupply`, an atomic conditional UPDATE
 * contending on the token row, run via mintTo's onBeforeSubmit hook immediately before
 * submission. These tests model the race deterministically — the (mocked) preflight says
 * there is room, the (authoritative) reservation says there is not — and assert the
 * reservation decides. The concurrency safety of reserveMintSupply itself is covered by
 * token.service.test.ts; what is pinned here is that runMint actually routes through it.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkflowExecutionRow } from "@/db/repositories";
import type { Env } from "@/types/env";

const MINT = "So11111111111111111111111111111111111111112";
const DEST = "AENLi9e2xTiK7YHThmEQhBrCaDTjTRV4hsDXdwbPcBbK";
const TREASURY = "11111111111111111111111111111111";

// Relative order of the reservation and the submission — the fix's core claim is
// "reserve" strictly before "submit", and never "submit" without a granted "reserve".
const events = vi.hoisted(() => [] as string[]);

const mintTo = vi.hoisted(() => vi.fn());
const burn = vi.hoisted(() => vi.fn());
const forceBurn = vi.hoisted(() => vi.fn());
const forceTransfer = vi.hoisted(() => vi.fn());
const reserveMintSupply = vi.hoisted(() => vi.fn());
const updateSupply = vi.hoisted(() => vi.fn());
// The DB control list. Its answer must reach the mint decision.
const isAddressAllowed = vi.hoisted(() => vi.fn());
// Swapped per test so a token can be put into allowlist mode with an on-chain list.
const tokenOverrides = vi.hoisted(() => ({ value: {} as Record<string, unknown> }));
const logWarn = vi.hoisted(() => vi.fn());
const preflightWalletPolicy = vi.hoisted(() => vi.fn());

vi.mock("@/db", () => ({ getDb: () => ({}) }));
vi.mock("@/runtime/logger", () => ({
  getLogger: () => ({ warn: logWarn, error: vi.fn() }),
}));
vi.mock("@/services/token.service", () => ({
  TokenService: class {
    reserveMintSupply = reserveMintSupply;
    updateSupply = updateSupply;
    isAddressAllowed = isAddressAllowed;
  },
}));
vi.mock("@/services/solana", () => ({
  createToken2022Service: () => ({ burn }),
}));
vi.mock("./record-transaction", () => ({ recordWorkflowTransaction: async () => true }));

// The advisory preflights pass by default. For the supply check that is the point: it is
// the stale in-process snapshot both racers read, and it must not be what admits a mint.
// The wallet policy is a controllable mock so tests can deny it per custody action.
//
// `preflightDestinationAllowed` is deliberately left REAL: whether a mint consults the
// control list at all is a property of how runMint calls it, which a stub would hide.
vi.mock("./preflight", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./preflight")>()),
  preflightMintAmount: () => ({ ok: true, mosaicAmount: 10 }),
  preflightWalletPolicy,
}));

vi.mock("./onchain", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./onchain")>();
  return {
    ...actual,
    prepareOnchain: async () => ({
      ok: true,
      ctx: {
        token: { id: "tok_1", symbol: "TKN", ...tokenOverrides.value },
        decimals: 2,
        mintAddress: MINT,
        signer: { address: DEST },
        signerWalletId: null,
        mosaic: { mintTo, forceBurn, forceTransfer },
      },
    }),
    resolveWalletTokenAccount: async () => MINT,
  };
});

import { runBurn, runForceBurn, runMint, runSeize } from "./supply";

const env = {} as Env;

function executionFixture(): WorkflowExecutionRow {
  return {
    id: "workflow_execution_supply",
    organization_id: "org_1",
    project_id: "prj_1",
    workflow_id: "asset_workflow_1",
    token_id: "tok_1",
    trigger_type: "kyc_approved",
    action_type: "mint",
    status: "processing",
    idempotency_key: "kyc_approved:1",
    trigger_payload: { wallet: DEST },
    result: {},
    attempt_count: 1,
    max_attempts: 5,
    next_attempt_at: null,
    locked_at: null,
    error: null,
    decided_by: null,
    decided_at: null,
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
  } as WorkflowExecutionRow;
}

// amount "10" at 2 decimals → 1000 base units: the reservation must be in base units.
const action = { type: "mint", params: { amount: "10" } } as never;

beforeEach(() => {
  vi.clearAllMocks();
  events.length = 0;
  // Mirrors the real mintTo contract: the hook runs once the transaction is built and
  // signed, immediately before submission; a throw from it aborts the submission.
  mintTo.mockImplementation(async (_opts: unknown, onBeforeSubmit?: () => Promise<void>) => {
    if (onBeforeSubmit) {
      await onBeforeSubmit();
    }
    events.push("submit");
    return { signature: "sig_mint", slot: 42n, tokenAccount: MINT };
  });
  burn.mockResolvedValue({ signature: "sig_burn", slot: 43n });
  forceBurn.mockResolvedValue({ signature: "sig_force_burn", slot: 44n });
  forceTransfer.mockResolvedValue({ signature: "sig_seize", slot: 45n });
  reserveMintSupply.mockImplementation(async () => {
    events.push("reserve");
    return "1000";
  });
  updateSupply.mockResolvedValue(undefined);
  preflightWalletPolicy.mockResolvedValue({ ok: true });
  // Control list off by default (`requiresAllowlist` unset → mode "disabled"), so the
  // supply and policy tests above are unaffected by it.
  tokenOverrides.value = {};
  isAddressAllowed.mockResolvedValue(true);
});

describe("workflow mint counts against the cap atomically at the effect boundary", () => {
  // The reported bug. A concurrent mint consumed the headroom after this execution read
  // its snapshot: the snapshot check passed, the DB reservation refuses. Unpatched code
  // never asked the DB and submitted anyway — supply ends above maxSupply on chain.
  it("refuses to submit when the atomic reservation says the cap has no room", async () => {
    reserveMintSupply.mockImplementation(async () => {
      events.push("reserve");
      return null;
    });

    const result = await runMint(env, executionFixture(), action);

    expect(events).not.toContain("submit");
    expect(result.status).toBe("failed");
    expect(result.retryable).toBe(false);
    expect(result.error).toMatch(/maximum supply/i);
  });

  it("reserves before submission — in base units — and never mirrors the mint after", async () => {
    const result = await runMint(env, executionFixture(), action);

    expect(events).toEqual(["reserve", "submit"]);
    expect(reserveMintSupply).toHaveBeenCalledWith("tok_1", "1000");
    // The reservation IS the count: a post-settle mirror would count the mint twice and
    // drift the recorded supply into false MAX_SUPPLY_EXCEEDED on later legitimate mints.
    expect(updateSupply).not.toHaveBeenCalled();
    expect(result.status).toBe("succeeded");
    expect(result.result).toMatchObject({ signature: "sig_mint" });
    expect(result.result).not.toMatchObject({ mirrorFailed: true });
  });

  // A post-submit failure is ambiguous — the transaction may still land. The reservation
  // must stand (releasing it lets a second mint reserve supply the first already minted)
  // and the failure is permanent, surfaced for a human with the retained-reservation log.
  it("keeps the reservation and fails permanently when the submit fails after reserving", async () => {
    mintTo.mockImplementation(async (_opts: unknown, onBeforeSubmit?: () => Promise<void>) => {
      if (onBeforeSubmit) {
        await onBeforeSubmit();
      }
      events.push("submit");
      throw new Error("confirmation timeout");
    });

    const result = await runMint(env, executionFixture(), action);

    expect(result.status).toBe("failed");
    expect(result.retryable).toBe(false);
    expect(updateSupply).not.toHaveBeenCalled();
    expect(logWarn).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "mint_supply_reservation_retained",
        tokenId: "tok_1",
        reservedBaseUnits: "1000",
      }),
      expect.any(String)
    );
  });

  // The converse boundary: burns settle first and are mirrored after (a burn cannot
  // violate a cap), so removing the mint mirror must not have removed the burn mirror.
  it("still mirrors a settled burn after the chain call", async () => {
    const result = await runBurn(env, executionFixture(), action);

    expect(result.status).toBe("succeeded");
    expect(updateSupply).toHaveBeenCalledWith("tok_1", "10", "burn");
    expect(reserveMintSupply).not.toHaveBeenCalled();
  });
});

// The HTTP mint route skips the generic control-list check for an allowlist-mode token,
// but only because it then hands the destination to syncDestinationToOnChainAllowlist,
// which refuses a revoked entry outright. The engine never mutates on-chain compliance
// state, so it never reaches that check — mirroring only the skip let a rule mint to an
// address revoked in the database but still present on the on-chain list, which the same
// mint over HTTP refuses with DESTINATION_REVOKED.
describe("workflow mint consults the token's control list", () => {
  // An allowlist-mode token whose on-chain list is live — exactly the shape that used to
  // take the skip.
  const allowlistToken = {
    requiresAllowlist: true,
    ablListAddress: MINT,
    template: "stablecoin",
  };

  it("refuses a destination the control list does not allow", async () => {
    tokenOverrides.value = allowlistToken;
    isAddressAllowed.mockResolvedValue(false);

    const result = await runMint(env, executionFixture(), action);

    expect(isAddressAllowed).toHaveBeenCalledWith("tok_1", DEST);
    expect(events).not.toContain("submit");
    expect(reserveMintSupply).not.toHaveBeenCalled();
    expect(result.status).toBe("failed");
    // A compliance decision, not a hiccup: retrying asks the same question.
    expect(result.retryable).toBe(false);
    expect(result.error).toMatch(/allowlist/i);
  });

  it("mints to a destination the control list still allows", async () => {
    tokenOverrides.value = allowlistToken;
    isAddressAllowed.mockResolvedValue(true);

    const result = await runMint(env, executionFixture(), action);

    expect(result.status).toBe("succeeded");
    expect(events).toEqual(["reserve", "submit"]);
  });
});

// Wallet-baseline policies (amount/velocity limits, custody approval bound to the
// signing key) match every enforced operation when they name no operationTypes — so a
// custody action that never submits its operation for enforcement silently escapes
// them. Each destructive action must ask the policy BEFORE its chain call and treat a
// denial as a permanent, un-retried failure.
describe("custody actions enforce the signing wallet's operation policy", () => {
  const denied = {
    ok: false,
    result: { status: "failed", retryable: false, result: {}, error: "POLICY_DENIED" },
  };

  it("burn asks the policy and is refused before the chain call on denial", async () => {
    preflightWalletPolicy.mockResolvedValue(denied);

    const result = await runBurn(env, executionFixture(), action);

    expect(burn).not.toHaveBeenCalled();
    expect(result.status).toBe("failed");
    expect(result.retryable).toBe(false);
    expect(result.error).toBe("POLICY_DENIED");
    expect(preflightWalletPolicy).toHaveBeenCalledWith(
      env,
      expect.anything(),
      expect.objectContaining({ operationType: "issuance_burn_execute", amount: "10" })
    );
  });

  it("force_burn asks the policy and is refused before the chain call on denial", async () => {
    preflightWalletPolicy.mockResolvedValue(denied);

    const result = await runForceBurn(env, executionFixture(), action);

    expect(forceBurn).not.toHaveBeenCalled();
    expect(result.status).toBe("failed");
    expect(result.retryable).toBe(false);
    expect(preflightWalletPolicy).toHaveBeenCalledWith(
      env,
      expect.anything(),
      expect.objectContaining({ operationType: "issuance_force_burn_execute", amount: "10" })
    );
  });

  it("seize asks the policy — destination included — and is refused on denial", async () => {
    preflightWalletPolicy.mockResolvedValue(denied);

    const result = await runSeize(env, executionFixture(), {
      type: "seize",
      params: { amount: "10", destination: TREASURY },
    } as never);

    expect(forceTransfer).not.toHaveBeenCalled();
    expect(result.status).toBe("failed");
    expect(result.retryable).toBe(false);
    expect(preflightWalletPolicy).toHaveBeenCalledWith(
      env,
      expect.anything(),
      expect.objectContaining({
        operationType: "issuance_seize_execute",
        amount: "10",
        destination: TREASURY,
      })
    );
  });

  it("seize proceeds when the policy allows", async () => {
    const result = await runSeize(env, executionFixture(), {
      type: "seize",
      params: { amount: "10", destination: TREASURY },
    } as never);

    expect(forceTransfer).toHaveBeenCalledTimes(1);
    expect(result.status).toBe("succeeded");
    expect(result.result).toMatchObject({ signature: "sig_seize" });
  });
});
