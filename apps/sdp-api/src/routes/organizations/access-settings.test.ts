/**
 * Organization access settings: the allowed-IP restriction, and the concurrency
 * of the column that holds it.
 */

import { hashString } from "@sdp/payments/hash";
import type { OrganizationSettings } from "@sdp/types";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getDb } from "@/db";
import app from "@/index";
import { SessionService } from "@/services/session.service";
import { TEST_API_KEY, TEST_CACHED_API_KEY } from "@/test/fixtures/api-keys";
import { TEST_MEMBER, TEST_ORG, TEST_USER } from "@/test/fixtures/organizations";
import { env } from "@/test/helpers/env";
import { seedTestDatabase } from "@/test/mocks/db";
import { clearKVStores, seedCachedApiKey } from "@/test/mocks/kv";

const ORGANIZATION_ID = TEST_CACHED_API_KEY.organizationId;
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
}

/** Raw settings, for the cases where the stored value is not valid JSON. */
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
    .first<{ settings: string | null }>();

  return row?.settings ? (JSON.parse(row.settings) as OrganizationSettings) : null;
}

/** A member with a project they can scope a dashboard request to. */
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
  await getDb(env)
    .prepare(
      `INSERT INTO projects (id, organization_id, name, slug, environment, status, created_by)
         VALUES (?, ?, 'Access Settings', 'access-settings', 'sandbox', 'active', ?)`
    )
    .bind(PROJECT_ID, ORGANIZATION_ID, TEST_USER.id)
    .run();
  await getDb(env)
    .prepare(
      "INSERT INTO project_members (id, project_id, user_id, role) VALUES (?, ?, ?, 'developer')"
    )
    .bind("pm_access_settings", PROJECT_ID, TEST_USER.id)
    .run();
}

function get(headers: Record<string, string>) {
  return app.request(`/v1/organizations/${ORGANIZATION_ID}`, { headers }, env);
}

