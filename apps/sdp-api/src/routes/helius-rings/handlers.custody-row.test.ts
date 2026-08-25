import { beforeEach, describe, expect, it, vi } from "vitest";
import type { HeliusRingsOperationRow, HeliusRingsWalletRow } from "@/db/repositories";

const AUTH = {
  authType: "api_key",
  id: "key_1",
  organizationId: "org_1",
  projectId: "proj_1",
  apiKeyId: "key_1",
};
const ACTOR = { type: "api_key", id: "key_1", apiKeyId: "key_1" };

const mocks = vi.hoisted(() => ({
  getHeliusRingsService: vi.fn(),
  getWalletById: vi.fn(),
  prepareOperation: vi.fn(),
  requireParam: vi.fn(),
  requireRingsOperation: vi.fn(),
  requireRingsWallet: vi.fn(),
  resolveScope: vi.fn(),
  retryOperation: vi.fn(),
  success: vi.fn((_context: unknown, body: unknown) => body),
  withRingsErrors: vi.fn((work: () => Promise<unknown>) => work()),
}));

vi.mock("@/db/repositories", () => ({
  mapHeliusRingsOperationSummaryRow: (row: { id: string }) => ({ id: row.id }),
  mapHeliusRingsWalletRow: (row: { id: string }) => ({ id: row.id }),
  mapHeliusRingsZoneRow: (row: { id: string }) => ({ id: row.id }),
}));
vi.mock("@/lib/auth", () => ({
  getAuth: () => AUTH,
  requireProjectId: () => "proj_1",
}));
vi.mock("@/lib/response", () => ({ success: mocks.success }));
vi.mock("@/routes/payments/wallets", () => ({
  resolveScope: mocks.resolveScope,
  resolveWallet: vi.fn(),
}));
vi.mock("@/services/api-key-scope.service", () => ({
  assertApiKeyWalletAccess: vi.fn(),
}));
vi.mock("@/services/policy/enforcement.service", () => ({
  walletOperationActorFromAuth: () => ACTOR,
}));
vi.mock("./context", () => ({
  allowedRingsWalletIds: vi.fn(),
  getHeliusRingsOperationRepository: () => ({}),
  getHeliusRingsService: mocks.getHeliusRingsService,
  getHeliusRingsWalletRepository: () => ({
    getWalletById: mocks.getWalletById,
  }),
  getHeliusRingsZoneRepository: () => ({}),
  requireParam: mocks.requireParam,
  requireRingsOperation: mocks.requireRingsOperation,
  requireRingsWallet: mocks.requireRingsWallet,
  withRingsErrors: mocks.withRingsErrors,
}));

const { prepareRingsOperation, retryRingsOperation } = await import("./handlers");

const NOW = "2026-08-25T10:00:00.000Z";
const TENANT = { organizationId: AUTH.organizationId, projectId: AUTH.projectId };
const LIVE_WALLET = {
  id: "hrw_1",
  organization_id: "org_1",
  project_id: "proj_1",
  sdp_wallet_id: "wal_provider_reissued",
  name: "Treasury",
  network: "devnet",
  status: "ready",
  shielded_address: "rings1liveidentity",
  owner_address: "Owner111111111111111111111111111111111111",
  sync_cursor: null,
  last_indexed_slot: null,
  custody_wallet_id: "cw_immutable",
  material_tag: "live",
  created_at: NOW,
  updated_at: NOW,
} satisfies HeliusRingsWalletRow;

const NULL_CUSTODY_WALLETS = [
  {
    name: "pending wallet",
    wallet: {
      ...LIVE_WALLET,
      status: "pending",
      shielded_address: null,
      owner_address: null,
      custody_wallet_id: null,
      material_tag: "simulated",
    },
  },
  {
    name: "simulated ready wallet",
    wallet: {
      ...LIVE_WALLET,
      custody_wallet_id: null,
      material_tag: "simulated",
    },
  },
  {
    name: "paused partially provisioned wallet",
    wallet: {
      ...LIVE_WALLET,
      status: "paused",
      custody_wallet_id: null,
    },
  },
  {
    name: "ready live wallet",
    wallet: {
      ...LIVE_WALLET,
      custody_wallet_id: null,
    },
  },
] satisfies Array<{ name: string; wallet: HeliusRingsWalletRow }>;

