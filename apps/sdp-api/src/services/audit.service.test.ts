import { describe, expect, it, vi } from "vitest";
import type { KVStore } from "@/runtime/kv";
import { AuditPersistenceError, AuditService } from "./audit.service";

function createMemoryCheckpointStore(): KVStore {
  let value: string | null = null;
  return {
    get: vi.fn(async () => value) as KVStore["get"],
    put: vi.fn(async (_key: string, next: string) => {
      value = next;
    }),
    delete: vi.fn(async () => {
      value = null;
    }),
    compareAndSet: vi.fn(async (_key: string, expected: string | null, next: string) => {
      if (value !== expected) return false;
      value = next;
      return true;
    }),
    list: vi.fn(async () => ({ keys: [] })),
    admitSlidingWindow: vi.fn(),
  };
}

function createAuditWriter(options: { failAt?: number; returnNullAt?: number } = {}) {
  let sequence = 0;
  const queryOne = vi.fn(async (_query: string, params: readonly unknown[]) => {
    const attempt = sequence + 1;
    if (options.failAt === attempt) throw new Error("database unavailable");
    if (options.returnNullAt === attempt) return null;
    sequence = attempt;
    return {
      ledger_sequence: sequence,
      previous_entry_hash: sequence === 1 ? null : `hash_${sequence - 1}`,
      entry_hash: `hash_${sequence}`,
      params,
    };
  });
  const db = {
    transaction: vi.fn(async (callback: (tx: { queryOne: typeof queryOne }) => Promise<void>) =>
      callback({ queryOne })
    ),
  };
  return { db, queryOne, checkpoint: createMemoryCheckpointStore() };
}

