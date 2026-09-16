import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "pg";
import { expect, it } from "vitest";
import { adminDatabaseUrl } from "@/test/helpers/env";

it("archives v2 pre-customer BVNK link rows and drops legacy agreement metadata", async () => {
  const migrationPath = path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    "postgres/0111_bvnk_customer_link_sessions.sql"
  );
  const sql = readFileSync(migrationPath, "utf8");
  const client = new Client({ connectionString: adminDatabaseUrl });
  await client.connect();

  try {
    await client.query("BEGIN");
    await client.query(`CREATE TEMP TABLE counterparty_provider_accounts (
      id TEXT PRIMARY KEY,
      provider TEXT NOT NULL,
      kind TEXT NOT NULL,
      status TEXT NOT NULL,
      metadata JSONB NOT NULL DEFAULT '{}'::jsonb
    )`);
    await client.query(`INSERT INTO counterparty_provider_accounts (id, provider, kind, status, metadata) VALUES
      ('cpa_v2_pre_customer', 'bvnk', 'customer_link', 'active',
       '{"residenceCountryCode":"US","agreements":{"entries":{"agr_1":{"status":"PENDING","name":"EPC Partner Platform Agreement (US)","description":"Terms"}}}}'::jsonb),
      ('cpa_v2_post_customer', 'bvnk', 'customer_link', 'active',
       '{"status":"PENDING","residenceCountryCode":"US","agreements":{"entries":{"agr_1":{"status":"ACCEPTED","name":"EPC Partner Platform Agreement (US)","description":"Terms"}}}}'::jsonb),
      ('cpa_v1_pre_customer', 'bvnk', 'customer_link', 'active',
       '{"residenceCountryCode":"US","session":{"reference":"c1d91c8b-f4a6-469e-953d-7344fdb6858c","agreements":[{"name":"EMBEDDED_PARTNER_PLATFORM_CUSTOMERS_US","displayName":"Embedded US Partner Platform Customers Agreement","description":"Embedded US Partner Platform Customers Agreement","url":"https://help.bvnk.com/hc/en-us/sections/27816998470930-BVNK-US-Partner-Platform-Customers","privacyPolicyUrl":"https://help.bvnk.com/hc/en-us/articles/7662076884882-Privacy-Policy"}]}}'::jsonb),
      ('cpa_other_provider', 'lightspark', 'customer_link', 'active',
       '{"residenceCountryCode":"US","agreements":{"entries":{}}}'::jsonb)`);

    await client.query(sql);

    const { rows } = await client.query<{
      id: string;
      status: string;
      metadata: Record<string, unknown>;
    }>("SELECT id, status, metadata FROM counterparty_provider_accounts ORDER BY id");
    const rowById = new Map(rows.map((row) => [row.id, row]));

    expect(rowById.get("cpa_v2_pre_customer")?.status).toBe("archived");
    expect(rowById.get("cpa_v2_pre_customer")?.metadata).toEqual({
      residenceCountryCode: "US",
    });

    expect(rowById.get("cpa_v2_post_customer")?.status).toBe("active");
    expect(rowById.get("cpa_v2_post_customer")?.metadata).toEqual({
      status: "PENDING",
      residenceCountryCode: "US",
    });

    expect(rowById.get("cpa_v1_pre_customer")?.status).toBe("active");
    const v1Metadata = rowById.get("cpa_v1_pre_customer")?.metadata as {
      session?: { reference: string };
    };
    expect(v1Metadata.session?.reference).toBe("c1d91c8b-f4a6-469e-953d-7344fdb6858c");

    expect(rowById.get("cpa_other_provider")?.status).toBe("active");
    expect(rowById.get("cpa_other_provider")?.metadata).toEqual({
      residenceCountryCode: "US",
      agreements: { entries: {} },
    });
  } finally {
    await client.query("ROLLBACK");
    await client.end();
  }
});
