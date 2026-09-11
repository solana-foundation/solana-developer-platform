import { SANDBOX_DEFAULTS } from "@sdp/private-channels";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { asTransactionalClient, getDb } from "@/db";
import { TEST_ORG, TEST_USER } from "@/test/fixtures/organizations";
import { env } from "@/test/helpers/env";
import { seedDefaultProjects } from "@/test/helpers/projects";
import { seedTestDatabase } from "@/test/mocks/db";
import type { CreateDepositInput } from "./private-channel-deposit.repository";
import { createPostgresPrivateChannelDepositRepository } from "./private-channel-deposit.repository.postgres";
import type { PrivateChannelInstanceRepository } from "./private-channel-instance.repository";
import { createPostgresPrivateChannelInstanceRepository } from "./private-channel-instance.repository.postgres";

const TEST_PROJECT_ID = "prj_pci_repo_test";

let nextDepositKey = 0;

function depositInput(instanceId: string): CreateDepositInput {
  nextDepositKey += 1;
  return {
    organizationId: TEST_ORG.id,
    projectId: TEST_PROJECT_ID,
    instanceId,
    walletId: "wal_pci_1",
    depositor: "DepositorAddr1111111111111111111111111111",
    recipient: "RecipientAddr11111111111111111111111111111",
    mint: "MintAddr11111111111111111111111111111111111",
    amount: "1",
    context: {},
    idempotencyKey: `idem_pci_${nextDepositKey}`,
    idempotencyFingerprint: `fp_pci_${nextDepositKey}`,
  };
}

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
    await seedDefaultProjects(db, {
      organizationId: TEST_ORG.id,
      createdBy: TEST_USER.id,
      members: [],
      ids: { sandbox: TEST_PROJECT_ID, production: `${TEST_PROJECT_ID}_production` },
    });

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
    expect(inserted.chain_rpc_url).toBe("");
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
    expect(reactivated?.chain_rpc_url).toBe("");
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
    const ok = await repo.deleteActive(
      { organizationId: TEST_ORG.id, projectId: TEST_PROJECT_ID },
      null
    );
    expect(ok).toBe(true);

    const active = await repo.getActiveByProject({
      organizationId: TEST_ORG.id,
      projectId: TEST_PROJECT_ID,
    });
    expect(active).toBeNull();
  });

  it("beginDraining is idempotent and atomically closes value-movement admission", async () => {
    const scope = { organizationId: TEST_ORG.id, projectId: TEST_PROJECT_ID };
    const created = await repo.createActive({
      ...scope,
      ...SANDBOX_DEFAULTS,
      createdBy: TEST_USER.id,
    });
    if (!created) throw new Error("failed to seed instance");

    const drained = await repo.beginDraining(scope);
    expect(drained?.draining_at).toBeTruthy();

    // Idempotent: a deletion retry keeps the original drain timestamp.
    const again = await repo.beginDraining(scope);
    expect(again?.draining_at).toBe(drained?.draining_at);

    // The admission barrier: the guarded INSERT returns no row for a draining
    // instance — the same statement that would create the movement refuses it,
    // so a movement racing the delete cannot be stranded.
    const deposits = createPostgresPrivateChannelDepositRepository(getDb(env));
    expect(await deposits.createDeposit(depositInput(created.id))).toBeNull();
  });

  it("refuses an admission racing a drain that another transaction is committing", async () => {
    const scope = { organizationId: TEST_ORG.id, projectId: TEST_PROJECT_ID };
    const created = await repo.createActive({
      ...scope,
      ...SANDBOX_DEFAULTS,
      createdBy: TEST_USER.id,
    });
    if (!created) throw new Error("failed to seed instance");

    const deposits = createPostgresPrivateChannelDepositRepository(getDb(env));
    let admission: Promise<unknown> = Promise.resolve(null);

    await getDb(env).transaction(async (tx) => {
      const draining = createPostgresPrivateChannelInstanceRepository(asTransactionalClient(tx));
      await draining.beginDraining(scope);
      // Started while the drain is still uncommitted: the admitting insert takes
      // the same row lock, so it can only proceed once this transaction commits
      // — and then sees the drain and admits nothing.
      admission = deposits.createDeposit(depositInput(created.id));
      await new Promise((resolve) => setTimeout(resolve, 100));
    });

    expect(await admission).toBeNull();
    const count = await createPostgresPrivateChannelDepositRepository(
      getDb(env)
    ).countNonTerminalByInstance(created.id);
    expect(count).toBe(0);
  });

  it("abandons a deletion whose drain was resumed while it was running", async () => {
    const scope = { organizationId: TEST_ORG.id, projectId: TEST_PROJECT_ID };
    const created = await repo.createActive({
      ...scope,
      ...SANDBOX_DEFAULTS,
      createdBy: TEST_USER.id,
    });
    if (!created) throw new Error("failed to seed instance");

    const draining = await repo.beginDraining(scope);
    const drainToken = draining?.draining_token ?? null;
    expect(drainToken).not.toBeNull();

    // The operator resumes between the drain and the deletion's own lock.
    await repo.updateActive({ id: created.id, ...scope, ...SANDBOX_DEFAULTS });

    // The deletion may only ever apply to the drain it established, so both
    // halves refuse — otherwise it would delete the instance the resume just
    // told the operator it had kept.
    expect(await repo.lockActiveForDeletion(scope, drainToken)).toBeNull();
    expect(await repo.deleteActive(scope, drainToken)).toBe(false);
    expect(await repo.getActiveByProject(scope)).not.toBeNull();

    // And a LATER drain is a different episode, so the abandoned deletion stays
    // abandoned however quickly the instance is drained again — the token is
    // per-drain identity, not a timestamp two drains could share.
    const redrained = await repo.beginDraining(scope);
    expect(redrained?.draining_token).not.toBe(drainToken);
    expect(await repo.deleteActive(scope, drainToken)).toBe(false);
    expect(await repo.getActiveByProject(scope)).not.toBeNull();
  });

  it("updateActive clears a drain so a refused deletion is not a one-way door", async () => {
    const scope = { organizationId: TEST_ORG.id, projectId: TEST_PROJECT_ID };
    const created = await repo.createActive({
      ...scope,
      ...SANDBOX_DEFAULTS,
      createdBy: TEST_USER.id,
    });
    if (!created) throw new Error("failed to seed instance");

    await repo.beginDraining(scope);

    // A private-channel transfer has no reconciler, so "retry once it settles"
    // can never come true; updating the connection is the operator's explicit
    // way to keep the instance instead of leaving it refusing everything.
    const updated = await repo.updateActive({ id: created.id, ...scope, ...SANDBOX_DEFAULTS });
    expect(updated?.draining_at).toBeNull();

    const deposits = createPostgresPrivateChannelDepositRepository(getDb(env));
    expect(await deposits.createDeposit(depositInput(created.id))).not.toBeNull();
  });

  it("reactivateAndUpdate clears a drain left by a refused deletion", async () => {
    const scope = { organizationId: TEST_ORG.id, projectId: TEST_PROJECT_ID };
    const created = await repo.createActive({
      ...scope,
      ...SANDBOX_DEFAULTS,
      createdBy: TEST_USER.id,
    });
    if (!created) throw new Error("failed to seed instance");

    await repo.beginDraining(scope);
    await repo.deactivateActive(scope);

    const reactivated = await repo.reactivateAndUpdate({ id: created.id, ...SANDBOX_DEFAULTS });
    expect(reactivated?.is_active).toBe(true);
    expect(reactivated?.draining_at).toBeNull();

    // A reconnected instance admits movements again.
    const deposits = createPostgresPrivateChannelDepositRepository(getDb(env));
    expect(await deposits.createDeposit(depositInput(created.id))).not.toBeNull();
  });
});
