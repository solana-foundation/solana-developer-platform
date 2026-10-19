import { beforeEach, describe, expect, it, vi } from "vitest";
import { getDb } from "@/db";
import { runWithTenantDatabaseIdentity } from "@/db/identity";
import { env } from "@/test/helpers/env";
import { seedDefaultProjects } from "@/test/helpers/projects";
import { seedTestDatabase } from "@/test/mocks/db";
import {
  createPostgresIdempotencyKeyRepository,
  type IdempotencyKeyClaimInput,
} from "./idempotency-keys.repository";

const ORG = "org_idem_repo";
const OTHER_ORG = "org_idem_repo_other";
const USER = "usr_idem_repo";
const PROJECT = `prj_${ORG}_sandbox`;

async function seed(): Promise<void> {
  const db = getDb(env);
  await db
    .prepare(
      `INSERT INTO users (id, email, email_verified, status)
       VALUES (?, 'idem-repo@example.com', 1, 'active') ON CONFLICT (id) DO NOTHING`
    )
    .bind(USER)
    .run();
  for (const org of [ORG, OTHER_ORG]) {
    await db
      .prepare(
        `INSERT INTO organizations (id, name, slug, tier, status)
         VALUES (?, ?, ?, 'individual', 'active') ON CONFLICT (id) DO NOTHING`
      )
      .bind(org, org, org)
      .run();
  }
  await seedDefaultProjects(db, { organizationId: ORG, createdBy: USER, members: [USER] });
}

let sequence = 0;
function claimInput(overrides: Partial<IdempotencyKeyClaimInput> = {}): IdempotencyKeyClaimInput {
  sequence += 1;
  return {
    id: `idk_test_${sequence}`,
    claimToken: `token_${sequence}`,
    organizationId: ORG,
    projectId: PROJECT,
    operation: "POST /v1/things",
    idempotencyKey: "key-1",
    principal: "key_api_1",
    fingerprint: "fp-1",
    takeOverLapsed: true,
    presumedLiveSeconds: 0,
    leaseSeconds: 60,
    retentionSeconds: 86_400,
    ...overrides,
  };
}

const RESPONSE = { status: 201, headers: { "content-type": "application/json" }, body: "{}" };

