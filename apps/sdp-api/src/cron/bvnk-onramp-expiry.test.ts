import { RAMP_PROVIDER_CLIENTS } from "@sdp/payments/ramps";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getDb } from "@/db";
import type { BackgroundRunner } from "@/runtime/background";
import type { Observability } from "@/runtime/observability";
import { env } from "@/test/helpers/env";
import { seedTestDatabase } from "@/test/mocks/db";
import type { Env } from "@/types/env";
import {
  BVNK_ONRAMP_EXPIRY_CRON,
  BVNK_ONRAMP_EXPIRY_MONITOR,
  reconcileBvnkOnrampExpiry,
  runBvnkOnrampExpiryReconciliation,
} from "./bvnk-onramp-expiry";

const loggerMocks = vi.hoisted(() => ({
  trace: vi.fn(),
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  fatal: vi.fn(),
  child: vi.fn(),
}));

vi.mock("@/runtime/logger", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/runtime/logger")>()),
  getLogger: () => loggerMocks,
}));

const ORG_ID = "org_bvnk_onramp_expiry";

async function seedOrg(): Promise<void> {
  await getDb(env)
    .prepare("INSERT INTO organizations (id, name, slug, tier, status) VALUES (?, ?, ?, ?, ?)")
    .bind(ORG_ID, "BVNK Expiry Org", "bvnk-expiry-org", "enterprise", "active")
    .run();
}

async function insertTransfer(input: {
  id: string;
  provider: string;
  type: string;
  direction: string;
  status: string;
  providerData: Record<string, unknown>;
  createdAt: string;
  projectId?: string | null;
  counterpartyId?: string | null;
}): Promise<void> {
  await getDb(env)
    .prepare(
      `INSERT INTO payment_transfers (
         id, organization_id, project_id, wallet_id, counterparty_id, source_address,
         destination_address, token, amount, memo, type, direction, status, provider,
         provider_reference, delivery_mode, fiat_currency, fiat_amount, provider_data,
         signature, serialized_tx, initiated_by_key_id, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, NULL, ?, ?, NULL, NULL, ?, ?, ?, ?, NULL, NULL, 'USD', NULL, ?::jsonb, NULL, NULL, NULL, ?, ?)`
    )
    .bind(
      input.id,
      ORG_ID,
      input.projectId ?? null,
      "wallet_bvnk_expiry",
      input.counterpartyId ?? null,
      input.direction === "onramp" ? "dest" : null,
      "USDC",
      input.type,
      input.direction,
      input.status,
      input.provider,
      JSON.stringify(input.providerData),
      input.createdAt,
      input.createdAt
    )
    .run();
}

function bvnkOnrampProviderData(ruleId: string, ruleStatus: string): Record<string, unknown> {
  return {
    bvnk: { fundingWalletAccountId: "counterparty_provider_account_funding", ruleId, ruleStatus },
  };
}

const OLD = "2026-01-01T00:00:00.000Z";

