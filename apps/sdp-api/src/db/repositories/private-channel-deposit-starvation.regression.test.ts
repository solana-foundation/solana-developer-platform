/**
 * Regression test for Apex finding SOLA9-544 (APE-813).
 *
 * `confirmed` is a TERMINAL status for private-channel deposits: the cron
 * worker (`trackPendingDeposits`) has no transition out of it, because the
 * operator's channel-side credit is off-chain and not observable. Selecting
 * `confirmed` rows into the bounded cron page (`listNonTerminal`, LIMIT 100)
 * let 100 older confirmed rows permanently starve every newer pending or
 * submitted deposit: the worker never saw it, so it was never polled and
 * stayed `submitted` forever.
 *
 * The intended secure behavior: the reconciliation queue contains only
 * deposit states the worker can actually advance (`pending`, `submitted`).
 * A newer submitted deposit must be selected regardless of how many
 * confirmed rows precede it, `listNonTerminalByProject` must apply the same
 * predicate, and `countNonTerminalByInstance` (the instance-deletion guard)
 * must not treat terminal confirmed rows as in-flight work. The schema's
 * `settled` state stays unreachable for deposits, so `confirmed` belongs to
 * no active-work predicate.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { getDb } from "@/db";
import { TEST_ORG, TEST_USER } from "@/test/fixtures/organizations";
import { env } from "@/test/helpers/env";
import { seedDefaultProjects } from "@/test/helpers/projects";
import { seedTestDatabase } from "@/test/mocks/db";
import type {
  CreateDepositInput,
  PrivateChannelDepositRepository,
} from "./private-channel-deposit.repository";
import { createPostgresPrivateChannelDepositRepository } from "./private-channel-deposit.repository.postgres";

const PROJECT_ID = "prj_pcd_starvation_regression";
const INSTANCE_ID = "inst_pcd_starvation_regression";
const PAGE_SIZE = 100;

function input(index: number): CreateDepositInput {
  const key = `idem_pcd_starvation_${index}`;
  return {
    organizationId: TEST_ORG.id,
    projectId: PROJECT_ID,
    instanceId: INSTANCE_ID,
    walletId: "wal_pcd_starvation",
    depositor: "DepositorAddr1111111111111111111111111111",
    recipient: "RecipientAddr11111111111111111111111111111",
    mint: "MintAddr11111111111111111111111111111111111",
    amount: "1",
    context: {},
    idempotencyKey: key,
    idempotencyFingerprint: `fp_${key}`,
  };
}

/** sdp_iso_now() is millisecond-resolution; a short sleep guarantees the
 * submitted row lands on a strictly later timestamp than every seeded
 * confirmed row, so ordering — not a timestamp tie — decides selection. */
async function waitForDistinctDatabaseTimestamp(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 50));
}

async function seedProject(): Promise<PrivateChannelDepositRepository> {
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
  await seedDefaultProjects(db, {
    organizationId: TEST_ORG.id,
    createdBy: TEST_USER.id,
    members: [],
    ids: { sandbox: PROJECT_ID, production: `${PROJECT_ID}_production` },
  });
  await db
    .prepare(
      `INSERT INTO private_channel_instances (
         id, organization_id, project_id, gateway_url,
         escrow_program_id, withdraw_program_id, escrow_instance_addr, auth_url, is_active
       ) VALUES (?, ?, ?, 'https://gateway.example',
         'escrow_program', 'withdraw_program', 'escrow_instance', 'https://auth.example', TRUE)`
    )
    .bind(INSTANCE_ID, TEST_ORG.id, PROJECT_ID)
    .run();
  return createPostgresPrivateChannelDepositRepository(db);
}

async function createConfirmedDeposit(
  repo: PrivateChannelDepositRepository,
  index: number
): Promise<{ id: string; updatedAt: string }> {
  const created = await repo.createDeposit(input(index));
  expect(created).not.toBeNull();
  const submitted = await repo.updateDeposit({
    id: created?.id ?? "",
    status: "submitted",
    signature: `sig_pcd_starvation_${index}`,
    expectedStatus: "pending",
  });
  expect(submitted?.status).toBe("submitted");
  const confirmed = await repo.updateDeposit({
    id: created?.id ?? "",
    status: "confirmed",
    expectedStatus: "submitted",
  });
  expect(confirmed?.status).toBe("confirmed");
  return { id: created?.id ?? "", updatedAt: confirmed?.updated_at ?? "" };
}

