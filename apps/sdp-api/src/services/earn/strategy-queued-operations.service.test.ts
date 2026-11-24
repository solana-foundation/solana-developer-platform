import { runInClusterScope } from "@sdp/rpc/scope";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getDb } from "@/db/client";
import { createPostgresEarnVaultWithdrawalRequestsRepository } from "@/db/repositories/earn-vault-withdrawal-requests.repository";
import { type EarnAuthzTenant, seedEarnAuthzTenant } from "@/test/helpers/earn";
import { env } from "@/test/helpers/env";
import { seedTestDatabase } from "@/test/mocks/db";
import {
  prepareQueuedStrategyWithdrawal,
  prepareStrategyWithdrawalChoices,
  selectStrategyWithdrawalChoice,
} from "./strategy-queued-operations.service";

const { resolve, buildQueued, readRecoveries } = vi.hoisted(() => ({
  resolve: vi.fn(),
  buildQueued: vi.fn(),
  readRecoveries: vi.fn(),
}));
vi.mock("./strategy-withdrawal-recovery.service", async (original) => {
  const actual = await original<typeof import("./strategy-withdrawal-recovery.service")>();
  readRecoveries.mockImplementation(actual.readExpiredStrategyWithdrawalRecoveries);
  return { ...actual, readExpiredStrategyWithdrawalRecoveries: readRecoveries };
});
vi.mock("./execution-registry", async (original) => ({
  ...(await original<typeof import("./execution-registry")>()),
  resolveEarnExecutionClient: resolve,
}));
vi.mock("./vault-queued-withdraw.service", async (original) => ({
  ...(await original<typeof import("./vault-queued-withdraw.service")>()),
  buildWalletQueuedWithdrawalRequest: buildQueued,
  submitWalletQueuedWithdrawalAction: vi.fn(),
}));

const position = {
  id: "position",
  provider: "veda",
  vaultAddress: "strategy-reference",
  tokenMint: "token",
  shareMint: "shares",
  ownerAddress: "owner",
};
const direct = {
  buildVaultDeposit: vi.fn(),
  readVaultPositions: vi.fn(),
  sponsoredPrograms: vi.fn(),
  buildVaultWithdrawal: vi.fn(),
  quoteVaultWithdrawal: vi.fn(async () => ({
    assetsOut: "10",
    assetDecimals: 6,
    blockingIssues: [],
  })),
};
const queued = {
  ...direct,
  getWithdrawalOptions: vi.fn(async () => ({
    instant: true,
    queued: true,
    providerOrder: false,
    withdrawAuthority: null,
    queueState: null,
    parRedemption: null,
    queueAsset: {
      assetMint: "token",
      allowWithdrawals: true,
      secondsToMaturity: 600,
      minimumSecondsToDeadline: 120,
      maximumSecondsToDeadline: 3600,
      minimumDiscountBps: 25,
      maximumDiscountBps: 100,
      minimumShares: "1",
      shareDecimals: 6,
    },
  })),
  quoteQueuedWithdrawal: vi.fn(async () => ({
    assetMint: "token",
    shares: "2",
    shareDecimals: 6,
    assets: "9.975",
    assetDecimals: 6,
    discountBps: 25,
    maturityTimestamp: "2000000000",
    deadlineTimestamp: "2000000120",
    blockingIssues: [],
  })),
  buildQueuedWithdrawalRequest: vi.fn(),
  buildQueuedWithdrawalCancel: vi.fn(),
  readQueuedWithdrawalRequests: vi.fn(),
  readQueuedWithdrawalRequest: vi.fn(),
  decodeQueuedWithdrawalLifecycleEvents: vi.fn(),
};
const par = {
  ...direct,
  getParRedemptionOptions: vi.fn(async () => ({
    intermediateMint: "intermediate",
    assetMint: "token",
    minimumShares: "1",
    minimumIntermediateAmount: "1000",
    shareDecimals: 6,
    assetDecimals: 6,
    cancelable: true,
    operatorSettled: true,
  })),
  quoteParRedemption: vi.fn(async () => ({
    shares: "0",
    shareDecimals: 6,
    intermediateMint: "intermediate",
    intermediateAmount: "2000",
    assetMint: "token",
    assets: "2000",
    assetDecimals: 6,
    blockingIssues: [],
  })),
  buildParRedemptionRequest: vi.fn(),
  buildParRedemptionCancel: vi.fn(),
  readParRedemptionRequest: vi.fn(),
  decodeParRedemptionLifecycleEvents: vi.fn(),
};
function choices(input: Parameters<typeof prepareStrategyWithdrawalChoices>[1]) {
  return runInClusterScope({ projectId: "project", environment: "sandbox" }, () =>
    prepareStrategyWithdrawalChoices(env, input)
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  resolve.mockReturnValue(queued);
});

