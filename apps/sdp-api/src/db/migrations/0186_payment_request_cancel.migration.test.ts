import { SOL_MINT } from "@sdp/types/well-known-tokens";
import { Client } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { TEST_CUSTODY_PUBLIC_KEY } from "@/test/fixtures/custody";
import { env } from "@/test/helpers/env";
import { CHECK_VIOLATION, seedOrgProject } from "@/test/helpers/migration-db";

const CANCELER_CHECK = "payment_requests_canceled_by_principal_check";
const CANCELED_AT = "2026-10-28T00:00:00.000Z";

type Cancellation = [
  canceledAt: string | null,
  canceledByApiKeyId: string | null,
  canceledByUserId: string | null,
];

let client: Client;
let tenant: Awaited<ReturnType<typeof seedOrgProject>>;

function insertCancel(id: string, cancellation: Cancellation) {
  return client.query(
    `INSERT INTO payment_requests (
       id, organization_id, project_id, wallet_id, destination_address, token, amount,
       reference, public_token, status, canceled_at, canceled_by_api_key_id, canceled_by_user_id
     ) VALUES ($1, $2, $3, 'wlt_0186', $4, $5, '10', $1, $1, 'canceled', $6, $7, $8)`,
    [
      id,
      tenant.organizationId,
      tenant.projectId,
      TEST_CUSTODY_PUBLIC_KEY,
      SOL_MINT,
      ...cancellation,
    ]
  );
}

beforeAll(async () => {
  client = new Client({ connectionString: env.DATABASE_URL });
  await client.connect();
});

afterAll(async () => {
  await client.end();
});

beforeEach(async () => {
  await client.query("BEGIN");
  tenant = await seedOrgProject(client, "0186");
});

afterEach(async () => {
  await client.query("ROLLBACK");
});

describe("0186 payment request cancel", () => {
  it.each<[string, Cancellation]>([
    ["both an API key and a member", [CANCELED_AT, "key_0186", "user_0186"]],
    ["no canceler", [CANCELED_AT, null, null]],
    ["a canceler but no canceled_at", [null, "key_0186", null]],
  ])("refuses a cancel naming %s", async (_case, cancellation) => {
    await expect(insertCancel("pr_0186_refused", cancellation)).rejects.toMatchObject({
      code: CHECK_VIOLATION,
      constraint: CANCELER_CHECK,
    });
  });
});
