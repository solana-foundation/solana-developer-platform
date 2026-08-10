import {
  PRIVATE_CHANNEL_EVENT_FAMILIES,
  PRIVATE_CHANNEL_EVENT_STATUSES,
  PRIVATE_CHANNEL_EVENT_TYPES,
} from "@sdp/types";
import { beforeEach, describe, expect, it } from "vitest";
import { getDb } from "@/db";
import { TEST_ORG, TEST_USER } from "@/test/fixtures/organizations";
import { env } from "@/test/helpers/env";
import { seedTestDatabase } from "@/test/mocks/db";
import {
  generatePrivateChannelEventId,
  type PrivateChannelEventRepository,
  type PrivateChannelEventWriteInput,
} from "./private-channel-event.repository";
import { createPostgresPrivateChannelEventRepository } from "./private-channel-event.repository.postgres";

const TEST_PROJECT_ID = "prj_pce_repo_test";
const TEST_INSTANCE_ID = "pci_pce_repo_test";
const TEST_CHANNEL_ID = "pch_pce_repo_test";

function baseEvent(
  overrides: Partial<PrivateChannelEventWriteInput> = {}
): PrivateChannelEventWriteInput {
  const now = new Date().toISOString();
  return {
    id: generatePrivateChannelEventId(),
    organizationId: TEST_ORG.id,
    projectId: TEST_PROJECT_ID,
    instanceId: TEST_INSTANCE_ID,
    channelId: TEST_CHANNEL_ID,
    sdpUserId: TEST_USER.id,
    family: PRIVATE_CHANNEL_EVENT_FAMILIES.LIFECYCLE,
    type: PRIVATE_CHANNEL_EVENT_TYPES.LIFECYCLE_CHANNEL_CREATED,
    status: PRIVATE_CHANNEL_EVENT_STATUSES.INFO,
    payload: { name: "Treasury" },
    occurredAt: now,
    createdAt: now,
    ...overrides,
  };
}

