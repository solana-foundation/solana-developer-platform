import { Hono } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AppError } from "@/lib/errors";
import { env } from "@/test/helpers/env";
import type { Env } from "@/types/env";

const { addEntryMock, auditLogMock } = vi.hoisted(() => ({
  addEntryMock: vi.fn(),
  auditLogMock: vi.fn(),
}));

vi.mock("@/services/allowlist.service", () => ({
  createAllowlistService: () => ({ addEntry: addEntryMock }),
}));

vi.mock("@/services/audit.service", () => ({
  AuditService: class {
    log = auditLogMock;
  },
}));

import { addEntry } from "./handlers";

/**
 * Mimics `pg` unique-constraint error: SQLSTATE 23505 with Postgres
 * message wording. Note it do NOT contain SQLite string "UNIQUE
 * constraint", which is exactly why handler must key off error code.
 */
function postgresUniqueViolation(): Error {
  return Object.assign(
    new Error('duplicate key value violates unique constraint "allowlist_type_value_key"'),
    { code: "23505" }
  );
}

function buildApp() {
  const app = new Hono<{ Bindings: Env }>();
  app.post("/allowlist", addEntry);
  app.onError((err, c) => {
    if (err instanceof AppError) {
      return c.json(err.toResponse(), err.statusCode as ContentfulStatusCode);
    }
    return c.json({ error: { code: "INTERNAL_ERROR", message: (err as Error).message } }, 500);
  });
  return app;
}

async function postEntry() {
  return buildApp().request(
    "/allowlist",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "email", value: "user@example.com" }),
    },
    env
  );
}

describe("allowlist addEntry", () => {
  beforeEach(() => {
    addEntryMock.mockReset();
    auditLogMock.mockReset();
    auditLogMock.mockResolvedValue(undefined);
  });

  it("returns 201 when entry is created", async () => {
    addEntryMock.mockResolvedValue({
      id: "al_1",
      type: "email",
      value: "user@example.com",
      tier: "standard",
      notes: null,
      status: "active",
      createdAt: new Date().toISOString(),
    });

    const res = await postEntry();

    expect(res.status).toBe(201);
    expect(addEntryMock).toHaveBeenCalledOnce();
  });

  it("maps Postgres unique violation to 409 CONFLICT", async () => {
    addEntryMock.mockRejectedValue(postgresUniqueViolation());

    const res = await postEntry();

    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("CONFLICT");
  });

  it("does not treat SQLite-style message as conflict (Postgres keys off error code)", async () => {
    // A stray error whose message contain old SQLite string but carry no
    // Postgres SQLSTATE must not be misreported as 409.
    addEntryMock.mockRejectedValue(new Error("UNIQUE constraint failed: allowlist.value"));

    const res = await postEntry();

    expect(res.status).toBe(500);
  });
});
