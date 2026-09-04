import { SdpKaminoError } from "@sdp/kamino";
import { SdpVedaError } from "@sdp/veda";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getDb } from "@/db";
import { createPostgresEarnMovementsRepository } from "@/db/repositories/earn-movements.repository";
import { createPostgresPolicyRepository } from "@/db/repositories/policy.repository.postgres";
import { createTenantScope } from "@/lib/tenant-scope";
import {
  recoverApprovedWalletOperations,
  runApprovedWalletOperationEffectTransaction,
} from "@/services/policy/approved-operation-replay";
import type { CustodyWallet } from "@/services/stores/custody-config.store";
import { env } from "@/test/helpers/env";
import { seedTestDatabase } from "@/test/mocks/db";
import type { VaultDepositInput } from "./vault-deposit.service";

const buildVaultDeposit = vi.hoisted(() => vi.fn());
const fetchJupiterSwapLeg = vi.hoisted(() => vi.fn());
const signVaultPlan = vi.hoisted(() => vi.fn());
const broadcastVaultTransaction = vi.hoisted(() => vi.fn());
const simulateVaultPlan = vi.hoisted(() => vi.fn());
const createOrgSignerForCustodyWallet = vi.hoisted(() => vi.fn());
const resolveVaultDirectClient = vi.hoisted(() => vi.fn());
const resolveVaultSponsorship = vi.hoisted(() => vi.fn());

// `prependSwapLegToVaultPlan` stays real; only the Jupiter HTTP boundary is stubbed.
vi.mock("./jupiter-swap.service", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./jupiter-swap.service")>()),
  fetchJupiterSwapLeg,
}));

vi.mock("./execution-registry", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./execution-registry")>()),
  resolveVaultDirectClient,
  resolveClusterRpcUrl: () => "https://rpc.example.invalid",
}));

vi.mock("./vault-execution.service", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./vault-execution.service")>()),
  signVaultPlan,
  broadcastVaultTransaction,
  simulateVaultPlan,
}));

vi.mock("@/services/solana", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/services/solana")>()),
  createOrgSignerForCustodyWallet,
}));

// `vaultRentPayer` stays real: it is the thing under test in the rent-funder
// cases below, and it only reads whatever this mock returns.
vi.mock("./vault-sponsorship", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./vault-sponsorship")>()),
  resolveVaultSponsorship,
}));

const { depositIntoVault } = await import("./vault-deposit.service");
const { VaultTransactionTooLargeError } = await import("./vault-execution.service");

const ORG = "org_vault_deposit";
const PROJECT = "prj_vault_deposit";
const USER = "usr_vault_deposit";
const WALLET_ROW_ID = "cwlt_vault_deposit";
const CUSTODY_CONFIG_ID = "cfg_vault_deposit";
const WALLET_ADDRESS = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";
const TOKEN_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const SHARE_MINT = "So11111111111111111111111111111111111111112";
const VAULT_A = "7uib8xGAwkaPz4ZGCA6t8sSEid5Yp9ty13PHUweTypx";
const VAULT_B = "3nMFwZXwY1s1M5s8vYAHqd4wGs4iSxXE4LRoUMMYqEgF";

const wallet = {
  id: WALLET_ROW_ID,
  walletId: "privy_vault_deposit",
  publicKey: WALLET_ADDRESS,
} as unknown as CustodyWallet;

function depositInput(overrides: Partial<VaultDepositInput> = {}): VaultDepositInput {
  return {
    organizationId: ORG,
    projectId: PROJECT,
    environment: "sandbox" as const,
    provider: "kamino",
    providerReference: VAULT_A,
    wallet,
    tokenMint: TOKEN_MINT,
    shareMint: SHARE_MINT,
    label: "Test USDC Vault",
    amount: "10",
    requestId: "11111111-1111-4111-8111-111111111111",
    userId: USER,
    apiKeyId: null,
    ...overrides,
  };
}

function plan(overrides: Record<string, unknown> = {}) {
  return {
    cluster: "devnet",
    instructions: [{ programAddress: "11111111111111111111111111111111", accounts: [], data: "" }],
    lookupTables: [],
    assetIdentity: {
      depositTokenMint: TOKEN_MINT,
      shareMint: SHARE_MINT,
    },
    accepted: { amount: "10" },
    ...overrides,
  };
}

async function seedWallet(): Promise<void> {
  await getDb(env).batch([
    getDb(env)
      .prepare("INSERT INTO organizations (id, name, slug, tier, status) VALUES (?, ?, ?, ?, ?)")
      .bind(ORG, "Vault Deposit Org", "vault-deposit", "enterprise", "active"),
    getDb(env)
      .prepare("INSERT INTO users (id, email, email_verified, status) VALUES (?, ?, ?, ?)")
      .bind(USER, "vault-deposit@example.com", 1, "active"),
    getDb(env)
      .prepare(
        `INSERT INTO projects (id, organization_id, name, slug, environment, status, created_by)
         VALUES (?, ?, ?, ?, 'sandbox', 'active', ?)`
      )
      .bind(PROJECT, ORG, "Vault Deposit Project", "vault-deposit-project", USER),
    getDb(env)
      .prepare(
        `INSERT INTO custody_configs (id, organization_id, project_id, provider, config_encrypted, status)
         VALUES (?, ?, ?, 'privy', 'test-encrypted', 'active')`
      )
      .bind(CUSTODY_CONFIG_ID, ORG, PROJECT),
    getDb(env)
      .prepare(
        `INSERT INTO custody_wallets (id, custody_config_id, wallet_id, public_key, status)
         VALUES (?, ?, ?, ?, 'active')`
      )
      .bind(WALLET_ROW_ID, CUSTODY_CONFIG_ID, wallet.walletId, WALLET_ADDRESS),
  ]);
}

async function tableCount(table: "earn_positions" | "earn_movements") {
  const row = await getDb(env)
    .prepare(`SELECT COUNT(*) AS count FROM ${table}`)
    .first<{ count: number | string }>();
  return Number(row?.count ?? 0);
}

