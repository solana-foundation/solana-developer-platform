import type { CachedApiKey } from "@sdp/types";
import type { Context, Next } from "hono";
import { describe, expect, it, vi } from "vitest";
import type { KVStore } from "@/runtime/kv";
import { TEST_API_KEY, TEST_CACHED_API_KEY } from "@/test/fixtures/api-keys";
import type { Env } from "@/types/env";
import { authMiddleware } from "./auth";

class FakeKVStore implements KVStore {
  constructor(private readonly cachedKey: CachedApiKey) {}

  async get(_key: string): Promise<string | null>;
  async get<T>(_key: string, type: "json"): Promise<T | null>;
  async get<T>(_key: string, type?: "json"): Promise<string | T | null> {
    return type === "json" ? (this.cachedKey as T) : JSON.stringify(this.cachedKey);
  }

  async put(): Promise<void> {}

  async delete(): Promise<void> {}

  async list(): Promise<{ keys: [] }> {
    return { keys: [] };
  }
}

function createAuthContext(
  cachedKey: CachedApiKey,
  headers: Record<string, string>
): Context<{ Bindings: Env }> {
  const normalizedHeaders = new Map(
    Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value])
  );
  const kv = new FakeKVStore(cachedKey);

  return {
    env: {
      ENVIRONMENT: "development",
      API_VERSION: "v1",
      API_KEY_PEPPER: "test-pepper-for-unit-tests",
    },
    req: {
      header: (name: string) => normalizedHeaders.get(name.toLowerCase()),
    },
    var: {
      kv: {
        apiKeys: kv,
        rateLimits: kv,
        cache: kv,
        sessions: kv,
      },
    },
    set: vi.fn(),
  } as unknown as Context<{ Bindings: Env }>;
}

describe("authMiddleware allowed IPs", () => {
  it("rejects cached API keys used outside the configured CIDR", async () => {
    const context = createAuthContext(
      {
        ...TEST_CACHED_API_KEY,
        allowedIps: ["203.0.113.0/24"],
      },
      {
        Authorization: `Bearer ${TEST_API_KEY.raw}`,
        "cf-connecting-ip": "198.51.100.42",
      }
    );
    const next = vi.fn() as Next;

    await expect(authMiddleware()(context, next)).rejects.toMatchObject({
      code: "INVALID_API_KEY",
      statusCode: 401,
    });
    expect(next).not.toHaveBeenCalled();
  });

  it("rejects cached API keys without a trusted Cloudflare source IP", async () => {
    const context = createAuthContext(
      {
        ...TEST_CACHED_API_KEY,
        allowedIps: ["203.0.113.0/24"],
      },
      {
        Authorization: `Bearer ${TEST_API_KEY.raw}`,
        "x-forwarded-for": "203.0.113.42",
      }
    );
    const next = vi.fn() as Next;

    await expect(authMiddleware()(context, next)).rejects.toMatchObject({
      code: "INVALID_API_KEY",
      statusCode: 401,
    });
    expect(next).not.toHaveBeenCalled();
  });

  it("rejects cached API keys when any allowlist entry is malformed", async () => {
    const context = createAuthContext(
      {
        ...TEST_CACHED_API_KEY,
        allowedIps: ["203.0.113.0/24", "not-a-cidr"],
      },
      {
        Authorization: `Bearer ${TEST_API_KEY.raw}`,
        "cf-connecting-ip": "203.0.113.42",
      }
    );
    const next = vi.fn() as Next;

    await expect(authMiddleware()(context, next)).rejects.toMatchObject({
      code: "INVALID_API_KEY",
      statusCode: 401,
    });
    expect(next).not.toHaveBeenCalled();
  });
});