describe("idempotency keys repository", () => {
  const repository = () => createPostgresIdempotencyKeyRepository(getDb(env));

  beforeEach(async () => {
    await seedTestDatabase(env);
    await seed();
  });

  it("lets a request take over an expired lease only with the same fingerprint", async () => {
    const first = claimInput();
    expect(await repository().claim(first)).toEqual({
      kind: "claimed",
      fresh: true,
      replacedUnfinished: false,
    });
    await repository().unlock(first.id, first.claimToken);

    expect(await repository().claim(claimInput({ fingerprint: "fp-2" }))).toEqual({
      kind: "mismatch",
    });
    const second = claimInput();
    expect(await repository().claim(second)).toEqual({
      kind: "claimed",
      fresh: false,
      replacedUnfinished: false,
    });

    // The first request outlived its lease: it can no longer record an outcome.
    expect(await repository().complete(first.id, first.claimToken, RESPONSE)).toBe(false);
    expect(await repository().complete(second.id, second.claimToken, RESPONSE)).toBe(true);
    expect(await repository().claim(claimInput())).toEqual({
      kind: "completed",
      response: RESPONSE,
    });
  });

  it("renews only the holder's lease, and ignores stale tokens", async () => {
    const first = claimInput();
    await repository().claim(first);
    expect(await repository().renew(first.id, first.claimToken, 60)).toBe(true);
    expect(await repository().renew(first.id, "stale", 60)).toBe(false);

    await repository().discard(first.id, "stale");
    await repository().unlock(first.id, "stale");
    expect(await repository().claim(claimInput())).toMatchObject({ kind: "in_flight" });
  });

  it("takes over a lapsed, never-released claim only when the route allows it", async () => {
    const crashed = claimInput();
    await repository().claim(crashed);
    await getDb(env).execute(
      `UPDATE idempotency_keys SET locked_until = now() - interval '1 second' WHERE id = ?`,
      [crashed.id]
    );

    expect(await repository().claim(claimInput({ takeOverLapsed: false }))).toEqual({
      kind: "outcome_unknown",
    });
    expect(await repository().claim(claimInput({ takeOverLapsed: true }))).toEqual({
      kind: "claimed",
      fresh: false,
      replacedUnfinished: false,
    });
  });

  it.each([true, false])(
    "answers a lapsed claim in flight until the renewal cap plus lease has passed (takeOverLapsed %s)",
    async (takeOverLapsed) => {
      const lapsed = claimInput();
      await repository().claim(lapsed);
      await getDb(env).execute(
        `UPDATE idempotency_keys SET locked_until = now() - interval '1 second' WHERE id = ?`,
        [lapsed.id]
      );

      const within = await repository().claim(
        claimInput({ takeOverLapsed, presumedLiveSeconds: 900 })
      );
      expect(within).toMatchObject({ kind: "in_flight" });
      expect(within.kind === "in_flight" && within.retryAfterSeconds).toBe(60);

      await getDb(env).execute(
        `UPDATE idempotency_keys SET claimed_at = now() - interval '901 seconds' WHERE id = ?`,
        [lapsed.id]
      );
      expect(
        await repository().claim(claimInput({ takeOverLapsed, presumedLiveSeconds: 900 }))
      ).toEqual(
        takeOverLapsed
          ? { kind: "claimed", fresh: false, replacedUnfinished: false }
          : { kind: "outcome_unknown" }
      );
    }
  );

  it("takes over a released claim at once, whatever the window", async () => {
    const released = claimInput();
    await repository().claim(released);
    await repository().unlock(released.id, released.claimToken);

    expect(
      await repository().claim(claimInput({ takeOverLapsed: false, presumedLiveSeconds: 900 }))
    ).toEqual({ kind: "claimed", fresh: false, replacedUnfinished: false });
  });

  it("takes over a released claim even when lapsed claims stay in flight", async () => {
    const released = claimInput();
    await repository().claim(released);
    await repository().unlock(released.id, released.claimToken);

    expect(await repository().claim(claimInput({ takeOverLapsed: false }))).toEqual({
      kind: "claimed",
      fresh: false,
      replacedUnfinished: false,
    });
  });

  it.each([
    { claim: "lapsed, on a route that may take it over", release: false, takeOverLapsed: true },
    { claim: "released, on any route", release: true, takeOverLapsed: false },
  ])(
    "claims again when a $claim claim's lease ends between the takeover and the read",
    async ({ release, takeOverLapsed }) => {
      const first = claimInput();
      await repository().claim(first);
      if (release) {
        await repository().unlock(first.id, first.claimToken);
      } else {
        await getDb(env).execute(
          `UPDATE idempotency_keys SET locked_until = now() - interval '1 second' WHERE id = ?`,
          [first.id]
        );
      }
      // The first takeover statement still saw the lease live.
      const db = getDb(env);
      const prepare = db.prepare.bind(db);
      let raced = false;
      const spy = vi.spyOn(db, "prepare").mockImplementation((query) => {
        const statement = prepare(query);
        if (!raced && query.includes("SET id = ?, claim_token = ?")) {
          raced = true;
          vi.spyOn(statement, "bind").mockReturnValue(statement);
          vi.spyOn(statement, "first").mockResolvedValue(null);
        }
        return statement;
      });
      try {
        expect(
          await createPostgresIdempotencyKeyRepository(db).claim(claimInput({ takeOverLapsed }))
        ).toEqual({ kind: "claimed", fresh: false, replacedUnfinished: false });
        expect(raced).toBe(true);
      } finally {
        spy.mockRestore();
      }
    }
  );

  it("stores and replays a bodyless response", async () => {
    const first = claimInput();
    await repository().claim(first);
    const bodyless = { status: 204, headers: {}, body: null };
    await repository().complete(first.id, first.claimToken, bodyless);
    expect(await repository().claim(claimInput())).toEqual({
      kind: "completed",
      response: bodyless,
    });
  });

  it("refuses the key to another credential, even for the same request", async () => {
    await repository().claim(claimInput());
    expect(await repository().claim(claimInput({ principal: "key_api_2" }))).toEqual({
      kind: "mismatch",
    });
  });

  it("treats an expired row as a new key", async () => {
    const first = claimInput();
    await repository().claim(first);
    await repository().complete(first.id, first.claimToken, RESPONSE);
    await getDb(env).execute(
      `UPDATE idempotency_keys SET expires_at = now() - interval '1 second' WHERE id = ?`,
      [first.id]
    );

    expect(await repository().claim(claimInput({ fingerprint: "fp-2" }))).toEqual({
      kind: "claimed",
      fresh: true,
      replacedUnfinished: false,
    });
  });

  it("reports an expired unfinished row its claim replaces", async () => {
    const abandoned = claimInput();
    await repository().claim(abandoned);
    await getDb(env).execute(
      `UPDATE idempotency_keys SET expires_at = now() - interval '1 second' WHERE id = ?`,
      [abandoned.id]
    );
    expect(await repository().claim(claimInput())).toEqual({
      kind: "claimed",
      fresh: true,
      replacedUnfinished: true,
    });
  });

  it("does not report a released row its claim replaces, and reports one taken over and lapsed", async () => {
    const released = claimInput();
    await repository().claim(released);
    await repository().unlock(released.id, released.claimToken);
    await getDb(env).execute(
      `UPDATE idempotency_keys SET expires_at = now() - interval '1 second' WHERE id = ?`,
      [released.id]
    );
    expect(await repository().claim(claimInput())).toEqual({
      kind: "claimed",
      fresh: true,
      replacedUnfinished: false,
    });

    // Released, then taken over by a request that crashed: its lease lapsed.
    const first = claimInput({ idempotencyKey: "key-takeover" });
    await repository().claim(first);
    await repository().unlock(first.id, first.claimToken);
    const takeover = claimInput({ idempotencyKey: "key-takeover" });
    expect(await repository().claim(takeover)).toMatchObject({ kind: "claimed", fresh: false });
    await getDb(env).execute(
      `UPDATE idempotency_keys SET expires_at = now() - interval '1 second' WHERE id = ?`,
      [takeover.id]
    );
    expect(await repository().claim(claimInput({ idempotencyKey: "key-takeover" }))).toEqual({
      kind: "claimed",
      fresh: true,
      replacedUnfinished: true,
    });
  });

  it("prunes a released row without counting it unfinished", async () => {
    const released = claimInput({ idempotencyKey: "released" });
    await repository().claim(released);
    await repository().unlock(released.id, released.claimToken);
    const lapsed = claimInput({ idempotencyKey: "lapsed" });
    await repository().claim(lapsed);
    await getDb(env).execute(
      `UPDATE idempotency_keys SET expires_at = now() - interval '1 second' WHERE id IN (?, ?)`,
      [released.id, lapsed.id]
    );

    expect(await repository().pruneExpired(100)).toEqual({ deleted: 2, unfinished: 1 });
  });

  it("fails loudly when the prune query returns no row", async () => {
    const db = getDb(env);
    const statement = db.prepare("SELECT 1");
    const bind = vi.spyOn(statement, "bind").mockReturnValue(statement);
    const first = vi.spyOn(statement, "first").mockResolvedValue(null);
    const prepare = vi.spyOn(db, "prepare").mockReturnValue(statement);
    try {
      await expect(createPostgresIdempotencyKeyRepository(db).pruneExpired(100)).rejects.toThrow(
        "idempotency key prune returned no row"
      );
    } finally {
      prepare.mockRestore();
      first.mockRestore();
      bind.mockRestore();
    }
  });

  it("requires a project on every key", async () => {
    await expect(
      getDb(env).execute(
        `INSERT INTO idempotency_keys
           (id, organization_id, project_id, operation, idempotency_key, principal, fingerprint,
            status, claim_token, locked_until, expires_at)
         VALUES ('idk_no_project', ?, NULL, 'POST /v1/things', 'k', 'p', 'f',
                 'in_progress', 't', now(), now() + interval '1 day')`,
        [ORG]
      )
    ).rejects.toThrow(/project_id/);
  });

  it("prunes only expired rows", async () => {
    const expired = claimInput({ idempotencyKey: "expired" });
    await repository().claim(expired);
    await repository().claim(claimInput({ idempotencyKey: "live" }));
    await getDb(env).execute(
      `UPDATE idempotency_keys SET expires_at = now() - interval '1 second' WHERE id = ?`,
      [expired.id]
    );

    expect(await repository().pruneExpired(100)).toEqual({ deleted: 1, unfinished: 1 });
    const left = await getDb(env).queryMany<{ idempotency_key: string }>(
      "SELECT idempotency_key FROM idempotency_keys"
    );
    expect(left).toEqual([{ idempotency_key: "live" }]);
  });

  it("hides another organization's keys from a tenant", async () => {
    await repository().claim(claimInput());
    const seen = await runWithTenantDatabaseIdentity({ organizationId: OTHER_ORG }, () =>
      getDb(env).queryMany("SELECT id FROM idempotency_keys")
    );
    expect(seen).toEqual([]);
  });
});