beforeEach(async () => {
  await seedTestDatabase(env);
  await seedWallet();
  vi.clearAllMocks();
  resolveVaultDirectClient.mockReturnValue({ buildVaultDeposit });
  buildVaultDeposit.mockResolvedValue(plan());
  // Matches the real resolver with the flag unset, which is the default in every
  // existing case here.
  resolveVaultSponsorship.mockResolvedValue({ kind: "wallet-pays" });
  simulateVaultPlan.mockResolvedValue({ ok: true });
  createOrgSignerForCustodyWallet.mockResolvedValue({ address: WALLET_ADDRESS });
  signVaultPlan.mockResolvedValue({
    bytes: new Uint8Array([1]),
    signature: "sig_original",
    lastValidBlockHeight: "12345",
  });
  broadcastVaultTransaction.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("depositIntoVault — idempotency", () => {
  it("replays the original vault deposit for the same requestId and payload", async () => {
    const first = await depositIntoVault(env, depositInput());
    const second = await depositIntoVault(env, depositInput());

    expect(second).toMatchObject({ replayed: true });
    expect(second.movement.id).toBe(first.movement.id);
    expect(second.position.id).toBe(first.position.id);
    expect(signVaultPlan).toHaveBeenCalledTimes(1);
    expect(broadcastVaultTransaction).toHaveBeenCalledTimes(1);
  });

  it("serves a durable replay without proving or touching the RPC endpoint", async () => {
    await depositIntoVault(env, depositInput());
    vi.clearAllMocks();

    const replay = await depositIntoVault(env, depositInput());

    expect(replay.replayed).toBe(true);
    expect(resolveVaultDirectClient).not.toHaveBeenCalled();
    expect(buildVaultDeposit).not.toHaveBeenCalled();
    expect(signVaultPlan).not.toHaveBeenCalled();
    // A replay is a durable read. Resolving sponsorship first would 5xx every
    // retry of an already-signed movement during a paymaster outage.
    expect(resolveVaultSponsorship).not.toHaveBeenCalled();
  });

  it("treats insignificant decimal zeroes as the same on-chain intent", async () => {
    await depositIntoVault(env, depositInput({ amount: "10.000000" }));
    const replay = await depositIntoVault(env, depositInput({ amount: "10" }));

    expect(replay.replayed).toBe(true);
    expect(signVaultPlan).toHaveBeenCalledTimes(1);
    expect(broadcastVaultTransaction).toHaveBeenCalledTimes(1);
  });

  it("rejects the same requestId with a different payload", async () => {
    const first = await depositIntoVault(env, depositInput());
    await expect(
      depositIntoVault(env, depositInput({ providerReference: VAULT_B }))
    ).rejects.toMatchObject({ code: "CONFLICT" });

    expect(await tableCount("earn_positions")).toBe(1);
    expect(await tableCount("earn_movements")).toBe(1);
    expect(first.position.vault_address).toBe(VAULT_A);
  });

  it("conflicts a sibling project's identical key on the fast replay path, before signing", async () => {
    // The third site of the shared ownership rule, and the one a repository
    // test cannot reach: the fast sequential preflight returns BEFORE
    // createSignedDepositIntent, and it is reachable with the route-level
    // guard skipped (approved-operation execution). The fingerprint omits the
    // project by design, so an identical deposit from a sibling project
    // matches it — without assertMovementIsOwnReplay here, project B's
    // approved deposit was answered with project A's movement as
    // replayed:true.
    const siblingProject = "prj_vault_deposit_sibling";
    await getDb(env)
      .prepare(
        `INSERT INTO projects
           (id, organization_id, name, slug, environment, status, created_by)
         VALUES (?, ?, 'Sibling Vault Project', 'sibling-vault-project', 'sandbox', 'active', ?)`
      )
      .bind(siblingProject, ORG, USER)
      .run();

    const first = await depositIntoVault(env, depositInput());
    expect(first.replayed).toBe(false);
    const signingsAfterFirst = signVaultPlan.mock.calls.length;

    await expect(
      depositIntoVault(env, depositInput({ projectId: siblingProject }))
    ).rejects.toThrow("Idempotency key already used with different request payload");
    // Refused at the durable preflight: nothing was rebuilt, re-signed, or
    // broadcast for the sibling.
    expect(signVaultPlan.mock.calls.length).toBe(signingsAfterFirst);

    // And the owning project still replays its own movement.
    const replay = await depositIntoVault(env, depositInput());
    expect(replay.replayed).toBe(true);
    expect(replay.movement.id).toBe(first.movement.id);
  });

  it("rolls back a concurrent divergent requestId loser before it can claim a position", async () => {
    let releaseBuilds: (() => void) | undefined;
    const bothBuilding = new Promise<void>((resolve) => {
      releaseBuilds = resolve;
    });
    let buildCount = 0;
    buildVaultDeposit.mockImplementation(async () => {
      buildCount += 1;
      if (buildCount === 2) releaseBuilds?.();
      await bothBuilding;
      return plan();
    });
    let signCount = 0;
    signVaultPlan.mockImplementation(async () => {
      signCount += 1;
      return {
        bytes: new Uint8Array([signCount]),
        signature: `sig_concurrent_${signCount}`,
        lastValidBlockHeight: "12345",
      };
    });

    const outcomes = await Promise.allSettled([
      depositIntoVault(env, depositInput({ providerReference: VAULT_A })),
      depositIntoVault(env, depositInput({ providerReference: VAULT_B })),
    ]);

    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
    const rejected = outcomes.find((outcome) => outcome.status === "rejected");
    expect(rejected).toMatchObject({ reason: { code: "CONFLICT" } });
    expect(await tableCount("earn_positions")).toBe(1);
    expect(await tableCount("earn_movements")).toBe(1);
    expect(broadcastVaultTransaction).toHaveBeenCalledTimes(1);
  });

  it("broadcasts exactly once when identical requests race with different signatures", async () => {
    let releaseBuilds: (() => void) | undefined;
    const bothBuilding = new Promise<void>((resolve) => {
      releaseBuilds = resolve;
    });
    let buildCount = 0;
    buildVaultDeposit.mockImplementation(async () => {
      buildCount += 1;
      if (buildCount === 2) releaseBuilds?.();
      await bothBuilding;
      return plan();
    });
    let signCount = 0;
    signVaultPlan.mockImplementation(async () => {
      signCount += 1;
      return {
        bytes: new Uint8Array([signCount]),
        signature: `sig_identical_${signCount}`,
        lastValidBlockHeight: "12345",
      };
    });

    const results = await Promise.all([
      depositIntoVault(env, depositInput()),
      depositIntoVault(env, depositInput()),
    ]);

    expect(results.map((result) => result.replayed).sort()).toEqual([false, true]);
    expect(new Set(results.map((result) => result.movement.id))).toHaveProperty("size", 1);
    expect(new Set(results.map((result) => result.position.id))).toHaveProperty("size", 1);
    expect(await tableCount("earn_positions")).toBe(1);
    expect(await tableCount("earn_movements")).toBe(1);
    expect(broadcastVaultTransaction).toHaveBeenCalledTimes(1);
  });

  it("binds independent request keys into distinct on-chain memo instructions", async () => {
    const memoPayloads: string[] = [];
    signVaultPlan.mockImplementation(async (_env, input) => {
      const encoded = input.plan.instructions.at(-1)?.data;
      if (!encoded) throw new Error("missing request memo");
      memoPayloads.push(Buffer.from(encoded, "base64").toString("utf8"));
      return {
        bytes: new Uint8Array([memoPayloads.length]),
        signature: `sig_distinct_${memoPayloads.length}`,
        lastValidBlockHeight: "12345",
      };
    });

    const firstRequestId = "11111111-1111-4111-8111-111111111111";
    const secondRequestId = "22222222-2222-4222-8222-222222222222";
    await Promise.all([
      depositIntoVault(env, depositInput({ requestId: firstRequestId })),
      depositIntoVault(env, depositInput({ requestId: secondRequestId })),
    ]);

    expect(memoPayloads.sort()).toEqual(
      [firstRequestId, secondRequestId]
        .map((requestId) => `sdp:earn:vault-deposit:${requestId}`)
        .sort()
    );
    expect(await tableCount("earn_positions")).toBe(1);
    expect(await tableCount("earn_movements")).toBe(2);
    expect(broadcastVaultTransaction).toHaveBeenCalledTimes(2);
  });

  /**
   * Replay is a property of this service, not of a provider, so it is asserted
   * for the second `vault_direct` provider rather than assumed to carry over —
   * the fingerprint includes the provider, and the durable movement is what the
   * retry returns.
   */
  it("replays a Veda deposit from durable state without rebuilding it", async () => {
    const input = depositInput({ provider: "veda", providerReference: VAULT_B });

    const first = await depositIntoVault(env, input);
    expect(first.replayed).toBe(false);

    buildVaultDeposit.mockClear();
    const second = await depositIntoVault(env, input);

    expect(second.replayed).toBe(true);
    expect(second.movement.id).toBe(first.movement.id);
    expect(second.movement.signature).toBe(first.movement.signature);
    // The whole point of a durable replay: no chain work, so a retry survives
    // an RPC outage.
    expect(buildVaultDeposit).not.toHaveBeenCalled();
    expect(broadcastVaultTransaction).toHaveBeenCalledTimes(1);
  });

  it("treats a changed minSharesOut as a different request", async () => {
    buildVaultDeposit.mockResolvedValue(plan({ accepted: { amount: "10", minSharesOut: "1" } }));
    await depositIntoVault(env, depositInput({ minSharesOut: "1" }));

    await expect(depositIntoVault(env, depositInput({ minSharesOut: "2" }))).rejects.toMatchObject({
      code: "CONFLICT",
    });
  });
});

describe("depositIntoVault — validation and custody identity", () => {
  it("maps deterministic provider amount validation to a caller 400", async () => {
    buildVaultDeposit.mockRejectedValue(
      new SdpKaminoError("INVALID_AMOUNT", "amount exceeds its mint precision")
    );

    await expect(depositIntoVault(env, depositInput())).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message: "amount exceeds its mint precision",
    });
  });

  /**
   * Provider-neutral by CODE, not by class. Each of these names something the
   * request or the vault's current state makes impossible, and the provider's
   * own sentence explains it better than a status code — while an unrecognised
   * failure keeps bubbling, because telling a customer their request was wrong
   * when SDP does not know that would be a guess.
   */
  it("maps every refused-build code to a caller 400, across providers", async () => {
    const refusals = [
      new SdpKaminoError("INVALID_AMOUNT", "amount exceeds its mint precision"),
      new SdpVedaError("INVALID_AMOUNT", "minSharesOut is below one share atom"),
      new SdpVedaError("DEPOSIT_REFUSED", "the vault is at its deposit cap"),
      new SdpVedaError("COMPLIANCE_APPROVAL_REQUIRED", "this vault requires an approval"),
    ];

    for (const [index, refusal] of refusals.entries()) {
      buildVaultDeposit.mockRejectedValueOnce(refusal);
      await expect(
        depositIntoVault(
          env,
          depositInput({
            provider: refusal instanceof SdpVedaError ? "veda" : "kamino",
            requestId: `3333333${index}-3333-4333-8333-333333333333`,
          })
        )
      ).rejects.toMatchObject({ code: "BAD_REQUEST", message: refusal.message });
    }
  });

  it("maps unreadable provider state to a retryable 503", async () => {
    buildVaultDeposit.mockRejectedValue(
      new SdpVedaError("VAULT_UNREADABLE", "the configured RPC could not be reached")
    );

    await expect(depositIntoVault(env, depositInput({ provider: "veda" }))).rejects.toMatchObject({
      code: "PROVIDER_UNAVAILABLE",
      statusCode: 503,
      message: "Earn provider is temporarily unavailable. Try again.",
    });
  });

  it("resolves signing by the exact custody-wallet row id", async () => {
    await depositIntoVault(env, depositInput());

    expect(createOrgSignerForCustodyWallet).toHaveBeenCalledWith(env, ORG, PROJECT, WALLET_ROW_ID);
  });
});

