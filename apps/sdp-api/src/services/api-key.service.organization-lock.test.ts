import { beforeEach, describe, expect, it } from "vitest";
import {
  asTransactionalClient,
  getDb,
  runWithSystemDatabaseIdentity,
  runWithTenantDatabaseIdentity,
} from "@/db";
import { createTenantScope } from "@/lib/tenant-scope";
import { TEST_ORG, TEST_USER } from "@/test/fixtures/organizations";
import { TEST_PRODUCTION_PROJECT, TEST_PROJECT } from "@/test/fixtures/tokens";
import { env } from "@/test/helpers/env";
import { seedDefaultProjects } from "@/test/helpers/projects";
import { seedTestDatabase } from "@/test/mocks/db";
import { ApiKeyService, type CreateApiKeyInput } from "./api-key.service";

/**
 * APE-358: a key created while its organization is being deleted must not
 * commit active under the deleted organization. The create reads the
 * organization with a share lock in its own transaction, so it either finishes
 * first (and the deletion's revocation then sees the new key) or waits for the
 * deletion and finds the organization gone.
 */

const INPUT: CreateApiKeyInput = {
  organizationId: TEST_ORG.id,
  projectId: TEST_PROJECT.id,
  createdByUserId: TEST_USER.id,
  actorPermissions: ["*"],
  actorApiKeyRole: null,
  actorAllowedOperations: null,
  name: "Racing key",
  role: "api_readonly",
};

function createKey(): Promise<unknown> {
  return runWithTenantDatabaseIdentity({ organizationId: TEST_ORG.id }, () =>
    getDb(env).transaction((tx) =>
      new ApiKeyService(
        asTransactionalClient(tx),
        createTenantScope({ organizationId: TEST_ORG.id, projectId: TEST_PROJECT.id })
      ).createApiKey(INPUT)
    )
  );
}

async function keyCount(): Promise<number> {
  const row = await runWithSystemDatabaseIdentity("test:api-key-lock", () =>
    getDb(env)
      .prepare("SELECT COUNT(*) AS total FROM api_keys WHERE organization_id = ?")
      .bind(TEST_ORG.id)
      .first<{ total: number | string }>()
  );
  return Number(row?.total ?? 0);
}

async function waitForLockWait(): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const waiting = await runWithSystemDatabaseIdentity("test:api-key-lock", () =>
      getDb(env).queryMany<{ pid: string }>(
        `SELECT pid::text AS pid FROM pg_stat_activity
          WHERE datname = current_database() AND wait_event_type = 'Lock'`
      )
    );
    if (waiting.length > 0) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("the key creation never waited on the organization lock");
}

describe("ApiKeyService.createApiKey and organization deletion (APE-358)", () => {
  beforeEach(async () => {
    await seedTestDatabase(env);
    const db = getDb(env);
    await db.batch([
      db
        .prepare("INSERT INTO organizations (id, name, slug, tier, status) VALUES (?, ?, ?, ?, ?)")
        .bind(TEST_ORG.id, TEST_ORG.name, TEST_ORG.slug, TEST_ORG.tier, "active"),
      db
        .prepare("INSERT INTO users (id, email, email_verified, status) VALUES (?, ?, 1, 'active')")
        .bind(TEST_USER.id, TEST_USER.email),
    ]);
    await seedDefaultProjects(db, {
      organizationId: TEST_ORG.id,
      createdBy: TEST_USER.id,
      members: [TEST_USER.id],
      ids: { sandbox: TEST_PROJECT.id, production: TEST_PRODUCTION_PROJECT.id },
    });
  });

  it("refuses to create a key for a deleted organization", async () => {
    await getDb(env)
      .prepare("UPDATE organizations SET status = 'deleted' WHERE id = ?")
      .bind(TEST_ORG.id)
      .run();

    await expect(createKey()).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(await keyCount()).toBe(0);
  });

  it("waits for a deletion in flight before rotating, and then rotates nothing", async () => {
    const created = (await createKey()) as { id: string };
    expect(await keyCount()).toBe(1);
    let releaseDeletion!: () => void;
    const deletionReleased = new Promise<void>((resolve) => {
      releaseDeletion = resolve;
    });
    let markDeletionWritten!: () => void;
    const deletionWritten = new Promise<void>((resolve) => {
      markDeletionWritten = resolve;
    });
    const deletion = runWithSystemDatabaseIdentity("test:api-key-lock", () =>
      getDb(env).transaction(async (tx) => {
        await tx
          .prepare("UPDATE organizations SET status = 'deleted' WHERE id = ?")
          .bind(TEST_ORG.id)
          .run();
        markDeletionWritten();
        await deletionReleased;
      })
    );

    try {
      await deletionWritten;
      const rotation = runWithTenantDatabaseIdentity({ organizationId: TEST_ORG.id }, () =>
        new ApiKeyService(
          getDb(env),
          createTenantScope({ organizationId: TEST_ORG.id, projectId: TEST_PROJECT.id })
        ).rotateApiKey(created.id, TEST_ORG.id, TEST_PROJECT.id, 24, ["*"], null, null)
      ).then(
        (result) => result,
        (error: unknown) => error
      );
      await waitForLockWait();
      releaseDeletion();
      await deletion;

      expect(await rotation).toBeNull();
      expect(await keyCount()).toBe(1);
    } finally {
      releaseDeletion();
      await deletion.catch(() => {});
    }
  });

  it("waits for a deletion in flight and then refuses, rather than committing an active key", async () => {
    let releaseDeletion!: () => void;
    const deletionReleased = new Promise<void>((resolve) => {
      releaseDeletion = resolve;
    });
    let markDeletionWritten!: () => void;
    const deletionWritten = new Promise<void>((resolve) => {
      markDeletionWritten = resolve;
    });
    const deletion = runWithSystemDatabaseIdentity("test:api-key-lock", () =>
      getDb(env).transaction(async (tx) => {
        await tx
          .prepare("UPDATE organizations SET status = 'deleted' WHERE id = ?")
          .bind(TEST_ORG.id)
          .run();
        markDeletionWritten();
        await deletionReleased;
      })
    );

    try {
      await deletionWritten;
      const creation = createKey().then(
        () => "created",
        (error: unknown) => error
      );
      await waitForLockWait();
      releaseDeletion();
      await deletion;

      expect(await creation).toMatchObject({ code: "NOT_FOUND" });
      expect(await keyCount()).toBe(0);
    } finally {
      releaseDeletion();
      await deletion.catch(() => {});
    }
  });
});
