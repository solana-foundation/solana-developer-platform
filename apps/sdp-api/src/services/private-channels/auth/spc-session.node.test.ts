import type { SpcAuthClient } from "@sdp/private-channels/auth";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { PrivateChannelUserRow } from "@/db/repositories";
import { createSpcCredentialCipher } from "@/lib/spc-credential-crypto";
import type { KVPutOptions, KVStore } from "@/runtime/kv";
import { generateEncryptionKey } from "@/services/encryption.service";
import type { Env } from "@/types/env";
import { getSpcSession } from "./spc-session";

// getSpcSession only needs PrivateChannelError from this package; stub it so importing
// the package index doesn't pull in gateway.ts → @sdp/rpc/solana (an unresolved subpath
// in the node test pool). Mirrors the cron tests' approach.
vi.mock("@sdp/private-channels", () => ({
  PrivateChannelError: class PrivateChannelError extends Error {
    constructor(
      public readonly code: string,
      message?: string
    ) {
      super(message ?? code);
      this.name = "PrivateChannelError";
    }
  },
}));

const ORG = "org-1";
const INSTANCE = "inst-1";
const PC_USER_ID = "pcu-1";
const USERNAME = "alice";
const KEY = `spc-session:${INSTANCE}:${PC_USER_ID}`;

let env: Env;
let credentialCiphertext: string;

beforeAll(async () => {
  const key = await generateEncryptionKey();
  env = { SPC_CREDENTIAL_ENCRYPTION_KEY: key } as unknown as Env;
  // A ciphertext the same key can decrypt — the stored SPC password.
  credentialCiphertext = await createSpcCredentialCipher(env).encrypt(ORG, "s3cret");
});

