import { beforeEach, describe, expect, it, vi } from "vitest";
import { ZodError } from "zod";
import * as sdpApi from "@/lib/sdp-api";
import { PRODUCTION_PROJECT } from "@/test/projects";
import { setPageRequest } from "@/test/request-project";

vi.mock("next/headers", () => import("@/test/next-headers"));
vi.mock("next/navigation", () => import("@/test/next-navigation"));

import { listMembers } from "./members-load";

const client = { request: vi.fn(), fetch: vi.fn() };

beforeEach(() => {
  vi.clearAllMocks();
  setPageRequest(`/dashboard/${PRODUCTION_PROJECT.id}/settings`);
  vi.spyOn(sdpApi, "createOrgSdpApiClient").mockResolvedValue(client);
});

describe("listMembers", () => {
  it("rejects a directory naming a role SDP does not define", async () => {
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
