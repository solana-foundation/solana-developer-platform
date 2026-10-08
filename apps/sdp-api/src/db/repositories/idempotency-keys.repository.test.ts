import { beforeEach, describe, expect, it } from "vitest";
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
    fingerprint: "fp-1",
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
    expect(await repository().claim(first)).toEqual({ kind: "claimed", fresh: true });
    await repository().unlock(first.id, first.claimToken);

    expect(await repository().claim(claimInput({ fingerprint: "fp-2" }))).toEqual({
      kind: "mismatch",
    });
    const second = claimInput();
    expect(await repository().claim(second)).toEqual({ kind: "claimed", fresh: false });

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
    });
  });

  it("keeps project-less keys unique", async () => {
    expect(await repository().claim(claimInput({ projectId: null }))).toEqual({
      kind: "claimed",
      fresh: true,
    });
    expect(await repository().claim(claimInput({ projectId: null }))).toMatchObject({
      kind: "in_flight",
    });
  });

  it("prunes only expired rows", async () => {
    const expired = claimInput({ idempotencyKey: "expired" });
    await repository().claim(expired);
    await repository().claim(claimInput({ idempotencyKey: "live" }));
    await getDb(env).execute(
      `UPDATE idempotency_keys SET expires_at = now() - interval '1 second' WHERE id = ?`,
      [expired.id]
    );

    expect(await repository().pruneExpired(100)).toBe(1);
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
