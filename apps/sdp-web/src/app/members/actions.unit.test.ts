import type { OrganizationRole } from "@sdp/types/roles";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ZodError } from "zod";
import { PRODUCTION_PROJECT } from "@/test/projects";
import { setPageRequest } from "@/test/request-project";

const mocks = vi.hoisted(() => ({
  createOrgSdpApiClient: vi.fn(),
  createSdpApiClient: vi.fn(),
  revalidatePath: vi.fn(),
}));

vi.mock("next/cache", () => ({ revalidatePath: mocks.revalidatePath }));
vi.mock("next/headers", () => import("@/test/next-headers"));
vi.mock("next/navigation", () => import("@/test/next-navigation"));
vi.mock("@/i18n/server", () => ({ getTranslations: async () => (key: string) => key }));
vi.mock("@/lib/sdp-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/sdp-api")>()),
  createOrgSdpApiClient: mocks.createOrgSdpApiClient,
  createSdpApiClient: mocks.createSdpApiClient,
}));

import {
  changeMemberRole,
  inviteMember,
  listMembers,
  removeMember,
  revokeInvitation,
} from "./actions";

const client = { fetch: vi.fn() };

beforeEach(() => {
  vi.clearAllMocks();
  setPageRequest(`/dashboard/${PRODUCTION_PROJECT.id}/settings`);
  mocks.createOrgSdpApiClient.mockResolvedValue(client);
  mocks.createSdpApiClient.mockResolvedValue(client);
  client.fetch.mockResolvedValue({});
});

describe("member actions", () => {
  it.each([
    {
      name: "removeMember",
      run: () => removeMember("mem_test", "key_remove"),
      path: "/v1/members/mem_test",
      init: { method: "DELETE", headers: { "Idempotency-Key": "key_remove" } },
    },
    {
      name: "changeMemberRole",
      run: () => changeMemberRole("mem_test", "admin", "key_role"),
      path: "/v1/members/mem_test",
      init: {
        method: "PATCH",
        headers: { "Idempotency-Key": "key_role" },
        body: JSON.stringify({ role: "admin" }),
      },
    },
    {
      name: "revokeInvitation",
      run: () => revokeInvitation("inv_test", "key_revoke"),
      path: "/v1/members/invitations/inv_test",
      init: { method: "DELETE", headers: { "Idempotency-Key": "key_revoke" } },
    },
  ])("$name sends the Idempotency-Key it is given", async ({ run, path, init }) => {
    expect(await run()).toEqual({ status: "success" });
    expect(client.fetch.mock.calls).toEqual([[path, init]]);
  });

  it("inviteMember forwards the form's idempotencyKey", async () => {
    const formData = new FormData();
    formData.set("email", "invitee@example.com");
    formData.set("role", "member");
    formData.set("idempotencyKey", "key_invite");

    expect(await inviteMember(formData)).toEqual({
      status: "success",
      email: "invitee@example.com",
    });
    expect(client.fetch.mock.calls).toEqual([
      [
        "/v1/members/invite",
        {
          method: "POST",
          headers: { "Idempotency-Key": "key_invite" },
          body: JSON.stringify({ email: "invitee@example.com", role: "member" }),
        },
      ],
    ]);
  });

  const wireRole: string = "owner";

  it.each([
    { name: "removeMember with an empty key", run: () => removeMember("mem_test", "") },
    {
      name: "changeMemberRole with a role outside admin and member",
      // SAFETY: a server action's arguments arrive untyped from the browser; this sends one the type rules out.
      run: () => changeMemberRole("mem_test", wireRole as OrganizationRole, "key_role"),
    },
    { name: "revokeInvitation with an empty id", run: () => revokeInvitation("", "key_revoke") },
  ])("refuses $name before calling sdp-api", async ({ run }) => {
    await expect(run()).rejects.toThrow(ZodError);
    expect(client.fetch).not.toHaveBeenCalled();
  });

  it("inviteMember answers a form with no idempotencyKey with the error result, unsent", async () => {
    const formData = new FormData();
    formData.set("email", "invitee@example.com");
    formData.set("role", "member");

    expect(await inviteMember(formData)).toEqual({
      status: "error",
      message: "Shared.members.emailRequired",
    });
    expect(client.fetch).not.toHaveBeenCalled();
  });

  it("listMembers rejects a directory naming a member role other than admin or member", async () => {
    client.fetch.mockResolvedValue({
      members: [
        {
          id: "mem_test",
          role: "owner",
          status: "active",
          createdAt: "2026-10-01T00:00:00.000Z",
          isSelf: false,
          user: { id: "user_test", email: "owner@example.com", name: null },
        },
      ],
      invitations: [],
      meta: { total: 1, page: 1, pageSize: 25, hasMore: false, activeAdminCount: 0 },
    });

    await expect(listMembers(1)).rejects.toThrow(ZodError);
  });
});
