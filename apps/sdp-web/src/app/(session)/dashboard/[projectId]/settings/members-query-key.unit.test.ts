import { describe, expect, it } from "vitest";
import type { DashboardKeyScope } from "@/lib/dashboard-request-key";
import { SANDBOX_PROJECT } from "@/test/projects";
import { membersQueryKeys } from "./members-query-key";

describe("members query keys", () => {
  it("keys each read by the request it sends", () => {
    const scope: DashboardKeyScope = { projectId: SANDBOX_PROJECT.id, mode: "demo" };
    expect([
      membersQueryKeys.directory(scope, { page: 2 }),
      membersQueryKeys.memberApiKeys(scope, { memberId: "mem_test/1" }),
    ]).toEqual([
      [SANDBOX_PROJECT.id, "demo", "/api/dashboard/members", { page: 2, pageSize: 25 }],
      [SANDBOX_PROJECT.id, "demo", "/api/dashboard/members/mem_test%2F1/api-keys"],
    ]);
  });
});
