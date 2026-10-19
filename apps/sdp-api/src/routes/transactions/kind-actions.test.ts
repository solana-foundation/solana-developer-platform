import type { Action } from "@sdp/types/actions";
import { wellKnownMint } from "@sdp/types/well-known-tokens";
import { beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { getDb } from "@/db/client";
import { app } from "@/index";
import { env } from "@/test/helpers/env";
import {
  installPaymentsRouteTestHooks,
  TEST_API_KEY,
  TEST_CUSTODY_WALLET_ID,
  TEST_ORG,
  TEST_PROJECT,
  TEST_WALLET_ID,
} from "@/test/helpers/payments-routes";

// `transactions.read` opens the feed; each kind of Payments row also needs the
// read of the module it comes from, so the feed never shows a row the caller
// could not read from that module (HOO-2099).

const listResponseSchema = z.object({
  data: z.object({ transactions: z.array(z.object({ id: z.string(), kind: z.string() })) }),
});
const errorResponseSchema = z.object({
  error: z.object({ code: z.string(), details: z.object({ action: z.string() }) }),
});

const CREATED_AT = "2026-10-01T10:00:00.000Z";

async function seedTransfer(id: string, type: string, provider: string | null = null) {
  await getDb(env)
    .prepare(
      `INSERT INTO payment_transfers
         (id, organization_id, project_id, wallet_id, custody_wallet_id, source_address,
          destination_address, token, amount, type, direction, status, provider, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'source', 'destination', ?, '10', ?, 'outbound', 'confirmed', ?, ?, ?)`
    )
    .bind(
      id,
      TEST_ORG.id,
      TEST_PROJECT.id,
      TEST_WALLET_ID,
      TEST_CUSTODY_WALLET_ID,
      wellKnownMint("USDC", "devnet"),
      type,
      provider,
      CREATED_AT,
      CREATED_AT
    )
    .run();
}

async function grantKey(grants: Action[]): Promise<void> {
  await getDb(env)
    .prepare("UPDATE api_keys SET grants = ? WHERE id = ?")
    .bind(grants, TEST_API_KEY.id)
    .run();
}

function list(query = "") {
  return app.request(
    `/v1/transactions${query}`,
    { headers: { Authorization: `Bearer ${TEST_API_KEY.raw}` } },
    env
  );
}

async function listedKinds(query = ""): Promise<string[]> {
  const response = await list(query);
  expect(response.status).toBe(200);
  const body = listResponseSchema.parse(await response.json());
  return body.data.transactions.map((row) => row.kind).sort();
}

describe("GET /v1/transactions: Payments rows by the read of their module", () => {
  installPaymentsRouteTestHooks();
  beforeEach(async () => {
    await seedTransfer("xfr_kind_pay", "transfer");
    await seedTransfer("xfr_kind_batch", "transfer_batch");
    await seedTransfer("xfr_kind_onramp", "onramp", "moonpay");
    await seedTransfer("xfr_kind_offramp", "offramp", "moonpay");
  });

  it("shows a transactions-only key no Payments row", async () => {
    await grantKey(["transactions.read"]);
    expect(await listedKinds()).toEqual([]);
  });

  it("shows each kind only beside the read of its module", async () => {
    await grantKey(["transactions.read", "transfers.read"]);
    expect(await listedKinds()).toEqual(["pay"]);

    await grantKey(["transactions.read", "transfer_batches.read", "onramp.read"]);
    expect(await listedKinds()).toEqual(["batch_pay", "onramp"]);

    // A module's execute includes its read.
    await grantKey(["transactions.read", "offramp.execute", "transfers.execute"]);
    expect(await listedKinds()).toEqual(["offramp", "pay"]);
  });

  it("refuses a Payments kind filter the key cannot read, naming the read", async () => {
    await grantKey(["transactions.read", "transfers.read"]);
    const response = await list("?module=payments&kind=onramp");
    expect(response.status).toBe(403);
    expect(errorResponseSchema.parse(await response.json()).error).toEqual({
      code: "INSUFFICIENT_PERMISSIONS",
      details: { action: "onramp.read" },
    });
    expect(await listedKinds("?module=payments&kind=pay")).toEqual(["pay"]);
  });
});
