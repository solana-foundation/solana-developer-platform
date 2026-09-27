/**
 * End-to-end regression tests for the `audit:ledger` CLI (scripts/audit-ledger.mjs).
 *
 * The CLI connects with a raw `pg.Client`, so nothing stamps the tenant-isolation
 * identity unless the script does it itself. An unstamped session is fail-closed
 * under RLS: `sdp_verify_audit_ledger()` is invoker-security and only scans the
 * rows the caller can see, so the unstamped CLI saw an empty ledger and — with
 * the Redis checkpoint also missing — certified it as `valid: true` with zero
 * checked entries (Apex SOLA9-490 / APE-734).
 *
 * These tests spawn the real CLI as a NOSUPERUSER/NOBYPASSRLS runtime role
 * against the worker testcontainers, mirroring docs/ops/audit-ledger.md.
 */

import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Redis from "ioredis";
import pg from "pg";
import { afterAll, describe, expect, it } from "vitest";
import { getDb, runWithSystemDatabaseIdentity } from "@/db";
import { env } from "@/test/helpers/env";
import { seedTestDatabase } from "@/test/mocks/db";
import {
  AUDIT_LEDGER_SYSTEM_COMPONENT,
  type AuditLedgerInspection,
  inspect,
  systemIdentitySessionStatement,
} from "../../scripts/audit-ledger.mjs";
import { databaseIdentitySessionConfigStatement } from "../../scripts/lib/database-identity.mjs";

const apiRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const cliEntry = path.join(apiRoot, "scripts/audit-ledger.mjs");
// The CLI's checkpoint key in Redis — no test-worker namespace, unlike the
// application KV store prefix.
const RAW_CHECKPOINT_KEY = "cache:audit-ledger:checkpoint:v1";
const SEALED_ENTRY_ID = "aud_audit_ledger_cli_regression";

function requiredStoreUrl(value: string | undefined, label: string): string {
  if (!value) {
    throw new Error(`Test environment requires ${label}.`);
  }
  return value;
}

const runtimeDatabaseUrl = requiredStoreUrl(env.DATABASE_URL, "DATABASE_URL");
const runtimeRedisUrl = requiredStoreUrl(env.REDIS_URL, "REDIS_URL");

function runAuditLedgerCli(args: string[], entryPath: string = cliEntry) {
  return spawnSync(process.execPath, [entryPath, ...args], {
    cwd: apiRoot,
    env: { ...process.env, DATABASE_URL: runtimeDatabaseUrl, REDIS_URL: runtimeRedisUrl },
    encoding: "utf8",
    timeout: 20_000,
  });
}

async function withRawRedis<T>(fn: (redis: Redis) => Promise<T>): Promise<T> {
  const redis = new Redis(runtimeRedisUrl, { maxRetriesPerRequest: 3 });
  try {
    return await fn(redis);
  } finally {
    await redis.quit();
  }
}

/**
 * Seeds one genuinely sealed audit row through the application writer's
 * identity path: the seal trigger hashes it and writes the independent anchor.
 */
async function seedSealedAuditEntry(): Promise<void> {
  await runWithSystemDatabaseIdentity("test", () =>
    getDb(env).execute(
      `INSERT INTO audit_logs
         (id, organization_id, action, resource_type, resource_id, metadata, status)
       VALUES (?, NULL, 'custody_transfer', 'wallet_operation', 'op_audit_ledger_cli',
               '{"auditPhase":"outcome"}', 'success')`,
      [SEALED_ENTRY_ID]
    )
  );
}

