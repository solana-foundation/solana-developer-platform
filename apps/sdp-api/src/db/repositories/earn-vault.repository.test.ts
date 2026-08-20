import { beforeEach, describe, expect, it } from "vitest";
import { getDb } from "@/db";
import { env } from "@/test/helpers/env";
import {
  type CreateSignedEarnVaultDepositIntentInput,
  createPostgresEarnVaultRepository,
  type EarnVaultRepository,
} from "./earn-vault.repository";

const ORG_A = "org_earn_vault_a";
const ORG_B = "org_earn_vault_b";
const USER_ID = "usr_earn_vault";
const PROJECT_A = "prj_earn_vault_a";
const PROJECT_A_OTHER = "prj_earn_vault_a_other";
const PROJECT_B = "prj_earn_vault_b";
const WALLET_A = "cw_earn_vault_a";
const WALLET_A_ORG = "cw_earn_vault_a_org";

describe("EarnVaultRepository (postgres)", () => {
  let repo: EarnVaultRepository;
  let sequence = 0;

  beforeEach(async () => {
    const db = getDb(env);

    // The unified ledger the repository mirrors into (PRO-1705) is cleared
    // first: its rows reference both the legacy holdings and the custody wallets
    // deleted below.
    await db
      .prepare("DELETE FROM earn_movements WHERE organization_id IN (?, ?)")
      .bind(ORG_A, ORG_B)
      .run();
    await db
      .prepare("DELETE FROM earn_positions WHERE organization_id IN (?, ?)")
      .bind(ORG_A, ORG_B)
      .run();
    await db
      .prepare("DELETE FROM earn_vault_movements WHERE organization_id IN (?, ?)")
      .bind(ORG_A, ORG_B)
      .run();
    await db
      .prepare("DELETE FROM earn_vault_positions WHERE organization_id IN (?, ?)")
      .bind(ORG_A, ORG_B)
      .run();
    await db
      .prepare("DELETE FROM custody_wallets WHERE id IN (?, ?)")
      .bind(WALLET_A, WALLET_A_ORG)
      .run();
    await db
      .prepare("DELETE FROM custody_configs WHERE id IN (?, ?)")
      .bind("cc_earn_vault_a", "cc_earn_vault_a_org")
      .run();
    await db
      .prepare("DELETE FROM projects WHERE id IN (?, ?, ?)")
      .bind(PROJECT_A, PROJECT_A_OTHER, PROJECT_B)
      .run();
    await db.prepare("DELETE FROM organizations WHERE id IN (?, ?)").bind(ORG_A, ORG_B).run();
    await db.prepare("DELETE FROM users WHERE id = ?").bind(USER_ID).run();

    await db
      .prepare(
        `INSERT INTO users (id, email, email_verified, status)
         VALUES (?, 'earn-vault@example.com', 1, 'active')`
      )
      .bind(USER_ID)
      .run();
    await db
      .prepare(
        `INSERT INTO organizations (id, name, slug, tier, status)
         VALUES
           (?, 'Earn Vault A', 'earn-vault-a', 'individual', 'active'),
           (?, 'Earn Vault B', 'earn-vault-b', 'individual', 'active')`
      )
      .bind(ORG_A, ORG_B)
      .run();
    await db
      .prepare(
        `INSERT INTO projects (
           id, organization_id, name, slug, environment, status, created_by
         ) VALUES
           (?, ?, 'Project A', 'project-a', 'sandbox', 'active', ?),
           (?, ?, 'Project A Other', 'project-a-other', 'sandbox', 'active', ?),
           (?, ?, 'Project B', 'project-b', 'sandbox', 'active', ?)`
      )
      .bind(PROJECT_A, ORG_A, USER_ID, PROJECT_A_OTHER, ORG_A, USER_ID, PROJECT_B, ORG_B, USER_ID)
      .run();
    await db
      .prepare(
        `INSERT INTO custody_configs (
           id, organization_id, project_id, provider, config_encrypted
         ) VALUES
           ('cc_earn_vault_a', ?, ?, 'local', 'encrypted'),
           ('cc_earn_vault_a_org', ?, NULL, 'local', 'encrypted')`
      )
      .bind(ORG_A, PROJECT_A, ORG_A)
      .run();
    await db
      .prepare(
        `INSERT INTO custody_wallets (
           id, custody_config_id, wallet_id, public_key, label
         ) VALUES
           (?, 'cc_earn_vault_a', 'wallet-a', 'WalletAPublicKey', 'Project wallet'),
           (?, 'cc_earn_vault_a_org', 'wallet-a-org', 'WalletAOrgPublicKey', 'Org wallet')`
      )
      .bind(WALLET_A, WALLET_A_ORG)
      .run();

    repo = createPostgresEarnVaultRepository(db);
    sequence = 0;
  });

  function intent(
    overrides: Partial<CreateSignedEarnVaultDepositIntentInput> = {}
  ): CreateSignedEarnVaultDepositIntentInput {
    sequence += 1;
    return {
      organizationId: ORG_A,
      projectId: PROJECT_A,
      environment: "sandbox",
      provider: "kamino",
      providerReference: "vault-usdc",
      custodyWalletId: WALLET_A,
      shareMint: "ShareMint1111111111111111111111111111111111",
      tokenMint: "TokenMint1111111111111111111111111111111111",
      label: "USDC vault",
      requestedAmount: "100",
      acceptedAmount: "100.0",
      requestedMinSharesOut: "99",
      acceptedMinSharesOut: "99.0",
      signature: `earn-vault-signature-${sequence}`,
      signedTransaction: `earn-vault-transaction-${sequence}`,
      lastValidBlockHeight: "123456",
      requestId: `earn-vault-request-${sequence}`,
      idempotencyFingerprint: `earn-vault-fingerprint-${sequence}`,
      createdBy: USER_ID,
      ...overrides,
    };
  }

  async function confirm(movementId: string, shares: string | null = "99.5") {
    return repo.advanceMovement({
      movementId,
      organizationId: ORG_A,
      fromStatuses: ["pending"],
      toStatus: "confirmed",
      shares,
      confirmedAt: "2026-08-17T12:00:00.000Z",
    });
  }

  it("rejects positions whose project, environment, and custody wallet scope do not agree", async () => {
    await expect(
      repo.createSignedDepositIntent(
        intent({ organizationId: ORG_B, projectId: PROJECT_B, custodyWalletId: WALLET_A })
      )
    ).rejects.toThrow("Vault position does not match project, wallet scope, or asset identity");

    await expect(
      repo.createSignedDepositIntent(intent({ projectId: PROJECT_A_OTHER }))
    ).rejects.toThrow("Vault position does not match project, wallet scope, or asset identity");

    await expect(
      repo.createSignedDepositIntent(intent({ environment: "production" }))
    ).rejects.toThrow("Vault position does not match project, wallet scope, or asset identity");

    const validOrgWallet = await repo.createSignedDepositIntent(
      intent({ projectId: PROJECT_A_OTHER, custodyWalletId: WALLET_A_ORG })
    );
    expect(validOrgWallet.position).toMatchObject({
      organization_id: ORG_A,
      project_id: PROJECT_A_OTHER,
      environment: "sandbox",
      custody_wallet_id: WALLET_A_ORG,
    });
  });

  it("replays a key only to its OWN project, and conflicts for a sibling", async () => {
    // The transaction-level guard, and the one every path funnels through —
    // including an approved-operation execution, which deliberately skips the
    // route-level replay guard. wallet_operations uniqueness is per-project, so
    // sibling projects can each hold an approval with the same caller-chosen
    // key; the second to execute must NOT be handed the first project's
    // movement as a replay.
    const key = "earn-vault-shared-key";
    const fingerprint = "earn-vault-shared-fingerprint";
    const first = await repo.createSignedDepositIntent(
      intent({
        custodyWalletId: WALLET_A_ORG,
        requestId: key,
        idempotencyFingerprint: fingerprint,
      })
    );
    expect(first.replayed).toBe(false);

    // Same project, same key, same fingerprint: a genuine replay.
    const replay = await repo.createSignedDepositIntent(
      intent({
        custodyWalletId: WALLET_A_ORG,
        requestId: key,
        idempotencyFingerprint: fingerprint,
      })
    );
    expect(replay.replayed).toBe(true);
    expect(replay.movement.id).toBe(first.movement.id);

    // Sibling project, same org-level wallet, same key AND same fingerprint
    // (the server fingerprint omits the project, so it matches): conflict, and
    // with the same message as a fingerprint mismatch so nothing about the
    // sibling is disclosed.
    await expect(
      repo.createSignedDepositIntent(
        intent({
          projectId: PROJECT_A_OTHER,
          custodyWalletId: WALLET_A_ORG,
          requestId: key,
          idempotencyFingerprint: fingerprint,
        })
      )
    ).rejects.toThrow("Idempotency key already used with different request payload");

    // A movement whose owning project was deleted conflicts too: the org-scoped
    // unique index means the key is burnt either way.
    await getDb(env)
      .prepare("UPDATE earn_vault_movements SET project_id = NULL WHERE id = ?")
      .bind(first.movement.id)
      .run();
    await expect(
      repo.createSignedDepositIntent(
        intent({
          custodyWalletId: WALLET_A_ORG,
          requestId: key,
          idempotencyFingerprint: fingerprint,
        })
      )
    ).rejects.toThrow("Idempotency key already used with different request payload");
  });

  it("keeps a closed position closed when re-entry fails and reopens it on confirmation", async () => {
    const initial = await repo.createSignedDepositIntent(intent());
    await confirm(initial.movement.id);
    const db = getDb(env);
    const closedAt = "2026-08-17T13:00:00.000Z";
    await db
      .prepare("UPDATE earn_vault_positions SET closed_at = ? WHERE id = ?")
      .bind(closedAt, initial.position.id)
      .run();

    const failedReentry = await repo.createSignedDepositIntent(intent());
    expect(failedReentry.position.closed_at).toBe(closedAt);
    expect(
      (
        await repo.listPositions({
          organizationId: ORG_A,
          environment: "sandbox",
          custodyWalletIds: [WALLET_A],
          limit: 10,
          before: null,
        })
      ).rows
    ).toHaveLength(1);

    await repo.advanceMovement({
      movementId: failedReentry.movement.id,
      organizationId: ORG_A,
      fromStatuses: ["pending"],
      toStatus: "failed",
      failureReason: "transaction expired",
    });
    expect(
      await repo.getPositionById({
        organizationId: ORG_A,
        environment: "sandbox",
        positionId: initial.position.id,
      })
    ).toMatchObject({ closed_at: closedAt });
    expect(
      (
        await repo.listPositions({
          organizationId: ORG_A,
          environment: "sandbox",
          custodyWalletIds: [WALLET_A],
          limit: 10,
          before: null,
        })
      ).rows
    ).toHaveLength(0);

    const successfulReentry = await repo.createSignedDepositIntent(intent());
    await confirm(successfulReentry.movement.id);
    expect(
      await repo.getPositionById({
        organizationId: ORG_A,
        environment: "sandbox",
        positionId: initial.position.id,
      })
    ).toMatchObject({ closed_at: null });
  });

  it("rejects malformed shares before advancing a movement", async () => {
    const { movement } = await repo.createSignedDepositIntent(intent());

    for (const shares of ["", "-1", "not-a-number", "1".repeat(129), "0", "0.0"]) {
      await expect(confirm(movement.id, shares)).rejects.toThrow(
        "shares must be a positive unsigned decimal with at most 128 characters"
      );
    }

    expect(await confirm(movement.id, null)).toMatchObject({ status: "confirmed", shares: null });

    const valid = await repo.createSignedDepositIntent(intent());
    expect(await confirm(valid.movement.id, "123.456")).toMatchObject({
      status: "confirmed",
      shares: "123.456",
    });
  });

  it("enforces the shares invariant at the database boundary", async () => {
    const { movement } = await repo.createSignedDepositIntent(intent());
    const db = getDb(env);

    for (const shares of ["", "-1", "not-a-number", "1".repeat(129), "0"]) {
      await expect(
        db
          .prepare(
            `UPDATE earn_vault_movements
             SET status = 'confirmed', confirmed_at = sdp_iso_now(), shares = ?
             WHERE id = ?`
          )
          .bind(shares, movement.id)
          .run()
      ).rejects.toThrow();
    }
  });
});
