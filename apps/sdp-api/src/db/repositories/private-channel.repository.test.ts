import { beforeEach, describe, expect, it } from "vitest";
import { getDb } from "@/db";
import { TEST_ORG, TEST_USER } from "@/test/fixtures/organizations";
import { env } from "@/test/helpers/env";
import { seedTestDatabase } from "@/test/mocks/db";
import type { PrivateChannelRepository } from "./private-channel.repository";
import { createPostgresPrivateChannelRepository } from "./private-channel.repository.postgres";

const TEST_PROJECT_ID = "prj_pch_repo_test";
const TEST_ORG_ID = TEST_ORG.id;
const TEST_INSTANCE_ID = "pci_pch_repo_test";
const OTHER_INSTANCE_ID = "pci_pch_repo_test_other";
const SCOPE = {
  instanceId: TEST_INSTANCE_ID,
  organizationId: TEST_ORG_ID,
  projectId: TEST_PROJECT_ID,
};

async function seedInstance(db: ReturnType<typeof getDb>, id: string): Promise<void> {
  await db
    .prepare(
      `INSERT INTO private_channel_instances
         (id, organization_id, project_id, gateway_url,
          escrow_program_id, withdraw_program_id, escrow_instance_addr, auth_url, is_active)
       VALUES (?, ?, ?, ?, 'prog1', 'prog2', 'escrow1', 'http://auth', ?)`
    )
    // gateway_url is unique per (project, gateway); each instance needs its own.
    .bind(id, TEST_ORG_ID, TEST_PROJECT_ID, `http://gw/${id}`, id === TEST_INSTANCE_ID ? 1 : 0)
    .run();
}

/** Insert a channel with an explicit created_at, which createChannel cannot set. */
async function seedChannelAt(id: string, name: string, createdAt: string): Promise<void> {
  await getDb(env)
    .prepare(
      `INSERT INTO private_channels
         (id, organization_id, project_id, instance_id, name, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'active', ?, ?)`
    )
    .bind(id, TEST_ORG_ID, TEST_PROJECT_ID, TEST_INSTANCE_ID, name, createdAt, createdAt)
    .run();
}

