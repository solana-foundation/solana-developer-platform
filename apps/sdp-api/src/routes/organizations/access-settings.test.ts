import { hashString } from "@sdp/payments/hash";
import type { OrganizationSettings } from "@sdp/types/organizations";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getDb } from "@/db/client";
import { app } from "@/index";
import { API_KEY_PRE_READ_MAX_REQUESTS, apiKeyFloodGuardIdentifier } from "@/middleware/rate-limit";
import { ALL_API_KEY_GRANTS, TEST_API_KEY, TEST_SEEDED_API_KEY } from "@/test/fixtures/api-keys";
import { TEST_MEMBER, TEST_ORG, TEST_USER } from "@/test/fixtures/organizations";
import { stubClerkBackend } from "@/test/helpers/clerk-backend";
import { signSeededClerkMember } from "@/test/helpers/clerk-member";
import { env } from "@/test/helpers/env";
import { seedDefaultProjects } from "@/test/helpers/projects";
import { required } from "@/test/helpers/required";
import { seedApiKeyRow, seedTestDatabase } from "@/test/mocks/db";
import { clearKVStores, seedRateLimit } from "@/test/mocks/kv";

const ORGANIZATION_ID = TEST_SEEDED_API_KEY.organizationId;

const PROJECT_ID = "prj_access_settings";

async function seedOrganization(settings: OrganizationSettings | null): Promise<void> {
  await getDb(env)
    .prepare(
      "INSERT INTO organizations (id, name, slug, tier, status, settings) VALUES (?, ?, ?, ?, ?, ?)"
    )
    .bind(
      ORGANIZATION_ID,
      TEST_ORG.name,
      TEST_ORG.slug,
      TEST_ORG.tier,
      TEST_ORG.status,
      settings === null ? null : JSON.stringify(settings)
    )
    .run();
  await seedApiKeyRow(env, await hashString(TEST_API_KEY.raw, env.API_KEY_PEPPER), {
    ...TEST_SEEDED_API_KEY,
    projectId: PROJECT_ID,
    grants: ALL_API_KEY_GRANTS,
  });
}

async function writeRawSettings(settings: string): Promise<void> {
  await getDb(env)
    .prepare("UPDATE organizations SET settings = ? WHERE id = ?")
    .bind(settings, ORGANIZATION_ID)
    .run();
}

async function readSettings(): Promise<OrganizationSettings | null> {
  const row = await getDb(env)
    .prepare("SELECT settings FROM organizations WHERE id = ?")
    .bind(ORGANIZATION_ID)
    .first<{
      settings: string | null;
    }>();
  const settings = required(row).settings;
  return settings === null ? null : (JSON.parse(settings) as OrganizationSettings);
}

async function seedMemberWithProject(): Promise<void> {
  await getDb(env)
    .prepare("INSERT INTO users (id, email, status) VALUES (?, ?, ?)")
    .bind(TEST_USER.id, TEST_USER.email, TEST_USER.status)
    .run();
  await getDb(env)
    .prepare(
      "INSERT INTO organization_members (id, organization_id, user_id, role, status) VALUES (?, ?, ?, ?, ?)"
    )
    .bind(TEST_MEMBER.id, ORGANIZATION_ID, TEST_USER.id, TEST_MEMBER.role, TEST_MEMBER.status)
    .run();
  await seedDefaultProjects(getDb(env), {
    organizationId: ORGANIZATION_ID,
    createdBy: TEST_USER.id,
    members: [TEST_USER.id],
    ids: { sandbox: PROJECT_ID, production: `${PROJECT_ID}_production` },
  });
}

function get(headers: Record<string, string>) {
  return app.request(`/v1/organizations/${ORGANIZATION_ID}`, { headers }, env);
}

/** Settings are written by a signed-in organization admin, never a key (HOO-2099). */
let adminToken: string;

async function signInAdmin(): Promise<void> {
  await seedMemberWithProject();
  adminToken = await signSeededClerkMember(env, getDb(env), TEST_USER.id, ORGANIZATION_ID);
}