describe("AuditService", () => {
  it("redacts credential-shaped metadata before persisting", async () => {
    const { db, queryOne, checkpoint } = createAuditWriter();
    const context = {
      get: (key: string) =>
        key === "apiKey" ? { id: "ak_123", organizationId: "org_123" } : "req_123",
      req: { header: () => null },
    };

    await new AuditService(db as never, checkpoint).log(context as never, {
      action: "validate_failed",
      resourceType: "provider_credential",
      resourceId: "pcred_123",
      metadata: {
        provider: "privy",
        appSecret: "privy-secret",
        nested: { authorization: "Bearer raw-token" },
      },
      status: "failure",
    });

    const metadata = String(queryOne.mock.calls[0]?.[1]?.[7]);
    expect(metadata).toContain('"provider":"privy"');
    expect(metadata).toContain('"appSecret":"[REDACTED]"');
    expect(metadata).toContain('"authorization":"[REDACTED]"');
    expect(metadata).not.toContain("privy-secret");
    expect(metadata).not.toContain("raw-token");
  });

  it("fails closed when an audit insert fails", async () => {
    const { db, checkpoint } = createAuditWriter({ failAt: 1 });

    await expect(
      new AuditService(db as never, checkpoint).logSystem({
        action: "submit",
        resourceType: "transaction",
        resourceId: "tx_123",
      })
    ).rejects.toMatchObject({ name: "AuditPersistenceError" });
  });

  it("rejects a zero-row audit write", async () => {
    const { db, checkpoint } = createAuditWriter({ returnNullAt: 1 });

    await expect(
      new AuditService(db as never, checkpoint).logSystem({
        action: "maintenance",
        resourceType: "audit_ledger",
      })
    ).rejects.toBeInstanceOf(AuditPersistenceError);
  });

  it("maps integrity verification results", async () => {
    const first = vi.fn(async () => ({
      valid: true,
      checked_entries: 42,
      first_invalid_sequence: null,
      head_hash: "abc123",
      unresolved_critical_intents: 0,
    }));
    const db = { prepare: vi.fn(() => ({ bind: () => ({ first }) })) };
    const checkpoint = createMemoryCheckpointStore();
    await checkpoint.put(
      "audit-ledger:checkpoint:v1",
      JSON.stringify({ sequence: 42, headHash: "abc123" })
    );

    await expect(new AuditService(db as never, checkpoint).verifyIntegrity()).resolves.toEqual({
      valid: true,
      checkedEntries: 42,
      firstInvalidSequence: null,
      headHash: "abc123",
      unresolvedCriticalIntents: 0,
      externalCheckpointMatches: true,
    });
  });

  it("persists a critical intent before appending its outcome", async () => {
    const { db, queryOne, checkpoint } = createAuditWriter();
    const context = {
      get: (key: string) =>
        key === "apiKey" ? { id: "ak_123", organizationId: "org_123" } : "req_123",
      req: { header: () => null },
    };
    const audit = new AuditService(db as never, checkpoint);

    const intent = await audit.beginCritical(context as never, {
      action: "mint",
      resourceType: "token_transaction",
      resourceId: "tx_123",
      metadata: { tokenId: "tok_123" },
    });
    await expect(
      audit.completeCritical(context as never, intent, {
        metadata: { signature: "sig_123" },
      })
    ).resolves.toBe(true);

    const intentMetadata = JSON.parse(String(queryOne.mock.calls[0]?.[1]?.[7])) as Record<
      string,
      unknown
    >;
    const outcomeMetadata = JSON.parse(String(queryOne.mock.calls[1]?.[1]?.[7])) as Record<
      string,
      unknown
    >;
    expect(intentMetadata).toMatchObject({
      auditPhase: "intent",
      target: { action: "mint", resourceId: "tx_123" },
    });
    expect(outcomeMetadata).toMatchObject({
      auditPhase: "outcome",
      auditIntentId: intent.id,
      tokenId: "tok_123",
      signature: "sig_123",
    });
  });

  it("keeps a completed operation successful when its durable intent exists", async () => {
    const { db, checkpoint } = createAuditWriter({ failAt: 2 });
    const context = {
      get: () => null,
      req: { header: () => null },
    };
    const audit = new AuditService(db as never, checkpoint);
    const intent = await audit.beginCritical(context as never, {
      action: "freeze",
      resourceType: "token_transaction",
      resourceId: "tx_456",
    });

    await expect(audit.completeCritical(context as never, intent)).resolves.toBe(false);
  });

  describe("getForAsset", () => {
    const rows = [
      {
        id: "aud_1",
        user_id: "u1",
        api_key_id: null,
        action: "freeze",
        resource_type: "frozen_account",
        resource_id: "fa_1",
        metadata: JSON.stringify({ tokenId: "tok_1" }),
        status: "success",
        created_at: "2026-07-19T00:00:00Z",
        api_key_name: null,
        user_name: "Jordan Lee",
        user_email: "jordan@example.com",
      },
      {
        id: "aud_2",
        user_id: null,
        api_key_id: "ak_1",
        action: "mint",
        resource_type: "token_transaction",
        resource_id: "tx_1",
        metadata: JSON.stringify({ tokenId: "tok_1" }),
        status: "success",
        created_at: "2026-07-18T00:00:00Z",
        api_key_name: "CI key",
        user_name: null,
        user_email: null,
      },
      {
        id: "aud_3",
        user_id: null,
        api_key_id: null,
        action: "pause",
        resource_type: "token_transaction",
        resource_id: "tx_2",
        metadata: null,
        status: "success",
        created_at: "2026-07-17T00:00:00Z",
        api_key_name: null,
        user_name: null,
        user_email: null,
      },
    ];

    function mockDb(results: unknown[]) {
      const all = vi.fn(async () => ({ results }));
      const bind = vi.fn((..._values: unknown[]) => ({ all }));
      const prepare = vi.fn((_query: string) => ({ bind }));
      return { db: { prepare } as never, prepare, bind };
    }

    it("aggregates events by token id (resource_id or metadata.tokenId) and resolves actors", async () => {
      const { db, prepare, bind } = mockDb(rows);

      const events = await new AuditService(db).getForAsset("org_1", "tok_1");

      const sql = String(prepare.mock.calls[0]?.[0]);
      expect(sql).toContain("audit_logs");
      expect(sql).toContain("a.resource_id = ?");
      expect(sql).toContain("->> 'tokenId'");
      // org + tokenId (resource_id) + tokenId (metadata) + limit + offset
      expect(bind).toHaveBeenCalledWith("org_1", "tok_1", "tok_1", 50, 0);

      expect(events[0]).toMatchObject({ actorType: "user", actorLabel: "Jordan Lee" });
      expect(events[1]).toMatchObject({ actorType: "api_key", actorLabel: "CI key" });
      expect(events[2]).toMatchObject({ actorType: "system", actorLabel: "SDP" });
      expect(events[0]?.metadata).toEqual({ tokenId: "tok_1" });
      expect(events[2]?.metadata).toBeNull();
    });

    it("falls back to email then a generic label for users without a name", async () => {
      const { db } = mockDb([
        { ...rows[0], user_name: null, user_email: "jordan@example.com" },
        { ...rows[0], id: "aud_x", user_name: null, user_email: null },
      ]);

      const events = await new AuditService(db).getForAsset("org_1", "tok_1");
      expect(events[0]?.actorLabel).toBe("jordan@example.com");
      expect(events[1]?.actorLabel).toBe("Team member");
    });

    it("does not print an unsubstituted Clerk placeholder as the actor", async () => {
      const placeholder = "{{user.primary_email_address.email_address}}";
      const { db } = mockDb([
        { ...rows[0], user_name: null, user_email: placeholder },
        { ...rows[0], id: "aud_y", user_name: placeholder, user_email: "jordan@example.com" },
      ]);

      const events = await new AuditService(db).getForAsset("org_1", "tok_1");
      // Something was recorded but is unusable, which is a data fault rather than an
      // ordinary nameless user, so it must not read as one.
      expect(events[0]?.actorLabel).toBe("Unknown user");
      // A corrupted name must not shadow an email that is still good.
      expect(events[1]?.actorLabel).toBe("jordan@example.com");
    });

    it("separates an unusable identity from one that was never recorded", async () => {
      const { db } = mockDb([
        { ...rows[0], user_name: null, user_email: null },
        { ...rows[0], id: "aud_z", user_name: "  ", user_email: "{{user.primary_email_address}}" },
      ]);

      const events = await new AuditService(db).getForAsset("org_1", "tok_1");
      expect(events[0]?.actorLabel).toBe("Team member");
      expect(events[1]?.actorLabel).toBe("Unknown user");
    });

    it("applies the action filter and pagination bounds", async () => {
      const { db, prepare, bind } = mockDb([]);

      await new AuditService(db).getForAsset("org_1", "tok_1", {
        action: "freeze",
        limit: 10,
        offset: 5,
      });

      const sql = String(prepare.mock.calls[0]?.[0]);
      expect(sql).toContain("a.action = ?");
      expect(bind).toHaveBeenCalledWith("org_1", "tok_1", "tok_1", "freeze", 10, 5);
    });

    it("applies the status filter as a bound parameter", async () => {
      const { db, prepare, bind } = mockDb([]);

      await new AuditService(db).getForAsset("org_1", "tok_1", { status: "failure" });

      const sql = String(prepare.mock.calls[0]?.[0]);
      expect(sql).toContain("a.status = ?");
      expect(bind).toHaveBeenCalledWith("org_1", "tok_1", "tok_1", "failure", 50, 0);
    });

    it("maps the actorType filter to id-presence predicates without bound params", async () => {
      const cases = [
        { actorType: "user" as const, clause: "a.user_id IS NOT NULL" },
        { actorType: "api_key" as const, clause: "a.user_id IS NULL AND a.api_key_id IS NOT NULL" },
        { actorType: "system" as const, clause: "a.user_id IS NULL AND a.api_key_id IS NULL" },
      ];

      for (const { actorType, clause } of cases) {
        const { db, prepare, bind } = mockDb([]);
        await new AuditService(db).getForAsset("org_1", "tok_1", { actorType });

        const sql = String(prepare.mock.calls[0]?.[0]);
        expect(sql).toContain(clause);
        // actorType is derived, not stored, so it adds no bound parameter.
        expect(bind).toHaveBeenCalledWith("org_1", "tok_1", "tok_1", 50, 0);
      }
    });

    it("combines filters in a stable parameter order", async () => {
      const { db, bind } = mockDb([]);

      await new AuditService(db).getForAsset("org_1", "tok_1", {
        action: "freeze",
        status: "success",
        actorType: "user",
        limit: 10,
        offset: 5,
      });

      // org, tokenId x2, then action, status (actorType adds no param), then limit, offset.
      expect(bind).toHaveBeenCalledWith("org_1", "tok_1", "tok_1", "freeze", "success", 10, 5);
    });
  });
});