/** `from` matters when installing an allowlist: one excluding the caller is refused. */
function patch(body: unknown, from = "203.0.113.42") {
  return app.request(
    `/v1/organizations/${ORGANIZATION_ID}`,
    {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${TEST_API_KEY.raw}`,
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
    await seedCachedApiKey(env, validKeyHash, { ...TEST_CACHED_API_KEY, permissions: ["*"] });
  });

  afterEach(async () => {
    await clearKVStores(env);
  });

  describe("writing settings.allowedIpAddresses", () => {
    beforeEach(async () => {
      await seedOrganization(null);
    });

    it("rejects an entry that is not an address or CIDR range", async () => {
      const res = await patch({ settings: { allowedIpAddresses: ["203.0.113.0/24", "office"] } });

      expect(res.status).toBe(400);
      expect(await readSettings()).toBeNull();
    });

    it("rejects a prefix wider than the address family allows", async () => {
      const res = await patch({ settings: { allowedIpAddresses: ["203.0.113.0/33"] } });

      expect(res.status).toBe(400);
      expect(await readSettings()).toBeNull();
    });

    it("stores the range each entry actually selects", async () => {
      // The stored form is what a later review shows: it must say 256 hosts
      // when it grants 256.
      const res = await patch({
        settings: {
          allowedIpAddresses: ["203.0.113.5/24", "2001:0DB8::0042", "::ffff:198.51.100.7"],
        },
      });

      expect(res.status).toBe(200);
      expect((await readSettings())?.allowedIpAddresses).toEqual([
        "203.0.113.0/24",
        "2001:db8::42",
        "198.51.100.7",
      ]);
    });

    it("collapses entries that name the same range", async () => {
      const res = await patch({
        settings: { allowedIpAddresses: ["203.0.113.0/24", "203.0.113.42/24"] },
      });

      expect(res.status).toBe(200);
      expect((await readSettings())?.allowedIpAddresses).toEqual(["203.0.113.0/24"]);
    });

    it("rejects an allowlist longer than the cap", async () => {
      const res = await patch({
        settings: {
          allowedIpAddresses: Array.from({ length: 101 }, (_, index) => `203.0.113.${index % 256}`),
        },
      });

      expect(res.status).toBe(400);
    });

    it("refuses an allowlist that excludes the caller's own origin", async () => {
      // Accepting it would take database access to reverse.
      const res = await patch(
        { settings: { allowedIpAddresses: ["203.0.113.0/24"] } },
        "198.51.100.42"
      );

      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: { message: string } };
      expect(body.error.message).toContain("198.51.100.42");
      expect(await readSettings()).toBeNull();
    });

    it("refuses an allowlist when the caller's origin cannot be determined", async () => {
      const res = await app.request(
        `/v1/organizations/${ORGANIZATION_ID}`,
        {
          method: "PATCH",
          headers: {
            Authorization: `Bearer ${TEST_API_KEY.raw}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ settings: { allowedIpAddresses: ["203.0.113.0/24"] } }),
        },
        env
      );

      expect(res.status).toBe(400);
      expect(await readSettings()).toBeNull();
    });

    it("clears the restriction when given an empty list", async () => {
      expect((await patch({ settings: { allowedIpAddresses: ["203.0.113.0/24"] } })).status).toBe(
        200
      );

      const res = await patch({ settings: { allowedIpAddresses: [] } });

      expect(res.status).toBe(200);
      expect((await readSettings())?.allowedIpAddresses).toEqual([]);
    });
  });

  describe("concurrent settings updates", () => {
    beforeEach(async () => {
      await seedOrganization({ defaultEnvironment: "sandbox" });
    });

    it("keeps a security change that lands alongside an unrelated one", async () => {
      // Unsynchronized read-merge-write would let the second commit silently
      // revert the allowlist the first just installed.
      const [restriction, unrelated] = await Promise.all([
        patch({ settings: { allowedIpAddresses: ["203.0.113.0/24"] } }),
        patch({ settings: { defaultEnvironment: "production" } }),
      ]);

      expect(restriction.status).toBe(200);
      expect(unrelated.status).toBe(200);

      const settings = await readSettings();
      expect(settings?.allowedIpAddresses).toEqual(["203.0.113.0/24"]);
      expect(settings?.defaultEnvironment).toBe("production");
    });

    it("keeps the restriction when a rename lands at the same moment", async () => {
      const [first, second] = await Promise.all([
        patch({ settings: { allowedIpAddresses: ["203.0.113.0/24"] } }),
        patch({ name: "Renamed Organization" }),
      ]);

      expect(first.status).toBe(200);
      expect(second.status).toBe(200);

      const row = await getDb(env)
        .prepare("SELECT name, settings FROM organizations WHERE id = ?")
        .bind(ORGANIZATION_ID)
        .first<{ name: string; settings: string | null }>();

      expect(row?.name).toBe("Renamed Organization");
      expect(
        (JSON.parse(row?.settings ?? "{}") as OrganizationSettings).allowedIpAddresses
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
      const body = (await res.json()) as { error: { code: string; message: string } };
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

    it("reads no restriction from settings that will not parse", async () => {
      // Denying over an unreadable row would be an unrecoverable lockout;
      // every other reader treats such a blob as holding no configuration.
      await seedOrganization({ allowedIpAddresses: ["203.0.113.0/24"] });
      await writeRawSettings("{not json");

      const res = await get({
        Authorization: `Bearer ${TEST_API_KEY.raw}`,
        "x-forwarded-for": "198.51.100.42",
      });

      expect(res.status).toBe(200);
    });

    it("ignores an allowlist that was recorded before the setting was enforced", async () => {
      // Migration 0055 parks never-validated values here; they must not start deciding access.
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

    it("applies to a dashboard session as well as an API key", async () => {
      await seedOrganization({ allowedIpAddresses: ["203.0.113.0/24"] });
      await seedMemberWithProject();
      const session = await new SessionService(getDb(env)).createSession(
        TEST_USER.id,
        ORGANIZATION_ID,
        {}
      );

      const denied = await app.request(
        "/v1/members",
        {
          headers: {
            Cookie: `sdp_session=${session.id}`,
            "x-project-id": PROJECT_ID,
            "x-forwarded-for": "198.51.100.42",
          },
        },
        env
      );

      expect(denied.status).toBe(403);

      const allowed = await app.request(
        "/v1/members",
        {
          headers: {
            Cookie: `sdp_session=${session.id}`,
            "x-project-id": PROJECT_ID,
            "x-forwarded-for": "203.0.113.42",
          },
        },
        env
      );

      expect(allowed.status).toBe(200);
    });

    it("dies at the rate limiter before the organization row is read", async () => {
      // The check is an uncached Postgres read; ahead of the KV-backed limiter
      // it would cost one query per rejected request of a flooding key. Past
      // the tier the request must get the limiter's 429, not the allowlist's
      // 403 — only possible with the read behind the limiter.
      await seedOrganization({ allowedIpAddresses: ["203.0.113.0/24"] });

      const headers = {
        Authorization: `Bearer ${TEST_API_KEY.raw}`,
        // Outside the allowlist: on the wrong ordering every request 403s
        // without ever counting toward the tier.
        "x-forwarded-for": "198.51.100.42",
      };

      // Standard tier allows 100 requests per window; the 101st must trip it.
      let finalStatus = 0;
      for (let request = 0; request < 101; request++) {
        finalStatus = (await get(headers)).status;
      }

      expect(finalStatus).toBe(429);
    });

    it("intersects with the API key's own allowlist rather than replacing it", async () => {
      await seedOrganization({ allowedIpAddresses: ["203.0.113.0/24"] });
      await clearKVStores(env);
      await seedCachedApiKey(env, validKeyHash, {
        ...TEST_CACHED_API_KEY,
        permissions: ["*"],
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
      // Inside the organization's range, outside the key's.
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
