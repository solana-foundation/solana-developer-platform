/**
 * Integration test for SPC gateway auth: the KV token cache + 401 invalidate-and-retry,
 * exercised against the real `createKVStoreSet(env).cache` (Redis) and the test
 * Postgres, both provisioned by the testcontainers global setup.
 *
 * Only the external SPC boundary is mocked: `createAuthClient().login` (so no live SPC auth
 * service). Everything else is the production path — `resolveGatewayAuth` does its DB
 * lookup for the member, `getSpcSession` reads/writes KV and does AES-GCM
 * encryption, and `withGatewayRpc` runs the retry with the `isUnauthorizedRpcError`
 * classifier. The gateway RPC op itself is supplied by the test (a Solana RPC call
 * isn't part of the caching feature), simulating success / 401 / non-401.
 */

import { PrivateChannelError } from "@sdp/private-channels";
import * as spcAuth from "@sdp/private-channels/auth";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { getDb } from "@/db";
import { createPrivateChannelUserRepository } from "@/db/repositories";
import { createSpcCredentialCipher } from "@/lib/spc-credential-crypto";
import { createKVStoreSet } from "@/runtime/kv-redis";
import { generateEncryptionKey } from "@/services/encryption.service";
import {
  openSpcAuthContext,
  resolveGatewayAuth,
  withGatewayRpc,
  withSpcAuth,
} from "@/services/private-channels/auth/gateway-auth";
import { TEST_ORG, TEST_USER } from "@/test/fixtures/organizations";
import { env as baseEnv } from "@/test/helpers/env";
import { clearTestDatabase, seedTestDatabase } from "@/test/mocks/db";
import type { Env } from "@/types/env";

const PROJECT_ID = "prj_spc_cache_it";
const PCU_ID = "pcu_spc_cache_it";
const INSTANCE_ID = "pci_spc_cache_it";
const AUTH_URL = "http://auth.example:8903";
const GATEWAY_URL = "https://gateway.example";
const CACHE_KEY = `spc-session:${INSTANCE_ID}:${PCU_ID}`;

const instance = { id: INSTANCE_ID, authUrl: AUTH_URL };
const resolveInput = {
  instance,
  organizationId: TEST_ORG.id,
  projectId: PROJECT_ID,
  userId: TEST_USER.id,
};

/** A distinct far-future-exp JWT per call, so a minted token is cached above the floor. */
let tokenCounter = 0;
function mintJwt(): string {
  tokenCounter += 1;
  const exp = Math.floor(Date.now() / 1000) + 3600;
  const payload = Buffer.from(JSON.stringify({ exp, jti: tokenCounter })).toString("base64url");
  return `h.${payload}.s`;
}

let testEnv: Env;
let loginMock: ReturnType<typeof vi.fn>;

beforeAll(async () => {
  const key = await generateEncryptionKey();
  // The shared test env lacks the SPC key; add it so encryption is consistent across
  // seeding (the stored credential) and getSpcSession (the cached token).
  testEnv = { ...(baseEnv as Env), SPC_CREDENTIAL_ENCRYPTION_KEY: key };
  await seedTestDatabase(baseEnv as Parameters<typeof seedTestDatabase>[0]);
});

afterAll(async () => {
  await clearTestDatabase(baseEnv as Parameters<typeof clearTestDatabase>[0]);
});