describe("depositIntoVault — signed persistence boundary", () => {
  it("fails closed when the builder returns a plan for another cluster", async () => {
    buildVaultDeposit.mockResolvedValue(plan({ cluster: "mainnet-beta" }));

    await expect(depositIntoVault(env, depositInput())).rejects.toMatchObject({
      code: "INTERNAL_ERROR",
    });

    expect(simulateVaultPlan).not.toHaveBeenCalled();
    expect(signVaultPlan).not.toHaveBeenCalled();
    expect(await tableCount("earn_movements")).toBe(0);
  });

  it.each([
    ["deposit token", { depositTokenMint: VAULT_B, shareMint: SHARE_MINT }],
    ["share", { depositTokenMint: TOKEN_MINT, shareMint: VAULT_B }],
  ])(
    "fails closed when the builder's %s mint disagrees with the catalogue",
    async (_name, assetIdentity) => {
      buildVaultDeposit.mockResolvedValue(plan({ assetIdentity }));

      await expect(depositIntoVault(env, depositInput())).rejects.toMatchObject({
        code: "INTERNAL_ERROR",
      });

      expect(simulateVaultPlan).not.toHaveBeenCalled();
      expect(signVaultPlan).not.toHaveBeenCalled();
      expect(await tableCount("earn_positions")).toBe(0);
      expect(await tableCount("earn_movements")).toBe(0);
    }
  );

  it.each([
    ["amount", { accepted: { amount: "10.000001" } }, {}],
    ["minSharesOut", { accepted: { amount: "10", minSharesOut: "0.9" } }, { minSharesOut: "1" }],
    ["unexpected minSharesOut", { accepted: { amount: "10", minSharesOut: "1" } }, {}],
  ])(
    "fails closed when the builder changes the policy-approved %s",
    async (_name, planOverrides, inputOverrides) => {
      buildVaultDeposit.mockResolvedValue(plan(planOverrides));

      await expect(depositIntoVault(env, depositInput(inputOverrides))).rejects.toMatchObject({
        code: "INTERNAL_ERROR",
      });

      expect(simulateVaultPlan).not.toHaveBeenCalled();
      expect(signVaultPlan).not.toHaveBeenCalled();
      expect(await tableCount("earn_movements")).toBe(0);
    }
  );

  it("atomically records canonical amounts, metadata, activation, and signature before broadcast", async () => {
    buildVaultDeposit.mockResolvedValue(plan({ accepted: { amount: "10", minSharesOut: "1" } }));
    let movementAtBroadcast: Record<string, unknown> | null = null;
    let positionAtBroadcast: Record<string, unknown> | null = null;
    broadcastVaultTransaction.mockImplementation(async () => {
      movementAtBroadcast = await getDb(env)
        .prepare("SELECT * FROM earn_movements")
        .first<Record<string, unknown>>();
      positionAtBroadcast = await getDb(env)
        .prepare("SELECT * FROM earn_positions")
        .first<Record<string, unknown>>();
    });

    await depositIntoVault(env, depositInput({ amount: "10.000000", minSharesOut: "1.000" }));

    expect(broadcastVaultTransaction).toHaveBeenCalledTimes(1);
    const deadline = resolveVaultDirectClient.mock.calls[0]?.[2];
    expect(deadline).toBeDefined();
    expect(simulateVaultPlan.mock.calls[0]?.[1]).toMatchObject({
      cluster: "devnet",
      deadline,
      expectedAssetIdentity: { depositTokenMint: TOKEN_MINT, shareMint: SHARE_MINT },
    });
    expect(signVaultPlan.mock.calls[0]?.[1]).toMatchObject({
      cluster: "devnet",
      deadline,
      expectedAssetIdentity: { depositTokenMint: TOKEN_MINT, shareMint: SHARE_MINT },
      fee: { kind: "wallet-pays" },
    });
    expect(broadcastVaultTransaction.mock.calls[0]?.[1]).toMatchObject({
      cluster: "devnet",
      deadline,
    });
    expect(movementAtBroadcast).toMatchObject({
      // The caller's spelling is what the ledger keeps; the provider plan's
      // canonical form is asserted equal before signing, not stored twice.
      amount_requested: "10.000000",
      // The ENCODED floor — the value that actually constrained the chain.
      min_shares_out: "1",
      signature: "sig_original",
      signed_transaction: "AQ==",
      last_valid_block_height: "12345",
      status: "requested",
    });
    expect(positionAtBroadcast).toMatchObject({
      token_mint: TOKEN_MINT,
      share_mint: SHARE_MINT,
      label: "Test USDC Vault",
    });
    expect((positionAtBroadcast as Record<string, unknown> | null)?.activated_at).toEqual(
      expect.any(String)
    );
  });

  it("rejects direct SQL writes that break fund or parent-position identity", async () => {
    const result = await depositIntoVault(env, depositInput());

    // The requested/accepted PAIR is gone: 0059 stored both and DB-enforced them
    // numerically equal, and the ledger keeps one column per fact with the equality
    // asserted in `requireAcceptedPlan` before anything is signed. What the database
    // still refuses is a value that is not an amount at all.
    await expect(
      getDb(env)
        .prepare("UPDATE earn_movements SET amount_requested = ? WHERE id = ?")
        .bind("9".repeat(129), result.movement.id)
        .run()
    ).rejects.toThrow();
    await expect(
      getDb(env)
        .prepare("UPDATE earn_movements SET amount_requested = '0.00' WHERE id = ?")
        .bind(result.movement.id)
        .run()
    ).rejects.toThrow();
    // The unit a movement is denominated in can never be blank — that is what keeps
    // USD, mint units and share counts from ever being read as the same figure.
    await expect(
      getDb(env)
        .prepare("UPDATE earn_movements SET denomination = '   ' WHERE id = ?")
        .bind(result.movement.id)
        .run()
    ).rejects.toThrow();
    await expect(
      getDb(env)
        .prepare("UPDATE earn_movements SET min_shares_out = '0' WHERE id = ?")
        .bind(result.movement.id)
        .run()
    ).rejects.toThrow();
    await expect(
      getDb(env)
        .prepare("UPDATE earn_movements SET last_valid_block_height = 1.5 WHERE id = ?")
        .bind(result.movement.id)
        .run()
    ).rejects.toThrow();
    // A vault movement cannot borrow a custodial column, or shed the signed-outbox
    // payload that makes record-before-broadcast enforceable.
    await expect(
      getDb(env)
        .prepare("UPDATE earn_movements SET payout_token = 'usdc' WHERE id = ?")
        .bind(result.movement.id)
        .run()
    ).rejects.toThrow();
    await expect(
      getDb(env)
        .prepare("UPDATE earn_movements SET signed_transaction = NULL WHERE id = ?")
        .bind(result.movement.id)
        .run()
    ).rejects.toThrow();
    await expect(
      getDb(env)
        .prepare("UPDATE earn_movements SET vault_address = ? WHERE id = ?")
        .bind(VAULT_B, result.movement.id)
        .run()
    ).rejects.toThrow();
    expect(
      await createPostgresEarnMovementsRepository(getDb(env)).getMovementById({
        movementId: result.movement.id,
        organizationId: ORG,
      })
    ).toMatchObject({ amount_requested: "10", vault_address: VAULT_A });
  });

  it.each([
    ["deposit token", { tokenMint: VAULT_B }, { depositTokenMint: VAULT_B, shareMint: SHARE_MINT }],
    ["share", { shareMint: VAULT_B }, { depositTokenMint: TOKEN_MINT, shareMint: VAULT_B }],
  ])(
    "never relabels an existing position's %s mint",
    async (_name, inputOverrides, assetIdentity) => {
      await depositIntoVault(env, depositInput());
      buildVaultDeposit.mockResolvedValue(plan({ assetIdentity }));
      signVaultPlan.mockResolvedValue({
        bytes: new Uint8Array([2]),
        signature: `sig_identity_change_${String(_name).replace(" ", "_")}`,
        lastValidBlockHeight: "12346",
      });

      await expect(
        depositIntoVault(
          env,
          depositInput({
            ...inputOverrides,
            requestId: "22222222-2222-4222-8222-222222222222",
          })
        )
      ).rejects.toMatchObject({ code: "CONFLICT" });

      expect(await tableCount("earn_movements")).toBe(1);
      const position = await getDb(env)
        .prepare("SELECT token_mint, share_mint FROM earn_positions")
        .first<{ token_mint: string; share_mint: string }>();
      expect(position).toEqual({ token_mint: TOKEN_MINT, share_mint: SHARE_MINT });
    }
  );

  it("leaves an ambiguous broadcast as a signed intent for reconciliation", async () => {
    broadcastVaultTransaction.mockRejectedValue(new Error("socket hang up"));

    const result = await depositIntoVault(env, depositInput());

    expect(result.movement).toMatchObject({ status: "requested", signature: "sig_original" });
  });

  it("returns a matching terminal CAS winner after broadcast", async () => {
    broadcastVaultTransaction.mockImplementation(async () => {
      const movement = await getDb(env)
        .prepare("SELECT id FROM earn_movements")
        .first<{ id: string }>();
      if (!movement) throw new Error("missing movement fixture");
      await createPostgresEarnMovementsRepository(getDb(env)).advanceVaultMovement({
        movementId: movement.id,
        organizationId: ORG,
        toStatus: "failed",
        failureReason: "chain rejected",
      });
    });

    const result = await depositIntoVault(env, depositInput());

    expect(result.movement).toMatchObject({
      status: "failed",
      signature: "sig_original",
      failure_reason: "chain rejected",
    });
    const listed = await createPostgresEarnMovementsRepository(getDb(env)).listVaultPositions({
      organizationId: ORG,
      environment: "sandbox",
      custodyWalletIds: [WALLET_ROW_ID],
      limit: 20,
      before: null,
    });
    expect(listed.rows).toEqual([]);
  });

  it("keeps a position active when a later failed attempt follows a confirmed deposit", async () => {
    const repository = createPostgresEarnMovementsRepository(getDb(env));
    const first = await depositIntoVault(
      env,
      depositInput({ requestId: "11111111-1111-4111-8111-111111111111" })
    );
    await repository.advanceVaultMovement({
      movementId: first.movement.id,
      organizationId: ORG,
      toStatus: "confirmed",
      confirmedAt: new Date().toISOString(),
    });

    signVaultPlan.mockResolvedValue({
      bytes: new Uint8Array([2]),
      signature: "sig_later_failed",
      lastValidBlockHeight: "12346",
    });
    broadcastVaultTransaction.mockImplementation(async () => {
      const movement = await getDb(env)
        .prepare(
          "SELECT id FROM earn_movements WHERE status = 'requested' ORDER BY created_at DESC LIMIT 1"
        )
        .first<{ id: string }>();
      if (!movement) throw new Error("missing later movement fixture");
      await repository.advanceVaultMovement({
        movementId: movement.id,
        organizationId: ORG,
        toStatus: "failed",
        failureReason: "chain rejected",
      });
    });

    await depositIntoVault(
      env,
      depositInput({ requestId: "22222222-2222-4222-8222-222222222222" })
    );

    const listed = await repository.listVaultPositions({
      organizationId: ORG,
      environment: "sandbox",
      custodyWalletIds: [WALLET_ROW_ID],
      limit: 20,
      before: null,
    });
    expect(listed.rows).toHaveLength(1);
    expect(listed.rows[0]?.id).toBe(first.position.id);
    expect(listed.rows[0]?.activated_at).not.toBeNull();
  });

  it("deactivates after two concurrent failures settle the last nonterminal attempts", async () => {
    let signedCount = 0;
    signVaultPlan.mockImplementation(async () => {
      signedCount += 1;
      return {
        bytes: new Uint8Array([signedCount]),
        signature: `sig_concurrent_failure_${signedCount}`,
        lastValidBlockHeight: "12345",
      };
    });
    broadcastVaultTransaction.mockRejectedValue(new Error("ambiguous broadcast"));
    const first = await depositIntoVault(
      env,
      depositInput({ requestId: "11111111-1111-4111-8111-111111111111" })
    );
    const second = await depositIntoVault(
      env,
      depositInput({ requestId: "22222222-2222-4222-8222-222222222222" })
    );
    const repository = createPostgresEarnMovementsRepository(getDb(env));

    const settled = await Promise.all([
      repository.advanceVaultMovement({
        movementId: first.movement.id,
        organizationId: ORG,
        toStatus: "failed",
        failureReason: "expired",
      }),
      repository.advanceVaultMovement({
        movementId: second.movement.id,
        organizationId: ORG,
        toStatus: "failed",
        failureReason: "expired",
      }),
    ]);

    expect(settled.every(Boolean)).toBe(true);
    const position = await repository.getPositionById({
      organizationId: ORG,
      environment: "sandbox",
      positionId: first.position.id,
    });
    expect(position?.activated_at).toBeNull();
  });

  it("keeps confirmed and failed movements terminal and rejects irrelevant metadata", async () => {
    const repository = createPostgresEarnMovementsRepository(getDb(env));
    await expect(
      repository.advanceVaultMovement({
        movementId: "earn_vault_movement_missing",
        organizationId: ORG,
        toStatus: "confirmed",
      })
    ).rejects.toThrow("confirmedAt is required");
    await expect(
      repository.advanceVaultMovement({
        movementId: "earn_vault_movement_missing",
        organizationId: ORG,
        toStatus: "failed",
      })
    ).rejects.toThrow("failureReason is required");
    const confirmed = await depositIntoVault(env, depositInput());
    await repository.advanceVaultMovement({
      movementId: confirmed.movement.id,
      organizationId: ORG,
      toStatus: "confirmed",
      confirmedAt: new Date().toISOString(),
      sharesOut: "9.5",
    });
    // NULL, not a throw. Legal source states come from the shared matrix now, so a
    // caller cannot name an illegal one and there is nothing to assert against —
    // the guard is the CAS matching zero rows, which is the same answer a lost race
    // gives and the same contract every other guarded write in the codebase has.
    await expect(
      repository.advanceVaultMovement({
        movementId: confirmed.movement.id,
        organizationId: ORG,
        toStatus: "failed",
        failureReason: "must not regress",
      })
    ).resolves.toBeNull();
    await expect(
      repository.getMovementById({ movementId: confirmed.movement.id, organizationId: ORG })
    ).resolves.toMatchObject({ status: "confirmed" });

    signVaultPlan.mockResolvedValue({
      bytes: new Uint8Array([2]),
      signature: "sig_terminal_failed",
      lastValidBlockHeight: "12346",
    });
    broadcastVaultTransaction.mockRejectedValue(new Error("ambiguous broadcast"));
    const failed = await depositIntoVault(
      env,
      depositInput({ requestId: "22222222-2222-4222-8222-222222222222" })
    );
    await repository.advanceVaultMovement({
      movementId: failed.movement.id,
      organizationId: ORG,
      toStatus: "failed",
      failureReason: "expired",
    });
    await expect(
      repository.advanceVaultMovement({
        movementId: failed.movement.id,
        organizationId: ORG,
        toStatus: "confirmed",
        confirmedAt: new Date().toISOString(),
      })
    ).resolves.toBeNull();
    await expect(
      repository.getMovementById({ movementId: failed.movement.id, organizationId: ORG })
    ).resolves.toMatchObject({ status: "failed" });
    await expect(
      repository.advanceVaultMovement({
        movementId: failed.movement.id,
        organizationId: ORG,
        toStatus: "failed",
        // A reason is supplied so the SHARES coupling is what fails here, not the
        // missing-reason check that would otherwise fire first.
        failureReason: "expired",
        sharesOut: "1",
      })
    ).rejects.toThrow("sharesOut is only valid");
    // A target the vocabulary has no transition for is still a caller bug, and
    // still throws: there is no source set to guard with.
    await expect(
      repository.advanceVaultMovement({
        movementId: failed.movement.id,
        organizationId: ORG,
        toStatus: "requested",
      })
    ).rejects.toThrow("Illegal earn movement transition");
  });

  it.each([
    ["build throws", () => buildVaultDeposit.mockRejectedValue(new Error("build failed"))],
    ["simulation throws", () => simulateVaultPlan.mockRejectedValue(new Error("RPC failed"))],
    [
      "simulation rejects",
      () => simulateVaultPlan.mockResolvedValue({ ok: false, error: "program error", logs: [] }),
    ],
    [
      "signer lookup throws",
      () => createOrgSignerForCustodyWallet.mockRejectedValue(new Error("custody failed")),
    ],
    [
      "signer address mismatches",
      () => createOrgSignerForCustodyWallet.mockResolvedValue({ address: VAULT_A }),
    ],
    ["signing throws", () => signVaultPlan.mockRejectedValue(new Error("sign failed"))],
  ])("does not invent a movement or holding when %s", async (_name, arrange) => {
    arrange();

    await expect(depositIntoVault(env, depositInput())).rejects.toBeTruthy();

    expect(await tableCount("earn_positions")).toBe(0);
    expect(await tableCount("earn_movements")).toBe(0);
    expect(broadcastVaultTransaction).not.toHaveBeenCalled();
  });

  /**
   * A blown slippage floor is the caller's tolerance, not a fault: the 400
   * carries `details.reason` so the dashboard can reopen its slippage control
   * with its own copy instead of relaying a simulation log. Matched on the
   * program's NAMED error — the bare custom-error number is every Anchor
   * program's first error code and would relabel unrelated failures.
   */
  it("names a slippage-exceeded simulation in the caller's terms", async () => {
    simulateVaultPlan.mockResolvedValue({
      ok: false,
      error: "custom program error: 0x1770",
      logs: [
        "Program log: AnchorError occurred. Error Code: SlippageExceeded. " +
          "Error Number: 6000. Error Message: Slippage tolerance exceeded.",
      ],
    });

    await expect(depositIntoVault(env, depositInput())).rejects.toMatchObject({
      code: "BAD_REQUEST",
      details: { reason: "slippage_exceeded" },
      message: expect.stringContaining("slippage"),
    });

    expect(await tableCount("earn_movements")).toBe(0);
    expect(broadcastVaultTransaction).not.toHaveBeenCalled();
  });
});

