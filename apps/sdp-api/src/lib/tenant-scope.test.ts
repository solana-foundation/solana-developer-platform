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

  it("rejects nested cross-tenant claims before repository execution", () => {
    let calls = 0;
    const repository = bindRepositoryToTenant(
      {
        createTransferBatchWithRecipients(input: {
          batch: { organizationId: string; projectId: string; id: string };
          recipients: Array<{ organizationId: string; projectId: string; id: string }>;
        }) {
          calls += 1;
          return input.recipients.length;
        },
      },
      scope,
      "TestRepository"
    );

    expect(() =>
      repository.createTransferBatchWithRecipients({
        batch: {
          organizationId: "org_foreign",
          projectId: "prj_foreign",
          id: "foreign-batch",
        },
        recipients: [
          {
            organizationId: "org_alpha",
            projectId: "prj_alpha",
            id: "owned-recipient",
          },
        ],
      })
    ).toThrow(TenantScopeViolationError);

    expect(() =>
      repository.createTransferBatchWithRecipients({
        batch: {
          organizationId: "org_alpha",
          projectId: "prj_alpha",
          id: "owned-batch",
        },
        recipients: [
          {
            organizationId: "org_foreign",
            projectId: "prj_foreign",
            id: "foreign-recipient",
          },
        ],
      })
    ).toThrow(TenantScopeViolationError);
    expect(calls).toBe(0);
  });

  it("validates each tenant claim independently without rejecting legitimate partial filters", () => {
    let calls = 0;
    const repository = bindRepositoryToTenant(
      {
        create(input: { organizationId: string; projectId?: string; id: string }) {
          calls += 1;
          return input.id;
        },
      },
      scope,
      "TestRepository"
    );

    expect(repository.create({ organizationId: "org_alpha", id: "partial" })).toBe("partial");
    expect(() => repository.create({ organizationId: "org_foreign", id: "foreign" })).toThrow(
      TenantScopeViolationError
    );
    expect(calls).toBe(1);
  });

  it("rejects inherited tenant claims before repository execution", () => {
    let calls = 0;
    const repository = bindRepositoryToTenant(
      {
        create(input: { organizationId: string; projectId: string; id: string }) {
          calls += 1;
          return input.id;
        },
      },
      scope,
      "TestRepository"
    );
    const inheritedClaim = Object.assign(
      Object.create({ organizationId: "org_foreign", projectId: "prj_foreign" }),
      { id: "inherited" }
    );

    expect(() => repository.create(inheritedClaim)).toThrow(TenantScopeViolationError);
    expect(calls).toBe(0);
  });

  it("rejects snake-case cross-tenant claims before repository execution", () => {
    let calls = 0;
    const repository = bindRepositoryToTenant(
      {
        create(input: { organization_id: string; project_id: string; id: string }) {
          calls += 1;
          return input.id;
        },
      },
      scope,
      "TestRepository"
    );

    expect(() =>
      repository.create({
        organization_id: "org_alpha",
        project_id: "prj_foreign",
        id: "foreign",
      })
    ).toThrow(TenantScopeViolationError);
    expect(calls).toBe(0);
  });

  it("rejects cross-tenant claims nested in Map and Set arguments", () => {
    let calls = 0;
    const repository = bindRepositoryToTenant(
      {
        create(input: Map<string, Set<{ organizationId: string; projectId: string }>>) {
          calls += 1;
          return input.size;
        },
      },
      scope,
      "TestRepository"
    );

    expect(() =>
      repository.create(
        new Map([
          ["nested", new Set([{ organizationId: "org_foreign", projectId: "prj_foreign" }])],
        ])
      )
    ).toThrow(TenantScopeViolationError);
    expect(calls).toBe(0);
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
