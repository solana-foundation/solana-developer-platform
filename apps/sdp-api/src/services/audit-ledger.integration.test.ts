import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getDb } from "@/db";
import { env } from "@/test/helpers/env";
import { clearTestDatabase, seedTestDatabase } from "@/test/mocks/db";
import { AuditService } from "./audit.service";

describe("tamper-evident audit ledger", () => {
  const db = getDb(env);
  const audit = new AuditService(db);

  beforeEach(async () => {
    await seedTestDatabase(env);
  });

  afterEach(async () => {
    // Test databases have the migration's explicit TRUNCATE-only exemption.
    await clearTestDatabase(env);
  });

  it("serializes request-independent worker writes into a valid chain", async () => {
    await Promise.all(
      Array.from({ length: 8 }, (_, index) =>
        audit.logSystem({
          action: "submit",
          resourceType: "transaction",
          resourceId: `worker_tx_${index}`,
          requestId: `job_run_${index}`,
          metadata: { worker: "reconciliation" },
        })
      )
    );

    await expect(audit.verifyIntegrity()).resolves.toMatchObject({
      valid: true,
      checkedEntries: 8,
      firstInvalidSequence: null,
    });

    const rows = await db.queryMany<{
      ledger_sequence: number;
      previous_entry_hash: Buffer | null;
    }>(
      `SELECT ledger_sequence, previous_entry_hash
       FROM audit_logs
       ORDER BY ledger_sequence`
    );
    expect(rows.map((row) => row.ledger_sequence)).toEqual([...rows.map((_, i) => i + 1)]);
    expect(rows[0]?.previous_entry_hash).toBeNull();
    expect(rows.slice(1).every((row) => row.previous_entry_hash !== null)).toBe(true);
  });

  it("blocks update and delete, including for records past retention review", async () => {
    await db
      .prepare(
        `INSERT INTO audit_logs (
           id, action, resource_type, resource_id, status, created_at
         ) VALUES (?, 'maintenance', 'audit_ledger', 'retention_evidence', 'success', ?)`
      )
      .bind("aud_retention_evidence", "2016-01-01T00:00:00.000Z")
      .run();

    await expect(
      db
        .prepare("UPDATE audit_logs SET status = 'failure' WHERE id = ?")
        .bind("aud_retention_evidence")
        .run()
    ).rejects.toThrow("append-only");

    await expect(
      db.prepare("DELETE FROM audit_logs WHERE id = ?").bind("aud_retention_evidence").run()
    ).rejects.toThrow("append-only");

    expect(
      await db.queryOne("SELECT id FROM audit_logs WHERE id = ?", ["aud_retention_evidence"])
    ).toMatchObject({ id: "aud_retention_evidence" });
  });

  it("detects privileged out-of-band tampering", async () => {
    await audit.logSystem({
      action: "maintenance",
      resourceType: "audit_ledger",
      resourceId: "before_restore",
      metadata: { operator: "security@example.com", reason: "restore rehearsal" },
    });

    try {
      // Testcontainers uses a disposable superuser. This simulates the exact
      // privileged maintenance failure the verifier must detect.
      await db.execute("ALTER TABLE audit_logs DISABLE TRIGGER audit_logs_reject_row_mutation");
      await db.execute("UPDATE audit_logs SET metadata = '{\"tampered\":true}'");
    } finally {
      await db.execute("ALTER TABLE audit_logs ENABLE TRIGGER audit_logs_reject_row_mutation");
    }

    await expect(audit.verifyIntegrity()).resolves.toMatchObject({
      valid: false,
      checkedEntries: 0,
      firstInvalidSequence: 1,
    });
  });
});