describe("depositIntoVault — approved-operation effect fencing", () => {
  it("makes an interrupted signed intent recover as ambiguous, never completed", async () => {
    const repository = createPostgresPolicyRepository(
      getDb(env),
      createTenantScope({ organizationId: ORG, projectId: PROJECT })
    );
    const operation = await repository.createWalletOperation({
      organizationId: ORG,
      projectId: PROJECT,
      custodyWalletId: WALLET_ROW_ID,
      walletId: wallet.walletId,
      source: "earn_vault_deposit",
      operationFamily: "program",
      operationType: "earn_vault_deposit",
      asset: TOKEN_MINT,
      amount: "10",
      destination: VAULT_A,
      rawPayload: { requestId: "11111111-1111-4111-8111-111111111111" },
      status: "pending_approval",
    });
    if (!operation) throw new Error("failed to seed approved wallet operation");
    const approval = await repository.createApprovalRequest({
      organizationId: ORG,
      projectId: PROJECT,
      walletOperationId: operation.id,
    });
    if (!approval) throw new Error("failed to seed approval request");
    await repository.updateApprovalRequestStatus({
      organizationId: ORG,
      projectId: PROJECT,
      approvalRequestId: approval.id,
      status: "approved",
      operationStatus: "executing",
      resolvedBy: USER,
    });
    const attemptId = "earn-approved-interrupted-attempt";
    expect(await repository.claimWalletOperationExecution(operation.id, attemptId)).not.toBeNull();
    const contextValues: Record<string, unknown> = {
      apiKey: {
        id: "key_earn_approved_test",
        organizationId: ORG,
        projectId: PROJECT,
        role: "api_admin",
        permissions: ["*"],
        environment: "sandbox",
        signingWalletId: null,
        signingWalletIds: [],
        walletBindings: [],
      },
      projectId: PROJECT,
      approvedWalletOperationId: operation.id,
      approvedWalletOperationAttemptId: attemptId,
    };
    const context = {
      env,
      get: (key: string) => contextValues[key],
    } as never;
    broadcastVaultTransaction.mockRejectedValue(new Error("worker interrupted after insert"));

    const result = await depositIntoVault(env, depositInput(), {
      runIntentTransaction: (mutation) =>
        runApprovedWalletOperationEffectTransaction(context, mutation),
    });
    expect(result.movement.status).toBe("requested");
    const fenced = await repository.getWalletOperationById(operation.id);
    expect(fenced?.execution_effect_started_at).not.toBeNull();
    await getDb(env)
      .prepare(
        `UPDATE wallet_operations
         SET execution_lease_expires_at = '2000-01-01T00:00:00.000Z'
         WHERE id = ?`
      )
      .bind(operation.id)
      .run();

    expect(await recoverApprovedWalletOperations(env)).toBe(0);
    expect(await repository.getWalletOperationById(operation.id)).toMatchObject({
      status: "failed",
      execution_attempt_id: attemptId,
    });
    expect((await repository.getWalletOperationById(operation.id))?.execution_error).toContain(
      "manual reconciliation"
    );
    expect(await tableCount("earn_movements")).toBe(1);
  });
});

