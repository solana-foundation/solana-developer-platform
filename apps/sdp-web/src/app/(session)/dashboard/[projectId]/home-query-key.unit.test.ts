import { describe, expect, it } from "vitest";
import type { DashboardKeyScope } from "@/lib/dashboard-request-key";
import { SANDBOX_PROJECT } from "@/test/projects";
import { homeQueryKeys } from "./home-query-key";

describe("home query keys", () => {
  it("keys each read by the request it sends", () => {
    const scope: DashboardKeyScope = { projectId: SANDBOX_PROJECT.id, mode: "demo" };
    expect([homeQueryKeys.activity(scope), homeQueryKeys.network(scope)]).toEqual([
      [SANDBOX_PROJECT.id, "demo", "/api/dashboard/home/activity"],
      [SANDBOX_PROJECT.id, "demo", "/api/dashboard/network"],
    ]);
  });
});
