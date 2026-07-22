import { describe, expect, it, vi } from "vitest";
import { AuditService } from "./audit.service";

describe("AuditService", () => {
  it("redacts credential-shaped metadata before persisting", async () => {
    const run = vi.fn(async () => undefined);
    const bind = vi.fn((..._args: unknown[]) => ({ run }));
    const db = { prepare: vi.fn(() => ({ bind })) };
    const context = {
      get: (key: string) =>
        key === "apiKey" ? { id: "ak_123", organizationId: "org_123" } : "req_123",
      req: { header: () => null },
    };

    await new AuditService(db as never).log(context as never, {
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

    const metadata = String(bind.mock.calls[0]?.[7]);
    expect(metadata).toContain('"provider":"privy"');
    expect(metadata).toContain('"appSecret":"[REDACTED]"');
    expect(metadata).toContain('"authorization":"[REDACTED]"');
    expect(metadata).not.toContain("privy-secret");
    expect(metadata).not.toContain("raw-token");
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
      expect(events[2]).toMatchObject({ actorType: "system", actorLabel: "Automated" });
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
  });
});
