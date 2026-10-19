import { hashString } from "@sdp/payments/hash";
import { SDP_RAMP_PROVIDER_STAGES } from "@sdp/types/release-channels";
import { describe, expect, it } from "vitest";
import type { DatabaseClient, PreparedStatement, QueryManyResult } from "@/db/client";
import { createTenantScope, TenantScopeViolationError } from "@/lib/tenant-scope";
import { ApiKeyService } from "./api-key.service";
import type { ApiKeyGrantChannel } from "./api-key-scope.service";

const TEST_SCOPE = createTenantScope({ organizationId: "org_1", projectId: "prj_1" });
const EXPERIMENTAL: ApiKeyGrantChannel = {
  releaseChannel: "experimental",
  rampProviderStages: SDP_RAMP_PROVIDER_STAGES,
};
const STABLE: ApiKeyGrantChannel = {
  releaseChannel: "stable",
  rampProviderStages: SDP_RAMP_PROVIDER_STAGES,
};

type RunCall = { sql: string; values: unknown[] };

class RecordingStatement implements PreparedStatement {
  constructor(
    private readonly runs: RunCall[],
    private readonly sql: string,
    private readonly values: unknown[] = []
  ) {}

  bind(...values: unknown[]): PreparedStatement {
    return new RecordingStatement(this.runs, this.sql, values);
  }

  async first<T = Record<string, unknown>>(): Promise<T | null> {
    return null;
  }

  async all<T = Record<string, unknown>>(): Promise<QueryManyResult<T>> {
    return { results: [], rows: [] };
  }

  async run(): Promise<number> {
    this.runs.push({ sql: this.sql, values: this.values });
    return 1;
  }
}

class RecordingDb implements DatabaseClient {
  readonly runs: RunCall[] = [];

  /** @param heldGrants - The grants the key row stores, for an update's read. */
  constructor(private readonly heldGrants: string[] = []) {}

  prepare(query: string): PreparedStatement {
    return new RecordingStatement(this.runs, query);
  }

  async queryOne<T = Record<string, unknown>>(): Promise<T | null> {
    // SAFETY: the only queryOne an update issues reads the key's grants column.
    return { grants: this.heldGrants } as T;
  }

  queryMany<T = Record<string, unknown>>(): Promise<T[]> {
    throw new Error("not implemented");
  }

  execute(): Promise<number> {
    throw new Error("not implemented");
  }

  batch(): Promise<number[]> {
    throw new Error("not implemented");
  }

  transaction<T>(): Promise<T> {
    throw new Error("not implemented");
  }
}

type FirstCall = { sql: string; values: unknown[] };

class LookupStatement implements PreparedStatement {
  constructor(
    private readonly row: Record<string, unknown> | null,
    private readonly calls: FirstCall[],
    private readonly sql: string,
    private readonly values: unknown[] = []
  ) {}

  bind(...values: unknown[]): PreparedStatement {
    return new LookupStatement(this.row, this.calls, this.sql, values);
  }

  async first<T = Record<string, unknown>>(): Promise<T | null> {
    this.calls.push({ sql: this.sql, values: this.values });
    return this.row as T | null;
  }

  async all<T = Record<string, unknown>>(): Promise<QueryManyResult<T>> {
    return { results: [], rows: [] };
  }

  async run(): Promise<number> {
    return 0;
  }
}

class LookupDb extends RecordingDb {
  readonly lookups: FirstCall[] = [];

  constructor(private readonly row: Record<string, unknown> | null) {
    super();
  }

  override prepare(query: string): PreparedStatement {
    return new LookupStatement(this.row, this.lookups, query);
  }
}

describe("ApiKeyService.resolveUsableApiKey", () => {
  it("rejects forged organization and project claims before database access", async () => {
    const db = new LookupDb({ status: "active", expires_at: null });
    const service = new ApiKeyService(db, TEST_SCOPE);

    await expect(
      service.resolveUsableApiKey({
        apiKey: "sk_test_foreign_secret",
        organizationId: "org_foreign",
        projectId: "prj_foreign",
        pepper: "test-pepper",
      })
    ).rejects.toBeInstanceOf(TenantScopeViolationError);
    expect(db.lookups).toHaveLength(0);
  });

  it("matches exact key material inside the organization and project boundary", async () => {
    const db = new LookupDb({
      id: "key_1",
      name: "smoke-test-key",
      key_prefix: "sk_test_abc",
      status: "active",
      expires_at: null,
    });
    const service = new ApiKeyService(db, TEST_SCOPE);
    const apiKey = "sk_test_owned_secret";
    const pepper = "test-pepper";

    // The identity comes from the matched row, never from the supplied material.
    await expect(
      service.resolveUsableApiKey({
        apiKey,
        organizationId: "org_1",
        projectId: "prj_1",
        pepper,
      })
    ).resolves.toEqual({ id: "key_1", name: "smoke-test-key", keyPrefix: "sk_test_abc" });

    expect(db.lookups).toHaveLength(1);
    expect(db.lookups[0]?.sql).toContain("key_hash = ? AND organization_id = ? AND project_id = ?");
    expect(db.lookups[0]?.values).toEqual([await hashString(apiKey, pepper), "org_1", "prj_1"]);
  });

  it("fails closed when no scoped exact-key match exists", async () => {
    const service = new ApiKeyService(new LookupDb(null), TEST_SCOPE);

    await expect(
      service.resolveUsableApiKey({
        apiKey: "sk_live_foreign_secret",
        organizationId: "org_1",
        projectId: "prj_1",
        pepper: "test-pepper",
      })
    ).resolves.toBeNull();
  });

  it.each([
    ["deactivated", null],
    ["active", "2000-01-01T00:00:00.000Z"],
  ])("rejects an unusable key with status %s and expiry %s", async (status, expiresAt) => {
    const service = new ApiKeyService(
      new LookupDb({
        id: "key_1",
        name: "unusable",
        key_prefix: "sk_test_abc",
        status,
        expires_at: expiresAt,
      }),
      TEST_SCOPE
    );

    // An unusable key resolves to nothing, so no identity leaks for a key the
    // caller cannot actually use.
    await expect(
      service.resolveUsableApiKey({
        apiKey: "sk_test_unusable_secret",
        organizationId: "org_1",
        projectId: "prj_1",
        pepper: "test-pepper",
      })
    ).resolves.toBeNull();
  });
});

