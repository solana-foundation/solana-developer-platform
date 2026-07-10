import { Hono } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { beforeEach, describe, expect, it } from "vitest";
import { getDb } from "@/db";
import { AppError } from "@/lib/errors";
import { env } from "@/test/helpers/env";
import type { Env } from "@/types/env";
import { addEntry } from "./handlers";

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
  beforeEach(async () => {
    await getDb(env).prepare("DELETE FROM allowlist").run();
  });

  it("returns 201 when entry is created", async () => {
    const res = await postEntry();

    expect(res.status).toBe(201);
  });

  it("maps a real Postgres unique violation to 409 CONFLICT", async () => {
    expect((await postEntry()).status).toBe(201);

    const res = await postEntry();

    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("CONFLICT");
  });
});
