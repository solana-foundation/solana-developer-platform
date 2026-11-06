import { hashString } from "@sdp/payments/hash";
import { SOL_MINT, WELL_KNOWN_TOKENS } from "@sdp/types/well-known-tokens";
import {
  blockhash,
  compileTransaction,
  createTransactionMessage,
  generateKeyPairSigner,
  getBase58Decoder,
  getBase64EncodedWireTransaction,
  getTransactionDecoder,
  type KeyPairSigner,
  partiallySignTransaction,
  pipe,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
} from "@solana/kit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getDb } from "@/db/client";
import { generateEarnPositionId } from "@/db/repositories/earn-movements.repository";
import { app } from "@/index";
import { ALL_API_KEY_GRANTS } from "@/test/fixtures/api-keys";
import { installClusterRpcStub } from "@/test/helpers/cluster-rpc";
import {
  seedTestPrivyConnection,
  writeTestPrivyCredentialSecret,
} from "@/test/helpers/custody-connections";
import { env } from "@/test/helpers/env";
import { seedDefaultProjects } from "@/test/helpers/projects";
import { type SeededApiKey, seedApiKeyRow, seedTestDatabase } from "@/test/mocks/db";
import { clearKVStores } from "@/test/mocks/kv";

const surfacingEnabled = vi.hoisted(() => ({ value: true }));

vi.mock("@sdp/types/provider-access", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@sdp/types/provider-access")>()),
  isEarnProviderSurfaced: () => surfacingEnabled.value,
}));

vi.mock("@sdp/types/release-channels", async (importOriginal) => {
  const { mockCustodyReleaseChannels } = await import("@/test/helpers/custody-release-channel");
  return mockCustodyReleaseChannels(
    await importOriginal<typeof import("@sdp/types/release-channels")>()
  );
});

/**
 * An external-wallet cancellation submit must recheck its selected redemption
 * before accepting the signed bytes: a build prepared while the redemption was
 * pending goes stale once that redemption settles, and Plume's cancellation
 * clears every pending standard redemption for the wallet and vault — so the
 * stale bytes would cancel a newer order instead. Referenced by
 * `src/routes/wallet-scope-route-inventory.test.ts` as the submit route's
 * behavioral test.
 */

const TEST_ORG = {
  id: "org_earn_pa_submit",
  name: "Earn Provider Submit Org",
  slug: "earn-pa-submit",
};
const TEST_PROJECT = { id: "prj_test_earn_pa_submit", slug: "test-earn-pa-submit-project" };
const TEST_USER = { id: "usr_earn_pa_submit", email: "earn-pa-submit@example.com" };
const TEST_API_KEY = {
  id: "key_earn_pa_submit",
  raw: "sk_test_earn_pa_submit",
  prefix: "sk_test_eaps",
};
const TEST_SEEDED_API_KEY: SeededApiKey = {
  id: TEST_API_KEY.id,
  organizationId: TEST_ORG.id,
  projectId: TEST_PROJECT.id,
  grants: ALL_API_KEY_GRANTS,
  environment: "sandbox",
  rateLimitTier: "standard",
  allowedIps: null,
  status: "active",
  expiresAt: null,
};

const USDC_MINT = WELL_KNOWN_TOKENS.USDC.mints.devnet.address;
const SHARE_MINT = SOL_MINT;
const VAULT = "7uib8xGAwkaPz4ZGCA6t8sSEid5Yp9ty13PHUweTypx";
const CUSTODY_WALLET_ID = "cwlt_earn_pa_submit";
const CONNECTION_ID = "cconn_earn_pa_submit";

let originalMarketsEnabled: string | undefined;
let originalEarnEnabled: string | undefined;
let originalEncryptionKey: string | undefined;

async function seedAuth(): Promise<void> {
  await getDb(env).batch([
    getDb(env)
      .prepare(
        "INSERT INTO organizations (id, name, slug, tier, status, settings) VALUES (?, ?, ?, ?, ?, ?)"
      )
      .bind(TEST_ORG.id, TEST_ORG.name, TEST_ORG.slug, "enterprise", "active", "{}"),
    getDb(env)
      .prepare("INSERT INTO users (id, email, email_verified, status) VALUES (?, ?, 1, 'active')")
      .bind(TEST_USER.id, TEST_USER.email),
  ]);
  await seedDefaultProjects(getDb(env), {
    organizationId: TEST_ORG.id,
    createdBy: TEST_USER.id,
    members: [TEST_USER.id],
    ids: { sandbox: TEST_PROJECT.id, production: `${TEST_PROJECT.id}_prod` },
  });

  const keyHash = await hashString(TEST_API_KEY.raw, env.API_KEY_PEPPER);
  await seedApiKeyRow(env, keyHash, TEST_SEEDED_API_KEY);
}