describe("shared strategy withdrawal options", () => {
  it("quotes independently available direct and queue exits without silently choosing", async () => {
    const prepared = await choices({ position, shares: "2" });
    expect(prepared.options.map((option) => option.id)).toEqual(["direct", "solver_queue:25:120"]);
    expect(() => selectStrategyWithdrawalChoice(prepared)).toThrow("Choose one");
    const selected = selectStrategyWithdrawalChoice(prepared, "solver_queue:25:120");
    expect(selected.terms).toEqual({
      mechanism: "solver_queue",
      shares: "2",
      discountBps: 25,
      deadlineSeconds: 120,
    });
    expect(selected.option).toMatchObject({
      settlement: "delayed",
      estimatedSeconds: null,
      amount: { mint: "token", value: "9.975" },
      minimum: null,
    });
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(queued.getWithdrawalOptions).toHaveBeenCalledTimes(1);
    expect(queued.quoteQueuedWithdrawal).toHaveBeenCalledTimes(1);
    expect(direct.quoteVaultWithdrawal).toHaveBeenCalledTimes(1);
    expect(buildQueued).not.toHaveBeenCalled();
  });

  it("keeps direct-only exits available without queue capabilities", async () => {
    resolve.mockReturnValue(direct);
    const prepared = await choices({ position, shares: "2" });
    expect(prepared.options).toEqual([
      expect.objectContaining({ id: "direct", settlement: "instant", mechanism: "direct" }),
    ]);
    expect(queued.getWithdrawalOptions).not.toHaveBeenCalled();
    expect(buildQueued).not.toHaveBeenCalled();
  });

  it("reports a provider redemption order as delayed without promising payout time", async () => {
    resolve.mockReturnValue({ ...direct, vaultWithdrawalSettlement: "provider_order" });
    const prepared = await choices({ position, shares: "2" });
    expect(prepared.options).toEqual([
      expect.objectContaining({
        id: "direct",
        settlement: "delayed",
        estimatedSeconds: null,
        mechanism: "provider_order",
      }),
    ]);
    expect(buildQueued).not.toHaveBeenCalled();
  });

  it("intersects static exit capabilities with the provider's live availability", async () => {
    const original = queued.getWithdrawalOptions.getMockImplementation();
    if (!original) throw new Error("Missing provider option fixture");
    queued.getWithdrawalOptions.mockImplementationOnce(async () => ({
      ...(await original()),
      instant: false,
      queued: false,
    }));
    await expect(choices({ position, shares: "2" })).rejects.toThrow(
      "No supported withdrawal route"
    );
    expect(direct.quoteVaultWithdrawal).not.toHaveBeenCalled();
    expect(queued.quoteQueuedWithdrawal).not.toHaveBeenCalled();
    expect(buildQueued).not.toHaveBeenCalled();
  });

  it("keeps held intermediate exits independent from redeemable shares", async () => {
    resolve.mockReturnValue(par);
    const prepared = await choices({ position, intermediateAmount: "2000" });
    expect(prepared.options.map((option) => option.id)).toEqual(["operator_redemption"]);
    expect(selectStrategyWithdrawalChoice(prepared).terms).toEqual({
      mechanism: "operator_redemption",
      intermediateAmount: "2000",
    });
    expect(par.quoteParRedemption).toHaveBeenCalledWith(expect.anything(), {
      providerReference: position.vaultAddress,
      intermediateAmount: "2000",
    });
    expect(direct.quoteVaultWithdrawal).not.toHaveBeenCalled();
  });

  it("keeps Hastra direct exit disabled while preserving operator redemption", async () => {
    resolve.mockReturnValue(par);
    const prepared = await choices({ position: { ...position, provider: "hastra" }, shares: "2" });
    expect(prepared.options.map((option) => option.id)).toEqual(["operator_redemption"]);
    expect(direct.quoteVaultWithdrawal).not.toHaveBeenCalled();
  });

  it("does not advertise a queue whose minimum exceeds the requested holding", async () => {
    const prepared = await choices({ position, shares: "0.5" });
    expect(prepared.options.map((option) => option.id)).toEqual(["direct"]);
    expect(queued.quoteQueuedWithdrawal).not.toHaveBeenCalled();
  });

  it("retains an independent par route while the direct DEX quote is unavailable", async () => {
    resolve.mockReturnValue(par);
    direct.quoteVaultWithdrawal.mockRejectedValueOnce(new Error("DEX unavailable"));
    const prepared = await choices({ position, shares: "2" });
    expect(prepared.options.map((option) => option.id)).toEqual(["operator_redemption"]);
    expect(par.quoteParRedemption).toHaveBeenCalledTimes(1);
    expect(buildQueued).not.toHaveBeenCalled();
  });

  it("answers a provider outage with 503, not a missing route", async () => {
    queued.getWithdrawalOptions.mockRejectedValueOnce(
      Object.assign(new Error("Vault state is unreadable"), { code: "VAULT_UNREADABLE" })
    );
    await expect(choices({ position, shares: "2" })).rejects.toMatchObject({
      code: "PROVIDER_UNAVAILABLE",
    });
  });

  it("answers an unusable swap quote with 503 when no other route survives", async () => {
    resolve.mockReturnValue(direct);
    direct.quoteVaultWithdrawal.mockRejectedValueOnce(
      Object.assign(new Error("Jupiter returned an invalid wYLDS quote."), {
        code: "SWAP_UNAVAILABLE",
      })
    );
    await expect(choices({ position, shares: "2" })).rejects.toMatchObject({
      code: "PROVIDER_UNAVAILABLE",
    });
  });

  it("keeps the no-route 400 when a failed read is not an outage", async () => {
    queued.getWithdrawalOptions.mockRejectedValueOnce(new Error("Unexpected provider failure"));
    await expect(choices({ position, shares: "2" })).rejects.toThrow(
      "No supported withdrawal route"
    );
  });

  it("fails closed with 503 when a recorded expired escrow can't be read", async () => {
    readRecoveries.mockRejectedValueOnce(
      Object.assign(new Error("Withdrawal request is unreadable"), { code: "REQUEST_UNREADABLE" })
    );
    await expect(
      choices({
        position,
        shares: "2",
        recovery: { actor: { organizationId: "organization", projectId: "project" } },
      })
    ).rejects.toMatchObject({ code: "PROVIDER_UNAVAILABLE" });
    expect(buildQueued).not.toHaveBeenCalled();
  });

  it("rejects incompatible custody sources before building", async () => {
    await expect(
      prepareQueuedStrategyWithdrawal(env, {
        actor: { organizationId: "organization", projectId: "project" },
        position: { ...position, custodyWalletId: "actual-wallet" },
        custodyWalletId: "different-wallet",
        terms: { mechanism: "solver_queue", shares: "2", discountBps: 25, deadlineSeconds: 120 },
      })
    ).rejects.toThrow("authorized position");
    expect(buildQueued).not.toHaveBeenCalled();
  });
});