describe("reconcileBvnkOnrampExpiry", () => {
  let deactivateRule: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    vi.clearAllMocks();
    await seedTestDatabase(env);
    await seedOrg();
    deactivateRule = vi
      .spyOn(RAMP_PROVIDER_CLIENTS.bvnk, "deactivateOnrampRule")
      .mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  async function readTransfer(
    id: string
  ): Promise<{ status: string; provider_data: { bvnk?: Record<string, unknown> } } | null> {
    return getDb(env)
      .prepare("SELECT status, provider_data FROM payment_transfers WHERE id = ?")
      .bind(id)
      .first<{ status: string; provider_data: { bvnk?: Record<string, unknown> } }>();
  }

  it("expires awaiting_payment rows older than the TTL and deactivates their rules, skipping DEACTIVATED ones", async () => {
    await insertTransfer({
      id: "xfr_expire_deactivate",
      provider: "bvnk",
      type: "onramp",
      direction: "inbound",
      status: "awaiting_payment",
      providerData: bvnkOnrampProviderData("rule_expire_1", "ACTIVE"),
      createdAt: OLD,
    });
    await insertTransfer({
      id: "xfr_expire_deactivation_fails",
      provider: "bvnk",
      type: "onramp",
      direction: "inbound",
      status: "awaiting_payment",
      providerData: bvnkOnrampProviderData("rule_expire_2", "ACTIVE"),
      createdAt: OLD,
    });
    await insertTransfer({
      id: "xfr_expire_already_deactivated",
      provider: "bvnk",
      type: "onramp",
      direction: "inbound",
      status: "awaiting_payment",
      providerData: bvnkOnrampProviderData("rule_expire_3", "DEACTIVATED"),
      createdAt: OLD,
    });
    await insertTransfer({
      id: "xfr_fresh_quote",
      provider: "bvnk",
      type: "onramp",
      direction: "inbound",
      status: "awaiting_payment",
      providerData: bvnkOnrampProviderData("rule_fresh_1", "ACTIVE"),
      createdAt: new Date().toISOString(),
    });
    await insertTransfer({
      id: "xfr_foreign_provider",
      provider: "moonpay",
      type: "onramp",
      direction: "inbound",
      status: "awaiting_payment",
      providerData: {},
      createdAt: OLD,
    });

    await reconcileBvnkOnrampExpiry(env);

    // The CAS only ages awaiting_payment BVNK on-ramp rows past the 24h TTL.
    expect((await readTransfer("xfr_expire_deactivate"))?.status).toBe("expired");
    expect((await readTransfer("xfr_expire_deactivation_fails"))?.status).toBe("expired");
    expect((await readTransfer("xfr_expire_already_deactivated"))?.status).toBe("expired");
    expect((await readTransfer("xfr_fresh_quote"))?.status).toBe("awaiting_payment");
    expect((await readTransfer("xfr_foreign_provider"))?.status).toBe("awaiting_payment");

    // Rules are deactivated per expired transfer unless already DEACTIVATED.
    expect(deactivateRule).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ ruleId: "rule_expire_1" })
    );
    expect(deactivateRule).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ ruleId: "rule_expire_2" })
    );
    expect(deactivateRule).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ ruleId: "rule_expire_3" })
    );
    const deactivated = (await readTransfer("xfr_expire_deactivate"))?.provider_data.bvnk;
    expect(deactivated?.ruleStatus).toBe("DEACTIVATED");
  });

  it("logs a deactivation failure and keeps the row eligible for the next tick", async () => {
    await insertTransfer({
      id: "xfr_expire_retry",
      provider: "bvnk",
      type: "onramp",
      direction: "inbound",
      status: "awaiting_payment",
      providerData: bvnkOnrampProviderData("rule_retry_1", "ACTIVE"),
      createdAt: OLD,
    });
    deactivateRule.mockRejectedValue(new Error("bvnk unreachable"));

    await reconcileBvnkOnrampExpiry(env);
    await reconcileBvnkOnrampExpiry(env);

    // The failure is logged under sdp_api_bvnk_rule_deactivate_failed...
    const serialized = loggerMocks.warn.mock.calls.map((call) => JSON.stringify(call)).join("\n");
    expect(serialized).toContain("sdp_api_bvnk_rule_deactivate_failed");

    // ...and the transfer stays expired with its rule status unchanged, so the
    // ruleStatus <> DEACTIVATED filter keeps it on the next tick's work list.
    const transfer = await readTransfer("xfr_expire_retry");
    expect(transfer?.status).toBe("expired");
    expect(transfer?.provider_data.bvnk?.ruleStatus).toBe("ACTIVE");
    // Two ticks, two attempts: the second tick retried the same rule.
    expect(deactivateRule).toHaveBeenCalledTimes(2);
    expect(deactivateRule).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ ruleId: "rule_retry_1" })
    );
  });

  it("adopts the rule a crash left at BVNK on a ruleless expired transfer, then deactivates it", async () => {
    const listRules = vi
      .spyOn(RAMP_PROVIDER_CLIENTS.bvnk, "listOnrampRulesByWallet")
      .mockResolvedValue([
        { id: "rule_leftover_1", reference: "sdp_onramp_xfr_expire_ruleless", status: "ACTIVE" },
      ]);
    const PROJECT_ID = "prj_bvnk_expiry_recovery";
    const COUNTERPARTY_ID = "cpty_bvnk_expiry_recovery";
    await getDb(env)
      .prepare(
        `INSERT INTO counterparty_provider_accounts (
           id, organization_id, project_id, counterparty_id, provider,
           provider_customer_reference, kind, external_account_reference, fiat_currency,
           provider_status, status, metadata
         ) VALUES (?, ?, ?, ?, 'bvnk', '', 'virtual_funding_wallet', ?, 'USD', 'ACTIVE', 'active', '{}')`
      )
      .bind(
        "counterparty_provider_account_funding",
        ORG_ID,
        PROJECT_ID,
        COUNTERPARTY_ID,
        "wallet_bvnk_expiry_external"
      )
      .run();
    await insertTransfer({
      id: "xfr_expire_ruleless",
      provider: "bvnk",
      type: "onramp",
      direction: "inbound",
      status: "awaiting_payment",
      providerData: {
        bvnk: { fundingWalletAccountId: "counterparty_provider_account_funding" },
      },
      createdAt: OLD,
      projectId: PROJECT_ID,
      counterpartyId: COUNTERPARTY_ID,
    });

    await reconcileBvnkOnrampExpiry(env);

    expect(listRules).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ walletId: "wallet_bvnk_expiry_external" })
    );
    expect(deactivateRule).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ ruleId: "rule_leftover_1" })
    );
    const transfer = await readTransfer("xfr_expire_ruleless");
    expect(transfer?.status).toBe("expired");
    expect(transfer?.provider_data.bvnk?.ruleStatus).toBe("DEACTIVATED");
  });
});

describe("runBvnkOnrampExpiryReconciliation", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    await seedTestDatabase(env);
  });

  it("runs the expiry through its fifteen-minute monitor and background tracker", async () => {
    const fakeEnv = env as Env;
    const bg = { run: vi.fn(), awaitAll: vi.fn(), draining: false } satisfies BackgroundRunner;
    const observability = {
      captureException: vi.fn(),
      withScope: vi.fn(),
      withMonitor: vi.fn((_slug, work) => work()),
    } satisfies Observability;

    expect(BVNK_ONRAMP_EXPIRY_CRON).toBe("*/15 * * * *");
    runBvnkOnrampExpiryReconciliation({ env: fakeEnv, bg, observability });

    expect(observability.withMonitor).toHaveBeenCalledExactlyOnceWith(
      BVNK_ONRAMP_EXPIRY_MONITOR,
      expect.any(Function),
      { schedule: { type: "crontab", value: BVNK_ONRAMP_EXPIRY_CRON } }
    );
    expect(bg.run).toHaveBeenCalledOnce();
    await vi.mocked(bg.run).mock.calls[0][0];
  });
});