async function seedConnectionWallet(): Promise<void> {
  env.CUSTODY_ENCRYPTION_KEY = Buffer.alloc(32, 43).toString("base64");
  await seedTestPrivyConnection(getDb(env), {
    organizationId: TEST_ORG.id,
    projectId: TEST_PROJECT.id,
    connectionId: CONNECTION_ID,
    credentialId: "pcred_earn_pa_submit",
    createdBy: TEST_USER.id,
    stored: await writeTestPrivyCredentialSecret(env, {
      organizationId: TEST_ORG.id,
      credentialId: "pcred_earn_pa_submit",
      appId: "earn-pa-submit-app",
      appSecret: "earn-pa-submit-secret",
    }),
    providerAccountFingerprint: "sha256:earn-pa-submit",
    lastCheckStatus: "success",
    wallets: [
      {
        id: CUSTODY_WALLET_ID,
        walletId: "privy_earn_pa_submit",
        publicKey: "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM",
        label: null,
        purpose: null,
        status: "active",
      },
    ],
    defaultCustodyWalletId: CUSTODY_WALLET_ID,
  });
}

/**
 * The parent redemption a cancellation build selected, in the state the ledger
 * held when the build was prepared (`confirmed`) or after it settled since
 * (`finalized`): both carry the chain-finalization facts the build gate
 * matched, so only the recheck can tell the stale build apart.
 */
async function seedRedemptionParent(status: "confirmed" | "finalized"): Promise<string> {
  const positionId = generateEarnPositionId();
  await getDb(env)
    .prepare(
      `INSERT INTO earn_positions (
         id, organization_id, project_id, environment, provider, kind,
         custody_wallet_id, vault_address, share_mint, token_mint,
         provider_wallet_id, label, activated_at
       ) VALUES (?, ?, ?, 'sandbox', 'plume', 'vault_direct', ?, ?, ?, ?, NULL, 'Exit Vault', sdp_iso_now())`
    )
    .bind(positionId, TEST_ORG.id, TEST_PROJECT.id, CUSTODY_WALLET_ID, VAULT, SHARE_MINT, USDC_MINT)
    .run();
  const movementId = `earn_movement_${crypto.randomUUID()}`;
  await getDb(env)
    .prepare(
      `INSERT INTO earn_movements (
         id, organization_id, project_id, environment, provider,
         execution_model, direction, position_id, status,
         denomination, amount_requested, custody_wallet_id, vault_address,
         signature, signed_transaction, last_valid_block_height,
         confirmed_at, chain_finalized_at, settled_at,
         request_id, idempotency_fingerprint
       ) VALUES (?, ?, ?, 'sandbox', 'plume', 'vault_direct', 'withdrawal', ?, ?,
                 ?, '10', ?, ?, ?, ?, '100',
                 sdp_iso_now(), sdp_iso_now(), ?, ?, 'fp_external_submit_parent')`
    )
    .bind(
      movementId,
      TEST_ORG.id,
      TEST_PROJECT.id,
      positionId,
      status,
      SHARE_MINT,
      CUSTODY_WALLET_ID,
      VAULT,
      `sig_${crypto.randomUUID()}`,
      "AQ==",
      status === "finalized" ? sdpIsoNow() : null,
      crypto.randomUUID()
    )
    .run();
  return movementId;
}

function sdpIsoNow(): string {
  return new Date().toISOString();
}

/** The owner-only unsigned build (no instructions) and its genuinely signed form. */
async function buildOwnerSignedTransaction(owner: KeyPairSigner): Promise<{
  unsigned: string;
  signed: string;
}> {
  const message = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayer(owner.address, m),
    (m) =>
      setTransactionMessageLifetimeUsingBlockhash(
        {
          blockhash: blockhash(getBase58Decoder().decode(new Uint8Array(32).fill(7))),
          lastValidBlockHeight: 1_000n,
        },
        m
      )
  );
  const unsigned = getBase64EncodedWireTransaction(compileTransaction(message));
  const decoded = getTransactionDecoder().decode(Uint8Array.from(Buffer.from(unsigned, "base64")));
  const signed = getBase64EncodedWireTransaction(
    await partiallySignTransaction([owner.keyPair], decoded)
  );
  return { unsigned, signed };
}

