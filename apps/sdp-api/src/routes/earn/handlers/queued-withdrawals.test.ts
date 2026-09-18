import { beforeEach, describe, expect, it, vi } from "vitest";
import { AuditService } from "@/services/audit.service";
import { env } from "@/test/helpers/env";
import {
  builtTransactionWire,
  readOptions,
  recordQueuedWithdrawalActionAudit,
} from "./queued-withdrawals";

const capabilities = vi.hoisted(() => ({
  instant: null as Record<string, unknown> | null,
  queued: null as Record<string, unknown> | null,
}));

vi.mock("@/services/earn/execution-registry", () => ({
  resolveVaultWithdrawClient: () => capabilities.instant,
  resolveVaultQueuedWithdrawClient: () => capabilities.queued,
}));

const position = {
  id: "earn_position_test",
  provider: "veda",
  vaultAddress: "8VfVedaQueueVault111111111111111111111111111",
  tokenMint: "9VfVedaQueueToken111111111111111111111111111",
  shareMint: "AVfVedaQueueShare111111111111111111111111111",
  ownerAddress: "7YfVedaQueueOwner111111111111111111111111111",
};

function withdrawalClient(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    buildVaultDeposit: vi.fn(),
    readVaultPositions: vi.fn(),
    sponsoredPrograms: vi.fn(),
    buildVaultWithdrawal: vi.fn(),
    ...overrides,
  };
}

describe("queued withdrawal handler contracts", () => {
  beforeEach(() => {
    capabilities.instant = null;
    capabilities.queued = null;
  });

  it("keeps instant-only providers available and leaves queue-only fields null", async () => {
    capabilities.instant = withdrawalClient();
    await expect(readOptions({ env } as never, "sandbox", position)).resolves.toEqual({
      instant: true,
      providerOrder: false,
      queued: false,
      withdrawAuthority: null,
      queueState: null,
      queueAsset: null,
    });
  });

  it("advertises a provider-managed redemption order without calling it instant", async () => {
    capabilities.instant = withdrawalClient({ vaultWithdrawalSettlement: "provider_order" });
    await expect(readOptions({ env } as never, "production", position)).resolves.toEqual({
      instant: false,
      providerOrder: true,
      queued: false,
      withdrawAuthority: null,
      queueState: null,
      queueAsset: null,
    });
  });

  it("intersects static instant capability with live provider availability", async () => {
    capabilities.instant = withdrawalClient();
    capabilities.queued = {
      getWithdrawalOptions: vi.fn().mockResolvedValue({
        instant: false,
        providerOrder: false,
        queued: false,
        withdrawAuthority: position.ownerAddress,
        queueState: null,
        queueAsset: null,
      }),
    };
    await expect(readOptions({ env } as never, "sandbox", position)).resolves.toMatchObject({
      instant: false,
      providerOrder: false,
      queued: false,
    });
  });

  it("emits the established unsigned external transaction envelope", () => {
    const wire = builtTransactionWire({
      id: "earn_external_wallet_withdrawal_request_transaction_test",
      environment: "sandbox",
      provider: "veda",
      position_id: position.id,
      withdrawal_request_id: null,
      action: "request",
      owner_address: position.ownerAddress,
      vault_address: position.vaultAddress,
      token_mint: position.tokenMint,
      share_mint: position.shareMint,
      request_address: "QueueRequestAddress11111111111111111111",
      shares: "10",
      quoted_assets: "9.8",
      share_decimals: 6,
      asset_decimals: 6,
      discount_bps: 25,
      maturity_timestamp: "1700000060",
      deadline_timestamp: "1700000120",
      fee_payer: null,
      unsigned_transaction: "AQ==",
      last_valid_block_height: "12345",
    });
    expect(wire).toMatchObject({
      transaction: "AQ==",
      sponsored: false,
      providerReference: position.vaultAddress,
      tokenMint: position.tokenMint,
      shareMint: position.shareMint,
      assets: "9.8",
    });
    expect(wire).not.toHaveProperty("unsignedTransaction");
    expect(wire).not.toHaveProperty("feePayer");
  });

  it("records queued share escrow as a distinct audit action, not a completed payout", async () => {
    const log = vi.spyOn(AuditService.prototype, "log").mockResolvedValue(undefined);
    await recordQueuedWithdrawalActionAudit({ env } as never, {
      replayed: true,
      request: {
        id: "earn_vault_withdrawal_request_test",
        organization_id: "org_test",
        position_id: position.id,
        provider: "veda",
        custody_wallet_id: null,
        owner_address: position.ownerAddress,
        request_address: "QueueRequestAddress11111111111111111111",
        shares: "10",
      } as never,
      action: {
        id: "earn_vault_withdrawal_action_test",
        action: "request",
        status: "submitted",
        signature: "request-signature",
        created_by: null,
        initiated_by_key_id: "key_test",
      } as never,
    });
    expect(log).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "withdraw_request",
        resourceType: "earn_vault_withdrawal_request",
        resourceId: "earn_vault_withdrawal_action_test",
        metadata: expect.objectContaining({
          withdrawalRequestId: "earn_vault_withdrawal_request_test",
          signature: "request-signature",
          replayed: true,
          backfilledOnReplay: true,
        }),
      })
    );
  });
});
