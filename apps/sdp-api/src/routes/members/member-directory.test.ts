import { hashString } from "@sdp/payments/hash";
import type { Permission } from "@sdp/types";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getDb } from "@/db";
import app from "@/index";
import { TEST_API_KEY, TEST_CACHED_API_KEY } from "@/test/fixtures/api-keys";
import { env } from "@/test/helpers/env";
import { clearTestDatabase, seedTestDatabase } from "@/test/mocks/db";
import { clearKVStores, seedCachedApiKey } from "@/test/mocks/kv";

const CLERK_API_URL = "https://clerk.example.test/v1";
const CLERK_ORG_ID = "org_clerk_member_directory";
const ORGANIZATION_ID = TEST_CACHED_API_KEY.organizationId;
const INVITER_USER_ID = "usr_directory_inviter";

interface DirectoryResponse {
  members: { id: string; user: { email: string } }[];
  invitations: { id: string; email: string; acceptUrl: string | null }[];
  meta: { total: number; page: number; pageSize: number; hasMore: boolean };
}

/**
 * Counts Clerk invitation lookups as well as answering them, so a test can
 * assert the accept links were never even fetched — not merely withheld.
 */
function stubClerk(): { listCalls: number } {
  const calls = { listCalls: 0 };

  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = typeof input === "string" ? input : String(input);

    if (url.includes("/invitations?status=pending")) {
      calls.listCalls += 1;
      const data = [0, 1, 2, 3].map((index) => ({
        id: `orginv_${index}`,
        email_address: `invitee${index}@example.com`,
        status: "pending",
        inviter_id: "clerk_user_inviter",
        url: `https://accept.example.test/orginv_${index}`,
      }));

      return new Response(JSON.stringify({ data }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    throw new Error(`Unexpected fetch in test: ${url}`);
  });

  return calls;
}

/** Seeds `memberCount` active members and 4 pending invitations. */
async function seedDirectory(memberCount: number): Promise<void> {
  const db = getDb(env);
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();

  const statements = [
    db
      .prepare(
        "INSERT INTO organizations (id, name, slug, tier, status) VALUES (?, 'Member Directory', 'member-directory', 'individual', 'active')"
      )
      .bind(ORGANIZATION_ID),
    db
      .prepare(
        `INSERT INTO auth_organization_identities (id, provider, provider_org_id, organization_id, slug)
         VALUES ('aoi_directory', 'clerk', ?, ?, 'member-directory')`
      )
      .bind(CLERK_ORG_ID, ORGANIZATION_ID),
    // invitations.invited_by is a foreign key onto users, so the inviter has to
    // be a real row.
    db
      .prepare(
        "INSERT INTO users (id, email, email_verified, status) VALUES (?, 'directory-inviter@example.com', 1, 'active')"
      )
      .bind(INVITER_USER_ID),
  ];

  for (let index = 0; index < memberCount; index += 1) {
    statements.push(
      db
        .prepare("INSERT INTO users (id, email, email_verified, status) VALUES (?, ?, 1, 'active')")
        .bind(`usr_directory_${index}`, `member${index}@example.com`),
      db
        .prepare(
          `INSERT INTO organization_members (id, organization_id, user_id, role, status, created_at)
           VALUES (?, ?, ?, 'member', 'active', ?)`
        )
        .bind(
          `mem_directory_${index}`,
          ORGANIZATION_ID,
          `usr_directory_${index}`,
          // Ordered so paging is deterministic rather than dependent on
          // insertion timestamps that can collide within the same millisecond.
          `2025-01-${String(index + 1).padStart(2, "0")}T00:00:00.000Z`
        )
    );
  }

  for (let index = 0; index < 4; index += 1) {
    statements.push(
      db
        .prepare(
          `INSERT INTO invitations
             (id, organization_id, email, role, invited_by, token_hash, expires_at, status, clerk_invitation_id, created_at)
           VALUES (?, ?, ?, 'member', ?, ?, ?, 'pending', ?, ?)`
        )
        .bind(
          `inv_directory_${index}`,
          ORGANIZATION_ID,
          `invitee${index}@example.com`,
          INVITER_USER_ID,
          `hash_directory_${index}`,
          expiresAt,
          `orginv_${index}`,
          `2025-02-${String(4 - index).padStart(2, "0")}T00:00:00.000Z`
        )
    );
  }

  await db.batch(statements);
}

/** Authenticates every request as an API key holding exactly `permissions`. */
async function authenticateAs(permissions: Permission[]): Promise<void> {
  const keyHash = await hashString(TEST_API_KEY.raw, env.API_KEY_PEPPER);
  await seedCachedApiKey(env, keyHash, {
    ...TEST_CACHED_API_KEY,
    organizationId: ORGANIZATION_ID,
    role: "api_developer",
    permissions,
  });
}

async function listMembers(page?: number): Promise<DirectoryResponse> {
  const query = page === undefined ? "" : `?page=${page}`;
  const response = await app.request(
    `/v1/members${query}`,
    { headers: { Authorization: `Bearer ${TEST_API_KEY.raw}` } },
    env
  );

  expect(response.status).toBe(200);
  const body = (await response.json()) as { data: DirectoryResponse };
  return body.data;
}

describe("member directory", () => {
  beforeEach(async () => {
    await seedTestDatabase(env);
    await clearKVStores(env);
    env.CLERK_SECRET_KEY = "sk_test_member_directory";
    env.CLERK_API_URL = CLERK_API_URL;
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await clearTestDatabase(env);
    await clearKVStores(env);
    env.CLERK_SECRET_KEY = undefined;
    env.CLERK_API_URL = undefined;
  });

  describe("email resolution", () => {
    /**
     * Migration 0040 treats a value as recoverable only when it is both not a
     * placeholder and shaped like an address. Testing only for `{{` let values like
     * `unknown` through, so the endpoint returned something its own repair rule does
     * not consider an email.
     */
    it("prefers the identity address over a stored value that is not an address", async () => {
      await seedDirectory(1);
      await getDb(env).batch([
        getDb(env)
          .prepare("UPDATE users SET email = 'unknown' WHERE id = 'usr_directory_0'")
          .bind(),
        getDb(env)
          .prepare(
            `INSERT INTO auth_user_identities (id, provider, provider_user_id, user_id, email)
               VALUES ('aui_directory_0', 'clerk', 'clerk_directory_0', 'usr_directory_0', ?)`
          )
          .bind("member0@example.com"),
      ]);
      await authenticateAs(["org:read"]);
      stubClerk();

      const directory = await listMembers();

      expect(directory.members[0]?.user.email).toBe("member0@example.com");
    });

    it("falls back to the stored value when no copy is an address", async () => {
      await seedDirectory(1);
      await getDb(env)
        .prepare("UPDATE users SET email = 'unknown' WHERE id = 'usr_directory_0'")
        .run();
      await authenticateAs(["org:read"]);
      stubClerk();

      const directory = await listMembers();

      // Returning the stored value rather than NULL keeps the row renderable; the
      // web side decides how to present something that is not an address.
      expect(directory.members[0]?.user.email).toBe("unknown");
    });
  });

  describe("invitation visibility", () => {
    it("withholds pending invitations from a caller that cannot act on them", async () => {
      await seedDirectory(2);
      await authenticateAs(["org:read"]);
      const clerk = stubClerk();

      const directory = await listMembers();

      // The accept link is minted by Clerk, cannot be expired by us, and is
      // forwardable, so a role that can neither raise nor withdraw an
      // invitation must not receive one.
      expect(directory.invitations).toEqual([]);
      expect(directory.members).toHaveLength(2);
      // Never fetched, not merely filtered out of the response: a link that is
      // not retrieved cannot leak through a later change to the shape.
      expect(clerk.listCalls).toBe(0);
    });

    it("does not leak invitee addresses to a caller without org:write", async () => {
      await seedDirectory(2);
      await authenticateAs(["org:read"]);
      stubClerk();

      const directory = await listMembers();
      const serialized = JSON.stringify(directory);

      expect(serialized).not.toContain("invitee0@example.com");
      expect(serialized).not.toContain("accept.example.test");
    });

    it("returns invitations with their accept links to a caller holding org:write", async () => {
      await seedDirectory(2);
      await authenticateAs(["org:read", "org:write"]);
      stubClerk();

      const directory = await listMembers();

      expect(directory.invitations).toHaveLength(4);
      expect(directory.invitations[0]?.acceptUrl).toBe("https://accept.example.test/orginv_0");
    });

    it("counts only what the caller can see in meta.total", async () => {
      await seedDirectory(2);

      await authenticateAs(["org:read"]);
      // 2 members, no visible invitations.
      expect((await listMembers()).meta.total).toBe(2);

      await authenticateAs(["org:read", "org:write"]);
      stubClerk();
      // 2 members plus 4 pending invitations.
      expect((await listMembers()).meta.total).toBe(6);
    });
  });

  describe("paging", () => {
    // pageSize is 25 by default, so 26 members push the directory onto a
    // second page while leaving room there for invitations.
    it("continues invitations after the members rather than repeating them", async () => {
      await seedDirectory(26);
      await authenticateAs(["org:read", "org:write"]);
      stubClerk();

      const first = await listMembers(1);
      const second = await listMembers(2);

      expect(first.members).toHaveLength(25);
      // The page is already full of members, so no invitation fits on it.
      expect(first.invitations).toEqual([]);
      expect(first.meta.hasMore).toBe(true);

      expect(second.members).toHaveLength(1);
      expect(second.invitations).toHaveLength(4);
      expect(second.meta.total).toBe(30);
      expect(second.meta.hasMore).toBe(false);
    });

    it("never returns the same invitation on two pages", async () => {
      await seedDirectory(24);
      await authenticateAs(["org:read", "org:write"]);
      stubClerk();

      const first = await listMembers(1);
      const second = await listMembers(2);

      // 24 members leave room for 1 invitation on page 1; the other 3 follow.
      expect(first.invitations.map((invitation) => invitation.id)).toEqual(["inv_directory_0"]);
      expect(second.members).toEqual([]);
      expect(second.invitations.map((invitation) => invitation.id)).toEqual([
        "inv_directory_1",
        "inv_directory_2",
        "inv_directory_3",
      ]);
    });

    it("does not call Clerk for a page that carries no invitations", async () => {
      await seedDirectory(26);
      await authenticateAs(["org:read", "org:write"]);
      const clerk = stubClerk();

      await listMembers(1);

      expect(clerk.listCalls).toBe(0);
    });
  });
});
