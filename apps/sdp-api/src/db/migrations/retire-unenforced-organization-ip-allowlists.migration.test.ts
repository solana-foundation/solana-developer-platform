import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "pg";
import { expect, it } from "vitest";
import { env } from "@/test/helpers/env";

/**
 * Never-validated pre-enforcement allowlists must not start deciding access on
 * deploy — a bad one denies the whole organization. Moved aside, not deleted.
 */
it("retires pre-enforcement allowlists without losing them", async () => {
  const migrationPath = path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    "postgres/0055_retire_unenforced_organization_ip_allowlists.sql"
  );
  const sql = readFileSync(migrationPath, "utf8");
  const client = new Client({ connectionString: env.DATABASE_URL });
  await client.connect();

  try {
    await client.query("BEGIN");
    await client.query(`CREATE TEMP TABLE organizations (
      id TEXT PRIMARY KEY,
      settings TEXT,
      updated_at TEXT
    )`);
    await client.query(
      `INSERT INTO organizations (id, settings) VALUES
         ('org_valid', $1),
         ('org_invalid_entry', $2),
         ('org_not_an_array', $3),
         ('org_other_settings', $4),
         ('org_unparseable', $5),
         ('org_no_settings', NULL)`,
      [
        JSON.stringify({ allowedIpAddresses: ["203.0.113.0/24"], defaultEnvironment: "sandbox" }),
        JSON.stringify({ allowedIpAddresses: ["office wifi"] }),
        JSON.stringify({ allowedIpAddresses: "203.0.113.0/24" }),
        JSON.stringify({ defaultEnvironment: "production" }),
        "{not json",
      ]
    );

    await client.query(sql);

    const { rows } = await client.query<{ id: string; settings: string | null }>(
      "SELECT id, settings FROM organizations ORDER BY id"
    );
    const settingsById = new Map(rows.map((row) => [row.id, row.settings]));
    const parse = (id: string) => JSON.parse(settingsById.get(id) ?? "null");

    // Moved aside, and the rest of the settings survive alongside it.
    expect(parse("org_valid")).toEqual({
      legacyAllowedIpAddresses: ["203.0.113.0/24"],
      defaultEnvironment: "sandbox",
    });

    // Whatever the shape, it moves — the unparseable entry is the one that would deny everything.
    expect(parse("org_invalid_entry")).toEqual({ legacyAllowedIpAddresses: ["office wifi"] });
    expect(parse("org_not_an_array")).toEqual({ legacyAllowedIpAddresses: "203.0.113.0/24" });

    // Untouched: no allowlist to retire.
    expect(parse("org_other_settings")).toEqual({ defaultEnvironment: "production" });
    expect(settingsById.get("org_no_settings")).toBeNull();

    // Nothing readable to move; enforcement reads such a blob as unrestricted.
    expect(settingsById.get("org_unparseable")).toBe("{not json");
  } finally {
    await client.query("ROLLBACK");
    await client.end();
  }
});

it("is safe to run twice", async () => {
  const migrationPath = path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    "postgres/0055_retire_unenforced_organization_ip_allowlists.sql"
  );
  const sql = readFileSync(migrationPath, "utf8");
  const client = new Client({ connectionString: env.DATABASE_URL });
  await client.connect();

  try {
    await client.query("BEGIN");
    await client.query(`CREATE TEMP TABLE organizations (
      id TEXT PRIMARY KEY,
      settings TEXT,
      updated_at TEXT
    )`);
    await client.query(`INSERT INTO organizations (id, settings) VALUES ('org_valid', $1)`, [
      JSON.stringify({ allowedIpAddresses: ["203.0.113.0/24"] }),
    ]);

    await client.query(sql);
    await client.query(sql);

    const { rows } = await client.query<{ settings: string }>(
      "SELECT settings FROM organizations WHERE id = 'org_valid'"
    );
    expect(JSON.parse(rows[0]?.settings ?? "null")).toEqual({
      legacyAllowedIpAddresses: ["203.0.113.0/24"],
    });
  } finally {
    await client.query("ROLLBACK");
    await client.end();
  }
});
