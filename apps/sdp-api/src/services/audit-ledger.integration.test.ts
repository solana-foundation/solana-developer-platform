import pg from "pg";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getDb } from "@/db/client";
import type { KVStore, SlidingWindowAdmission, SlidingWindowOptions } from "@/runtime/kv";
import { getLogger } from "@/runtime/logger";
import { adminDatabaseUrl, env } from "@/test/helpers/env";
import { seedTestDatabase } from "@/test/mocks/db";
import { AUDIT_LEDGER_CHECKPOINT_KEY, AuditService } from "./audit.service";

// Every checkpoint call in this file answers at once unless a test stalls it,
// so a short bound only matters to the HOO-2089 stall cases.
vi.mock("./audit-ledger-timeout", () => ({ AUDIT_LEDGER_REDIS_TIMEOUT_MS: 50 }));

/**
 * Privileged tampering must be simulated as a genuine superuser: the runtime
 * role the suite normally connects through is bound by the ledger's forced
 * row-level security (no UPDATE/DELETE policy exists), so its tampering
 * statements would be silently filtered to zero rows instead of shortening
 * the chain — which is the control working, not the scenario under test.
 */
async function tamperAsSuperuser(statements: readonly string[]): Promise<void> {
  const client = new pg.Client({ connectionString: adminDatabaseUrl });
  await client.connect();
  try {
    for (const statement of statements) {
      await client.query(statement);
    }
  } finally {
    await client.end();
  }
}

class MemoryCheckpointStore implements KVStore {
  private value: string | null = null;
  private compareAndSetCalls = 0;
  private rejectAtCall: number | null = null;
  private stallAtCall: number | null = null;
  private stalledEffect: (() => void) | null = null;
  private lateAtCall: { call: number; delayMs: number } | null = null;

  reset() {
    this.value = null;
    this.compareAndSetCalls = 0;
    this.rejectAtCall = null;
    this.stallAtCall = null;
    this.stalledEffect = null;
    this.lateAtCall = null;
  }

  /**
   * The next compare-and-set answers, and takes effect, only after `delayMs`,
   * and after any command sent meanwhile: `RedisKVStore.compareAndSet`'s
   * EVALSHA came back NOSCRIPT and its fallback EVAL is sent behind them.
   */
  compareAndSetCallCount() {
    return this.compareAndSetCalls;
  }

  answerNextCompareAndSetLate(delayMs: number) {
    this.lateAtCall = { call: this.compareAndSetCalls + 1, delayMs };
  }

  /**
   * The next compare-and-set stalls until the client's `commandTimeout` (60ms)
   * rejects it, as on a stalled Redis. Its effect still lands, in order, before
   * the next command the store receives, as a
   * queued command does once the connection recovers.
   */
  stallNextCompareAndSet() {
    this.stallAtCall = this.compareAndSetCalls + 1;
  }

  private catchUp() {
    const effect = this.stalledEffect;
    this.stalledEffect = null;
    effect?.();
  }

  rejectCompareAndSetAfter(offset = 1) {
    this.rejectAtCall = this.compareAndSetCalls + offset;
  }

  get(_key: string): Promise<string | null>;
  get<T>(_key: string, _type: "json"): Promise<T | null>;
  async get<T>(_key: string, type?: "json"): Promise<string | T | null> {
    this.catchUp();
    if (this.value === null) return null;
    return type === "json" ? (JSON.parse(this.value) as T) : this.value;
  }

  async put(_key: string, value: string): Promise<void> {
    this.value = value;
  }

  async delete(): Promise<void> {
    this.value = null;
  }

  async compareAndSet(_key: string, expected: string | null, value: string): Promise<boolean> {
    this.catchUp();
    this.compareAndSetCalls += 1;
    if (this.compareAndSetCalls === this.stallAtCall) {
      this.stallAtCall = null;
      this.stalledEffect = () => {
        if (this.value === expected) this.value = value;
      };
      return new Promise<boolean>((_, reject) => {
        setTimeout(() => reject(new Error("Command timed out")), 60);
      });
    }
    if (this.compareAndSetCalls === this.lateAtCall?.call) {
      const { delayMs } = this.lateAtCall;
      this.lateAtCall = null;
      return new Promise<boolean>((resolve) => {
        setTimeout(() => {
          if (this.value !== expected) return resolve(false);
          this.value = value;
          resolve(true);
        }, delayMs);
      });
    }
    if (this.compareAndSetCalls === this.rejectAtCall) {
      this.rejectAtCall = null;
      return false;
    }
    if (this.value !== expected) return false;
    this.value = value;
    return true;
  }

