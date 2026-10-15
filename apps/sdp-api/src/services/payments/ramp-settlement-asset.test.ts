import { wellKnownMint } from "@sdp/types";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getDb } from "@/db";
import * as events from "@/runtime/money-path-events";
import { env } from "@/test/helpers/env";
import { seedDefaultProjects } from "@/test/helpers/projects";
import { seedTestDatabase } from "@/test/mocks/db";
import { applyRampSettlementEvent } from "./ramp-settlements";

const ORG_ID = "org_ramp_settlement_asset_test";
const PROJECT_ID = "prj_ramp_settlement_asset_test";
const USER_ID = "usr_ramp_settlement_asset_test";
function devnetUsdcMint(): string {
  const mint = wellKnownMint("USDC", "devnet");
  if (mint === undefined) {
    throw new Error("USDC has no devnet mint in the catalogue");
  }
  return mint;
}

async function seedStripeOnramp(id: string, reference: string) {
  await getDb(env)
    .prepare(
      `INSERT INTO payment_transfers (
         id, organization_id, project_id, wallet_id, destination_address, token, amount,
         type, direction, status, provider, provider_reference, delivery_mode, fiat_currency,
         fiat_amount, provider_data, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, 'onramp', 'inbound', 'settling', 'stripe', ?,
                 'session_widget', 'USD', '100', '{}'::jsonb, ?, ?)`
    )
    .bind(
      id,
      ORG_ID,
      PROJECT_ID,
      "wallet_ramp_settlement_asset_test",
      "destination",
      devnetUsdcMint(),
      null,
      reference,
      "2026-10-13T00:00:00.000Z",
      "2026-10-13T00:00:00.000Z"
    )
    .run();
}

async function readRow(id: string) {
  return getDb(env)
    .prepare("SELECT status, amount FROM payment_transfers WHERE id = ?")
    .bind(id)
    .first<{ status: string; amount: string | null }>();
}

describe("applyRampSettlementEvent delivered asset", () => {
  beforeEach(async () => {
    await seedTestDatabase(env);
    await getDb(env).batch([
      getDb(env)
        .prepare("INSERT INTO organizations (id, name, slug, tier, status) VALUES (?, ?, ?, ?, ?)")
        .bind(ORG_ID, "Ramp Settlement Asset", "ramp-settlement-asset", "enterprise", "active"),
      getDb(env)
        .prepare("INSERT INTO users (id, email, email_verified, status) VALUES (?, ?, ?, ?)")
        .bind(USER_ID, "ramp-settlement-asset@example.com", 1, "active"),
    ]);
    await seedDefaultProjects(getDb(env), {
      organizationId: ORG_ID,
      createdBy: USER_ID,
      members: [],
      ids: { sandbox: PROJECT_ID, production: `${PROJECT_ID}_production` },
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("completes a transfer when the provider delivered its asset", async () => {
    await seedStripeOnramp("xfr_asset_match", "cos_asset_match");

    const result = await applyRampSettlementEvent(env, {
      provider: "stripe",
      kind: "settled",
      reference: "cos_asset_match",
      receivedAmount: "96.5",
      deliveredAssetRail: "usdc.solana",
    });

    expect(result).toEqual({ applied: true });
    expect(await readRow("xfr_asset_match")).toEqual({ status: "completed", amount: "96.5" });
  });

  it("refuses another asset's delivery and records nothing", async () => {
    const logEvent = vi.spyOn(events, "logEvent").mockImplementation(() => {});
    await seedStripeOnramp("xfr_asset_mismatch", "cos_asset_mismatch");

    const result = await applyRampSettlementEvent(env, {
      provider: "stripe",
      kind: "settled",
      reference: "cos_asset_mismatch",
      receivedAmount: "0.42",
      deliveredAssetRail: "sol.solana",
    });

    expect(result).toEqual({ applied: false });
    expect(await readRow("xfr_asset_mismatch")).toEqual({ status: "settling", amount: null });
    expect(logEvent).toHaveBeenCalledWith(
      "error",
      expect.objectContaining({
        event: "sdp_api_ramp_settlement_asset_mismatch",
        transfer_id: "xfr_asset_mismatch",
        delivered_asset_rail: "sol.solana",
      })
    );
  });

  it("refuses a delivery the provider names no SDP asset for", async () => {
    vi.spyOn(events, "logEvent").mockImplementation(() => {});
    await seedStripeOnramp("xfr_asset_unknown", "cos_asset_unknown");

    const result = await applyRampSettlementEvent(env, {
      provider: "stripe",
      kind: "settled",
      reference: "cos_asset_unknown",
      receivedAmount: "1",
      deliveredAssetRail: null,
    });

    expect(result).toEqual({ applied: false });
    expect(await readRow("xfr_asset_unknown")).toEqual({ status: "settling", amount: null });
  });
});
