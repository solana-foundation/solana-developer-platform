import { SANDBOX_DEFAULTS } from "@sdp/private-channels";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { getDb } from "@/db";
import { TEST_ORG, TEST_USER } from "@/test/fixtures/organizations";
import { env } from "@/test/helpers/env";
import { seedTestDatabase } from "@/test/mocks/db";
import type { PrivateChannelInstanceRepository } from "./private-channel-instance.repository";
import { createPostgresPrivateChannelInstanceRepository } from "./private-channel-instance.repository.postgres";

const TEST_PROJECT_ID = "prj_pci_repo_test";
const OTHER_PROJECT_ID = "prj_pci_repo_test_other";

describe("PrivateChannelInstanceRepository (postgres)", () => {
  let repo: PrivateChannelInstanceRepository;

  beforeAll(async () => {
    await seedTestDatabase(env as Parameters<typeof seedTestDatabase>[0]);
  });

  afterAll(async () => {
    await seedTestDatabase(env as Parameters<typeof seedTestDatabase>[0]);
  });

  beforeEach(async () => {
    const db = getDb(env);
    await db.prepare("DELETE FROM private_channel_instances").run();
    await db.prepare("DELETE FROM projects").run();

    await db
      .prepare(
        "INSERT OR REPLACE INTO organizations (id, name, slug, tier, status) VALUES (?, ?, ?, 'individual', 'active')"
      )
      .bind(TEST_ORG.id, TEST_ORG.name, TEST_ORG.slug)
      .run();
    await db
      .prepare(
        "INSERT OR REPLACE INTO users (id, email, email_verified, status) VALUES (?, ?, 1, 'active')"
      )
      .bind(TEST_USER.id, TEST_USER.email)
      .run();
    for (const projectId of [TEST_PROJECT_ID, OTHER_PROJECT_ID]) {
      await db
        .prepare(
          `INSERT INTO projects (id, organization_id, name, slug, environment, status, created_by)
             VALUES (?, ?, 'Test Project', ?, 'sandbox', 'active', ?)`
        )
        .bind(projectId, TEST_ORG.id, projectId, TEST_USER.id)
        .run();
    }

    repo = createPostgresPrivateChannelInstanceRepository(db);
  });

  it("getActiveByProject returns null when no row exists", async () => {
    const row = await repo.getActiveByProject({
      organizationId: TEST_ORG.id,
      projectId: TEST_PROJECT_ID,
    });
    expect(row).toBeNull();
  });

  it("createActive inserts a row with is_active=true and returns it", async () => {
    const inserted = await repo.createActive({
      organizationId: TEST_ORG.id,
      projectId: TEST_PROJECT_ID,
      createdBy: TEST_USER.id,
      ...SANDBOX_DEFAULTS,
    });

    expect(inserted).not.toBeNull();
    if (!inserted) return;
    expect(inserted.id).toMatch(/^pci_/);
    expect(inserted.gateway_url).toBe(SANDBOX_DEFAULTS.gatewayUrl);
    expect(inserted.is_active).toBe(true);
    expect(inserted.auth_url).toBe(SANDBOX_DEFAULTS.authUrl);

    const fetched = await repo.getActiveByProject({
      organizationId: TEST_ORG.id,
      projectId: TEST_PROJECT_ID,
    });
    expect(fetched?.id).toBe(inserted.id);
  });

  it("deactivateActive flips is_active to false; getActiveByProject then returns null", async () => {
    const created = await repo.createActive({
      organizationId: TEST_ORG.id,
      projectId: TEST_PROJECT_ID,
      createdBy: TEST_USER.id,
      ...SANDBOX_DEFAULTS,
    });
    expect(created).not.toBeNull();

    const deactivated = await repo.deactivateActive({
      organizationId: TEST_ORG.id,
      projectId: TEST_PROJECT_ID,
    });
    expect(deactivated?.is_active).toBe(false);

    const active = await repo.getActiveByProject({
      organizationId: TEST_ORG.id,
      projectId: TEST_PROJECT_ID,
    });
    expect(active).toBeNull();
  });

  it("findByProjectAndGateway returns inactive rows too", async () => {
    await repo.createActive({
      organizationId: TEST_ORG.id,
      projectId: TEST_PROJECT_ID,
      createdBy: TEST_USER.id,
      ...SANDBOX_DEFAULTS,
    });
    await repo.deactivateActive({
      organizationId: TEST_ORG.id,
      projectId: TEST_PROJECT_ID,
    });

    const found = await repo.findByProjectAndGateway({
      organizationId: TEST_ORG.id,
      projectId: TEST_PROJECT_ID,
      gatewayUrl: SANDBOX_DEFAULTS.gatewayUrl,
    });
    expect(found?.gateway_url).toBe(SANDBOX_DEFAULTS.gatewayUrl);
    expect(found?.is_active).toBe(false);
  });

  it("reactivateAndUpdate updates editable fields and flips is_active back to true", async () => {
    const created = await repo.createActive({
      organizationId: TEST_ORG.id,
      projectId: TEST_PROJECT_ID,
      createdBy: TEST_USER.id,
      ...SANDBOX_DEFAULTS,
    });
    if (!created) throw new Error("createActive returned null");
    await repo.deactivateActive({
      organizationId: TEST_ORG.id,
      projectId: TEST_PROJECT_ID,
    });

    const reactivated = await repo.reactivateAndUpdate({
      id: created.id,
      ...SANDBOX_DEFAULTS,
      chainRpcUrl: "https://mainnet.helius-rpc.com/?api-key=NEW",
      authUrl: "http://auth.example:8903",
    });
    expect(reactivated?.id).toBe(created.id);
    expect(reactivated?.is_active).toBe(true);
    expect(reactivated?.chain_rpc_url).toBe("https://mainnet.helius-rpc.com/?api-key=NEW");
    expect(reactivated?.auth_url).toBe("http://auth.example:8903");
    // gateway_url is the identity key and must not change on reactivation.
    expect(reactivated?.gateway_url).toBe(created.gateway_url);
  });

  it("deleteActive removes the active row", async () => {
    await repo.createActive({
      organizationId: TEST_ORG.id,
      projectId: TEST_PROJECT_ID,
      createdBy: TEST_USER.id,
      ...SANDBOX_DEFAULTS,
    });
    const ok = await repo.deleteActive({
      organizationId: TEST_ORG.id,
      projectId: TEST_PROJECT_ID,
    });
    expect(ok).toBe(true);

    const active = await repo.getActiveByProject({
      organizationId: TEST_ORG.id,
      projectId: TEST_PROJECT_ID,
    });
    expect(active).toBeNull();
  });

  it("scopes reads by (organizationId, projectId): other project's row is not visible", async () => {
    await repo.createActive({
      organizationId: TEST_ORG.id,
      projectId: OTHER_PROJECT_ID,
      createdBy: TEST_USER.id,
      ...SANDBOX_DEFAULTS,
      gatewayUrl: "http://other.example:8899",
    });

    const row = await repo.getActiveByProject({
      organizationId: TEST_ORG.id,
      projectId: TEST_PROJECT_ID,
    });
    expect(row).toBeNull();
  });
});
