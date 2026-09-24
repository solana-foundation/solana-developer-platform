/**
 * Sealed render scopes bind a dashboard mutation to the project a page was
 * rendered with (APE-706, SOLA9-424): session binding, replay, expiry,
 * tampering, and fail-closed behavior when no sealing secret is configured.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  RENDER_SCOPE_TTL_SECONDS,
  sealRenderScope,
  unsealRenderScope,
  verifyRenderScope,
} from "./render-scope";

const SESSION = { sessionId: "sess_render", userId: "usr_render" };
const OTHER_SESSION = { sessionId: "sess_other", userId: "usr_render" };
const OTHER_USER = { sessionId: "sess_render", userId: "usr_other" };

describe("render scope seal", () => {
  beforeEach(() => {
    vi.stubEnv("CLERK_SECRET_KEY", "sk_clerk_unit_test_secret");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("round-trips for the session that minted it and reports the bound project", async () => {
    const mintedAt = Date.now();
    const sealed = await sealRenderScope({ projectId: "prj_a" }, SESSION, 1800, mintedAt);
    expect(sealed).not.toBeNull();

    const scope = await unsealRenderScope(sealed as string, SESSION, mintedAt + 1000);
    expect(scope).toEqual({ projectId: "prj_a" });
  });

  it("does not disclose the bound project in the sealed value", async () => {
    const sealed = await sealRenderScope({ projectId: "prj_secret_project" }, SESSION, 1800);
    expect(sealed).not.toBeNull();
    expect(sealed).not.toContain("prj_secret_project");
  });

  it("rejects a different Clerk session and a different user", async () => {
    const sealed = (await sealRenderScope({ projectId: "prj_a" }, SESSION, 1800)) as string;

    expect(await unsealRenderScope(sealed, OTHER_SESSION)).toBeNull();
    expect(await unsealRenderScope(sealed, OTHER_USER)).toBeNull();
  });

  it("honors the TTL", async () => {
    const mintedAt = Date.now();
    const sealed = (await sealRenderScope(
      { projectId: "prj_a" },
      SESSION,
      RENDER_SCOPE_TTL_SECONDS,
      mintedAt
    )) as string;

    expect(
      await unsealRenderScope(sealed, SESSION, mintedAt + (RENDER_SCOPE_TTL_SECONDS * 1000 - 1))
    ).toEqual({ projectId: "prj_a" });
    expect(
      await unsealRenderScope(sealed, SESSION, mintedAt + RENDER_SCOPE_TTL_SECONDS * 1000)
    ).toBeNull();
  });

  it("rejects tampered, malformed, and non-sealed values", async () => {
    const sealed = (await sealRenderScope({ projectId: "prj_a" }, SESSION, 1800)) as string;
    const [version, iv, cipher] = sealed.split(".");
    const flipped = Buffer.from(cipher as string, "base64url");
    flipped[0] = flipped[0] ^ 0xff;

    expect(
      await unsealRenderScope(`${version}.${iv}.${flipped.toString("base64url")}`, SESSION)
    ).toBeNull();
    expect(await unsealRenderScope("not-a-sealed-value", SESSION)).toBeNull();
    expect(await unsealRenderScope("v1.only-two-parts", SESSION)).toBeNull();
    expect(await unsealRenderScope(JSON.stringify({ projectId: "prj_a" }), SESSION)).toBeNull();
  });

  it("fails closed when no sealing secret is configured", async () => {
    vi.stubEnv("CLERK_SECRET_KEY", "");

    expect(await sealRenderScope({ projectId: "prj_a" }, SESSION, 1800)).toBeNull();
    const sealedWithSecret = await sealRenderScope({ projectId: "prj_a" }, SESSION, 1800);
    vi.stubEnv("CLERK_SECRET_KEY", "");
    expect(await unsealRenderScope(sealedWithSecret as string, SESSION)).toBeNull();
  });
});

describe("verifyRenderScope", () => {
  beforeEach(() => {
    vi.stubEnv("CLERK_SECRET_KEY", "sk_clerk_unit_test_secret");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("accepts a fresh scope bound to the expected project", async () => {
    const now = Date.now();
    const sealed = (await sealRenderScope({ projectId: "prj_a" }, SESSION, 1800, now)) as string;

    const verification = await verifyRenderScope(sealed, SESSION, "prj_a", now + 1000);
    expect(verification).toEqual({ ok: true, projectId: "prj_a" });
  });

  it("is unauthenticated without session claims, even with a valid scope", async () => {
    const sealed = (await sealRenderScope({ projectId: "prj_a" }, SESSION, 1800)) as string;

    expect(await verifyRenderScope(sealed, { sessionId: null, userId: null }, "prj_a")).toEqual({
      ok: false,
      reason: "unauthenticated",
    });
  });

  it("reports missing when no scope was presented", async () => {
    expect(await verifyRenderScope(null, SESSION, "prj_a")).toEqual({
      ok: false,
      reason: "missing",
    });
    expect(await verifyRenderScope(undefined, SESSION, "prj_a")).toEqual({
      ok: false,
      reason: "missing",
    });
    expect(await verifyRenderScope("", SESSION, "prj_a")).toEqual({
      ok: false,
      reason: "missing",
    });
  });

  it("reports invalid for expired, tampered, or foreign-session scopes", async () => {
    const mintedAt = Date.now();
    const sealed = (await sealRenderScope(
      { projectId: "prj_a" },
      SESSION,
      1800,
      mintedAt
    )) as string;

    expect(await verifyRenderScope(sealed, SESSION, "prj_a", mintedAt + 1800_000)).toEqual({
      ok: false,
      reason: "invalid",
    });
    expect(await verifyRenderScope(sealed, OTHER_SESSION, "prj_a")).toEqual({
      ok: false,
      reason: "invalid",
    });
    expect(await verifyRenderScope("garbage", SESSION, "prj_a")).toEqual({
      ok: false,
      reason: "invalid",
    });
  });

  it("reports a project mismatch when the rendered project differs from the current one", async () => {
    const sealed = (await sealRenderScope({ projectId: "prj_a" }, SESSION, 1800)) as string;

    expect(await verifyRenderScope(sealed, SESSION, "prj_b")).toEqual({
      ok: false,
      reason: "project_mismatch",
    });
  });
});