describe("earn vault project attribution", () => {
  it("preserves an organization-wallet claim and cross-project history when a project is deleted", async () => {
    const otherProject = "prj_vault_deposit_other";
    const orgConfig = "cfg_vault_deposit_org";
    const orgWallet = "cwlt_vault_deposit_org";
    await getDb(env).batch([
      getDb(env)
        .prepare(
          `INSERT INTO projects
             (id, organization_id, name, slug, environment, status, created_by)
           VALUES (?, ?, 'Other Vault Project', 'other-vault-project', 'sandbox', 'active', ?)`
        )
        .bind(otherProject, ORG, USER),
      getDb(env)
        .prepare(
          `INSERT INTO custody_configs
             (id, organization_id, project_id, provider, config_encrypted, status)
           VALUES (?, ?, NULL, 'privy', 'test-encrypted', 'active')`
        )
        .bind(orgConfig, ORG),
      getDb(env)
        .prepare(
          `INSERT INTO custody_wallets
             (id, custody_config_id, wallet_id, public_key, status)
           VALUES (?, ?, 'privy_vault_deposit_org', ?, 'active')`
        )
        .bind(orgWallet, orgConfig, VAULT_B),
    ]);
    const repository = createPostgresEarnMovementsRepository(getDb(env));
    const base = {
      organizationId: ORG,
      environment: "sandbox" as const,
      provider: "kamino",
      vaultAddress: VAULT_A,
      custodyWalletId: orgWallet,
      sourceAddress: WALLET_ADDRESS,
      tokenMint: TOKEN_MINT,
      shareMint: SHARE_MINT,
      label: "Shared Vault",
      requestedAmount: "1",
      signedTransaction: "AQ==",
      lastValidBlockHeight: "12345",
      createdBy: USER,
    };
    const first = await repository.createSignedVaultDepositIntent({
      ...base,
      projectId: PROJECT,
      signature: "sig_project_attribution_first",
      requestId: "11111111-1111-4111-8111-111111111111",
      idempotencyFingerprint: "fingerprint_project_attribution_first",
    });
    const second = await repository.createSignedVaultDepositIntent({
      ...base,
      projectId: otherProject,
      signature: "sig_project_attribution_second",
      requestId: "22222222-2222-4222-8222-222222222222",
      idempotencyFingerprint: "fingerprint_project_attribution_second",
    });
    expect(second.position.id).toBe(first.position.id);

    await getDb(env).prepare("DELETE FROM projects WHERE id = ?").bind(PROJECT).run();

    const position = await getDb(env)
      .prepare("SELECT project_id FROM earn_positions WHERE id = ?")
      .bind(first.position.id)
      .first<{ project_id: string | null }>();
    const movements = await getDb(env)
      .prepare("SELECT project_id FROM earn_movements WHERE position_id = ? ORDER BY request_id")
      .bind(first.position.id)
      .all<{ project_id: string | null }>();
    expect(position?.project_id).toBeNull();
    expect(movements.results.map((row) => row.project_id)).toEqual([null, otherProject]);
  });

  /**
   * Who is owed the share-ATA rent back. Recorded at DEPOSIT time because the
   * exit that closes the account may be months later and under a different fee
   * mode, and nothing on chain records who paid.
   */
  describe("share-ATA rent funder", () => {
    const SPONSOR = "4YhMUz8xDgHMPAevvfMpnJX9TJmw9DTNDA1sNWPRZG9q";

    /**
     * Read by POSITION ID, not `LIMIT 1`. An unscoped read makes the two
     * expect-null cases pass vacuously if the row is ever absent, which is the
     * failure they exist to catch.
     */
    async function recordedFunder(positionId: string): Promise<string | null> {
      const row = await getDb(env)
        .prepare("SELECT share_ata_rent_funder FROM earn_positions WHERE id = ?")
        .bind(positionId)
        .first<{ share_ata_rent_funder: string | null }>();
      if (!row) throw new Error(`missing position fixture ${positionId}`);
      return row.share_ata_rent_funder ?? null;
    }

    function sponsored() {
      resolveVaultSponsorship.mockResolvedValue({
        kind: "sponsored",
        sponsor: SPONSOR,
        feePayment: { getFeePayer: vi.fn(), signAsFeePayer: vi.fn(), signAndSend: vi.fn() },
      });
    }

    it("records the sponsor when this deposit creates the account", async () => {
      sponsored();
      buildVaultDeposit.mockResolvedValue(plan({ createsShareAccount: true }));

      const result = await depositIntoVault(env, depositInput());

      expect(await recordedFunder(result.position.id)).toBe(SPONSOR);
    });

    /**
     * The actual bug this feature fixed. Fees were already sponsorable; the
     * `rentPayer` inside the instructions still defaulted to the owner, so a
     * wallet holding zero SOL could not make a first deposit. Nothing else
     * asserts that the resolved sponsor reaches the builder.
     */
    it("hands the sponsor to the builder as the rent payer", async () => {
      sponsored();

      await depositIntoVault(env, depositInput());

      expect(buildVaultDeposit.mock.calls[0]?.[1]).toMatchObject({ rentPayer: SPONSOR });
    });

    it("names no rent payer when the wallet pays its own fees", async () => {
      await depositIntoVault(env, depositInput());

      expect(buildVaultDeposit.mock.calls[0]?.[1]).not.toHaveProperty("rentPayer");
    });

    /**
     * The case that protects the customer. Account creation is idempotent, so a
     * sponsored deposit into a vault the wallet already holds pays no rent.
     * Recording a funder here would later refund a sponsor with lamports the
     * customer had put up.
     */
    it("records nothing when the account already existed", async () => {
      sponsored();
      buildVaultDeposit.mockResolvedValue(plan({ createsShareAccount: false }));

      const result = await depositIntoVault(env, depositInput());

      expect(await recordedFunder(result.position.id)).toBeNull();
    });

    it("records nothing when the wallet funds its own rent", async () => {
      buildVaultDeposit.mockResolvedValue(plan({ createsShareAccount: true }));

      const result = await depositIntoVault(env, depositInput());

      expect(await recordedFunder(result.position.id)).toBeNull();
    });

    async function failMovement(movementId: string): Promise<void> {
      await createPostgresEarnMovementsRepository(getDb(env)).advanceVaultMovement({
        movementId,
        organizationId: ORG,
        toStatus: "failed",
        failureReason: "Transaction blockhash expired before confirmation",
      });
    }

    /**
     * The attribution is a PROJECTION, so it repairs itself. A movement that
     * observed the account missing and then never landed charged no rent, and
     * leaving its claim standing would send the close's 2,039,280 lamports to a
     * party that paid nothing, for as long as the position lives.
     */
    it("drops the claim when the creating movement fails", async () => {
      sponsored();
      buildVaultDeposit.mockResolvedValue(plan({ createsShareAccount: true }));
      const result = await depositIntoVault(env, depositInput());
      expect(await recordedFunder(result.position.id)).toBe(SPONSOR);

      await failMovement(result.movement.id);

      expect(await recordedFunder(result.position.id)).toBeNull();
    });

    /**
     * And it falls back rather than to a guess: an earlier surviving claim is
     * the truth once a later one fails, because the account it created is the
     * one still on chain.
     */
    it("falls back to the earlier surviving claim", async () => {
      const SPONSOR_LATER = "8pPyFjmDGXnstD9Yg8H1jd1CyJcCPHwRvUBhZ4NRLPMe";
      buildVaultDeposit.mockResolvedValue(plan({ createsShareAccount: true }));
      resolveVaultSponsorship.mockResolvedValue({
        kind: "sponsored",
        sponsor: SPONSOR,
        feePayment: { getFeePayer: vi.fn(), signAsFeePayer: vi.fn(), signAndSend: vi.fn() },
      });
      const first = await depositIntoVault(env, depositInput());

      resolveVaultSponsorship.mockResolvedValue({
        kind: "sponsored",
        sponsor: SPONSOR_LATER,
        feePayment: { getFeePayer: vi.fn(), signAsFeePayer: vi.fn(), signAndSend: vi.fn() },
      });
      signVaultPlan.mockResolvedValue({
        bytes: new Uint8Array([2]),
        signature: "sig_second_claim",
        lastValidBlockHeight: "12345",
      });
      const second = await depositIntoVault(
        env,
        depositInput({ requestId: "22222222-2222-4222-8222-222222222222" })
      );
      expect(second.position.id).toBe(first.position.id);
      expect(await recordedFunder(first.position.id)).toBe(SPONSOR_LATER);

      await failMovement(second.movement.id);

      expect(await recordedFunder(first.position.id)).toBe(SPONSOR);
    });

    /**
     * The loser of the insert race must not attribute rent. Its bytes never
     * broadcast, so it pays nothing, and it is not merely sometimes-last: the
     * claim upsert holds the position row's lock, so the loser is serialised
     * second and its funder would overwrite the winner's every time.
     *
     * Reachable because the idempotency fingerprint omits the fee mode, so two
     * same-key requests that resolved different sponsors replay-match instead
     * of conflicting. A rolling deploy (the flag is per-revision) or a
     * round-robin Kora signer pool is enough to skew them.
     */
    it("keeps the winner's funder when identical requests race under different fee modes", async () => {
      const SPONSOR_ROTATED = "8pPyFjmDGXnstD9Yg8H1jd1CyJcCPHwRvUBhZ4NRLPMe";
      let releaseBuilds: (() => void) | undefined;
      const bothBuilding = new Promise<void>((resolve) => {
        releaseBuilds = resolve;
      });
      let resolvedCount = 0;
      resolveVaultSponsorship.mockImplementation(async () => {
        resolvedCount += 1;
        return {
          kind: "sponsored",
          sponsor: resolvedCount === 1 ? SPONSOR : SPONSOR_ROTATED,
          feePayment: { getFeePayer: vi.fn(), signAsFeePayer: vi.fn(), signAndSend: vi.fn() },
        };
      });
      let buildCount = 0;
      buildVaultDeposit.mockImplementation(async () => {
        buildCount += 1;
        if (buildCount === 2) releaseBuilds?.();
        await bothBuilding;
        return plan({ createsShareAccount: true });
      });
      const sponsorBySignature = new Map<string, string>();
      signVaultPlan.mockImplementation(
        async (_env: unknown, input: { fee: { sponsor: string } }) => {
          const signature = `sig_fee_mode_${sponsorBySignature.size + 1}`;
          sponsorBySignature.set(signature, input.fee.sponsor);
          return { bytes: new Uint8Array([1]), signature, lastValidBlockHeight: "12345" };
        }
      );

      const results = await Promise.all([
        depositIntoVault(env, depositInput()),
        depositIntoVault(env, depositInput()),
      ]);

      // One insert won, both callers see that movement, and only it broadcast.
      expect(results.map((result) => result.replayed).sort()).toEqual([false, true]);
      expect(await tableCount("earn_movements")).toBe(1);
      expect(broadcastVaultTransaction).toHaveBeenCalledTimes(1);
      // Two sponsors were resolved, so the assertion below is not vacuous.
      expect(new Set(sponsorBySignature.values()).size).toBe(2);
      // The refund is owed to whoever signed the bytes that can land.
      const winner = results.find((result) => !result.replayed);
      expect(await recordedFunder(results[0].position.id)).toBe(
        sponsorBySignature.get(winner?.movement.signature ?? "")
      );
    });
  });
});

