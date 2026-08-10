/**
 * Which wallet the workflow engine binds its operation policy to.
 *
 * `prepareOnchain` does not always sign with the token's `signingWalletId`: when that
 * wallet is not the recorded on-chain authority — a rotation, a split-authority deploy,
 * or a token that names no wallet at all — it falls back to the custody wallet that is.
 * The policy was still evaluated against the nominal `signingWalletId`, so the engine
 * signed with wallet B under wallet A's limits, and skipped the policy outright when the
 * nominal id was null even though the fallback had positively identified a wallet to sign
 * with. Amount/velocity limits, destination rules and custody approval all rode on that.
 *
 * Everything below custody is stubbed; the assertions are on the wallet id handed to
 * enforceWalletOperationPolicy.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkflowExecutionRow } from "@/db/repositories";
import type { Env } from "@/types/env";

const TOKEN_WALLET_ID = "wal_token_nominal";
const AUTHORITY_WALLET_ID = "wal_actual_mint_authority";
// The wallet the org's effective custody config signs with when a token names none.
const DEFAULT_WALLET_ID = "wal_org_default";
const TOKEN_WALLET_PUBKEY = "So11111111111111111111111111111111111111112";
const MINT_AUTHORITY_PUBKEY = "AENLi9e2xTiK7YHThmEQhBrCaDTjTRV4hsDXdwbPcBbK";

// Signer address is keyed off the wallet id, so a wallet that is not the mint authority
// produces an address that does not match and drives the fallback. No wallet id means the
// org default signer, which here holds TOKEN_WALLET_PUBKEY.
const signerAddressByWallet: Record<string, string> = {
  [TOKEN_WALLET_ID]: TOKEN_WALLET_PUBKEY,
  [AUTHORITY_WALLET_ID]: MINT_AUTHORITY_PUBKEY,
  [DEFAULT_WALLET_ID]: TOKEN_WALLET_PUBKEY,
};

// Custody's view: both keys belong to active custody wallets that can carry a policy.
const custodyWalletByPubkey: Record<string, { walletId: string; publicKey: string; id: string }> = {
  [MINT_AUTHORITY_PUBKEY]: {
    walletId: AUTHORITY_WALLET_ID,
    publicKey: MINT_AUTHORITY_PUBKEY,
    id: "custody_row_authority",
  },
  [TOKEN_WALLET_PUBKEY]: {
    walletId: DEFAULT_WALLET_ID,
    publicKey: TOKEN_WALLET_PUBKEY,
    id: "custody_row_default",
  },
};

const createOrgSigner = vi.hoisted(() => vi.fn());
const findActiveWalletByPublicKey = vi.hoisted(() => vi.fn());
const getToken = vi.hoisted(() => vi.fn());
const enforceWalletOperationPolicy = vi.hoisted(() => vi.fn());
const resolvePolicyCustodyWallet = vi.hoisted(() => vi.fn());

vi.mock("@/db", () => ({ getDb: () => ({}) }));
vi.mock("@/services/solana", () => ({ createOrgSigner }));
vi.mock("@/services/issuance/mosaic", () => ({ createMosaicService: () => ({}) }));
vi.mock("@/services/stores/custody-config.store", () => ({
  CustodyConfigStore: class {
    findActiveWalletByPublicKey = findActiveWalletByPublicKey;
  },
}));
vi.mock("@/services/token.service", () => ({
  TokenService: class {
    getToken = getToken;
  },
}));
vi.mock("@/services/policy/enforcement.service", () => ({
  enforceWalletOperationPolicy,
  resolvePolicyCustodyWallet,
}));

import { prepareOnchain } from "./onchain";
import { preflightWalletPolicy } from "./preflight";

const env = {} as Env;

function executionFixture(): WorkflowExecutionRow {
  return {
    id: "workflow_execution_policy",
    organization_id: "org_test",
    project_id: "prj_test",
    workflow_id: "asset_workflow_test",
    token_id: "tok_test",
    trigger_type: "kyc_approved",
    action_type: "mint",
    status: "processing",
    idempotency_key: "kyc_approved:test",
    trigger_payload: { wallet: TOKEN_WALLET_PUBKEY },
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

function tokenFixture(signingWalletId: string | null) {
  return {
    id: "tok_test",
    symbol: "TEST",
    decimals: 6,
    mintAddress: TOKEN_WALLET_PUBKEY,
    // The recorded mint authority is a DIFFERENT custody wallet than the nominal one.
    mintAuthority: MINT_AUTHORITY_PUBKEY,
    freezeAuthority: null,
    signingWalletId,
    projectId: "prj_test",
  };
}

// Runs the real path a mint action takes: resolve the signer, then run the policy
// preflight against the resulting context.
async function prepareAndPreflight(signingWalletId: string | null) {
  getToken.mockResolvedValue(tokenFixture(signingWalletId));
  const prep = await prepareOnchain(env, executionFixture(), "mint");
  if (!prep.ok) {
    throw new Error(`prepareOnchain failed: ${prep.result.error}`);
  }
  const outcome = await preflightWalletPolicy(env, prep.ctx, {
    operationType: "issuance_mint_execute",
    amount: "1000",
    destination: TOKEN_WALLET_PUBKEY,
  });
  return { ctx: prep.ctx, outcome };
}

describe("workflow wallet policy binds to the signing wallet", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    createOrgSigner.mockImplementation(
      async (_env: unknown, _org: string, _project: string, walletId?: string) => ({
        // No wallet id → the org default signer, which here is not the mint authority.
        address: walletId ? signerAddressByWallet[walletId] : TOKEN_WALLET_PUBKEY,
      })
    );
    findActiveWalletByPublicKey.mockImplementation(
      async (_org: string, _project: string | undefined, publicKey: string) =>
        custodyWalletByPubkey[publicKey] ?? null
    );
    resolvePolicyCustodyWallet.mockResolvedValue({ id: "custody_row_authority" });
    enforceWalletOperationPolicy.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // The mismatch: signing happens with the fallback wallet, so the limits that bound it
  // must be the fallback wallet's too.
  it("enforces the fallback authority wallet's policy, not the token's nominal wallet", async () => {
    const { ctx, outcome } = await prepareAndPreflight(TOKEN_WALLET_ID);

    expect(outcome.ok).toBe(true);
    // Sanity: the fallback really did happen, so the two ids genuinely differ.
    expect(ctx.signer.address).toBe(MINT_AUTHORITY_PUBKEY);
    expect(ctx.token.signingWalletId).toBe(TOKEN_WALLET_ID);

    expect(enforceWalletOperationPolicy).toHaveBeenCalledTimes(1);
    expect(enforceWalletOperationPolicy.mock.calls[0][2]).toMatchObject({
      walletId: AUTHORITY_WALLET_ID,
    });
    expect(resolvePolicyCustodyWallet).toHaveBeenCalledWith(
      env,
      expect.anything(),
      AUTHORITY_WALLET_ID
    );
  });

  // The bypass: a null nominal id used to skip the policy entirely, even though the
  // fallback had identified a custody wallet and signed a mint with it.
  it("enforces a policy when the token names no wallet but a fallback signs", async () => {
    const { ctx, outcome } = await prepareAndPreflight(null);

    expect(outcome.ok).toBe(true);
    expect(ctx.signer.address).toBe(MINT_AUTHORITY_PUBKEY);

    expect(enforceWalletOperationPolicy).toHaveBeenCalledTimes(1);
    expect(enforceWalletOperationPolicy.mock.calls[0][2]).toMatchObject({
      walletId: AUTHORITY_WALLET_ID,
    });
  });

  // A denial has to stay a denial — and a permanent one, since retrying re-asks the same
  // question and burns the attempt budget.
  it("fails permanently when the signing wallet's policy denies the operation", async () => {
    enforceWalletOperationPolicy.mockRejectedValue(new Error("WALLET_POLICY_LIMIT_EXCEEDED"));

    const { outcome } = await prepareAndPreflight(TOKEN_WALLET_ID);

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.result.retryable).toBe(false);
      expect(outcome.result.error).toBe("WALLET_POLICY_LIMIT_EXCEEDED");
    }
  });

  // No fallback runs here: the token names no wallet AND the org default signer already
  // holds the mint authority, so the early return decides the wallet id. That default
  // signer is still a custody wallet — getTransactionSigner with no wallet id resolves the
  // effective custody config and signs with its wallet — so its limits have to apply.
  it("enforces the org default signer's policy when the token names no wallet", async () => {
    getToken.mockResolvedValue({ ...tokenFixture(null), mintAuthority: TOKEN_WALLET_PUBKEY });
    const prep = await prepareOnchain(env, executionFixture(), "mint");
    if (!prep.ok) {
      throw new Error("prepareOnchain failed");
    }

    // The signer is the default one, matched to its custody row by public key.
    expect(prep.ctx.signer.address).toBe(TOKEN_WALLET_PUBKEY);
    expect(prep.ctx.signerWalletId).toBe(DEFAULT_WALLET_ID);

    const outcome = await preflightWalletPolicy(env, prep.ctx, {
      operationType: "issuance_mint_execute",
      amount: "1000",
      destination: TOKEN_WALLET_PUBKEY,
    });

    expect(outcome.ok).toBe(true);
    expect(enforceWalletOperationPolicy).toHaveBeenCalledTimes(1);
    expect(enforceWalletOperationPolicy.mock.calls[0][2]).toMatchObject({
      walletId: DEFAULT_WALLET_ID,
    });
  });

  // Same shape for an action that demands no particular authority — the early return is
  // taken via `!requires`, and the signing wallet still has to be bound.
  it("enforces the default signer's policy for an action with no required authority", async () => {
    getToken.mockResolvedValue(tokenFixture(null));
    const prep = await prepareOnchain(env, executionFixture());
    if (!prep.ok) {
      throw new Error("prepareOnchain failed");
    }

    expect(prep.ctx.signerWalletId).toBe(DEFAULT_WALLET_ID);
  });

  // Null is now reserved for what it actually says: no custody wallet holds this key, so
  // there is no policy to bind. A local dev signer is the real-world case.
  it("skips only when custody manages no wallet for the signing key", async () => {
    getToken.mockResolvedValue({ ...tokenFixture(null), mintAuthority: TOKEN_WALLET_PUBKEY });
    findActiveWalletByPublicKey.mockResolvedValue(null);

    const prep = await prepareOnchain(env, executionFixture(), "mint");
    if (!prep.ok) {
      throw new Error("prepareOnchain failed");
    }

    expect(prep.ctx.signerWalletId).toBeNull();
    const outcome = await preflightWalletPolicy(env, prep.ctx, {
      operationType: "issuance_mint_execute",
      amount: "1000",
      destination: TOKEN_WALLET_PUBKEY,
    });

    expect(outcome.ok).toBe(true);
    expect(enforceWalletOperationPolicy).not.toHaveBeenCalled();
  });
});
