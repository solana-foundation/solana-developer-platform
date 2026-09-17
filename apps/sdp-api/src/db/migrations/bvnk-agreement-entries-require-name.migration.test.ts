import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "pg";
import { expect, it } from "vitest";
import { adminDatabaseUrl } from "@/test/helpers/env";

it("removes legacy BVNK agreement entries lacking name/description and archives pre-customer working sets", async () => {
  const migrationPath = path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    "postgres/0110_bvnk_agreement_entries_require_name.sql"
  );
  const sql = readFileSync(migrationPath, "utf8");
  const client = new Client({ connectionString: adminDatabaseUrl });
  await client.connect();

  try {
    await client.query("BEGIN");
    await client.query(`CREATE TEMP TABLE counterparty_provider_accounts (
      id TEXT PRIMARY KEY,
      provider TEXT NOT NULL,
      status TEXT NOT NULL,
      metadata JSONB NOT NULL DEFAULT '{}'::jsonb
    )`);
    await client.query(`INSERT INTO counterparty_provider_accounts (id, provider, status, metadata) VALUES
      ('cpa_post_customer', 'bvnk', 'active',
       '{"status":"completed","agreements":{"entries":{"agr_1":{"status":"ACCEPTED"}}}}'::jsonb),
      ('cpa_pre_customer', 'bvnk', 'active',
       '{"agreements":{"entries":{"agr_1":{"status":"PENDING"}}}}'::jsonb),
      ('cpa_conforming', 'bvnk', 'active',
       '{"agreements":{"entries":{"agr_1":{"status":"PENDING","name":"Platform Agreement","description":"BVNK platform terms"}}}}'::jsonb)`);

    await client.query(sql);

    const { rows } = await client.query<{
      id: string;
      status: string;
      metadata: Record<string, unknown>;
    }>("SELECT id, status, metadata FROM counterparty_provider_accounts ORDER BY id");
    const rowById = new Map(rows.map((row) => [row.id, row]));

    expect(rowById.get("cpa_post_customer")?.status).toBe("active");
    expect(rowById.get("cpa_post_customer")?.metadata).toEqual({ status: "completed" });

    expect(rowById.get("cpa_pre_customer")?.status).toBe("archived");
    expect(rowById.get("cpa_pre_customer")?.metadata).toEqual({
      agreements: { entries: { agr_1: { status: "PENDING" } } },
    });

    expect(rowById.get("cpa_conforming")?.status).toBe("active");
    expect(rowById.get("cpa_conforming")?.metadata).toEqual({
      agreements: {
        entries: {
          agr_1: {
            status: "PENDING",
            name: "Platform Agreement",
            description: "BVNK platform terms",
          },
        },
      },
    });
  } finally {
    await client.query("ROLLBACK");
    await client.end();
  }
});
