import { type SdpReleaseChannel, wellKnownMint } from "@sdp/types";
import { beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { getDb } from "@/db";
import app from "@/index";
import { env } from "@/test/helpers/env";
import {
  installPaymentsRouteTestHooks,
  TEST_API_KEY,
  TEST_CUSTODY_WALLET_ID,
  TEST_ORG,
  TEST_PROJECT,
  TEST_USER,
  TEST_WALLET_ID,
} from "@/test/helpers/payments-routes";

// `/v1/transactions` belongs to Payments, so it is served in every release channel,
// but it must not list rows of a module the release channel leaves out (ADR 0005).
// Issuance and every ramp provider are `experimental` today: listed on `experimental`,
// hidden on `stable`. Ramp transfers are Payments rows, filtered by their stored provider.

const listResponseSchema = z.object({
  data: z.object({ transactions: z.array(z.object({ id: z.string(), module: z.string() })) }),
});
const errorResponseSchema = z.object({
  error: z.object({ code: z.string(), message: z.string() }),
});

async function listTransactionsOn(releaseChannel: SdpReleaseChannel, query = "") {
  return app.request(
    `/v1/transactions${query}`,
    { headers: { Authorization: `Bearer ${TEST_API_KEY.raw}` } },
    { ...env, SDP_RELEASE_CHANNEL: releaseChannel }
  );
}

async function listedIds(releaseChannel: SdpReleaseChannel, query = ""): Promise<string[]> {
  const response = await listTransactionsOn(releaseChannel, query);
  expect(response.status).toBe(200);
  const body = listResponseSchema.parse(await response.json());
  return body.data.transactions.map((row) => row.id).sort();
}

async function seedPaymentAndIssuanceRows(): Promise<void> {
  const createdAt = "2026-10-01T10:00:00.000Z";
  await getDb(env)
    .prepare(
      `INSERT INTO payment_transfers
         (id, organization_id, project_id, wallet_id, custody_wallet_id, source_address,
          destination_address, token, amount, type, direction, status, created_at, updated_at)
       VALUES ('xfr_channel_listed', ?, ?, ?, ?, 'source', 'destination', ?, '10', 'transfer',
               'outbound', 'confirmed', ?, ?)`
    )
    .bind(
      TEST_ORG.id,
      TEST_PROJECT.id,
      TEST_WALLET_ID,
      TEST_CUSTODY_WALLET_ID,
      wellKnownMint("USDC", "devnet"),
      createdAt,
      createdAt
    )
    .run();
  await getDb(env)
    .prepare(
      `INSERT INTO issued_tokens
         (id, project_id, organization_id, mint_address, name, symbol, decimals, created_by)
       VALUES ('tok_channel', ?, ?, 'ChannelMint111', 'Channel', 'CHN', 6, ?)`
    )
    .bind(TEST_PROJECT.id, TEST_ORG.id, TEST_USER.id)
    .run();
  await getDb(env)
    .prepare(
      `INSERT INTO issuance_transactions
         (id, token_id, organization_id, type, status, operation_params, created_at, updated_at)
       VALUES ('itx_channel', 'tok_channel', ?, 'mint', 'confirmed', '{}', ?, ?)`
    )
    .bind(TEST_ORG.id, createdAt, createdAt)
    .run();
  await getDb(env)
    .prepare(
      `INSERT INTO payment_transfers
         (id, organization_id, project_id, wallet_id, custody_wallet_id, token, amount, type,
          direction, status, provider, created_at, updated_at)
       VALUES ('xfr_channel_onramp', ?, ?, ?, ?, ?, '10', 'onramp', 'inbound', 'pending',
               'moonpay', ?, ?)`
    )
    .bind(
      TEST_ORG.id,
      TEST_PROJECT.id,
      TEST_WALLET_ID,
      TEST_CUSTODY_WALLET_ID,
      wellKnownMint("USDC", "devnet"),
      createdAt,
      createdAt
    )
    .run();
}

describe("GET /v1/transactions release channel", () => {
  installPaymentsRouteTestHooks();
  beforeEach(seedPaymentAndIssuanceRows);

  it("experimental: lists rows of every module", async () => {
    expect(await listedIds("experimental")).toEqual([
      "itx_channel",
      "xfr_channel_listed",
      "xfr_channel_onramp",
    ]);
  });

  it("stable: leaves out rows of modules outside the release channel", async () => {
    expect(await listedIds("stable")).toEqual(["xfr_channel_listed"]);
  });

  it("stable: refuses a module filter outside the release channel", async () => {
    const response = await listTransactionsOn("stable", "?module=issuance");
    expect(response.status).toBe(403);
    expect(errorResponseSchema.parse(await response.json()).error).toEqual({
      code: "FORBIDDEN",
      message: "The issuance module is not available in this release channel.",
    });
  });

  it("stable: serves Payments, without ramp rows of providers outside the release channel", async () => {
    expect(await listedIds("stable", "?module=payments")).toEqual(["xfr_channel_listed"]);
  });

  it("experimental: still serves the Issuance filter", async () => {
    expect(await listedIds("experimental", "?module=issuance")).toEqual(["itx_channel"]);
  });
});