  async compareAndDelete(_key: string, expected: string): Promise<boolean> {
    this.catchUp();
    this.compareAndSetCalls += 1;
    if (this.compareAndSetCalls === this.rejectAtCall) {
      this.rejectAtCall = null;
      return false;
    }
    if (this.value !== expected) return false;
    this.value = null;
    return true;
  }

  async list() {
    return { keys: [] };
  }

  async admitSlidingWindow(
    _currentKey: string,
    _previousKey: string,
    _options: SlidingWindowOptions
  ): Promise<SlidingWindowAdmission> {
    throw new Error("not implemented by audit checkpoint test store");
  }
}

describe("tamper-evident audit ledger", () => {
  const db = getDb(env);
  const checkpoint = new MemoryCheckpointStore();
  const audit = new AuditService(db, checkpoint);

  beforeEach(async () => {
    checkpoint.reset();
    await seedTestDatabase(env);
  });

  afterEach(async () => {
    // Test databases have the migration's explicit TRUNCATE-only exemption.
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

  it("finalizes a committed pending witness before the next audit write", async () => {
    await audit.logSystem({
      action: "maintenance",
      resourceType: "audit_ledger",
      resourceId: "checkpointed_predecessor",
    });
    // Establishing the pending witness succeeds, but its post-commit promotion
    // fails. The durable pending value must remain evidence of the new row.
    checkpoint.rejectCompareAndSetAfter(2);
    await expect(
      audit.logSystem({
        action: "maintenance",
        resourceType: "audit_ledger",
        resourceId: "committed_before_checkpoint_failure",
      })
    ).rejects.toMatchObject({ name: "AuditPersistenceError" });

    await expect(audit.verifyIntegrity()).resolves.toMatchObject({
      valid: false,
      checkedEntries: 2,
      externalCheckpointMatches: false,
    });
    await expect(
      audit.logSystem({
        action: "maintenance",
        resourceType: "audit_ledger",
        resourceId: "write_after_committed_pending_witness",
      })
    ).resolves.toBeUndefined();
    await expect(audit.verifyIntegrity()).resolves.toMatchObject({
      valid: true,
      checkedEntries: 3,
      externalCheckpointMatches: true,
    });
  });

  it("rolls back the audit row when its pending witness cannot be established", async () => {
    checkpoint.rejectCompareAndSetAfter();
    await expect(
      audit.logSystem({
        action: "maintenance",
        resourceType: "audit_ledger",
        resourceId: "unwitnessed_first_row",
      })
    ).rejects.toMatchObject({ name: "AuditPersistenceError" });

    expect(
      await db.queryOne<{ count: number }>("SELECT count(*)::integer AS count FROM audit_logs")
    ).toMatchObject({ count: 0 });
    await expect(
      audit.logSystem({
        action: "maintenance",
        resourceType: "audit_ledger",
        resourceId: "safe_retry",
      })
    ).resolves.toBeUndefined();
    await expect(audit.verifyIntegrity()).resolves.toMatchObject({
      valid: true,
      checkedEntries: 1,
      externalCheckpointMatches: true,
    });
    expect(
      await db.queryOne<{ count: number }>("SELECT count(*)::integer AS count FROM audit_logs")
    ).toMatchObject({ count: 1 });
  });

  it("fails the write and frees the audit lock when Redis stalls inside it (HOO-2089)", async () => {
    const bounded = audit;
    await bounded.logSystem({
      action: "maintenance",
      resourceType: "audit_ledger",
      resourceId: "before_stall",
    });
    // The pending-witness CAS stalls past the bound, then lands late.
    checkpoint.stallNextCompareAndSet();
    await expect(
      bounded.logSystem({
        action: "maintenance",
        resourceType: "audit_ledger",
        resourceId: "stalled_witness",
      })
    ).rejects.toMatchObject({ name: "AuditPersistenceError" });

    expect(
      await db.queryOne<{ count: number }>("SELECT count(*)::integer AS count FROM audit_logs")
    ).toMatchObject({ count: 1 });
    await expect(
      bounded.logSystem({
        action: "maintenance",
        resourceType: "audit_ledger",
        resourceId: "after_stall",
      })
    ).resolves.toBeUndefined();
    await expect(audit.verifyIntegrity()).resolves.toMatchObject({
      valid: true,
      checkedEntries: 2,
      externalCheckpointMatches: true,
    });
  });

  it("restores the predecessor only after a late NOSCRIPT fallback witness lands (HOO-2089)", async () => {
    await audit.logSystem({
      action: "maintenance",
      resourceType: "audit_ledger",
      resourceId: "before_late_witness",
    });
    // The witness outlives the 50ms bound and lands at 80ms, behind any restore
    // sent at once; the writer waits for it before restoring.
    checkpoint.answerNextCompareAndSetLate(80);
    await expect(
      audit.logSystem({
        action: "maintenance",
        resourceType: "audit_ledger",
        resourceId: "late_witness",
      })
    ).rejects.toMatchObject({ name: "AuditPersistenceError" });
    // Past the late witness, so a restore sent before it had already lost.
    await new Promise((resolve) => setTimeout(resolve, 60));

    await expect(
      audit.logSystem({
        action: "maintenance",
        resourceType: "audit_ledger",
        resourceId: "after_late_witness",
      })
    ).resolves.toBeUndefined();
    await expect(audit.verifyIntegrity()).resolves.toMatchObject({
      valid: true,
      checkedEntries: 2,
      externalCheckpointMatches: true,
    });
  });

  it("sends no restore, and alerts, when the witness call never settles (HOO-2089)", async () => {
    await audit.logSystem({
      action: "maintenance",
      resourceType: "audit_ledger",
      resourceId: "before_unsettled_witness",
    });
    const error = vi.spyOn(getLogger(), "error");
    // Past the 150ms backstop: a store without the client's command bound.
    checkpoint.answerNextCompareAndSetLate(400);
    await expect(
      audit.logSystem({
        action: "maintenance",
        resourceType: "audit_ledger",
        resourceId: "unsettled_witness",
      })
    ).rejects.toMatchObject({ name: "AuditPersistenceError" });

    expect(error).toHaveBeenCalledWith(
      expect.objectContaining({ event: "audit_ledger_witness_unsettled" }),
      expect.any(String)
    );
    // The first write's witness and promotion, then this witness: no restore,
    // which could run ahead of the witness.
    expect(checkpoint.compareAndSetCallCount()).toBe(3);
    await new Promise((resolve) => setTimeout(resolve, 400));
    error.mockRestore();
  });

  it("detects tail deletion during the commit-to-checkpoint-promotion window", async () => {
    await audit.logSystem({
      action: "maintenance",
      resourceType: "audit_ledger",
      resourceId: "retained_prefix",
    });
    checkpoint.rejectCompareAndSetAfter(2);
    await expect(
      audit.logSystem({
        action: "maintenance",
        resourceType: "audit_ledger",
        resourceId: "committed_with_pending_witness",
      })
    ).rejects.toMatchObject({ name: "AuditPersistenceError" });

    try {
      await tamperAsSuperuser([
        "ALTER TABLE audit_logs DISABLE TRIGGER audit_logs_reject_row_mutation",
        "ALTER TABLE audit_ledger_anchors DISABLE TRIGGER audit_ledger_anchors_reject_row_mutation",
        "DELETE FROM audit_ledger_anchors WHERE ledger_sequence = 2",
        "DELETE FROM audit_logs WHERE ledger_sequence = 2",
      ]);
    } finally {
      await tamperAsSuperuser([
        "ALTER TABLE audit_logs ENABLE TRIGGER audit_logs_reject_row_mutation",
        "ALTER TABLE audit_ledger_anchors ENABLE TRIGGER audit_ledger_anchors_reject_row_mutation",
      ]);
    }

    await expect(audit.verifyIntegrity()).resolves.toMatchObject({
      valid: false,
      checkedEntries: 1,
      externalCheckpointMatches: false,
    });
    await expect(
      audit.logSystem({
        action: "maintenance",
        resourceType: "audit_ledger",
        resourceId: "write_after_tail_deletion",
      })
    ).rejects.toMatchObject({ name: "AuditPersistenceError" });
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

  it("rejects direct anchor insertion even when the runtime can insert audit rows", async () => {
    await expect(
      db
        .prepare(
          `INSERT INTO audit_ledger_anchors (ledger_sequence, entry_hash)
           VALUES (?, decode(?, 'hex'))`
        )
        .bind(999_999, "00".repeat(32))
        .run()
    ).rejects.toThrow("only be created from sealed audit rows");

    await audit.logSystem({
      action: "maintenance",
      resourceType: "audit_ledger",
      resourceId: "legitimate_anchor",
    });
    await expect(audit.verifyIntegrity()).resolves.toMatchObject({
      valid: true,
      checkedEntries: 1,
    });
  });

  it("detects privileged out-of-band tampering", async () => {
    await audit.logSystem({
      action: "maintenance",
      resourceType: "audit_ledger",
      resourceId: "before_restore",
      metadata: { operator: "security@example.com", reason: "restore rehearsal" },
    });

    try {
      // A disposable superuser connection simulates the exact privileged
      // maintenance failure the verifier must detect.
      await tamperAsSuperuser([
        "ALTER TABLE audit_logs DISABLE TRIGGER audit_logs_reject_row_mutation",
        "UPDATE audit_logs SET metadata = '{\"tampered\":true}'",
      ]);
    } finally {
      await tamperAsSuperuser([
        "ALTER TABLE audit_logs ENABLE TRIGGER audit_logs_reject_row_mutation",
      ]);
    }

    await expect(audit.verifyIntegrity()).resolves.toMatchObject({
      valid: false,
      checkedEntries: 0,
      firstInvalidSequence: 1,
    });
  });

  it("detects privileged deletion of the newest ledger entries", async () => {
    await audit.logSystem({
      action: "maintenance",
      resourceType: "audit_ledger",
      resourceId: "retained_prefix",
    });
    await audit.logSystem({
      action: "maintenance",
      resourceType: "audit_ledger",
      resourceId: "deleted_tail",
    });

    try {
      await tamperAsSuperuser([
        "ALTER TABLE audit_logs DISABLE TRIGGER audit_logs_reject_row_mutation",
        "DELETE FROM audit_logs WHERE ledger_sequence = 2",
      ]);
    } finally {
      await tamperAsSuperuser([
        "ALTER TABLE audit_logs ENABLE TRIGGER audit_logs_reject_row_mutation",
      ]);
    }

    await expect(audit.verifyIntegrity()).resolves.toMatchObject({
      valid: false,
      checkedEntries: 1,
      firstInvalidSequence: 2,
    });
  });

  it("detects privileged truncation of the audit ledger", async () => {
    await audit.logSystem({
      action: "maintenance",
      resourceType: "audit_ledger",
      resourceId: "before_truncate",
    });

    try {
      await db.execute("ALTER TABLE audit_logs DISABLE TRIGGER audit_logs_reject_truncate");
      await db.execute("TRUNCATE audit_logs");
    } finally {
      await db.execute("ALTER TABLE audit_logs ENABLE TRIGGER audit_logs_reject_truncate");
    }

    await expect(audit.verifyIntegrity()).resolves.toMatchObject({
      valid: false,
      checkedEntries: 0,
      firstInvalidSequence: 1,
    });
  });

  it("detects a privileged actor shortening both PostgreSQL ledger tables", async () => {
    await audit.logSystem({
      action: "maintenance",
      resourceType: "audit_ledger",
      resourceId: "retained_prefix",
    });
    await audit.logSystem({
      action: "maintenance",
      resourceType: "audit_ledger",
      resourceId: "deleted_from_both_tables",
    });

    try {
      await tamperAsSuperuser([
        "ALTER TABLE audit_logs DISABLE TRIGGER audit_logs_reject_row_mutation",
        "ALTER TABLE audit_ledger_anchors DISABLE TRIGGER audit_ledger_anchors_reject_row_mutation",
        "DELETE FROM audit_logs WHERE ledger_sequence = 2",
        "DELETE FROM audit_ledger_anchors WHERE ledger_sequence = 2",
      ]);
    } finally {
      await tamperAsSuperuser([
        "ALTER TABLE audit_logs ENABLE TRIGGER audit_logs_reject_row_mutation",
        "ALTER TABLE audit_ledger_anchors ENABLE TRIGGER audit_ledger_anchors_reject_row_mutation",
      ]);
    }

    await expect(audit.verifyIntegrity()).resolves.toMatchObject({
      valid: false,
      checkedEntries: 1,
      externalCheckpointMatches: false,
    });
  });

  it("fails integrity verification for a stale unresolved critical intent", async () => {
    await db
      .prepare(
        `INSERT INTO audit_logs (
           id, action, resource_type, resource_id, metadata, status, created_at
         ) VALUES (?, 'maintenance', 'audit_ledger', ?, ?, 'success', ?)`
      )
      .bind(
        "aud_stale_intent",
        "aint_stale",
        JSON.stringify({
          auditPhase: "intent",
          target: { action: "mint", resourceType: "token_transaction", resourceId: "tx_stale" },
        }),
        "2026-01-01T00:00:00.000Z"
      )
      .run();
    const staleIntentHead = await db.queryOne<{ ledger_sequence: number; head_hash: string }>(
      `SELECT ledger_sequence, encode(entry_hash, 'hex') AS head_hash
       FROM audit_logs
       ORDER BY ledger_sequence DESC
       LIMIT 1`
    );
    await checkpoint.put(
      AUDIT_LEDGER_CHECKPOINT_KEY,
      JSON.stringify({
        sequence: staleIntentHead?.ledger_sequence,
        headHash: staleIntentHead?.head_hash,
      })
    );

    await expect(audit.verifyIntegrity()).resolves.toMatchObject({
      valid: false,
      unresolvedCriticalIntents: 1,
      firstInvalidSequence: 1,
    });
  });
});