describe("PrivateChannelEventRepository (postgres)", () => {
  let repo: PrivateChannelEventRepository;

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

    await db
      .prepare(
        `INSERT INTO private_channel_instances
           (id, organization_id, project_id, gateway_url, chain_rpc_url,
            escrow_program_id, withdraw_program_id, escrow_instance_addr, auth_url, is_active)
         VALUES (?, ?, ?, 'http://gw', 'http://rpc', 'prog1', 'prog2', 'escrow1', 'http://auth', true)`
      )
      .bind(TEST_INSTANCE_ID, TEST_ORG.id, TEST_PROJECT_ID)
      .run();

    await db
      .prepare(
        `INSERT INTO private_channels
           (id, organization_id, project_id, instance_id, name, is_default, status)
         VALUES (?, ?, ?, ?, 'Default', true, 'active')`
      )
      .bind(TEST_CHANNEL_ID, TEST_ORG.id, TEST_PROJECT_ID, TEST_INSTANCE_ID)
      .run();

    repo = createPostgresPrivateChannelEventRepository(db);
  });

  it("inserts and lists by occurred_at DESC", async () => {
    const older = await repo.insert(
      baseEvent({
        occurredAt: "2026-01-01T00:00:00.000Z",
        type: PRIVATE_CHANNEL_EVENT_TYPES.LIFECYCLE_CHANNEL_CREATED,
      })
    );
    const newer = await repo.insert(
      baseEvent({
        occurredAt: "2026-02-01T00:00:00.000Z",
        type: PRIVATE_CHANNEL_EVENT_TYPES.LIFECYCLE_CHANNEL_ARCHIVED,
        payload: { name: "Default" },
      })
    );

    const { rows, hasMore } = await repo.listByChannel({
      channelId: TEST_CHANNEL_ID,
      instanceId: TEST_INSTANCE_ID,
      viewer: { scope: "all" },
      limit: 50,
    });
    expect(hasMore).toBe(false);
    expect(rows.map((r) => r.id)).toEqual([newer.id, older.id]);
    expect(rows[0]?.payload).toEqual({ name: "Default" });
  });

  it("includes instance-level events but excludes channel-less transfers from channel feeds", async () => {
    await repo.insert(
      baseEvent({
        channelId: null,
        type: PRIVATE_CHANNEL_EVENT_TYPES.LIFECYCLE_INSTANCE_CONNECTED,
        payload: { gatewayUrl: "http://gw" },
      })
    );
    await repo.insert(
      baseEvent({
        channelId: null,
        family: PRIVATE_CHANNEL_EVENT_FAMILIES.TRANSFER,
        type: PRIVATE_CHANNEL_EVENT_TYPES.TRANSFER_TRANSFER_SUBMITTED,
      })
    );
    const { rows } = await repo.listByChannel({
      channelId: TEST_CHANNEL_ID,
      instanceId: TEST_INSTANCE_ID,
      viewer: { scope: "all" },
      limit: 10,
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.type).toBe(PRIVATE_CHANNEL_EVENT_TYPES.LIFECYCLE_INSTANCE_CONNECTED);
    expect(rows[0]?.channel_id).toBeNull();
  });

  it("filters by family and type", async () => {
    await repo.insert(
      baseEvent({
        family: PRIVATE_CHANNEL_EVENT_FAMILIES.LIFECYCLE,
        type: PRIVATE_CHANNEL_EVENT_TYPES.LIFECYCLE_CHANNEL_CREATED,
      })
    );
    await repo.insert(
      baseEvent({
        family: PRIVATE_CHANNEL_EVENT_FAMILIES.ERROR,
        type: PRIVATE_CHANNEL_EVENT_TYPES.ERROR_SPC_UNREACHABLE,
        status: PRIVATE_CHANNEL_EVENT_STATUSES.FAILED,
        payload: { message: "down" },
      })
    );

    const byFamily = await repo.listByChannel({
      channelId: TEST_CHANNEL_ID,
      instanceId: TEST_INSTANCE_ID,
      family: PRIVATE_CHANNEL_EVENT_FAMILIES.ERROR,
      viewer: { scope: "all" },
      limit: 10,
    });
    expect(byFamily.rows).toHaveLength(1);
    expect(byFamily.rows[0]?.type).toBe(PRIVATE_CHANNEL_EVENT_TYPES.ERROR_SPC_UNREACHABLE);

    const byType = await repo.listByChannel({
      channelId: TEST_CHANNEL_ID,
      instanceId: TEST_INSTANCE_ID,
      type: PRIVATE_CHANNEL_EVENT_TYPES.LIFECYCLE_CHANNEL_CREATED,
      viewer: { scope: "all" },
      limit: 10,
    });
    expect(byType.rows).toHaveLength(1);
  });

  it("keeps lifecycle and self-authored instance events in a member's channel feed", async () => {
    await repo.insert(baseEvent({ id: "pce_member_channel" }));
    await repo.insert(
      baseEvent({
        id: "pce_instance_level",
        channelId: null,
        type: PRIVATE_CHANNEL_EVENT_TYPES.LIFECYCLE_INSTANCE_CONNECTED,
      })
    );
    await repo.insert(
      baseEvent({
        id: "pce_own_wallet",
        channelId: null,
        family: PRIVATE_CHANNEL_EVENT_FAMILIES.MEMBER,
        type: PRIVATE_CHANNEL_EVENT_TYPES.MEMBER_WALLET_VERIFIED,
      })
    );
    await repo.insert(
      baseEvent({
        id: "pce_other_wallet",
        channelId: null,
        sdpUserId: "usr_other",
        family: PRIVATE_CHANNEL_EVENT_FAMILIES.MEMBER,
        type: PRIVATE_CHANNEL_EVENT_TYPES.MEMBER_WALLET_VERIFIED,
      })
    );

    const { rows } = await repo.listByChannel({
      channelId: TEST_CHANNEL_ID,
      instanceId: TEST_INSTANCE_ID,
      viewer: { scope: "member", channelIds: [TEST_CHANNEL_ID], userId: TEST_USER.id },
      limit: 10,
    });

    expect(rows.map((row) => row.id).sort()).toEqual(
      ["pce_member_channel", "pce_instance_level", "pce_own_wallet"].sort()
    );
  });

  it("shows a member's channel events, lifecycle, and their own channel-less transfers", async () => {
    await repo.insert(baseEvent({ id: "pce_member_channel" }));
    await repo.insert(
      baseEvent({
        id: "pce_other_channel",
        channelId: "pch_other",
      })
    );
    await repo.insert(
      baseEvent({
        id: "pce_own_transfer",
        channelId: null,
        family: PRIVATE_CHANNEL_EVENT_FAMILIES.TRANSFER,
        type: PRIVATE_CHANNEL_EVENT_TYPES.TRANSFER_TRANSFER_SUBMITTED,
        sdpUserId: TEST_USER.id,
      })
    );
    await repo.insert(
      baseEvent({
        id: "pce_other_transfer",
        channelId: null,
        family: PRIVATE_CHANNEL_EVENT_FAMILIES.TRANSFER,
        type: PRIVATE_CHANNEL_EVENT_TYPES.TRANSFER_TRANSFER_SUBMITTED,
        sdpUserId: "usr_other",
      })
    );
    await repo.insert(
      baseEvent({
        id: "pce_instance_level",
        channelId: null,
        type: PRIVATE_CHANNEL_EVENT_TYPES.LIFECYCLE_INSTANCE_CONNECTED,
      })
    );

    const { rows } = await repo.listByProject({
      organizationId: TEST_ORG.id,
      projectId: TEST_PROJECT_ID,
      viewer: { scope: "member", channelIds: [TEST_CHANNEL_ID], userId: TEST_USER.id },
      limit: 10,
    });

    expect(rows.map((row) => row.id).sort()).toEqual(
      ["pce_member_channel", "pce_own_transfer", "pce_instance_level"].sort()
    );
  });

  it("keeps authored channel-less events visible after the member leaves every channel", async () => {
    await repo.insert(
      baseEvent({
        id: "pce_authored_member_event",
        channelId: null,
        sdpUserId: TEST_USER.id,
        family: PRIVATE_CHANNEL_EVENT_FAMILIES.MEMBER,
        type: PRIVATE_CHANNEL_EVENT_TYPES.MEMBER_WALLET_VERIFICATION_REVOKED,
      })
    );
    await repo.insert(
      baseEvent({
        id: "pce_other_member_event",
        channelId: null,
        sdpUserId: "usr_other",
        family: PRIVATE_CHANNEL_EVENT_FAMILIES.MEMBER,
        type: PRIVATE_CHANNEL_EVENT_TYPES.MEMBER_WALLET_VERIFICATION_REVOKED,
      })
    );

    const { rows } = await repo.listByProject({
      organizationId: TEST_ORG.id,
      projectId: TEST_PROJECT_ID,
      viewer: { scope: "member", channelIds: [], userId: TEST_USER.id },
      limit: 10,
    });

    expect(rows.map((row) => row.id)).toEqual(["pce_authored_member_event"]);
  });

  it("filters channel and project feeds by exact status", async () => {
    await repo.insert(
      baseEvent({
        id: "pce_status_info",
        status: PRIVATE_CHANNEL_EVENT_STATUSES.INFO,
      })
    );
    await repo.insert(
      baseEvent({
        id: "pce_status_failed",
        family: PRIVATE_CHANNEL_EVENT_FAMILIES.ERROR,
        type: PRIVATE_CHANNEL_EVENT_TYPES.ERROR_SPC_UNREACHABLE,
        status: PRIVATE_CHANNEL_EVENT_STATUSES.FAILED,
      })
    );

    const channel = await repo.listByChannel({
      channelId: TEST_CHANNEL_ID,
      instanceId: TEST_INSTANCE_ID,
      status: PRIVATE_CHANNEL_EVENT_STATUSES.FAILED,
      viewer: { scope: "all" },
      limit: 10,
    });
    expect(channel.rows.map((row) => row.id)).toEqual(["pce_status_failed"]);

    const project = await repo.listByProject({
      organizationId: TEST_ORG.id,
      projectId: TEST_PROJECT_ID,
      status: PRIVATE_CHANNEL_EVENT_STATUSES.INFO,
      viewer: { scope: "all" },
      limit: 10,
    });
    expect(project.rows.map((row) => row.id)).toEqual(["pce_status_info"]);
  });

  it("paginates with before cursor and hasMore", async () => {
    await repo.insert(baseEvent({ occurredAt: "2026-01-01T00:00:00.000Z", id: "pce_a" }));
    await repo.insert(baseEvent({ occurredAt: "2026-02-01T00:00:00.000Z", id: "pce_b" }));
    await repo.insert(baseEvent({ occurredAt: "2026-03-01T00:00:00.000Z", id: "pce_c" }));

    const page1 = await repo.listByChannel({
      channelId: TEST_CHANNEL_ID,
      instanceId: TEST_INSTANCE_ID,
      viewer: { scope: "all" },
      limit: 2,
    });
    expect(page1.rows.map((r) => r.id)).toEqual(["pce_c", "pce_b"]);
    expect(page1.hasMore).toBe(true);

    const page2 = await repo.listByChannel({
      channelId: TEST_CHANNEL_ID,
      instanceId: TEST_INSTANCE_ID,
      viewer: { scope: "all" },
      limit: 2,
      beforeOccurredAt: page1.rows[1]?.occurred_at,
      beforeId: page1.rows[1]?.id,
    });
    expect(page2.rows.map((r) => r.id)).toEqual(["pce_a"]);
    expect(page2.hasMore).toBe(false);
  });

  it("paginates deterministically when occurred_at ties (id tiebreaker)", async () => {
    const ts = "2026-05-01T00:00:00.000Z";
    await repo.insert(baseEvent({ occurredAt: ts, id: "pce_t1" }));
    await repo.insert(baseEvent({ occurredAt: ts, id: "pce_t2" }));
    await repo.insert(baseEvent({ occurredAt: ts, id: "pce_t3" }));

    const page1 = await repo.listByChannel({
      channelId: TEST_CHANNEL_ID,
      instanceId: TEST_INSTANCE_ID,
      viewer: { scope: "all" },
      limit: 2,
    });
    expect(page1.rows.map((r) => r.id)).toEqual(["pce_t3", "pce_t2"]);
    expect(page1.hasMore).toBe(true);

    const page2 = await repo.listByChannel({
      channelId: TEST_CHANNEL_ID,
      instanceId: TEST_INSTANCE_ID,
      viewer: { scope: "all" },
      limit: 2,
      beforeOccurredAt: page1.rows[1]?.occurred_at,
      beforeId: page1.rows[1]?.id,
    });
    expect(page2.rows.map((r) => r.id)).toEqual(["pce_t1"]);
    expect(page2.hasMore).toBe(false);
  });

  it("retains events when the channel row is deleted (no FK cascade)", async () => {
    await repo.insert(baseEvent());
    const db = getDb(env);
    await db.prepare("DELETE FROM private_channels WHERE id = ?").bind(TEST_CHANNEL_ID).run();
    const { rows } = await repo.listByChannel({
      channelId: TEST_CHANNEL_ID,
      instanceId: TEST_INSTANCE_ID,
      viewer: { scope: "all" },
      limit: 10,
    });
    // Denormalized rows: deleting the channel does not remove its events.
    expect(rows.filter((r) => r.channel_id === TEST_CHANNEL_ID)).toHaveLength(1);
  });

  it("retains events after the instance is deleted and lists them by project", async () => {
    await repo.insert(
      baseEvent({
        id: "pce_p1",
        type: PRIVATE_CHANNEL_EVENT_TYPES.LIFECYCLE_INSTANCE_CONNECTED,
        channelId: null,
      })
    );
    await repo.insert(baseEvent({ id: "pce_p2" }));

    const db = getDb(env);
    // Hard-delete the instance; denormalized events must survive.
    await db
      .prepare("DELETE FROM private_channel_instances WHERE id = ?")
      .bind(TEST_INSTANCE_ID)
      .run();

    const { rows, hasMore } = await repo.listByProject({
      organizationId: TEST_ORG.id,
      projectId: TEST_PROJECT_ID,
      viewer: { scope: "all" },
      limit: 50,
    });
    expect(hasMore).toBe(false);
    expect([...rows.map((r) => r.id)].sort()).toEqual(["pce_p1", "pce_p2"]);
  });

  it("listByProject scopes to the org + project and paginates", async () => {
    await repo.insert(baseEvent({ id: "pce_x1", occurredAt: "2026-01-01T00:00:00.000Z" }));
    await repo.insert(baseEvent({ id: "pce_x2", occurredAt: "2026-02-01T00:00:00.000Z" }));
    await repo.insert(baseEvent({ id: "pce_x3", occurredAt: "2026-03-01T00:00:00.000Z" }));

    const page1 = await repo.listByProject({
      organizationId: TEST_ORG.id,
      projectId: TEST_PROJECT_ID,
      viewer: { scope: "all" },
      limit: 2,
    });
    expect(page1.rows.map((r) => r.id)).toEqual(["pce_x3", "pce_x2"]);
    expect(page1.hasMore).toBe(true);

    const page2 = await repo.listByProject({
      organizationId: TEST_ORG.id,
      projectId: TEST_PROJECT_ID,
      viewer: { scope: "all" },
      limit: 2,
      beforeOccurredAt: page1.rows[1]?.occurred_at,
      beforeId: page1.rows[1]?.id,
    });
    expect(page2.rows.map((r) => r.id)).toEqual(["pce_x1"]);
    expect(page2.hasMore).toBe(false);

    const other = await repo.listByProject({
      organizationId: TEST_ORG.id,
      projectId: "prj_other",
      viewer: { scope: "all" },
      limit: 50,
    });
    expect(other.rows).toHaveLength(0);
  });
});