const FAILED_OPERATION = {
  id: "hro_failed",
  organization_id: "org_1",
  project_id: "proj_1",
  wallet_id: LIVE_WALLET.id,
  op_type: "shield",
  state: "failed",
  asset_mint: "So11111111111111111111111111111111111111112",
  amount_raw: "1000000",
  from_addr: null,
  to_addr: null,
  zone_id: null,
  transfer_mode: null,
  intent_key: "sha256:failed",
  approval_request_id: null,
  policy_evaluation_id: null,
  proof_source: null,
  proof_ref: null,
  outer_tx_signature: null,
  photon_indexed_at: null,
  failure_code: "gateway_unavailable",
  failure_message: "gateway unavailable",
  retryable: true,
  retry_of_operation_id: null,
  timelock_unlock_at: null,
  input_notes: null,
  signed_transaction: null,
  last_valid_block_height: null,
  submission_started_at: null,
  created_at: NOW,
  updated_at: NOW,
} satisfies HeliusRingsOperationRow;

const PREPARE_INPUT = {
  walletId: LIVE_WALLET.id,
  opType: "shield",
  asset: {
    mint: "So11111111111111111111111111111111111111112",
    amountRaw: "1000000",
  },
  clientNonce: "prepare-custody-row",
} as const;

const UNRESOLVABLE_PROVIDER_SCOPE = {
  auth: AUTH,
  wallets: [
    {
      id: "cw_old",
      custodyConfigId: "cfg_1",
      walletId: "wal_provider_old",
      publicKey: LIVE_WALLET.owner_address,
      label: null,
      purpose: null,
      status: "active",
      createdAt: NOW,
    },
  ],
};

function context(body: unknown) {
  return {
    req: {
      json: async () => body,
    },
  } as never;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getHeliusRingsService.mockReturnValue({
    prepareOperation: mocks.prepareOperation,
    retryOperation: mocks.retryOperation,
  });
  mocks.getWalletById.mockResolvedValue(LIVE_WALLET);
  mocks.prepareOperation.mockResolvedValue({ id: "hro_prepared" });
  mocks.requireParam.mockReturnValue(FAILED_OPERATION.id);
  mocks.requireRingsOperation.mockResolvedValue(FAILED_OPERATION);
  mocks.requireRingsWallet.mockResolvedValue(LIVE_WALLET);
  mocks.resolveScope.mockResolvedValue(UNRESOLVABLE_PROVIDER_SCOPE);
  mocks.retryOperation.mockResolvedValue({ id: "hro_retry" });
});

describe("Rings policy custody row", () => {
  it("prepares with the persisted row id when the provider id is no longer resolvable", async () => {
    await prepareRingsOperation(context(PREPARE_INPUT));

    expect(mocks.prepareOperation).toHaveBeenCalledWith(PREPARE_INPUT, {
      apiKeyId: AUTH.apiKeyId,
      actor: ACTOR,
      custodyWalletId: LIVE_WALLET.custody_wallet_id,
    });
    expect(mocks.resolveScope).not.toHaveBeenCalled();
  });

  it.each(NULL_CUSTODY_WALLETS)(
    "rejects a $name with no custody row before service or policy",
    async ({ wallet }) => {
      mocks.requireRingsWallet.mockResolvedValue(wallet);
      const c = context(PREPARE_INPUT);

      await expect(prepareRingsOperation(c)).rejects.toMatchObject({
        code: "CONFLICT",
      });
      expect(mocks.requireRingsWallet).toHaveBeenCalledWith(c, TENANT, PREPARE_INPUT.walletId, [
        "payments:write",
      ]);
      expect(mocks.getHeliusRingsService).not.toHaveBeenCalled();
      expect(mocks.prepareOperation).not.toHaveBeenCalled();
    }
  );

  it("retries with the persisted row id without resolving the provider id", async () => {
    await retryRingsOperation(context({ clientNonce: "retry-custody-row" }));

    expect(mocks.retryOperation).toHaveBeenCalledWith(FAILED_OPERATION.id, "retry-custody-row", {
      apiKeyId: AUTH.apiKeyId,
      actor: ACTOR,
      custodyWalletId: LIVE_WALLET.custody_wallet_id,
    });
    expect(mocks.resolveScope).not.toHaveBeenCalled();
  });

  it("rejects a retry with no custody row after checking wallet authorization", async () => {
    mocks.getWalletById.mockResolvedValue({
      ...LIVE_WALLET,
      custody_wallet_id: null,
    });
    const c = context({ clientNonce: "retry-no-custody-row" });

    await expect(retryRingsOperation(c)).rejects.toMatchObject({
      code: "CONFLICT",
    });
    expect(mocks.requireRingsOperation).toHaveBeenCalledWith(c, TENANT, FAILED_OPERATION.id, [
      "payments:write",
    ]);
    expect(mocks.getHeliusRingsService).not.toHaveBeenCalled();
    expect(mocks.retryOperation).not.toHaveBeenCalled();
  });
});