describe("ApiKeyService.createApiKey grant guard", () => {
  it("refuses an action no API key may hold before touching the database", async () => {
    const db = new RecordingDb();
    const service = new ApiKeyService(db, TEST_SCOPE);

    await expect(
      service.createApiKey({
        organizationId: "org_1",
        projectId: "prj_1",
        actorRole: "admin",
        grantChannel: EXPERIMENTAL,
        createdByUserId: "usr_1",
        name: "escalated",
        grants: ["api_keys.manage"],
      })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    expect(db.runs).toHaveLength(0);
  });

  it("refuses a member granting an action their role lacks", async () => {
    const db = new RecordingDb();
    const service = new ApiKeyService(db, TEST_SCOPE);

    await expect(
      service.createApiKey({
        organizationId: "org_1",
        projectId: "prj_1",
        actorRole: "member",
        grantChannel: EXPERIMENTAL,
        createdByUserId: "usr_1",
        name: "escalated",
        grants: ["issuance.authority"],
      })
    ).rejects.toMatchObject({ code: "INSUFFICIENT_PERMISSIONS" });

    expect(db.runs).toHaveLength(0);
  });
});

describe("ApiKeyService grants outside the release channel", () => {
  it("refuses a create granting a module the channel does not run, naming it", async () => {
    const db = new RecordingDb();
    const service = new ApiKeyService(db, TEST_SCOPE);

    await expect(
      service.createApiKey({
        organizationId: "org_1",
        projectId: "prj_1",
        actorRole: "admin",
        grantChannel: STABLE,
        createdByUserId: "usr_1",
        name: "out of channel",
        grants: ["transfers.read", "issuance.execute", "earn.execute"],
      })
    ).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message:
        "Grants outside this deployment's stable release channel: issuance.execute, earn.execute",
    });

    expect(db.runs).toHaveLength(0);
  });

  it("refuses an update adding one, and writes nothing", async () => {
    const db = new RecordingDb(["transfers.read"]);
    const service = new ApiKeyService(db, TEST_SCOPE);

    await expect(
      service.updateApiKey({
        keyId: "key_1",
        organizationId: "org_1",
        projectId: "prj_1",
        actorRole: "admin",
        grantChannel: STABLE,
        grants: ["transfers.read", "dvp.read"],
      })
    ).rejects.toMatchObject({ code: "BAD_REQUEST", details: { actions: ["dvp.read"] } });

    expect(db.runs).toHaveLength(0);
  });

  it("keeps one the key already held when an edit sends it back", async () => {
    const db = new RecordingDb(["transfers.read", "dvp.read"]);
    const service = new ApiKeyService(db, TEST_SCOPE);

    await service.updateApiKey({
      keyId: "key_1",
      organizationId: "org_1",
      projectId: "prj_1",
      actorRole: "admin",
      grantChannel: STABLE,
      grants: ["transfers.read", "transfers.execute", "dvp.read"],
    });

    expect(db.runs).toHaveLength(1);
    expect(db.runs[0].values[0]).toEqual(["transfers.read", "transfers.execute", "dvp.read"]);
  });
});

describe("ApiKeyService.updateApiKey", () => {
  const base = {
    keyId: "key_1",
    organizationId: "org_1",
    projectId: "prj_1",
    grantChannel: EXPERIMENTAL,
  };

  it("refuses a grant no API key may hold", async () => {
    const db = new RecordingDb();
    const service = new ApiKeyService(db, TEST_SCOPE);

    await expect(
      service.updateApiKey({
        ...base,
        actorRole: "admin",
        grants: ["wallets.configure"],
      })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    expect(db.runs).toHaveLength(0);
  });

  it("scopes the update to organization and project", async () => {
    const db = new RecordingDb();
    const service = new ApiKeyService(db, TEST_SCOPE);

    await service.updateApiKey({
      ...base,
      actorRole: "admin",
      name: "renamed",
    });

    expect(db.runs).toHaveLength(1);
    expect(db.runs[0].sql).toContain("WHERE id = ? AND organization_id = ? AND project_id = ?");
    expect(db.runs[0].values).toEqual(["renamed", "key_1", "org_1", "prj_1"]);
  });

  it("stores replaced grants in registry order, deduplicated", async () => {
    const db = new RecordingDb();
    const service = new ApiKeyService(db, TEST_SCOPE);

    await service.updateApiKey({
      ...base,
      actorRole: "member",
      grants: ["transfers.execute", "transfers.read", "transfers.execute"],
    });

    expect(db.runs).toHaveLength(1);
    expect(db.runs[0].values).toEqual([
      ["transfers.read", "transfers.execute"],
      "key_1",
      "org_1",
      "prj_1",
    ]);
  });

  it("throws when there are no fields to update", async () => {
    const db = new RecordingDb();
    const service = new ApiKeyService(db, TEST_SCOPE);

    await expect(
      service.updateApiKey({
        ...base,
        actorRole: "admin",
      })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    expect(db.runs).toHaveLength(0);
  });
});