describe("audit:ledger CLI identity stamping", () => {
  afterAll(async () => {
    // The raw checkpoint key is not covered by seedTestDatabase's prefixed KV
    // delete; never leak CLI state into the worker's Redis database.
    await withRawRedis((redis) => redis.del(RAW_CHECKPOINT_KEY));
  });

  it("refuses to certify the RLS-hidden ledger as a valid empty chain", async () => {
    await seedTestDatabase(env);
    await seedSealedAuditEntry();
    await withRawRedis((redis) => redis.del(RAW_CHECKPOINT_KEY));

    // One sealed row and its anchor exist in PostgreSQL, Redis has no
    // checkpoint: a missing checkpoint for a non-empty ledger is a security
    // incident, so the verifier must fail closed — never report the
    // RLS-hidden view as a valid empty chain.
    const result = runAuditLedgerCli(["verify"]);
    const report = JSON.parse(result.stdout || "{}") as AuditLedgerInspection;

    expect(result.stderr).toBe("");
    expect(result.status).not.toBe(0);
    expect(report.valid).toBe(false);
    // The verifier must have evaluated the real ledger, not the RLS-hidden
    // empty view.
    expect(report.checkedEntries).toBe(1);
    expect(report.databaseLedgerValid).toBe(false);
  });

  it("reports the stamped system identity on a passing verification", async () => {
    await seedTestDatabase(env);
    await withRawRedis((redis) => redis.del(RAW_CHECKPOINT_KEY));

    // Supported pre-bootstrap state: an empty ledger with no checkpoint is
    // genuinely empty, so verification still succeeds after the fix.
    const result = runAuditLedgerCli(["verify"]);
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    const report = JSON.parse(result.stdout) as AuditLedgerInspection;
    expect(report.valid).toBe(true);
    expect(report.checkedEntries).toBe(0);
    expect(report.runtimeRoleProtected).toBe(true);
    expect(report.systemIdentity).toBe("script:audit-ledger");
  });

  it("runs the real CLI when invoked through a symlinked entry path", async () => {
    await seedTestDatabase(env);
    await withRawRedis((redis) => redis.del(RAW_CHECKPOINT_KEY));

    // An aliased entry path must never silently skip the CLI: a symlink
    // invocation loads the resolved module while process.argv[1] keeps the
    // alias path, and a skipped main() would "verify" nothing and exit 0.
    const linkDir = mkdtempSync(path.join(tmpdir(), "audit-ledger-entry-"));
    try {
      const linkedEntry = path.join(linkDir, "audit-ledger");
      symlinkSync(cliEntry, linkedEntry);
      const result = runAuditLedgerCli(["verify"], linkedEntry);
      const report = JSON.parse(result.stdout || "{}") as AuditLedgerInspection;

      expect(result.stderr).toBe("");
      expect(result.status).toBe(0);
      // Evidence that the CLI actually ran and stamped its session.
      expect(report.systemIdentity).toBe("script:audit-ledger");
      expect(report.valid).toBe(true);
      expect(report.checkedEntries).toBe(0);
    } finally {
      rmSync(linkDir, { recursive: true, force: true });
    }
  });

  it("appends a checkpoint through the stamped session and verifies it", async () => {
    await seedTestDatabase(env);
    await withRawRedis((redis) => redis.del(RAW_CHECKPOINT_KEY));

    // Supported maintenance flow: a checkpoint write is an audited ledger
    // append that must succeed under the runtime role's system identity and
    // leave the Redis checkpoint consistent with the sealed head.
    const checkpoint = runAuditLedgerCli([
      "checkpoint",
      "--operator",
      "ops@example.com",
      "--reason",
      "regression-test checkpoint",
    ]);
    expect(checkpoint.stderr).toBe("");
    expect(checkpoint.status).toBe(0);

    const verify = runAuditLedgerCli(["verify"]);
    expect(verify.stderr).toBe("");
    expect(verify.status).toBe(0);
    const report = JSON.parse(verify.stdout) as AuditLedgerInspection;
    expect(report.valid).toBe(true);
    expect(report.checkedEntries).toBe(1);
    expect(report.systemIdentity).toBe("script:audit-ledger");
  });

  it("refuses to checkpoint a non-empty ledger whose checkpoint is missing", async () => {
    await seedTestDatabase(env);
    await seedSealedAuditEntry();
    await withRawRedis((redis) => redis.del(RAW_CHECKPOINT_KEY));

    // Ordinary checkpoint writes never recreate a missing checkpoint for a
    // non-empty ledger (docs/ops/audit-ledger.md): the repair path must fail
    // closed instead of re-seeding Redis from the database alone.
    const checkpoint = runAuditLedgerCli([
      "checkpoint",
      "--operator",
      "ops@example.com",
      "--reason",
      "missing-checkpoint must not self-heal",
    ]);
    expect(checkpoint.status).not.toBe(0);
    expect(await withRawRedis((redis) => redis.exists(RAW_CHECKPOINT_KEY))).toBe(0);
  });

  describe("inspect() identity guard", () => {
    let runtimeClient: pg.Client;

    async function connectRuntimeClient(): Promise<pg.Client> {
      const client = new pg.Client({ connectionString: runtimeDatabaseUrl });
      await client.connect();
      return client;
    }

    it("seals the ledger behind the stamped system identity", async () => {
      await seedTestDatabase(env);
      await seedSealedAuditEntry();
      runtimeClient = await connectRuntimeClient();
      const redis = new Redis(runtimeRedisUrl, { maxRetriesPerRequest: 3 });
      try {
        // Sealed row present, but the session carries no tenant-isolation
        // identity: RLS hides it, so the verifier would see an empty chain.
        // inspect() must refuse instead of evaluating that view.
        const unstamped = await runtimeClient.query(
          "SELECT current_setting('app.tenant_isolation_identity', true) AS identity"
        );
        expect(unstamped.rows[0]?.identity ?? "").not.toBe("system");
        await expect(inspect(runtimeClient, redis)).rejects.toThrow(
          /missing the required system database identity/
        );

        // A stamp with the wrong component actor is equally refused.
        await runtimeClient.query(
          databaseIdentitySessionConfigStatement({
            kind: "system",
            component: "other:component",
          }).text
        );
        await expect(inspect(runtimeClient, redis)).rejects.toThrow(
          /missing the required system database identity/
        );

        // A tenant identity must never operate the ledger verifier either.
        await runtimeClient.query(
          databaseIdentitySessionConfigStatement({
            kind: "tenant",
            organizationId: "org_audit_ledger_cli",
          }).text
        );
        await expect(inspect(runtimeClient, redis)).rejects.toThrow(
          /missing the required system database identity/
        );

        // With the exact system identity stamped, the same session evaluates
        // the real (non-empty) ledger.
        await runtimeClient.query(systemIdentitySessionStatement());
        const report = await inspect(runtimeClient, redis);
        expect(report.checkedEntries).toBe(1);
        expect(report.systemIdentity).toBe(AUDIT_LEDGER_SYSTEM_COMPONENT);
        expect(report.runtimeRoleProtected).toBe(true);
      } finally {
        await Promise.allSettled([runtimeClient.end(), redis.quit()]);
      }
    });
  });
});