function pcUser(overrides: Partial<PrivateChannelUserRow> = {}): PrivateChannelUserRow {
  return {
    id: PC_USER_ID,
    organization_id: ORG,
    project_id: "proj-1",
    user_id: "user-1",
    spc_user_id: "spc-1",
    spc_username: USERNAME,
    spc_credential_ciphertext: credentialCiphertext,
    invited_by: null,
    invite_token: null,
    invited_at: "2026-01-01T00:00:00.000Z",
    accepted_at: null,
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function memoryKv() {
  const store = new Map<string, string>();
  const kv = {
    store,
    get: vi.fn(async (key: string, type?: "json") => {
      const raw = store.get(key);
      if (raw == null) return null;
      return type === "json" ? JSON.parse(raw) : raw;
    }),
    put: vi.fn(async (key: string, value: string, _options?: KVPutOptions) => {
      store.set(key, value);
    }),
    delete: vi.fn(async (key: string) => {
      store.delete(key);
    }),
    list: vi.fn(async () => ({ keys: [...store.keys()].map((name) => ({ name })) })),
  };
  return kv as typeof kv & KVStore;
}

function authClient(token: string) {
  const login = vi.fn(async () => ({ token }));
  return { client: { login } as unknown as SpcAuthClient, login };
}

async function seedEntry(kv: ReturnType<typeof memoryKv>, token: string, expiresAt: number) {
  const ciphertext = await createSpcCredentialCipher(env).encrypt(ORG, token);
  kv.store.set(KEY, JSON.stringify({ tokenCiphertext: ciphertext, expiresAt }));
}

/** JWT whose `exp` claim (in SECONDS) is `expSeconds`; only the payload matters here. */
function jwtWithExp(expSeconds: number): string {
  const payload = Buffer.from(JSON.stringify({ exp: expSeconds })).toString("base64url");
  return `h.${payload}.s`;
}

describe("getSpcSession caching", () => {
  it("logs in and writes the cache on a miss", async () => {
    const kv = memoryKv();
    const { client, login } = authClient("tok-1");

    const session = await getSpcSession(env, ORG, pcUser(), client, {
      cache: kv,
      instanceId: INSTANCE,
    });

    expect(session).toEqual({ token: "tok-1", username: USERNAME });
    expect(login).toHaveBeenCalledTimes(1);
    expect(kv.put).toHaveBeenCalledTimes(1);
    expect(kv.store.has(KEY)).toBe(true);
  });

  it("returns the cached token without logging in on a hit", async () => {
    const kv = memoryKv();
    await seedEntry(kv, "cached-tok", Date.now() + 3_600_000);
    const { client, login } = authClient("fresh");

    const session = await getSpcSession(env, ORG, pcUser(), client, {
      cache: kv,
      instanceId: INSTANCE,
    });

    expect(session.token).toBe("cached-tok");
    expect(login).not.toHaveBeenCalled();
  });

  it("re-logs in when the cached token is within the refresh skew", async () => {
    const kv = memoryKv();
    await seedEntry(kv, "stale", Date.now() + 30_000); // < 60s skew
    const { client, login } = authClient("fresh");

    const session = await getSpcSession(env, ORG, pcUser(), client, {
      cache: kv,
      instanceId: INSTANCE,
    });

    expect(session.token).toBe("fresh");
    expect(login).toHaveBeenCalledTimes(1);
  });

  it("forceRefresh evicts and re-logs in even on a fresh entry", async () => {
    const kv = memoryKv();
    await seedEntry(kv, "cached", Date.now() + 3_600_000);
    const { client, login } = authClient("fresh");

    const session = await getSpcSession(env, ORG, pcUser(), client, {
      cache: kv,
      instanceId: INSTANCE,
      forceRefresh: true,
    });

    expect(session.token).toBe("fresh");
    expect(login).toHaveBeenCalledTimes(1);
    expect(kv.delete).toHaveBeenCalledWith(KEY);
  });

  it("logs in every call and never touches a cache when none is provided", async () => {
    const { client, login } = authClient("tok");

    await getSpcSession(env, ORG, pcUser(), client);
    await getSpcSession(env, ORG, pcUser(), client);

    expect(login).toHaveBeenCalledTimes(2);
  });

  it("degrades to a login when the KV read throws", async () => {
    const kv = memoryKv();
    kv.get.mockRejectedValueOnce(new Error("kv down"));
    const { client, login } = authClient("tok");

    const session = await getSpcSession(env, ORG, pcUser(), client, {
      cache: kv,
      instanceId: INSTANCE,
    });

    expect(session.token).toBe("tok");
    expect(login).toHaveBeenCalledTimes(1);
  });

  it("treats an undecryptable cached entry as a miss", async () => {
    const kv = memoryKv();
    kv.store.set(
      KEY,
      JSON.stringify({
        tokenCiphertext: "not-decryptable",
        expiresAt: Date.now() + 3_600_000,
      })
    );
    const { client, login } = authClient("fresh");

    const session = await getSpcSession(env, ORG, pcUser(), client, {
      cache: kv,
      instanceId: INSTANCE,
    });

    expect(session.token).toBe("fresh");
    expect(login).toHaveBeenCalledTimes(1);
  });

  it("derives the cached expiry from the JWT exp (seconds → ms)", async () => {
    const kv = memoryKv();
    const exp = Math.floor(Date.now() / 1000) + 3600;
    const { client } = authClient(jwtWithExp(exp));

    await getSpcSession(env, ORG, pcUser(), client, { cache: kv, instanceId: INSTANCE });

    expect(kv.put).toHaveBeenCalledTimes(1);
    const opts = kv.put.mock.calls[0][2] as { expirationTtl: number };
    expect(opts.expirationTtl).toBeGreaterThan(0);
    const stored = JSON.parse(kv.store.get(KEY) as string);
    expect(stored.expiresAt).toBe(exp * 1000);
  });

  it("does not cache a token whose remaining life is below the floor", async () => {
    const kv = memoryKv();
    const { client } = authClient(jwtWithExp(Math.floor(Date.now() / 1000) + 90)); // 90s < 120s floor

    const session = await getSpcSession(env, ORG, pcUser(), client, {
      cache: kv,
      instanceId: INSTANCE,
    });

    expect(session.token).not.toBe("");
    expect(kv.put).not.toHaveBeenCalled();
  });
});
