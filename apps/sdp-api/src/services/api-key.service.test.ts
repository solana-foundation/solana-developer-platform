import { describe, expect, it } from "vitest";
import type { DatabaseClient, PreparedStatement, QueryManyResult } from "@/db/client";
import { ApiKeyService } from "./api-key.service";

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

  prepare(query: string): PreparedStatement {
    return new RecordingStatement(this.runs, query);
  }

  queryOne<T = Record<string, unknown>>(): Promise<T | null> {
    throw new Error("not implemented");
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

describe("ApiKeyService.createApiKey permission guard", () => {
  it("rejects a non-admin minting an api_admin key before touching the database", async () => {
    const db = new RecordingDb();
    const service = new ApiKeyService(db);

    await expect(
      service.createApiKey({
        organizationId: "org_1",
        projectId: "prj_1",
        actorPermissions: ["api-keys:write"],
        createdByUserId: "usr_1",
        name: "escalated",
        role: "api_admin",
      })
    ).rejects.toMatchObject({ code: "INSUFFICIENT_PERMISSIONS" });

    expect(db.runs).toHaveLength(0);
  });
});

describe("ApiKeyService.updateApiKey", () => {
  const base = {
    keyId: "key_1",
    organizationId: "org_1",
    projectId: "prj_1",
    currentRole: "api_developer" as const,
  };

  it("rejects a non-admin raising permissions to a wildcard", async () => {
    const db = new RecordingDb();
    const service = new ApiKeyService(db);

    await expect(
      service.updateApiKey({
        ...base,
        actorPermissions: ["payments:read"],
        permissions: ["*"],
      })
    ).rejects.toMatchObject({ code: "INSUFFICIENT_PERMISSIONS" });

    expect(db.runs).toHaveLength(0);
  });

  it("scopes the update to organization and project", async () => {
    const db = new RecordingDb();
    const service = new ApiKeyService(db);

    await service.updateApiKey({
      ...base,
      actorPermissions: ["org:admin"],
      name: "renamed",
    });

    expect(db.runs).toHaveLength(1);
    expect(db.runs[0].sql).toContain("WHERE id = ? AND organization_id = ? AND project_id = ?");
    expect(db.runs[0].values).toEqual(["renamed", "key_1", "org_1", "prj_1"]);
  });

  it("lets a non-admin narrow permissions to a subset of its own", async () => {
    const db = new RecordingDb();
    const service = new ApiKeyService(db);

    await service.updateApiKey({
      ...base,
      actorPermissions: ["payments:read", "payments:write", "api-keys:write"],
      permissions: ["payments:read"],
    });

    expect(db.runs).toHaveLength(1);
    expect(db.runs[0].values).toEqual([
      JSON.stringify(["payments:read"]),
      "key_1",
      "org_1",
      "prj_1",
    ]);
  });

  it("throws when there are no fields to update", async () => {
    const db = new RecordingDb();
    const service = new ApiKeyService(db);

    await expect(
      service.updateApiKey({ ...base, actorPermissions: ["org:admin"] })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    expect(db.runs).toHaveLength(0);
  });
});
