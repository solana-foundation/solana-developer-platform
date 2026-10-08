import type { SdpEnvironment } from "@sdp/types";
import { beforeEach, describe, expect, it } from "vitest";
import { getDb } from "@/db";
import { seedTestCustodyRows } from "@/test/helpers/custody";
import { seedTestPrivyConnection } from "@/test/helpers/custody-connections";
import { env } from "@/test/helpers/env";
import { seedDefaultProjects } from "@/test/helpers/projects";
import { seedTestDatabase } from "@/test/mocks/db";
import {
  type CreateSignedVaultDepositIntentInput,
  createPostgresEarnMovementsRepository,
} from "./earn-movements.repository";

const ORGANIZATION_ID = "org_earn_custody_scope";
const PROJECT_ID = "prj_earn_custody_scope";
const OTHER_PROJECT_ID = "prj_earn_custody_scope_other";
const USER_ID = "usr_earn_custody_scope";
const CONFIG_ID = "cust_earn_custody_scope";
const CONFIG_WALLET_ID = "cwlt_earn_custody_scope_config";
const CONNECTION_ID = "cconn_earn_custody_scope";
const CONNECTION_WALLET_ID = "cwlt_earn_custody_scope_connection";
const WALLET_PUBLIC_KEY = "Vote111111111111111111111111111111111111111";
const VAULT_ADDRESS = "VaultAddress11111111111111111111111111111111";
const TOKEN_MINT = "TokenMint1111111111111111111111111111111111";
const SHARE_MINT = "ShareMint1111111111111111111111111111111111";

const CUSTODY_WALLET_ID_BY_OWNER = {
  config: CONFIG_WALLET_ID,
  connection: CONNECTION_WALLET_ID,
} as const satisfies Record<"config" | "connection", string>;

describe("vault deposit custody wallet scope", () => {
  beforeEach(async () => {
    await seedTestDatabase(env);
    await seedScope();
    await seedCustody();
  });

  it.each(["config", "connection"] as const)(
    "never claims a vault position for a %s wallet owned by another project of the organization",
    async (owner) => {
      const custodyWalletId = CUSTODY_WALLET_ID_BY_OWNER[owner];
      const ledger = createPostgresEarnMovementsRepository(getDb(env));
      const walletBefore = await readCustodyWallet(custodyWalletId);

      await expect(
        ledger.createSignedVaultDepositIntent(
          depositIntent({
            projectId: OTHER_PROJECT_ID,
            environment: "production",
            custodyWalletId,
            requestId: `earn-custody-scope-foreign-${owner}`,
          })
        )
      ).rejects.toMatchObject({
        code: "CONFLICT",
        message: "Vault position does not match project, wallet scope, or asset identity",
      });
      expect(await readEarnRows()).toEqual({ positions: [], movements: [] });
      expect(await readCustodyWallet(custodyWalletId)).toEqual(walletBefore);

      const own = await ledger.createSignedVaultDepositIntent(
        depositIntent({
          projectId: PROJECT_ID,
          environment: "sandbox",
          custodyWalletId,
          requestId: `earn-custody-scope-own-${owner}`,
        })
      );
      expect(own.position).toMatchObject({
        organization_id: ORGANIZATION_ID,
        project_id: PROJECT_ID,
        custody_wallet_id: custodyWalletId,
      });
    }
  );
});

function depositIntent(params: {
  projectId: string;
  environment: SdpEnvironment;
  custodyWalletId: string;
  requestId: string;
}): CreateSignedVaultDepositIntentInput {
  return {
    organizationId: ORGANIZATION_ID,
    projectId: params.projectId,
    environment: params.environment,
    provider: "kamino",
    vaultAddress: VAULT_ADDRESS,
    sourceAddress: WALLET_PUBLIC_KEY,
    custodyWalletId: params.custodyWalletId,
    shareMint: SHARE_MINT,
    tokenMint: TOKEN_MINT,
    label: "USDC vault",
    requestedAmount: "100",
    acceptedMinSharesOut: "99.000000",
    signature: `${params.requestId}-signature`,
    signedTransaction: `${params.requestId}-transaction`,
    lastValidBlockHeight: "123456",
    requestId: params.requestId,
    idempotencyFingerprint: `${params.requestId}-fingerprint`,
    createdBy: USER_ID,
    initiatedByKeyId: null,
  };
}

async function seedScope(): Promise<void> {
  const db = getDb(env);
  await db.batch([
    db
      .prepare(
        `INSERT INTO organizations (id, name, slug, tier, status)
         VALUES (?, 'Earn custody scope', 'earn-custody-scope', 'individual', 'active')`
      )
      .bind(ORGANIZATION_ID),
    db
      .prepare(
        `INSERT INTO users (id, email, email_verified, status)
         VALUES (?, 'earn-custody-scope@example.com', 1, 'active')`
      )
      .bind(USER_ID),
  ]);
  await seedDefaultProjects(db, {
    organizationId: ORGANIZATION_ID,
    createdBy: USER_ID,
    members: [],
    ids: { sandbox: PROJECT_ID, production: OTHER_PROJECT_ID },
  });
}

async function seedCustody(): Promise<void> {
  await seedTestCustodyRows(env, {
    configs: [
      {
        id: CONFIG_ID,
        organizationId: ORGANIZATION_ID,
        projectId: PROJECT_ID,
        provider: "local",
        configEncrypted: "encrypted",
        defaultWalletId: null,
        status: "active",
      },
    ],
    wallets: [
      {
        id: CONFIG_WALLET_ID,
        owner: { kind: "config", custodyConfigId: CONFIG_ID },
        walletId: "local_earn_custody_scope",
        publicKey: WALLET_PUBLIC_KEY,
        label: null,
        purpose: null,
        status: "active",
      },
    ],
    scopeDefaults: [],
  });
  await getDb(env).transaction((tx) =>
    seedTestPrivyConnection(tx, {
      organizationId: ORGANIZATION_ID,
      projectId: PROJECT_ID,
      connectionId: CONNECTION_ID,
      credentialId: "pcred_earn_custody_scope",
      createdBy: USER_ID,
      stored: { storageBackend: "encrypted_db", encryptedSecretPayload: "ciphertext" },
      providerAccountFingerprint: "sha256:pcred_earn_custody_scope",
      lastCheckStatus: "success",
      wallets: [
        {
          id: CONNECTION_WALLET_ID,
          walletId: "privy_earn_custody_scope",
          publicKey: WALLET_PUBLIC_KEY,
          label: null,
          purpose: null,
          status: "active",
        },
      ],
      defaultCustodyWalletId: CONNECTION_WALLET_ID,
    })
  );
}

async function readEarnRows() {
  const db = getDb(env);
  return {
    positions: await db.queryMany("SELECT id FROM earn_positions WHERE organization_id = ?", [
      ORGANIZATION_ID,
    ]),
    movements: await db.queryMany("SELECT id FROM earn_movements WHERE organization_id = ?", [
      ORGANIZATION_ID,
    ]),
  };
}

async function readCustodyWallet(custodyWalletId: string) {
  return getDb(env).queryOne("SELECT * FROM custody_wallets WHERE id = ?", [custodyWalletId]);
}