beforeEach(async () => {
  const db = getDb(testEnv);
  await db.prepare("DELETE FROM private_channel_users").run();
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
  await db
    .prepare(
      `INSERT INTO projects (id, organization_id, name, slug, environment, status, created_by)
         VALUES (?, ?, 'IT', ?, 'sandbox', 'active', ?)`
    )
    .bind(PROJECT_ID, TEST_ORG.id, PROJECT_ID, TEST_USER.id)
    .run();

  // The member row resolveGatewayAuth looks up, with an encrypted SPC credential.
  const ciphertext = await createSpcCredentialCipher(testEnv).encrypt(TEST_ORG.id, "spc-password");
  await db
    .prepare(
      `INSERT INTO private_channel_users
         (id, organization_id, project_id, user_id, spc_user_id, spc_username, spc_credential_ciphertext)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(PCU_ID, TEST_ORG.id, PROJECT_ID, TEST_USER.id, "spc-1", "alice", ciphertext)
    .run();

  // Fresh KV per test.
  await createKVStoreSet(testEnv).cache.delete(CACHE_KEY);

  // Mock ONLY the external SPC auth service: each login mints a new far-future JWT.
  loginMock = vi.fn(async () => ({ token: mintJwt() }));
  vi.spyOn(spcAuth, "createAuthClient").mockReturnValue({ login: loginMock } as never);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("SPC gateway auth — KV cache + 401 retry (Redis KV + Postgres)", () => {
  it("caches the SPC token in KV so a second resolve does not re-login", async () => {
    const first = await resolveGatewayAuth(testEnv, resolveInput);
    expect(first?.current).toBeTruthy();
    expect(loginMock).toHaveBeenCalledTimes(1);

    // The token is really in the KV store (encrypted).
    const cached = await createKVStoreSet(testEnv).cache.get<{ tokenCiphertext: string }>(
      CACHE_KEY,
      "json"
    );
    expect(cached?.tokenCiphertext).toBeTruthy();
    expect(cached?.tokenCiphertext).not.toContain(first?.current ?? "");

    const second = await resolveGatewayAuth(testEnv, resolveInput);
    expect(second?.current).toBe(first?.current);
    expect(loginMock).toHaveBeenCalledTimes(1);
  });

  it("on a gateway 401, evicts + re-mints via the context and retries once", async () => {
    const auth = await resolveGatewayAuth(testEnv, resolveInput);
    expect(loginMock).toHaveBeenCalledTimes(1);
    const firstToken = auth?.current;

    let attempts = 0;
    const result = await withGatewayRpc(testEnv, GATEWAY_URL, auth, async (rpc) => {
      attempts += 1;
      if (attempts === 1) {
        throw { context: { statusCode: 401 } };
      }
      return rpc;
    });

    expect(attempts).toBe(2);
    expect(loginMock).toHaveBeenCalledTimes(2);
    expect(auth?.current).not.toBe(firstToken);
    expect(result).toBeTruthy();

    expect(await createKVStoreSet(testEnv).cache.get(CACHE_KEY, "json")).not.toBeNull();
  });

  it("does not retry or re-login on a non-401 gateway error", async () => {
    const auth = await resolveGatewayAuth(testEnv, resolveInput);
    loginMock.mockClear();

    let attempts = 0;
    await expect(
      withGatewayRpc(testEnv, GATEWAY_URL, auth, async () => {
        attempts += 1;
        throw { context: { statusCode: 500 } };
      })
    ).rejects.toEqual({ context: { statusCode: 500 } });

    expect(attempts).toBe(1);
    expect(loginMock).not.toHaveBeenCalled();
  });

  it("shares the KV cache between openSpcAuthContext and resolveGatewayAuth", async () => {
    const pcUser = await createPrivateChannelUserRepository(testEnv).getById(
      { organizationId: TEST_ORG.id, projectId: PROJECT_ID },
      PCU_ID
    );
    if (!pcUser) {
      throw new Error("test setup: expected the seeded private channel user to exist");
    }
    const client = spcAuth.createAuthClient(AUTH_URL);

    const walletAuth = await openSpcAuthContext(testEnv, TEST_ORG.id, INSTANCE_ID, pcUser, client);
    expect(loginMock).toHaveBeenCalledTimes(1);

    const gatewayAuth = await resolveGatewayAuth(testEnv, resolveInput);
    expect(gatewayAuth?.current).toBe(walletAuth.current);
    expect(loginMock).toHaveBeenCalledTimes(1);
  });

  it("on Auth REST UNAUTHORIZED, evicts + re-mints via withSpcAuth and retries once", async () => {
    const auth = await resolveGatewayAuth(testEnv, resolveInput);
    expect(loginMock).toHaveBeenCalledTimes(1);
    const firstToken = auth.current;

    let attempts = 0;
    const result = await withSpcAuth(auth, async (token) => {
      attempts += 1;
      if (attempts === 1) {
        throw new PrivateChannelError("UNAUTHORIZED", "stale");
      }
      return token;
    });

    expect(attempts).toBe(2);
    expect(loginMock).toHaveBeenCalledTimes(2);
    expect(result).not.toBe(firstToken);
    expect(auth.current).toBe(result);
  });
});