describe("current Hastra redemption release choices", () => {
  let tenant: EarnAuthzTenant;
  const hastraPosition = {
    ...position,
    provider: "hastra",
    ownerAddress: "11111111111111111111111111111111",
    custodyWalletId: undefined as string | undefined,
  };
  const plan = {
    cluster: "devnet",
    instructions: [],
    lookupTables: [],
    assetIdentity: { depositTokenMint: position.tokenMint, shareMint: position.shareMint },
  };
  const actor = () => ({ organizationId: tenant.org.id, projectId: tenant.project.id });
  const prepare = (
    overrides: Partial<typeof hastraPosition> = {},
    actorOverrides: Partial<ReturnType<typeof actor>> = {}
  ) =>
    runInClusterScope({ projectId: tenant.project.id, environment: "sandbox" }, () =>
      prepareStrategyWithdrawalChoices(env, {
        position: { ...hastraPosition, ...overrides },
        recovery: { actor: { ...actor(), ...actorOverrides } },
      })
    );
  async function seedPendingRequest(id = "pending_redemption") {
    await getDb(env).execute(
      `INSERT INTO earn_vault_withdrawal_requests (
       id, organization_id, project_id, environment, provider, position_id,
       owner_address, vault_address, token_mint, share_mint, request_address,
       status, mechanism, shares, quoted_assets, share_decimals, asset_decimals,
       intermediate_mint, intermediate_amount, client_request_id,
       idempotency_fingerprint, creation_signature, provider_state_observed)
       VALUES (?, ?, ?, 'sandbox', 'hastra', ?, ?, ?, ?, ?, 'owner_request',
               'pending', 'operator_redemption', '0', '2000', 6, 6,
               '8fr7WGTVFszfyNWRMXj6fRjZZAnDwmXwEpCrtzmUkdih', '2000', ?, ?, ?, TRUE)`,
      [
        id,
        tenant.org.id,
        tenant.project.id,
        position.id,
        hastraPosition.ownerAddress,
        position.vaultAddress,
        position.tokenMint,
        position.shareMint,
        id,
        `${id}_fingerprint`,
        `${id}_signature`,
      ]
    );
  }
  beforeEach(async () => {
    await seedTestDatabase(env);
    tenant = await seedEarnAuthzTenant(env, "release_choices", { environment: "sandbox" });
    await getDb(env).execute(
      `INSERT INTO earn_positions (
       id, organization_id, project_id, environment, provider, kind, owner_address,
       vault_address, token_mint, share_mint, label, activated_at)
       VALUES (?, ?, ?, 'sandbox', 'hastra', 'vault_direct', ?, ?, ?, ?,
               'Hastra holding', sdp_iso_now())`,
      [
        position.id,
        tenant.org.id,
        tenant.project.id,
        hastraPosition.ownerAddress,
        position.vaultAddress,
        position.tokenMint,
        position.shareMint,
      ]
    );
    resolve.mockReturnValue(par);
    par.buildParRedemptionCancel.mockResolvedValue(plan);
  });

  it("offers release without free PRIME or undelegated wYLDS and promises no amount", async () => {
    await seedPendingRequest();
    const prepared = await prepare();
    expect(prepared.options).toEqual([
      {
        id: "release_current_redemption",
        label: "Release current pending redemption",
        settlement: "instant",
        estimatedSeconds: null,
        mechanism: "release_current_redemption",
        minimum: null,
      },
    ]);
    expect(prepared.options[0]).not.toHaveProperty("amount");
    expect(prepared.choices[0]).toMatchObject({
      kind: "recovery",
      currentRedemptionRelease: { request: { id: "pending_redemption" }, plan },
    });
    expect(par.buildParRedemptionCancel).toHaveBeenCalledExactlyOnceWith(expect.anything(), {
      providerReference: position.vaultAddress,
      owner: hastraPosition.ownerAddress,
      requestAddress: "owner_request",
    });
    expect(par.getParRedemptionOptions).not.toHaveBeenCalled();
    expect(par.quoteParRedemption).not.toHaveBeenCalled();
    expect(par.readParRedemptionRequest).not.toHaveBeenCalled();
    expect(buildQueued).not.toHaveBeenCalled();
  });

  it.each([
    "none",
    "fulfilled",
    "other_project",
    "other_organization",
    "other_owner",
    "other_wallet",
  ] as const)("does not read provider state for a %s pending context", async (context) => {
    if (context !== "none") await seedPendingRequest();
    if (context === "fulfilled") {
      await getDb(env).execute(
        "UPDATE earn_vault_withdrawal_requests SET status = 'fulfilled', fulfilled_at = sdp_iso_now()"
      );
    }
    await expect(
      prepare(
        context === "other_wallet"
          ? { custodyWalletId: "another_wallet" }
          : context === "other_owner"
            ? { ownerAddress: "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM" }
            : {},
        context === "other_project"
          ? { projectId: "prj_release_choices_production" }
          : context === "other_organization"
            ? { organizationId: "another_organization" }
            : {}
      )
    ).rejects.toThrow("No supported withdrawal route");
    expect(par.buildParRedemptionCancel).not.toHaveBeenCalled();
    expect(par.readParRedemptionRequest).not.toHaveBeenCalled();
    expect(par.quoteParRedemption).not.toHaveBeenCalled();
  });

  it("rejects mismatched strategy assets before preparing a release", async () => {
    await seedPendingRequest();
    await getDb(env).execute(
      "UPDATE earn_vault_withdrawal_requests SET token_mint = 'another_mint'"
    );
    await expect(prepare()).rejects.toThrow("does not match the withdrawal strategy");
    expect(par.buildParRedemptionCancel).not.toHaveBeenCalled();
  });

  it("uses replacement context without rewriting the completed historical request", async () => {
    await seedPendingRequest("redemption_a");
    await getDb(env).execute(
      "UPDATE earn_vault_withdrawal_requests SET status = 'fulfilled', fulfilled_at = sdp_iso_now(), closing_signature = 'fulfilled_a' WHERE id = 'redemption_a'"
    );
    await seedPendingRequest("redemption_b");
    const repository = createPostgresEarnVaultWithdrawalRequestsRepository(getDb(env));
    const readA = () =>
      repository.getById({
        organizationId: tenant.org.id,
        environment: "sandbox",
        withdrawalRequestId: "redemption_a",
      });
    const originalA = await readA();
    const prepared = await prepare();
    expect(prepared.choices[0]?.currentRedemptionRelease?.request.id).toBe("redemption_b");
    expect(prepared.options[0]).toMatchObject({
      id: "release_current_redemption",
      minimum: null,
    });
    expect(prepared.options[0]).not.toHaveProperty("amount");
    expect(await readA()).toEqual(originalA);
    expect(par.buildParRedemptionCancel).toHaveBeenCalledTimes(1);
  });

  it("does not offer release when the provider proves the request is no longer pending", async () => {
    await seedPendingRequest();
    par.buildParRedemptionCancel.mockRejectedValueOnce(
      Object.assign(new Error("No current pending redemption"), { code: "REDEMPTION_REFUSED" })
    );
    await expect(prepare()).rejects.toThrow("No supported withdrawal route");
    expect(par.buildParRedemptionCancel).toHaveBeenCalledTimes(1);
  });

  it("keeps a provider read failure unresolved instead of advertising release", async () => {
    await seedPendingRequest();
    par.buildParRedemptionCancel.mockRejectedValueOnce(new Error("RPC unavailable"));
    await expect(prepare()).rejects.toThrow();
    expect(par.buildParRedemptionCancel).toHaveBeenCalledTimes(1);
    expect(buildQueued).not.toHaveBeenCalled();
  });
});