async function createSubmittedDeposit(
  repo: PrivateChannelDepositRepository,
  index: number
): Promise<{ id: string; updatedAt: string }> {
  const created = await repo.createDeposit(input(index));
  expect(created).not.toBeNull();
  const submitted = await repo.updateDeposit({
    id: created?.id ?? "",
    status: "submitted",
    signature: `sig_pcd_starvation_${index}`,
    expectedStatus: "pending",
  });
  expect(submitted?.status).toBe("submitted");
  return { id: created?.id ?? "", updatedAt: submitted?.updated_at ?? "" };
}

describe("PrivateChannelDepositRepository reconciliation queue (SOLA9-544)", () => {
  beforeEach(async () => {
    await seedTestDatabase(env as Parameters<typeof seedTestDatabase>[0]);
  });

  it("control: selects the newer submitted deposit while 99 confirmed rows leave room", async () => {
    const repo = await seedProject();
    const confirmed = await Promise.all(
      Array.from({ length: PAGE_SIZE - 1 }, (_, index) => createConfirmedDeposit(repo, index))
    );
    await waitForDistinctDatabaseTimestamp();
    const submitted = await createSubmittedDeposit(repo, PAGE_SIZE);

    const rows = await repo.listNonTerminal(PAGE_SIZE);
    expect(submitted.updatedAt > (confirmed[0]?.updatedAt ?? "")).toBe(true);
    expect(rows.some((row) => row.id === submitted.id)).toBe(true);
  });

  it("keeps the newer submitted deposit selected when 100 confirmed rows precede it", async () => {
    const repo = await seedProject();
    await Promise.all(
      Array.from({ length: PAGE_SIZE }, (_, index) => createConfirmedDeposit(repo, index))
    );
    await waitForDistinctDatabaseTimestamp();
    const submitted = await createSubmittedDeposit(repo, PAGE_SIZE);

    const rows = await repo.listNonTerminal(PAGE_SIZE);
    // Terminal confirmed rows must not occupy the bounded cron page: the
    // worker has no transition out of `confirmed`, so a page it fills is a
    // page of work the worker can never do, starving everything behind it.
    expect(rows.some((row) => row.id === submitted.id)).toBe(true);
    expect(rows.every((row) => row.status !== "confirmed")).toBe(true);
  });

  it("listNonTerminalByProject excludes confirmed deposits", async () => {
    const repo = await seedProject();
    const confirmed = await createConfirmedDeposit(repo, 0);
    await waitForDistinctDatabaseTimestamp();
    const submitted = await createSubmittedDeposit(repo, 1);

    const rows = await repo.listNonTerminalByProject({
      organizationId: TEST_ORG.id,
      projectId: PROJECT_ID,
    });
    expect(rows.map((row) => row.id)).toEqual([submitted.id]);
    expect(rows.some((row) => row.id === confirmed.id)).toBe(false);
  });

  it("countNonTerminalByInstance ignores confirmed deposits", async () => {
    const repo = await seedProject();
    const confirmed = await createConfirmedDeposit(repo, 0);
    expect(await repo.countNonTerminalByInstance(INSTANCE_ID)).toBe(0);

    const submitted = await createSubmittedDeposit(repo, 1);
    expect(await repo.countNonTerminalByInstance(INSTANCE_ID)).toBe(1);

    // The confirmed row is terminal financial history: it must not gate
    // instance deletion, and it must stay readable for the dashboard.
    const stillThere = await repo.getDepositById({
      organizationId: TEST_ORG.id,
      projectId: PROJECT_ID,
      id: confirmed.id,
    });
    expect(stillThere?.id).toBe(confirmed.id);
    expect(submitted.id).not.toBe(confirmed.id);
  });
});
