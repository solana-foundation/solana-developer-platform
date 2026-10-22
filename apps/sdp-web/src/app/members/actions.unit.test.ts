import { beforeEach, describe, expect, it, vi } from "vitest";
import { PRODUCTION_PROJECT } from "@/test/projects";
import { setPageRequest } from "@/test/request-project";

const mocks = vi.hoisted(() => ({
  createSdpApiClient: vi.fn(),
  revalidatePath: vi.fn(),
}));

vi.mock("next/cache", () => ({ revalidatePath: mocks.revalidatePath }));
vi.mock("next/headers", () => import("@/test/next-headers"));
vi.mock("next/navigation", () => import("@/test/next-navigation"));
vi.mock("@/i18n/server", () => ({ getTranslations: async () => (key: string) => key }));
vi.mock("@/lib/sdp-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/sdp-api")>()),
  createSdpApiClient: mocks.createSdpApiClient,
}));

import { changeMemberRole, inviteMember, removeMember, revokeInvitation } from "./actions";

const client = { fetch: vi.fn() };

beforeEach(() => {
  vi.clearAllMocks();
  setPageRequest(`/dashboard/${PRODUCTION_PROJECT.id}/settings`);
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
    expect(await run()).toEqual({ ok: true });
    expect(client.fetch.mock.calls).toEqual([[path, init]]);
  });

  it("inviteMember forwards the form's idempotencyKey", async () => {
    const formData = new FormData();
    formData.set("email", "invitee@example.com");
    formData.set("role", "member");
    formData.set("idempotencyKey", "key_invite");

    expect(await inviteMember(formData)).toEqual({ ok: true, email: "invitee@example.com" });
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
});
