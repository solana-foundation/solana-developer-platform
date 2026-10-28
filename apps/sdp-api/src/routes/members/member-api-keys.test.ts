import type { ApiKeyStatus } from "@sdp/types/api-keys";
import { beforeEach, describe, expect, it } from "vitest";
import { getDb } from "@/db/client";
import { app } from "@/index";
import { listActiveApiKeysCreatedBy } from "@/services/api-key.service";
import { seedProjectApiKey } from "@/test/helpers/api-keys";
import { clerkHeadersWithoutProject } from "@/test/helpers/clerk";
import { signSeededClerkMember } from "@/test/helpers/clerk-member";
import { env } from "@/test/helpers/env";
import {
  organizationMember,
  type SeededOrganizationMember,
  seedOrganizationMembers,
} from "@/test/helpers/organization-members";
import { type SeededProject, seedDefaultProjects } from "@/test/helpers/projects";
import { seedTestDatabase } from "@/test/mocks/db";

const ORGANIZATION = { id: "org_member_keys", slug: "member-keys" };
const OTHER_ORGANIZATION = { id: "org_member_keys_other", slug: "member-keys-other" };
const ADMIN = organizationMember("member_keys_admin", "admin");
const CREATOR = organizationMember("member_keys_creator", "member");
const FOREIGN_MEMBER = organizationMember("member_keys_foreign", "member");
const OLDER = "2026-01-01T00:00:00.000Z";
const NEWER = "2026-02-01T00:00:00.000Z";
let expectedKeys: ReturnType<typeof listedKey>[];

type KeyOwner = { organizationId: string; projectId: string; createdBy: string };

async function seedKey(id: string, owner: KeyOwner, status: ApiKeyStatus, createdAt: string) {
  const db = getDb(env);
  await seedProjectApiKey(db, env, {
    ...owner,
    key: { id, raw: `sk_test_${id}`, prefix: `sk_${id}` },
    grants: ["transfers.read"],
  });
  await db
    .prepare("UPDATE api_keys SET status = ?, created_at = ? WHERE id = ?")
    .bind(status, createdAt, id)
    .run();
}

function listedKey(id: string, project: SeededProject, createdAt: string) {
  return {
    id,
    name: id,
    keyPrefix: `sk_${id}`,
    projectId: project.id,
    projectName: project.name,
    environment: project.environment,
    createdAt,
  };
}

async function requestKeysAs(actor: SeededOrganizationMember, memberId: string) {
  const token = await signSeededClerkMember(env, getDb(env), actor.userId, ORGANIZATION.id);
  return app.request(
    `/v1/members/${memberId}/api-keys`,
    { headers: clerkHeadersWithoutProject(token) },
    env
  );
}

describe("member API keys", () => {
  beforeEach(async () => {
    await seedTestDatabase(env);
    const db = getDb(env);
    await seedOrganizationMembers(db, { organization: ORGANIZATION, members: [ADMIN, CREATOR] });
    await seedOrganizationMembers(db, {
      organization: OTHER_ORGANIZATION,
      members: [FOREIGN_MEMBER],
    });
    const { sandbox, production } = await seedDefaultProjects(db, {
      organizationId: ORGANIZATION.id,
      createdBy: ADMIN.userId,
      members: [ADMIN.userId, CREATOR.userId],
    });
    const other = await seedDefaultProjects(db, {
      organizationId: OTHER_ORGANIZATION.id,
      createdBy: FOREIGN_MEMBER.userId,
      members: [FOREIGN_MEMBER.userId],
    });
    const own = (project: SeededProject) => ({
      organizationId: project.organizationId,
      projectId: project.id,
      createdBy: CREATOR.userId,
    });
    await seedKey("key_older", own(sandbox), "active", OLDER);
    await seedKey("key_newer", own(production), "active", NEWER);
    await seedKey("key_revoked", own(sandbox), "revoked", NEWER);
    await seedKey("key_deactivated", own(production), "deactivated", NEWER);
    await seedKey("key_admin", { ...own(sandbox), createdBy: ADMIN.userId }, "active", NEWER);
    await seedKey("key_other_org", own(other.sandbox), "active", NEWER);
    expectedKeys = [
      listedKey("key_newer", production, NEWER),
      listedKey("key_older", sandbox, OLDER),
    ];
  });

  it("lists only the creator's working keys in the organization, newest first", async () => {
    expect(
      await listActiveApiKeysCreatedBy(getDb(env), {
        organizationId: ORGANIZATION.id,
        createdByUserId: CREATOR.userId,
      })
    ).toEqual(expectedKeys);
  });

  it("answers an admin with the member's keys", async () => {
    const response = await requestKeysAs(ADMIN, CREATOR.memberId);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      data: { apiKeys: expectedKeys },
      meta: { requestId: expect.any(String), timestamp: expect.any(String) },
    });
  });

  it("does not find a member of another organization", async () => {
    const response = await requestKeysAs(ADMIN, FOREIGN_MEMBER.memberId);

    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({
      error: { code: "NOT_FOUND", message: "Member not found" },
    });
  });

  it("refuses a member", async () => {
    expect((await requestKeysAs(CREATOR, ADMIN.memberId)).status).toBe(403);
  });
});
