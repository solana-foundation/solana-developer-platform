import { describe, expect, it } from "vitest";
import {
  bindRepositoryToTenant,
  createTenantScope,
  TenantScopeViolationError,
} from "./tenant-scope";

describe("tenant repository scope", () => {
  const scope = createTenantScope({
    organizationId: "org_alpha",
    projectId: "prj_alpha",
  });

  it("rejects cross-tenant organization and project claims before repository execution", async () => {
    let calls = 0;
    const repository = bindRepositoryToTenant(
      {
        async get(input: { organizationId: string; projectId: string; id: string }) {
          calls += 1;
          return input.id;
        },
      },
      scope,
      "TestRepository"
    );

    expect(() =>
      repository.get({
        organizationId: "org_foreign",
        projectId: "prj_foreign",
        id: "foreign",
      })
    ).toThrow(TenantScopeViolationError);
    expect(calls).toBe(0);
  });

  it("preserves legitimate same-tenant access", async () => {
    const repository = bindRepositoryToTenant(
      {
        async get(input: { organizationId: string; projectId: string; id: string }) {
          return input.id;
        },
      },
      scope,
      "TestRepository"
    );

    await expect(
      repository.get({
        organizationId: "org_alpha",
        projectId: "prj_alpha",
        id: "owned",
      })
    ).resolves.toBe("owned");
  });

  it("keeps organization-scoped null project semantics explicit", () => {
    expect(
      createTenantScope({
        organizationId: "org_alpha",
        projectId: null,
      })
    ).toMatchObject({
      organizationId: "org_alpha",
      projectId: null,
    });
  });

  it("blocks system-only methods from tenant repositories", () => {
    const repository = bindRepositoryToTenant(
      {
        reconcile() {
          return "unsafe";
        },
      },
      scope,
      "TestRepository",
      ["reconcile"]
    );

    expect(() => repository.reconcile()).toThrow(TenantScopeViolationError);
  });
});
