import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it } from "vitest";
import { getDb } from "@/db/client";
import { env } from "@/test/helpers/env";
import { seedTestDatabase } from "@/test/mocks/db";

const migration = readFileSync(
  path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    "postgres/0143_api_key_signing_wallets.sql"
  ),
  "utf8"
);

/** The statements between the backfill markers, as 0143 runs them. */
function backfillStatements(): string[] {
  const body = migration.slice(
    migration.indexOf("-- backfill:start"),
    migration.indexOf("-- backfill:end")
  );
  return body
    .split(";\n")
    .map((statement) =>
      statement
        .split("\n")
        .filter((line) => !line.trimStart().startsWith("--"))
        .join("\n")
        .trim()
    )
    .filter((statement) => statement.length > 0);
}

const ORG = "org_signing_backfill";
const PROJECT = "prj_signing_backfill";
const OTHER_ORG = "org_signing_backfill_other";
const OTHER_PROJECT = "prj_signing_backfill_other";
const USER = "usr_signing_backfill";

/** Each key, its legacy bindings, and the scope and wallets it must come out with. */
const KEYS = [
  // A module-specific binding signed only that module, and the list is not
  // per module, so it does not carry over.
  {
    id: "key_write",
    bindings: [["wal_a", '["payments:write"]']],
    scope: "selected",
    wallets: [],
  },
  { id: "key_star", bindings: [["wal_a", '["*"]']], scope: "selected", wallets: ["cw_a"] },
  // Could not sign before, so it may not now.
  { id: "key_read", bindings: [["wal_a", '["wallets:read"]']], scope: "selected", wallets: [] },
  // The provider id names two custody wallets in the project: neither.
  { id: "key_ambiguous", bindings: [["wal_dup", '["*"]']], scope: "selected", wallets: [] },
  // The provider id names a wallet of another organization's project.
  { id: "key_foreign", bindings: [["wal_foreign", '["*"]']], scope: "selected", wallets: [] },
  {
    id: "key_signing_only",
    signingWalletId: "wal_a",
    bindings: [],
    scope: "selected",
    wallets: [],
  },
  { id: "key_unbound", bindings: [], scope: "all", wallets: [] },
] as const satisfies ReadonlyArray<{
  id: string;
  signingWalletId?: string;
  bindings: ReadonlyArray<readonly [string, string | null]>;
  scope: "all" | "selected";
  wallets: readonly string[];
}>;

describe("0143 wallet scope backfill", () => {
  beforeEach(async () => {
    await seedTestDatabase(env);
    const db = getDb(env);
    for (const [id, slug] of [
      [ORG, "backfill"],
      [OTHER_ORG, "backfill-other"],
    ] as const) {
      await db.execute(
        "INSERT INTO organizations (id, name, slug, tier, status) VALUES (?, ?, ?, 'enterprise', 'active')",
        [id, slug, slug]
      );
    }
    await db.execute(
      "INSERT INTO users (id, email, status) VALUES (?, 'backfill@example.com', 'active')",
      [USER]
    );
    for (const [id, org] of [
      [PROJECT, ORG],
      [OTHER_PROJECT, OTHER_ORG],
    ] as const) {
      await db.execute(
        `INSERT INTO projects (id, organization_id, name, slug, environment, status, created_by)
         VALUES (?, ?, ?, ?, 'sandbox', 'active', ?)`,
        [id, org, id, id, USER]
      );
    }
    for (const [id, project, provider] of [
      ["cfg_a", PROJECT, "privy"],
      // Another provider in the same project: its wallet ids can repeat cfg_a's.
      ["cfg_dup", PROJECT, "turnkey"],
      ["cfg_other", OTHER_PROJECT, "privy"],
    ] as const) {
      await db.execute(
        `INSERT INTO custody_configs
           (id, organization_id, project_id, project_environment, provider, config_encrypted, status)
         VALUES (?, ?, ?, ?, ?, '{}', 'active')`,
        [id, project === PROJECT ? ORG : OTHER_ORG, project, "sandbox", provider]
      );
    }
    for (const [id, config, walletId] of [
      ["cw_a", "cfg_a", "wal_a"],
      ["cw_dup_1", "cfg_a", "wal_dup"],
      ["cw_dup_2", "cfg_dup", "wal_dup"],
      ["cw_foreign", "cfg_other", "wal_foreign"],
    ] as const) {
      await db.execute(
        `INSERT INTO custody_wallets (id, custody_config_id, wallet_id, public_key, status)
         VALUES (?, ?, ?, ?, 'active')`,
        [id, config, walletId, `addr_${id}`]
      );
    }
    for (const key of KEYS) {
      await db.execute(
        `INSERT INTO api_keys
           (id, organization_id, project_id, created_by, name, key_prefix, key_hash,
            grants, status, signing_wallet_id, wallet_scope)
         VALUES (?, ?, ?, ?, ?, 'sk_test', ?, '{}', 'active', ?, 'all')`,
        [
          key.id,
          ORG,
          PROJECT,
          USER,
          key.id,
          `hash_${key.id}`,
          "signingWalletId" in key ? key.signingWalletId : null,
        ]
      );
      for (const [walletId, permissions] of key.bindings) {
        await db.execute(
          `INSERT INTO api_key_wallet_permissions (id, api_key_id, wallet_id, permissions)
           VALUES (?, ?, ?, ?)`,
          [`akw_${key.id}_${walletId}`, key.id, walletId, permissions]
        );
      }
    }
  });

  it("keeps every bound key bound, listing only wallets it could sign with", async () => {
    const db = getDb(env);
    for (const statement of backfillStatements()) {
      await db.execute(statement);
    }

    const rows = await db.queryMany<{ id: string; wallet_scope: string; wallets: string[] }>(
      `SELECT ak.id, ak.wallet_scope,
              ARRAY(SELECT s.custody_wallet_id FROM api_key_signing_wallets s
                     WHERE s.api_key_id = ak.id ORDER BY 1) AS wallets
         FROM api_keys ak
        WHERE ak.organization_id = ?
        ORDER BY ak.id`,
      [ORG]
    );
    expect(
      Object.fromEntries(
        rows.map((row) => [row.id, { scope: row.wallet_scope, wallets: row.wallets }])
      )
    ).toEqual(
      Object.fromEntries(
        KEYS.map((key) => [key.id, { scope: key.scope, wallets: [...key.wallets] }])
      )
    );
  });
});
