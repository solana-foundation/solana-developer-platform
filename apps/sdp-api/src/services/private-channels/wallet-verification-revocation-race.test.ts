/**
 * Regression for SOLA9-664 (APE-812): a `verifyPrivateChannelWallet` request
 * that is still between its SPC verify-wallet call and its local mirror upsert
 * must not resurrect `private_channel_verified_wallets` after a concurrent
 * `deletePrivateChannelWallet` has completed an upstream `deleteWallet` and
 * removed the mirror. The resurrected row is accepted by the value-movement
 * gates (`findAnyByInstanceAndPubkey`) even though the SPC authority has no
 * binding — a post-revocation authorization divergence.
 *
 * The SPC HTTP boundary is a real local server (no SDP-function mocks); only
 * the network edge is synthetic. The secure invariant asserted:
 * after a successful revocation, no in-flight verification continuation may
 * recreate the mirror while SPC stays unbound.
 */

import { mkdtemp, readFile, rm } from "node:fs/promises";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hashString } from "@sdp/payments/hash";
import type { CachedApiKey } from "@sdp/types";
import { getBase58Codec } from "@solana/codecs";
import { createKeyPairSignerFromPrivateKeyBytes, writeKeyPairSigner } from "@solana/kit";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getDb } from "@/db";
import app from "@/index";
import { createSpcCredentialCipher } from "@/lib/spc-credential-crypto";
import { createCustodyCipher } from "@/services/custody-cipher/cipher-router";
import { env } from "@/test/helpers/env";
import { seedTestDatabase } from "@/test/mocks/db";
import { clearKVStores, seedCachedApiKey } from "@/test/mocks/kv";

const ORG_ID = "org_wallet_race";
const PROJECT_ID = "prj_wallet_race";
const USER_ID = "usr_wallet_race";
const API_KEY_ID = "key_wallet_race";
const API_KEY = "sk_test_wallet_race";
const INSTANCE_ID = "pci_wallet_race";
const PRINCIPAL_ID = "pcu_wallet_race";
const CUSTODY_CONFIG_ID = "cfg_wallet_race";
const CUSTODY_WALLET_ROW_ID = "cw_wallet_race";
const WALLET_ID = "wallet_wallet_race";
const SPC_PASSWORD = "synthetic-spc-password";
const CIPHER_KEY = "BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc=";

interface AuthHarness {
  server: Server;
  url: string;
  upstreamWallets: Set<string>;
  verifyReceived: Promise<void>;
  releaseVerify: () => void;
}

function json(res: ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value);
  res.writeHead(status, { "content-type": "application/json" });
  res.end(body);
}

async function requestBody(req: IncomingMessage): Promise<Record<string, string>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, string>;
}

/**
 * Stands in for the connected SPC auth service. `gateVerify` holds the first
 * verify-wallet response until the test releases it, so the verify request's
 * local mirror write can be raced against a completed revocation.
 */
async function createAuthHarness(gateVerify: boolean): Promise<AuthHarness> {
  const upstreamWallets = new Set<string>();
  let verifyReceivedResolve!: () => void;
  let releaseVerify!: () => void;
  const verifyReceived = new Promise<void>((resolve) => {
    verifyReceivedResolve = resolve;
  });
  const verifyRelease = new Promise<void>((resolve) => {
    releaseVerify = resolve;
  });

  const server = createServer(async (req, res) => {
    const path = new URL(req.url ?? "/", "http://127.0.0.1").pathname;
    if (req.method === "POST" && path === "/auth/login") {
      const body = await requestBody(req);
      if (body.password !== SPC_PASSWORD) return json(res, 401, { error: "bad credentials" });
      return json(res, 200, { token: "race-token" });
    }
    if (req.method === "POST" && path === "/auth/challenge-wallet") {
      return json(res, 200, {
        message: "synthetic wallet race challenge",
        nonce: "synthetic-race-nonce",
        expires_at: "2099-01-01T00:00:00.000Z",
      });
    }
    if (req.method === "POST" && path === "/auth/verify-wallet") {
      const body = await requestBody(req);
      upstreamWallets.add(body.pubkey);
      verifyReceivedResolve();
      if (gateVerify) {
        await verifyRelease;
      }
      return json(res, 200, { pubkey: body.pubkey, created_at: "2099-01-01T00:00:00.000Z" });
    }
    if (req.method === "DELETE" && path.startsWith("/auth/wallets/")) {
      const pubkey = decodeURIComponent(path.slice("/auth/wallets/".length));
      upstreamWallets.delete(pubkey);
      res.writeHead(204);
      return res.end();
    }
    return json(res, 404, { error: "not found" });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("auth harness did not bind a port");

  return {
    server,
    url: `http://127.0.0.1:${address.port}`,
    upstreamWallets,
    verifyReceived,
    releaseVerify,
  };
}

function apiHeaders(): Record<string, string> {
  return {
    Authorization: `Bearer ${API_KEY}`,
    "Content-Type": "application/json",
  };
}

async function waitFor<T>(promise: Promise<T>, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`Timed out waiting for ${label}`)), 10_000)
    ),
  ]);
}

