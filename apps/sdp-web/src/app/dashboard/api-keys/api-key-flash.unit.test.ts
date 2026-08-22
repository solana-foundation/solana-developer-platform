/**
 * One-time API key secret handoff: session binding, replay, logout, and
 * cookie-policy coverage for the sealed flash cookie and its delivery route.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  cookies: vi.fn(),
  auth: vi.fn(),
}));

vi.mock("next/headers", () => ({
  cookies: mocks.cookies,
}));

vi.mock("@clerk/nextjs/server", () => ({
  auth: mocks.auth,
}));

import {
  API_KEY_FLASH_COOKIE,
  API_KEY_FLASH_NOTICE_MAX_AGE_SECONDS,
  API_KEY_FLASH_SECRET_MAX_AGE_SECONDS,
  type ApiKeyFlash,
  apiKeyFlashCookieOptions,
  apiKeyFlashMaxAgeSeconds,
} from "./api-key-flash";
import { sealApiKeyFlash, unsealApiKeyFlash } from "./api-key-flash-seal";
import { DELETE, POST } from "./flash/route";

const SESSION = { sessionId: "sess_owner", userId: "user_owner" };
const OTHER_SESSION = { sessionId: "sess_other", userId: "user_owner" };
const OTHER_USER = { sessionId: "sess_owner", userId: "user_other" };

const SECRET_FLASH: ApiKeyFlash = {
  level: "success",
  message: "API key created",
  key: "sk_test_generated_secret",
  apiKeyId: "key_123",
  keyPrefix: "sk_test_gen",
};

function jarWithCookie(value: string | undefined) {
  return {
    get: (name: string) =>
      name === API_KEY_FLASH_COOKIE && value !== undefined ? { value } : undefined,
  };
}

describe("api key flash handoff", () => {
  beforeEach(() => {
    vi.stubEnv("CLERK_SECRET_KEY", "sk_clerk_unit_test_secret");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    mocks.cookies.mockReset();
    mocks.auth.mockReset();
  });

  describe("seal / unseal", () => {
    it("round-trips for the session that minted it", async () => {
      const sealed = await sealApiKeyFlash(SECRET_FLASH, SESSION, 120);
      expect(sealed).not.toBeNull();
      expect(sealed).not.toContain(SECRET_FLASH.key);

      const unsealed = await unsealApiKeyFlash(sealed as string, SESSION);
      expect(unsealed).toEqual(SECRET_FLASH);
    });

    it("rejects a different session on the same browser", async () => {
      const sealed = (await sealApiKeyFlash(SECRET_FLASH, SESSION, 120)) as string;
      expect(await unsealApiKeyFlash(sealed, OTHER_SESSION)).toBeNull();
    });

    it("rejects a different user", async () => {
      const sealed = (await sealApiKeyFlash(SECRET_FLASH, SESSION, 120)) as string;
      expect(await unsealApiKeyFlash(sealed, OTHER_USER)).toBeNull();
    });

    it("rejects a replayed value after its expiry", async () => {
      const mintedAt = Date.now();
      const sealed = (await sealApiKeyFlash(SECRET_FLASH, SESSION, 120, mintedAt)) as string;

      expect(await unsealApiKeyFlash(sealed, SESSION, mintedAt + 119_000)).toEqual(SECRET_FLASH);
      expect(await unsealApiKeyFlash(sealed, SESSION, mintedAt + 121_000)).toBeNull();
    });

    it("rejects tampered values", async () => {
      const sealed = (await sealApiKeyFlash(SECRET_FLASH, SESSION, 120)) as string;
      const tampered = sealed.slice(0, -2) + (sealed.endsWith("aa") ? "bb" : "aa");

      expect(await unsealApiKeyFlash(tampered, SESSION)).toBeNull();
      expect(await unsealApiKeyFlash("not-a-sealed-value", SESSION)).toBeNull();
      expect(await unsealApiKeyFlash(JSON.stringify(SECRET_FLASH), SESSION)).toBeNull();
    });

    it("never seals without a sealing secret", async () => {
      vi.stubEnv("CLERK_SECRET_KEY", "");
      expect(await sealApiKeyFlash(SECRET_FLASH, SESSION, 120)).toBeNull();
    });
  });

  describe("cookie policy", () => {
    it("is HttpOnly, SameSite=Strict, path-scoped, and Secure in production", () => {
      vi.stubEnv("NODE_ENV", "production");
      const options = apiKeyFlashCookieOptions(API_KEY_FLASH_SECRET_MAX_AGE_SECONDS);

      expect(options.httpOnly).toBe(true);
      expect(options.secure).toBe(true);
      expect(options.sameSite).toBe("strict");
      expect(options.path).toBe("/dashboard/api-keys");
      expect(options.maxAge).toBe(API_KEY_FLASH_SECRET_MAX_AGE_SECONDS);
    });

    it("keeps secret-bearing flashes shorter-lived than notices", () => {
      expect(apiKeyFlashMaxAgeSeconds(SECRET_FLASH)).toBe(API_KEY_FLASH_SECRET_MAX_AGE_SECONDS);
      expect(apiKeyFlashMaxAgeSeconds({ level: "success", message: "updated" })).toBe(
        API_KEY_FLASH_NOTICE_MAX_AGE_SECONDS
      );
      expect(API_KEY_FLASH_SECRET_MAX_AGE_SECONDS).toBeLessThan(
        API_KEY_FLASH_NOTICE_MAX_AGE_SECONDS
      );
    });
  });

  describe("POST /dashboard/api-keys/flash", () => {
    it("delivers the flash once to the minting session and consumes the cookie", async () => {
      const sealed = (await sealApiKeyFlash(SECRET_FLASH, SESSION, 120)) as string;
      mocks.auth.mockResolvedValue(SESSION);
      mocks.cookies.mockResolvedValue(jarWithCookie(sealed));

      const response = await POST();
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ flash: SECRET_FLASH });

      const cleared = response.cookies.get(API_KEY_FLASH_COOKIE);
      expect(cleared?.value).toBe("");
      expect(cleared?.maxAge).toBe(0);
      expect(cleared?.httpOnly).toBe(true);
      expect(cleared?.sameSite).toBe("strict");
      expect(cleared?.path).toBe("/dashboard/api-keys");

      // Replay: the cookie is gone, so a second read returns nothing.
      mocks.cookies.mockResolvedValue(jarWithCookie(undefined));
      const replay = await POST();
      expect(await replay.json()).toEqual({ flash: null });
    });

    it("returns null to a different session and still destroys the cookie", async () => {
      const sealed = (await sealApiKeyFlash(SECRET_FLASH, SESSION, 120)) as string;
      mocks.auth.mockResolvedValue(OTHER_SESSION);
      mocks.cookies.mockResolvedValue(jarWithCookie(sealed));

      const response = await POST();
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ flash: null });
      expect(response.cookies.get(API_KEY_FLASH_COOKIE)?.value).toBe("");
      expect(response.cookies.get(API_KEY_FLASH_COOKIE)?.maxAge).toBe(0);
    });

    it("rejects logged-out requests and destroys any pending secret", async () => {
      const sealed = (await sealApiKeyFlash(SECRET_FLASH, SESSION, 120)) as string;
      mocks.auth.mockResolvedValue({ sessionId: null, userId: null });
      mocks.cookies.mockResolvedValue(jarWithCookie(sealed));

      const response = await POST();
      expect(response.status).toBe(401);
      expect(await response.json()).toEqual({ flash: null });
      expect(response.cookies.get(API_KEY_FLASH_COOKIE)?.value).toBe("");
      expect(response.cookies.get(API_KEY_FLASH_COOKIE)?.maxAge).toBe(0);
    });

    it("ignores legacy plaintext cookies", async () => {
      mocks.auth.mockResolvedValue(SESSION);
      mocks.cookies.mockResolvedValue(jarWithCookie(JSON.stringify(SECRET_FLASH)));

      const response = await POST();
      expect(await response.json()).toEqual({ flash: null });
      expect(response.cookies.get(API_KEY_FLASH_COOKIE)?.value).toBe("");
    });
  });

  describe("DELETE /dashboard/api-keys/flash", () => {
    it("clears the cookie", async () => {
      const response = await DELETE();
      expect(await response.json()).toEqual({ ok: true });
      expect(response.cookies.get(API_KEY_FLASH_COOKIE)?.value).toBe("");
      expect(response.cookies.get(API_KEY_FLASH_COOKIE)?.maxAge).toBe(0);
    });
  });
});