describe("depositIntoVault — swap-funded (Jupiter)", () => {
  // Devnet USDG; the route validates membership, this service only carries it.
  const SOURCE_MINT = "4F6PM96JJxngmHnZLBh9n58RH4aTVNWvDs2nuwrT5BP7";

  function swapLeg(overrides: Record<string, unknown> = {}) {
    return {
      instructions: [
        {
          programAddress: "11111111111111111111111111111111",
          accounts: [],
          data: Buffer.from("swap-leg", "utf8").toString("base64"),
        },
      ],
      lookupTableAddresses: ["D1ZN9Wj1fRSUQfCjhvnu1hqDMT7hzjzBBpi12nVniYD6"],
      sourceAmount: "10",
      quotedAmount: "9.99",
      minOutAmount: "9.95",
      priceImpactPct: "0.0001",
      routeLabels: ["Whirlpool"],
      slippageBps: 50,
      ...overrides,
    };
  }

  function swapInput() {
    return depositInput({
      amount: "10",
      swap: { sourceTokenMint: SOURCE_MINT, slippageBps: 50 },
    });
  }

  beforeEach(() => {
    fetchJupiterSwapLeg.mockResolvedValue(swapLeg());
    buildVaultDeposit.mockResolvedValue(plan({ accepted: { amount: "9.95" } }));
  });

  it("sizes the deposit to the swap floor, prepends the leg, and never sponsors", async () => {
    const result = await depositIntoVault(env, swapInput());

    // The provider built for the swap's guaranteed output, not the source amount.
    expect(buildVaultDeposit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ amount: "9.95" })
    );
    // Jupiter programs are not paymaster-allowlisted; a swap-funded deposit
    // must not even ask.
    expect(resolveVaultSponsorship).not.toHaveBeenCalled();

    // The signed plan runs a LOCALLY built compute-unit limit (the probe's
    // consumption was unreported by the mocked simulation, so the maximum),
    // then swap → provider deposit → request memo, with the swap's lookup
    // tables carried along.
    const signedPlan = signVaultPlan.mock.calls[0]?.[1]?.plan;
    expect(signedPlan.instructions[0].programAddress).toBe(
      "ComputeBudget111111111111111111111111111111"
    );
    const datas = signedPlan.instructions
      .slice(1)
      .map((instruction: { data: string }) =>
        Buffer.from(instruction.data, "base64").toString("utf8")
      );
    expect(datas[0]).toBe("swap-leg");
    expect(datas.at(-1)).toMatch(/^sdp:earn:vault-deposit:/);
    expect(signedPlan.lookupTables).toContain("D1ZN9Wj1fRSUQfCjhvnu1hqDMT7hzjzBBpi12nVniYD6");

    // The ledger row claims the DEPOSIT amount in the deposit token.
    expect(result.movement.amount_requested).toBe("9.95");
    expect(result.movement.denomination).toBe(TOKEN_MINT);
  });

  it("keys idempotency on the funding token: same key, swap vs no swap, is a conflict", async () => {
    buildVaultDeposit.mockResolvedValueOnce(plan({ accepted: { amount: "10" } }));
    await depositIntoVault(env, depositInput({ amount: "10" }));
    await expect(depositIntoVault(env, swapInput())).rejects.toThrowError(
      /different request payload|conflict/i
    );
  });

  it("re-routes once for compactness and refuses when the transaction still cannot fit", async () => {
    signVaultPlan.mockRejectedValue(new VaultTransactionTooLargeError(1400, false));

    await expect(depositIntoVault(env, swapInput())).rejects.toThrowError(
      /cannot fit in one Solana transaction/
    );
    expect(fetchJupiterSwapLeg).toHaveBeenCalledTimes(2);
    expect(fetchJupiterSwapLeg.mock.calls[1]?.[2]).toMatchObject({ maxAccounts: 24 });
    // The refusal signed nothing durable and broadcast nothing.
    expect(await tableCount("earn_movements")).toBe(0);
    expect(broadcastVaultTransaction).not.toHaveBeenCalled();
  });
});