async function readMirrorRow(instanceId: string, pubkey: string) {
  return getDb(env)
    .prepare(
      "SELECT wallet_id, pubkey FROM private_channel_verified_wallets WHERE instance_id = ? AND pubkey = ?"
    )
    .bind(instanceId, pubkey)
    .first<{ wallet_id: string; pubkey: string }>();
}

describe("Private Channels wallet verification vs revocation race (SOLA9-664)", () => {
  let harness: AuthHarness;
  let signerAddress: string;
  let originalDeploymentMode: typeof env.SDP_DEPLOYMENT_MODE;
  let originalCustodyEncryptionKey: string | undefined;
  let originalCustodyPrivateKey: string | undefined;
  let originalPrivateChannelsEnabled: string | undefined;

  beforeEach(async () => {
    originalDeploymentMode = env.SDP_DEPLOYMENT_MODE;
    originalCustodyEncryptionKey = env.CUSTODY_ENCRYPTION_KEY;
    originalCustodyPrivateKey = env.CUSTODY_PRIVATE_KEY;
    originalPrivateChannelsEnabled = env.PRIVATE_CHANNELS_ENABLED;
    env.SDP_DEPLOYMENT_MODE = "self_hosted";
    env.CUSTODY_ENCRYPTION_KEY = CIPHER_KEY;
    env.PRIVATE_CHANNELS_ENABLED = "true";
    await seedTestDatabase(env);

    const signer = await createKeyPairSignerFromPrivateKeyBytes(new Uint8Array(32).fill(7), true);
    signerAddress = signer.address;
    const keyDir = await mkdtemp(join(tmpdir(), "sdp-wallet-race-"));
    const keyPath = join(keyDir, "keypair.json");
    await writeKeyPairSigner(signer, keyPath);
    const keypairBytes = Uint8Array.from(JSON.parse(await readFile(keyPath, "utf8")) as number[]);
    const privateKeyBase58 = getBase58Codec().decode(keypairBytes);
    env.CUSTODY_PRIVATE_KEY = privateKeyBase58;
    const encryptedPrivateKey = await createCustodyCipher(env).encrypt(ORG_ID, privateKeyBase58);
    const encryptedSpcPassword = await createSpcCredentialCipher(env).encrypt(ORG_ID, SPC_PASSWORD);
    await rm(keyDir, { recursive: true, force: true });

    const keyHash = await hashString(API_KEY, env.API_KEY_PEPPER);
    const cachedKey: CachedApiKey = {
      id: API_KEY_ID,
      organizationId: ORG_ID,
      projectId: PROJECT_ID,
      role: "api_admin",
      permissions: ["payments:write"],
      environment: "sandbox",
      rateLimitTier: "standard",
      allowedIps: null,
      signingWalletId: null,
      status: "active",
      expiresAt: null,
      rotationDeadline: null,
      organizationStatus: "active",
    };
    await seedCachedApiKey(env, keyHash, cachedKey);

    await getDb(env).batch([
      getDb(env)
        .prepare(
          "INSERT INTO organizations (id, name, slug, tier, status, settings) VALUES (?, ?, ?, ?, 'active', ?)"
        )
        .bind(
          ORG_ID,
          "Wallet Race",
          "wallet-race",
          "enterprise",
          JSON.stringify({ providerOverrides: { custody: { local: true } } })
        ),
      getDb(env)
        .prepare("INSERT INTO users (id, email, status) VALUES (?, ?, 'active')")
        .bind(USER_ID, "wallet-race@example.com"),
      getDb(env)
        .prepare(
          "INSERT INTO projects (id, organization_id, name, slug, environment, status, created_by) VALUES (?, ?, ?, ?, 'sandbox', 'active', ?)"
        )
        .bind(PROJECT_ID, ORG_ID, "Wallet Race", "wallet-race", USER_ID),
      getDb(env)
        .prepare(
          "INSERT INTO api_keys (id, organization_id, project_id, created_by, name, key_prefix, key_hash, role, permissions, status) VALUES (?, ?, ?, ?, ?, ?, ?, 'api_admin', ?, 'active')"
        )
        .bind(
          API_KEY_ID,
          ORG_ID,
          PROJECT_ID,
          USER_ID,
          "Wallet race key",
          API_KEY.slice(0, 12),
          keyHash,
          JSON.stringify(["payments:write"])
        ),
      getDb(env)
        .prepare(
          "INSERT INTO private_channel_instances (id, organization_id, project_id, gateway_url, chain_rpc_url, escrow_program_id, withdraw_program_id, escrow_instance_addr, auth_url, is_active) VALUES (?, ?, ?, ?, '', ?, ?, ?, ?, true)"
        )
        .bind(
          INSTANCE_ID,
          ORG_ID,
          PROJECT_ID,
          "http://127.0.0.1:1",
          signerAddress,
          signerAddress,
          signerAddress,
          "SET_BY_TEST"
        ),
      getDb(env)
        .prepare(
          "INSERT INTO private_channel_users (id, organization_id, project_id, instance_id, user_id, is_default, provisioned_at, spc_user_id, spc_username, spc_credential_ciphertext) VALUES (?, ?, ?, ?, ?, true, ?, ?, ?, ?)"
        )
        .bind(
          PRINCIPAL_ID,
          ORG_ID,
          PROJECT_ID,
          INSTANCE_ID,
          USER_ID,
          "2099-01-01T00:00:00.000Z",
          "spc-wallet-race-user",
          "wallet-race-user",
          encryptedSpcPassword
        ),
      getDb(env)
        .prepare(
          "INSERT INTO custody_configs (id, organization_id, project_id, provider, config_encrypted, default_wallet_id, status) VALUES (?, ?, ?, 'local', ?, ?, 'active')"
        )
        .bind(
          CUSTODY_CONFIG_ID,
          ORG_ID,
          PROJECT_ID,
          JSON.stringify({ provider: "local", encryptedPrivateKey }),
          WALLET_ID
        ),
      getDb(env)
        .prepare(
          "INSERT INTO custody_wallets (id, custody_config_id, wallet_id, public_key, status) VALUES (?, ?, ?, ?, 'active')"
        )
        .bind(CUSTODY_WALLET_ROW_ID, CUSTODY_CONFIG_ID, WALLET_ID, signerAddress),
    ]);
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => harness?.server.close(() => resolve()));
    await clearKVStores(env);
    env.SDP_DEPLOYMENT_MODE = originalDeploymentMode;
    env.CUSTODY_ENCRYPTION_KEY = originalCustodyEncryptionKey;
    env.CUSTODY_PRIVATE_KEY = originalCustodyPrivateKey;
    env.PRIVATE_CHANNELS_ENABLED = originalPrivateChannelsEnabled;
  });

  it("does not resurrect the local mirror after a completed revocation", async () => {
    harness = await createAuthHarness(true);
    await getDb(env)
      .prepare("UPDATE private_channel_instances SET auth_url = ? WHERE id = ?")
      .bind(harness.url, INSTANCE_ID)
      .run();
    // The mirror row from the wallet's previous verification: it is what makes
    // the concurrent DELETE a real revocation of a bound wallet.
    await getDb(env)
      .prepare(
        "INSERT INTO private_channel_verified_wallets (id, organization_id, project_id, user_id, instance_id, wallet_id, pubkey) VALUES (?, ?, ?, ?, ?, ?, ?)"
      )
      .bind(
        "pcvw_wallet_race",
        ORG_ID,
        PROJECT_ID,
        PRINCIPAL_ID,
        INSTANCE_ID,
        WALLET_ID,
        signerAddress
      )
      .run();
    harness.upstreamWallets.add(signerAddress);

    // Request A: verify. It completes the SPC verify-wallet upstream, then
    // parks on the harness before answering, so its local mirror write is pending.
    const verifyPromise = app.request(
      `/v1/private-channels/wallets/${WALLET_ID}/verify`,
      { method: "POST", headers: apiHeaders(), body: "{}" },
      env
    );
    await waitFor(harness.verifyReceived, "SPC verify-wallet");
    expect(harness.upstreamWallets.has(signerAddress)).toBe(true);

    // Request B: revoke. Runs to completion while A's mirror write is pending:
    // SPC delete-wallet succeeds and the local mirror is removed.
    const deleteResponse = await app.request(
      `/v1/private-channels/wallets/${encodeURIComponent(signerAddress)}`,
      { method: "DELETE", headers: apiHeaders() },
      env
    );
    expect(deleteResponse.status).toBe(200);
    expect(harness.upstreamWallets.has(signerAddress)).toBe(false);
    expect(await readMirrorRow(INSTANCE_ID, signerAddress)).toBeNull();

    // Release A: the stale verification continuation must not recreate the
    // mirror while SPC has no binding.
    harness.releaseVerify();
    const verifyResponse = await verifyPromise;
    expect(verifyResponse.status).toBe(409);
    expect(await readMirrorRow(INSTANCE_ID, signerAddress)).toBeNull();
    expect(harness.upstreamWallets.has(signerAddress)).toBe(false);
  });

  it("still allows a fresh verification after a completed revocation", async () => {
    harness = await createAuthHarness(false);
    await getDb(env)
      .prepare("UPDATE private_channel_instances SET auth_url = ? WHERE id = ?")
      .bind(harness.url, INSTANCE_ID)
      .run();
    await getDb(env)
      .prepare(
        "INSERT INTO private_channel_verified_wallets (id, organization_id, project_id, user_id, instance_id, wallet_id, pubkey) VALUES (?, ?, ?, ?, ?, ?, ?)"
      )
      .bind(
        "pcvw_wallet_race_seq",
        ORG_ID,
        PROJECT_ID,
        PRINCIPAL_ID,
        INSTANCE_ID,
        WALLET_ID,
        signerAddress
      )
      .run();
    harness.upstreamWallets.add(signerAddress);

    // Revoke the earlier verification completely.
    const deleteResponse = await app.request(
      `/v1/private-channels/wallets/${encodeURIComponent(signerAddress)}`,
      { method: "DELETE", headers: apiHeaders() },
      env
    );
    expect(deleteResponse.status).toBe(200);
    expect(harness.upstreamWallets.has(signerAddress)).toBe(false);
    expect(await readMirrorRow(INSTANCE_ID, signerAddress)).toBeNull();

    // A verification that starts after the revocation is a supported flow and
    // must succeed end to end: upstream binding recreated, mirror recorded.
    const verifyResponse = await app.request(
      `/v1/private-channels/wallets/${WALLET_ID}/verify`,
      { method: "POST", headers: apiHeaders(), body: "{}" },
      env
    );
    expect(verifyResponse.status).toBe(200);
    expect(harness.upstreamWallets.has(signerAddress)).toBe(true);
    expect(await readMirrorRow(INSTANCE_ID, signerAddress)).toEqual({
      wallet_id: WALLET_ID,
      pubkey: signerAddress,
    });
  });
});