describe("PrivateChannelRepository (postgres)", () => {
  let repo: PrivateChannelRepository;

  beforeEach(async () => {
    await seedTestDatabase(env);
    const db = getDb(env);

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

    await db
      .prepare(
        `INSERT INTO projects (id, organization_id, name, slug, environment, status, created_by)
         VALUES (?, ?, 'Test Project', 'test-project', 'sandbox', 'active', ?)`
      )
      .bind(TEST_PROJECT_ID, TEST_ORG.id, TEST_USER.id)
      .run();

    await seedInstance(db, TEST_INSTANCE_ID);
    await seedInstance(db, OTHER_INSTANCE_ID);

    repo = createPostgresPrivateChannelRepository(db);
  });

  describe("getOrCreateDefault", () => {
    it("creates the default channel on first call", async () => {
      const { channel, created } = await repo.getOrCreateDefault(SCOPE);
      expect(created).toBe(true);
      expect(channel.id).toMatch(/^pch_/);
      expect(channel.organization_id).toBe(TEST_ORG_ID);
      expect(channel.project_id).toBe(TEST_PROJECT_ID);
      expect(channel.instance_id).toBe(TEST_INSTANCE_ID);
      expect(channel.is_default).toBe(true);
      expect(channel.status).toBe("active");
      expect(channel.name).toBe("Default");
    });

    it("is idempotent — a second call returns the same row, one default total", async () => {
      const first = await repo.getOrCreateDefault(SCOPE);
      const second = await repo.getOrCreateDefault(SCOPE);
      expect(first.created).toBe(true);
      expect(second.created).toBe(false);
      expect(second.channel.id).toBe(first.channel.id);

      const rows = await repo.listChannels({ instanceId: TEST_INSTANCE_ID });
      expect(rows.filter((r) => r.is_default)).toHaveLength(1);
    });

    it("falls back to a suffixed name if a non-default channel already holds 'Default'", async () => {
      const named = await repo.createChannel({ ...SCOPE, name: "Default", description: null });
      expect(named?.is_default).toBe(false);

      const { channel: def, created } = await repo.getOrCreateDefault(SCOPE);
      expect(created).toBe(true);
      expect(def.is_default).toBe(true);
      expect(def.name).not.toBe("Default");
    });
  });

  describe("createChannel", () => {
    it("creates a non-default channel with a generated id", async () => {
      const channel = await repo.createChannel({
        ...SCOPE,
        name: "Treasury",
        description: "Ops payouts",
      });
      expect(channel?.id).toMatch(/^pch_/);
      expect(channel?.organization_id).toBe(TEST_ORG_ID);
      expect(channel?.instance_id).toBe(TEST_INSTANCE_ID);
      expect(channel?.is_default).toBe(false);
      expect(channel?.name).toBe("Treasury");
      expect(channel?.description).toBe("Ops payouts");
    });

    it("returns null on duplicate name within the instance", async () => {
      await repo.createChannel({ ...SCOPE, name: "Treasury", description: null });
      const dup = await repo.createChannel({ ...SCOPE, name: "Treasury", description: null });
      expect(dup).toBeNull();
    });

    it("allows the same name in a different instance", async () => {
      await repo.createChannel({ ...SCOPE, name: "Treasury", description: null });
      const other = await repo.createChannel({
        instanceId: OTHER_INSTANCE_ID,
        organizationId: TEST_ORG_ID,
        projectId: TEST_PROJECT_ID,
        name: "Treasury",
        description: null,
      });
      expect(other?.instance_id).toBe(OTHER_INSTANCE_ID);
    });
  });

  describe("listChannels", () => {
    it("returns the instance's active channels", async () => {
      const first = await repo.createChannel({ ...SCOPE, name: "Alpha", description: null });
      const second = await repo.createChannel({ ...SCOPE, name: "Beta", description: null });
      const rows = await repo.listChannels({ instanceId: TEST_INSTANCE_ID });
      // createChannel takes no created_at, so back-to-back creates can land in the
      // same millisecond (sdp_iso_now() is millisecond precision). Sequence is
      // asserted separately below, on rows seeded with explicit timestamps.
      expect(rows).toHaveLength(2);
      expect(new Set(rows.map((r) => r.id))).toEqual(new Set([first?.id, second?.id]));
    });

    it("orders by created_at DESC, newest first", async () => {
      await seedChannelAt("pch_older", "Older", "2026-01-01T00:00:00.000Z");
      await seedChannelAt("pch_newer", "Newer", "2026-02-01T00:00:00.000Z");

      const rows = await repo.listChannels({ instanceId: TEST_INSTANCE_ID });

      expect(rows.map((r) => r.id)).toEqual(["pch_newer", "pch_older"]);
    });

    it("breaks created_at ties on id DESC, so equal timestamps still order stably", async () => {
      // The whole point of the `, id DESC` tie-break: same-millisecond rows must
      // come back in one fixed order, not whichever order Postgres happens to pick.
      const sameInstant = "2026-03-01T00:00:00.000Z";
      await seedChannelAt("pch_aaa", "Aaa", sameInstant);
      await seedChannelAt("pch_bbb", "Bbb", sameInstant);
      await seedChannelAt("pch_ccc", "Ccc", sameInstant);

      const first = await repo.listChannels({ instanceId: TEST_INSTANCE_ID });
      const second = await repo.listChannels({ instanceId: TEST_INSTANCE_ID });

      expect(first.map((r) => r.id)).toEqual(["pch_ccc", "pch_bbb", "pch_aaa"]);
      expect(second.map((r) => r.id)).toEqual(first.map((r) => r.id));
    });
  });

  describe("getChannel / archiveChannel", () => {
    it("fetches then archives a channel scoped to the instance", async () => {
      const channel = await repo.createChannel({ ...SCOPE, name: "Ops", description: null });
      expect(channel?.status).toBe("active");

      const fetched = await repo.getChannel({
        channelId: channel?.id ?? "",
        instanceId: TEST_INSTANCE_ID,
      });
      expect(fetched?.id).toBe(channel?.id);

      const archived = await repo.archiveChannel({
        channelId: channel?.id ?? "",
        instanceId: TEST_INSTANCE_ID,
      });
      expect(archived).toBe(true);
      // Archived channels are hidden from getChannel and listChannels.
      expect(
        await repo.getChannel({ channelId: channel?.id ?? "", instanceId: TEST_INSTANCE_ID })
      ).toBeNull();
      expect(await repo.listChannels({ instanceId: TEST_INSTANCE_ID })).toHaveLength(0);
    });

    it("keeps an archived channel's name reserved (no reuse)", async () => {
      const first = await repo.createChannel({ ...SCOPE, name: "Treasury", description: null });
      await repo.archiveChannel({ channelId: first?.id ?? "", instanceId: TEST_INSTANCE_ID });

      const second = await repo.createChannel({ ...SCOPE, name: "Treasury", description: null });
      expect(second).toBeNull();
    });

    it("returns false when archiving an already-archived channel", async () => {
      const channel = await repo.createChannel({ ...SCOPE, name: "Ops", description: null });
      await repo.archiveChannel({ channelId: channel?.id ?? "", instanceId: TEST_INSTANCE_ID });
      const again = await repo.archiveChannel({
        channelId: channel?.id ?? "",
        instanceId: TEST_INSTANCE_ID,
      });
      expect(again).toBe(false);
    });

    it("does not archive a channel from another instance (tenancy guard)", async () => {
      const channel = await repo.createChannel({ ...SCOPE, name: "Ops", description: null });
      const archived = await repo.archiveChannel({
        channelId: channel?.id ?? "",
        instanceId: OTHER_INSTANCE_ID,
      });
      expect(archived).toBe(false);
    });

    it("does not fetch a channel from another instance (tenancy guard)", async () => {
      const channel = await repo.createChannel({ ...SCOPE, name: "Ops", description: null });
      const fetched = await repo.getChannel({
        channelId: channel?.id ?? "",
        instanceId: OTHER_INSTANCE_ID,
      });
      expect(fetched).toBeNull();
    });
  });
});
