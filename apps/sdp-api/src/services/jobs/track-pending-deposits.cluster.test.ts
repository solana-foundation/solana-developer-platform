import { SANDBOX_DEFAULTS } from "@sdp/private-channels";
import { runInClusterScope } from "@sdp/rpc/scope";
import type { SdpEnvironment } from "@sdp/types";
import type { Signature } from "@solana/kit";
import { beforeEach, describe, expect, it } from "vitest";
import { getDb } from "@/db";
import { createPostgresPrivateChannelDepositRepository } from "@/db/repositories/private-channel-deposit.repository.postgres";
import { createPostgresPrivateChannelInstanceRepository } from "@/db/repositories/private-channel-instance.repository.postgres";
import { TEST_ORG, TEST_USER } from "@/test/fixtures/organizations";
import { installClusterRpcResponder, signatureStatusesRead } from "@/test/helpers/cluster-rpc";
import { env } from "@/test/helpers/env";
import { type SeededDefaultProjects, seedDefaultProjects } from "@/test/helpers/projects";
import { testSignature } from "@/test/helpers/signatures";
import { seedTestDatabase } from "@/test/mocks/db";
import { trackPendingDeposits } from "./track-pending-deposits";

const SIGNATURE_BY_ENVIRONMENT = {
  sandbox: testSignature(31),
  production: testSignature(32),
} as const satisfies Record<SdpEnvironment, Signature>;

describe("trackPendingDeposits per cluster", () => {
  const rpc = installClusterRpcResponder();
  let projects: SeededDefaultProjects;

  async function seedSubmittedDeposit(environment: SdpEnvironment): Promise<void> {
    const db = getDb(env);
    const projectId = projects[environment].id;
    const instance = await createPostgresPrivateChannelInstanceRepository(db).createActive({
      organizationId: TEST_ORG.id,
      projectId,
      createdBy: TEST_USER.id,
      ...SANDBOX_DEFAULTS,
    });
    if (!instance) throw new Error(`test setup: no ${environment} instance was created`);
    const deposits = createPostgresPrivateChannelDepositRepository(db);
    const deposit = await deposits.createDeposit({
      organizationId: TEST_ORG.id,
      projectId,
      instanceId: instance.id,
      walletId: `wal_pcd_cluster_${environment}`,
      depositor: "DepositorAddr1111111111111111111111111111",
      recipient: "RecipientAddr11111111111111111111111111111",
      mint: "MintAddr11111111111111111111111111111111111",
      amount: "1.5",
      context: {},
      idempotencyKey: `idem_pcd_cluster_${environment}`,
      idempotencyFingerprint: `fp_pcd_cluster_${environment}`,
    });
    if (!deposit) throw new Error(`test setup: no ${environment} deposit was created`);
    const submitted = await deposits.updateDeposit({
      id: deposit.id,
      status: "submitted",
      signature: SIGNATURE_BY_ENVIRONMENT[environment],
      expectedStatus: "pending",
    });
    if (!submitted) throw new Error(`test setup: the ${environment} deposit was not submitted`);
  }

  beforeEach(async () => {
    await seedTestDatabase(env);
    const db = getDb(env);
    await db
      .prepare(
        "INSERT INTO organizations (id, name, slug, tier, status) VALUES (?, ?, ?, 'individual', 'active')"
      )
      .bind(TEST_ORG.id, TEST_ORG.name, TEST_ORG.slug)
      .run();
    await db
      .prepare("INSERT INTO users (id, email, email_verified, status) VALUES (?, ?, 1, 'active')")
      .bind(TEST_USER.id, TEST_USER.email)
      .run();
    projects = await seedDefaultProjects(db, {
      organizationId: TEST_ORG.id,
      createdBy: TEST_USER.id,
      members: [],
      ids: { sandbox: "prj_pcd_cluster_sandbox", production: "prj_pcd_cluster_production" },
    });
    await seedSubmittedDeposit("sandbox");
    await seedSubmittedDeposit("production");
  });

  it("reads only Production projects' deposits in a production scope and asks mainnet-beta", async () => {
    rpc.respondSignatureStatuses(() => null);

    await runInClusterScope({ projectId: null, environment: "production" }, () =>
      trackPendingDeposits(env)
    );

    expect(
      rpc.requests
        .filter((request) => request.method === "getSignatureStatuses")
        .map(signatureStatusesRead)
    ).toEqual([
      {
        cluster: "mainnet-beta",
        signatures: [SIGNATURE_BY_ENVIRONMENT.production],
        searchTransactionHistory: true,
      },
    ]);
  });
});