async function seedPreparedCancellation(input: {
  parentMovementId: string;
  ownerAddress: string;
  unsignedTransaction: string;
}): Promise<string> {
  const actionId = `earn_action_${crypto.randomUUID()}`;
  await getDb(env)
    .prepare(
      `INSERT INTO earn_provider_actions (
         id, organization_id, project_id, environment, provider, action, status,
         parent_movement_id, custody_wallet_id, owner_address, vault_address,
         token_mint, share_mint, fee_payer, request_id, fingerprint,
         unsigned_transaction, last_valid_block_height, lease_until
       ) VALUES (?, ?, ?, 'sandbox', 'plume', 'cancellation', 'prepared',
                 ?, NULL, ?, ?, ?, ?, NULL, ?, 'fp_external_submit_action',
                 ?, '100', sdp_iso_now())`
    )
    .bind(
      actionId,
      TEST_ORG.id,
      TEST_PROJECT.id,
      input.parentMovementId,
      input.ownerAddress,
      VAULT,
      USDC_MINT,
      SHARE_MINT,
      `idem_${crypto.randomUUID()}`,
      input.unsignedTransaction
    )
    .run();
  return actionId;
}

function post(actionId: string, signedTransaction: string) {
  return app.request(
    "/v1/earn/provider-actions/external/cancellations",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${TEST_API_KEY.raw}`,
        "Content-Type": "application/json",
        "Idempotency-Key": `idem_${crypto.randomUUID()}`,
      },
      body: JSON.stringify({ actionId, signedTransaction }),
    },
    env
  );
}

async function actionRow(actionId: string) {
  return getDb(env)
    .prepare("SELECT status, signature, signed_transaction FROM earn_provider_actions WHERE id = ?")
    .bind(actionId)
    .first<{ status: string; signature: string | null; signed_transaction: string | null }>();
}

installClusterRpcStub();

beforeEach(async () => {
  originalMarketsEnabled = env.MARKETS_ENABLED;
  originalEarnEnabled = env.EARN_ENABLED;
  originalEncryptionKey = env.CUSTODY_ENCRYPTION_KEY;
  env.MARKETS_ENABLED = "true";
  env.EARN_ENABLED = "true";
  surfacingEnabled.value = true;
  await seedTestDatabase(env);
  await clearKVStores(env);
  vi.clearAllMocks();
});

afterEach(() => {
  env.MARKETS_ENABLED = originalMarketsEnabled;
  env.EARN_ENABLED = originalEarnEnabled;
  env.CUSTODY_ENCRYPTION_KEY = originalEncryptionKey;
});

describe("external cancellation submit rechecks its selected redemption", () => {
  it("refuses a build whose selected redemption settled since preparation", async () => {
    await seedAuth();
    await seedConnectionWallet();
    const parentMovementId = await seedRedemptionParent("finalized");
    const owner = await generateKeyPairSigner();
    const { unsigned, signed } = await buildOwnerSignedTransaction(owner);
    const actionId = await seedPreparedCancellation({
      parentMovementId,
      ownerAddress: owner.address,
      unsignedTransaction: unsigned,
    });

    const res = await post(actionId, signed);

    expect(res.status).toBe(409);
    await expect(res.json()).resolves.toMatchObject({ error: { code: "CONFLICT" } });
    await expect(actionRow(actionId)).resolves.toMatchObject({
      status: "prepared",
      signature: null,
      signed_transaction: null,
    });
  });

  it("accepts a build whose selected redemption is still pending", async () => {
    await seedAuth();
    await seedConnectionWallet();
    const parentMovementId = await seedRedemptionParent("confirmed");
    const owner = await generateKeyPairSigner();
    const { unsigned, signed } = await buildOwnerSignedTransaction(owner);
    const actionId = await seedPreparedCancellation({
      parentMovementId,
      ownerAddress: owner.address,
      unsignedTransaction: unsigned,
    });

    const res = await post(actionId, signed);

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      data: { action: { actionId, status: "submitted" } },
    });
    await expect(actionRow(actionId)).resolves.toMatchObject({
      status: "submitted",
      signed_transaction: signed,
    });
  });
});