function patch(body: unknown, from: string) {
  return app.request(
    `/v1/organizations/${ORGANIZATION_ID}`,
    {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${adminToken}`,
        "Content-Type": "application/json",
        "x-forwarded-for": from,
      },
      body: JSON.stringify(body),
    },
    env
  );
}

describe("Organization access settings", () => {
  let validKeyHash: string;
  beforeEach(async () => {
    await seedTestDatabase(env);
    validKeyHash = await hashString(TEST_API_KEY.raw, env.API_KEY_PEPPER);
    await seedApiKeyRow(env, validKeyHash, { ...TEST_SEEDED_API_KEY, grants: ALL_API_KEY_GRANTS });
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    env.CLERK_API_URL = undefined;
    env.CLERK_SECRET_KEY = undefined;
    await clearKVStores(env);
  });
  describe("writing settings.allowedIpAddresses", () => {
    beforeEach(async () => {
      await seedOrganization(null);
      await signInAdmin();
    });
    it("rejects an entry that is not an address or CIDR range", async () => {
      const res = await patch(
        { settings: { allowedIpAddresses: ["203.0.113.0/24", "office"] } },
        "203.0.113.42"
      );
      expect(res.status).toBe(400);
      expect((await readSettings())?.allowedIpAddresses).toBeUndefined();
    });
    it("rejects a prefix wider than the address family allows", async () => {
      const res = await patch(
        { settings: { allowedIpAddresses: ["203.0.113.0/33"] } },
        "203.0.113.42"
      );
      expect(res.status).toBe(400);
      expect((await readSettings())?.allowedIpAddresses).toBeUndefined();
    });
    it("stores the range each entry actually selects", async () => {
      const res = await patch(
        {
          settings: {
            allowedIpAddresses: ["203.0.113.5/24", "2001:0DB8::0042", "::ffff:198.51.100.7"],
          },
        },
        "203.0.113.42"
      );
      expect(res.status).toBe(200);
      expect(required(await readSettings()).allowedIpAddresses).toEqual([
        "203.0.113.0/24",
        "2001:db8::42",
        "198.51.100.7",
      ]);
    });
    it("collapses entries that name the same range", async () => {
      const res = await patch(
        {
          settings: { allowedIpAddresses: ["203.0.113.0/24", "203.0.113.42/24"] },
        },
        "203.0.113.42"
      );
      expect(res.status).toBe(200);
      expect(required(await readSettings()).allowedIpAddresses).toEqual(["203.0.113.0/24"]);
    });
    it("rejects an allowlist longer than the cap", async () => {
      const res = await patch(
        {
          settings: {
            allowedIpAddresses: Array.from(
              { length: 101 },
              (_, index) => `203.0.113.${index % 256}`
            ),
          },
        },
        "203.0.113.42"
      );
      expect(res.status).toBe(400);
    });
    // The dashboard calls from SDP's servers and is never filtered, so an
    // allowlist that leaves out the admin's own address cannot lock them out.
    it("accepts an allowlist that leaves out the caller's own origin", async () => {
      const res = await patch(
        { settings: { allowedIpAddresses: ["203.0.113.0/24"] } },
        "198.51.100.42"
      );
      expect(res.status).toBe(200);
      expect(required(await readSettings()).allowedIpAddresses).toEqual(["203.0.113.0/24"]);
    });
    it("clears the restriction when given an empty list", async () => {
      expect(
        (await patch({ settings: { allowedIpAddresses: ["203.0.113.0/24"] } }, "203.0.113.42"))
          .status
      ).toBe(200);
      const res = await patch({ settings: { allowedIpAddresses: [] } }, "203.0.113.42");
      expect(res.status).toBe(200);
      expect(required(await readSettings()).allowedIpAddresses).toEqual([]);
    });
  });
  describe("concurrent settings updates", () => {
    beforeEach(async () => {
      await seedOrganization({ defaultEnvironment: "sandbox" });
      await signInAdmin();
    });
    it("keeps a security change that lands alongside an unrelated one", async () => {
      const [restriction, unrelated] = await Promise.all([
        patch({ settings: { allowedIpAddresses: ["203.0.113.0/24"] } }, "203.0.113.42"),
        patch({ settings: { defaultEnvironment: "production" } }, "203.0.113.42"),
      ]);
      expect(restriction.status).toBe(200);
      expect(unrelated.status).toBe(200);
      const settings = await readSettings();
      expect(required(settings).allowedIpAddresses).toEqual(["203.0.113.0/24"]);
      expect(required(settings).defaultEnvironment).toBe("production");
    });
    it("keeps the restriction when a rename lands at the same moment", async () => {
      const clerk = stubClerkBackend(env);
      clerk.answer({ status: 200, body: {} });
      const [first, second] = await Promise.all([
        patch({ settings: { allowedIpAddresses: ["203.0.113.0/24"] } }, "203.0.113.42"),
        patch({ name: "Renamed Organization" }, "203.0.113.42"),
      ]);
      expect(first.status).toBe(200);
      expect(second.status).toBe(200);
      const row = await getDb(env)
        .prepare("SELECT name, settings FROM organizations WHERE id = ?")
        .bind(ORGANIZATION_ID)
        .first<{
          name: string;
          settings: string | null;
        }>();
      expect(required(row).name).toBe("Renamed Organization");
      expect(
        (JSON.parse(required(required(row).settings)) as OrganizationSettings).allowedIpAddresses
      ).toEqual(["203.0.113.0/24"]);
    });
  });
  describe("enforcing settings.allowedIpAddresses", () => {
    it("rejects an API key request from outside the organization's range", async () => {
      await seedOrganization({ allowedIpAddresses: ["203.0.113.0/24"] });
      const res = await get({
        Authorization: `Bearer ${TEST_API_KEY.raw}`,
        "x-forwarded-for": "198.51.100.42",
      });
      expect(res.status).toBe(403);
      const body = (await res.json()) as {
        error: {
          code: string;
          message: string;
        };
      };
      expect(body.error.code).toBe("FORBIDDEN");
      expect(body.error.message).toContain("organization");
    });
    it("accepts an API key request from inside the organization's range", async () => {
      await seedOrganization({ allowedIpAddresses: ["203.0.113.0/24"] });
      const res = await get({
        Authorization: `Bearer ${TEST_API_KEY.raw}`,
        "x-forwarded-for": "203.0.113.42",
      });
      expect(res.status).toBe(200);
    });
    it("does not let an IPv6 client past an IPv4-only allowlist", async () => {
      await seedOrganization({ allowedIpAddresses: ["203.0.113.0/24"] });
      const res = await get({
        Authorization: `Bearer ${TEST_API_KEY.raw}`,
        "x-forwarded-for": "2001:db8::42",
      });
      expect(res.status).toBe(403);
    });
    it("does not let an IPv4 client past an IPv6-only allowlist", async () => {
      await seedOrganization({ allowedIpAddresses: ["2001:db8::/48"] });
      const res = await get({
        Authorization: `Bearer ${TEST_API_KEY.raw}`,
        "x-forwarded-for": "203.0.113.42",
      });
      expect(res.status).toBe(403);
    });
    it("enforces an IPv6 range against an IPv6 client", async () => {
      await seedOrganization({ allowedIpAddresses: ["2001:db8::/48"] });
      expect(
        (
          await get({
            Authorization: `Bearer ${TEST_API_KEY.raw}`,
            "x-forwarded-for": "2001:db8::42",
          })
        ).status
      ).toBe(200);
      expect(
        (
          await get({
            Authorization: `Bearer ${TEST_API_KEY.raw}`,
            "x-forwarded-for": "2001:db9::42",
          })
        ).status
      ).toBe(403);
    });
    it("treats an IPv4-mapped client as the IPv4 address it is", async () => {
      await seedOrganization({ allowedIpAddresses: ["203.0.113.0/24"] });
      expect(
        (
          await get({
            Authorization: `Bearer ${TEST_API_KEY.raw}`,
            "x-forwarded-for": "::ffff:203.0.113.42",
          })
        ).status
      ).toBe(200);
      expect(
        (
          await get({
            Authorization: `Bearer ${TEST_API_KEY.raw}`,
            "x-forwarded-for": "::ffff:198.51.100.42",
          })
        ).status
      ).toBe(403);
    });
    it("rejects a restricted request with no trusted client IP", async () => {
      await seedOrganization({ allowedIpAddresses: ["203.0.113.0/24"] });
      const res = await get({ Authorization: `Bearer ${TEST_API_KEY.raw}` });
      expect(res.status).toBe(403);
    });
    it("leaves an organization with no restriction unrestricted", async () => {
      await seedOrganization({ defaultEnvironment: "sandbox" });
      const res = await get({
        Authorization: `Bearer ${TEST_API_KEY.raw}`,
        "x-forwarded-for": "198.51.100.42",
      });
      expect(res.status).toBe(200);
    });
    it("fails loudly with a 500 on settings that will not parse", async () => {
      await seedOrganization({ allowedIpAddresses: ["203.0.113.0/24"] });
      await writeRawSettings("{not json");
      const res = await get({
        Authorization: `Bearer ${TEST_API_KEY.raw}`,
        "x-forwarded-for": "198.51.100.42",
      });
      expect(res.status).toBe(500);
    });
    it("ignores an allowlist that was recorded before the setting was enforced", async () => {
      await seedOrganization(null);
      await writeRawSettings(
        JSON.stringify({ legacyAllowedIpAddresses: ["203.0.113.0/24", "office wifi"] })
      );
      const res = await get({
        Authorization: `Bearer ${TEST_API_KEY.raw}`,
        "x-forwarded-for": "198.51.100.42",
      });
      expect(res.status).toBe(200);
    });
    it("fails closed on a restriction stored in a shape it does not understand", async () => {
      await seedOrganization(null);
      await writeRawSettings(JSON.stringify({ allowedIpAddresses: "203.0.113.0/24" }));
      const res = await get({
        Authorization: `Bearer ${TEST_API_KEY.raw}`,
        "x-forwarded-for": "203.0.113.42",
      });
      expect(res.status).toBe(403);
    });
    it("never filters a signed-in member, only API keys", async () => {
      await seedOrganization({ allowedIpAddresses: ["203.0.113.0/24"] });
      await seedMemberWithProject();
      const token = await signSeededClerkMember(env, getDb(env), TEST_USER.id, ORGANIZATION_ID);
      const outside = await app.request(
        "/v1/members",
        {
          headers: {
            Authorization: `Bearer ${token}`,
            "x-project-id": PROJECT_ID,
            "x-forwarded-for": "198.51.100.42",
          },
        },
        env
      );
      expect(outside.status).toBe(200);
      const inside = await app.request(
        "/v1/members",
        {
          headers: {
            Authorization: `Bearer ${token}`,
            "x-project-id": PROJECT_ID,
            "x-forwarded-for": "203.0.113.42",
          },
        },
        env
      );
      expect(inside.status).toBe(200);
    });
    // A key is admitted against the highest tier before its rows are read, so
    // a flood is refused there; its own tier is judged after the read.
    it("dies at the rate limiter before the organization row is read", async () => {
      await seedOrganization({ allowedIpAddresses: ["203.0.113.0/24"] });
      const headers = {
        Authorization: `Bearer ${TEST_API_KEY.raw}`,
        "x-forwarded-for": "198.51.100.42",
      };
      const now = Date.now();
      const nowSpy = vi.spyOn(Date, "now").mockReturnValue(now);
      try {
        await seedRateLimit(
          env,
          apiKeyFloodGuardIdentifier(
            await hashString(TEST_API_KEY.raw, env.API_KEY_PEPPER),
            "198.51.100.42"
          ),
          API_KEY_PRE_READ_MAX_REQUESTS
        );
        expect((await get(headers)).status).toBe(429);
      } finally {
        nowSpy.mockRestore();
      }
    });
    it("intersects with the API key's own allowlist rather than replacing it", async () => {
      await seedOrganization({ allowedIpAddresses: ["203.0.113.0/24"] });
      await clearKVStores(env);
      await seedApiKeyRow(env, validKeyHash, {
        ...TEST_SEEDED_API_KEY,
        grants: ALL_API_KEY_GRANTS,
        allowedIps: ["203.0.113.7/32"],
      });
      expect(
        (
          await get({
            Authorization: `Bearer ${TEST_API_KEY.raw}`,
            "x-forwarded-for": "203.0.113.7",
          })
        ).status
      ).toBe(200);
      expect(
        (
          await get({
            Authorization: `Bearer ${TEST_API_KEY.raw}`,
            "x-forwarded-for": "203.0.113.8",
          })
        ).status
      ).toBe(403);
    });
  });
});
