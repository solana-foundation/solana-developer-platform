import { SdpEarnError } from "@sdp/earn/errors";
import { WisdomTreeEarnClient } from "@sdp/earn/providers/wisdomtree/client";
import { WisdomTreeOnboardingClient } from "@sdp/earn/providers/wisdomtree/onboarding";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getDb } from "@/db/client";
import { runWithDatabaseIdentity } from "@/db/identity";
import type { EarnOnboardingScope } from "@/db/repositories/earn-onboarding.repository";
import { createPostgresEarnOnboardingRepository } from "@/db/repositories/earn-onboarding.repository.postgres";
import { createEarnOnboardingCipher } from "@/lib/earn-onboarding-crypto";
import { onboardingApplicationSchema } from "@/routes/earn-onboarding/schemas";
import { TEST_ORG, TEST_USER } from "@/test/fixtures/organizations";
import { deferred } from "@/test/helpers/deferred";
import { env } from "@/test/helpers/env";
import { seedDefaultProjects } from "@/test/helpers/projects";
import { seedTestDatabase } from "@/test/mocks/db";
import { assertVaultDepositEligible } from "./deposit-eligibility";
import { WisdomTreeOnboardingService } from "./wisdomtree-onboarding.service";

const moderatorGuid = "a3c9d5b7-8a4d-4e35-9c1e-417cba654e2c";
const childGuid = "8b6f0d3e-2c71-4f5a-a1d9-3e4c7b2f9a10";
const personGuid = "3f1c2b7e-8d4a-4c1e-9b2f-6a5d0e7c1a24";
const scope: EarnOnboardingScope = {
  organizationId: TEST_ORG.id,
  projectId: "prj_onboarding",
  environment: "sandbox",
  counterpartyId: "cp_onboarding",
};
const sibling: EarnOnboardingScope = { ...scope, counterpartyId: "cp_other" };
const db = getDb(env);
const repo = createPostgresEarnOnboardingRepository(db);
const provider = new WisdomTreeOnboardingClient();
const runtime = { environment: "sandbox" as const, env: {} };
const cipher = createEarnOnboardingCipher({
  EARN_ONBOARDING_ENCRYPTION_KEY: "BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc=",
});
const service = new WisdomTreeOnboardingService(repo, provider, cipher, runtime);
const draft = {
  application: {
    entity_type: "organization" as const,
    status: "draft" as const,
    org_details: { name: "Example", tax_id: "GB-ABC" },
  },
};
const form = { can_create: true, submission_template: {}, sections: [] };

async function linkBusiness() {
  await repo.claim(scope, { moderatorGuid, entityType: "business" });
  await repo.link(scope, { moderatorGuid, organizationGuid: childGuid, personGuid: null });
}
beforeEach(async () => {
  await seedTestDatabase(env);
  await db
    .prepare(
      "INSERT INTO organizations (id, name, slug, tier, status) VALUES (?, 'Test', 'onboarding', 'individual', 'active')"
    )
    .bind(TEST_ORG.id)
    .run();
  await db
    .prepare("INSERT INTO users (id, email, status) VALUES (?, ?, 'active')")
    .bind(TEST_USER.id, TEST_USER.email)
    .run();
  await seedDefaultProjects(db, {
    organizationId: TEST_ORG.id,
    createdBy: TEST_USER.id,
    members: [],
    ids: { sandbox: scope.projectId, production: "prj_onboarding_prod" },
  });
  for (const s of [scope, sibling])
    await db
      .prepare(
        "INSERT INTO counterparties (id, organization_id, project_id, entity_type, display_name, status) VALUES (?, ?, ?, 'business', 'Example', 'active')"
      )
      .bind(s.counterpartyId, s.organizationId, s.projectId)
      .run();
  vi.spyOn(provider, "getModerator").mockResolvedValue({
    guid: moderatorGuid,
    client_organizations: [],
  });
  vi.spyOn(provider, "getBusinessForm").mockResolvedValue(form);
  vi.spyOn(provider, "getPersonForm").mockResolvedValue(form);
  vi.spyOn(provider, "saveBusiness").mockResolvedValue({ organization_guid: childGuid });
  vi.spyOn(provider, "getBusiness").mockResolvedValue({
    org_guid: childGuid,
    onboarding_status: "submitted",
    sensitive_data_redacted: true,
  });
});
afterEach(() => vi.restoreAllMocks());

describe("durable customer mapping", () => {
  it("claims before the provider call and persists only the returned child identity", async () => {
    vi.spyOn(provider, "saveBusiness").mockImplementation(async () => {
      expect((await repo.get(scope))?.status).toBe("claimed");
      return { organization_guid: childGuid, tax_id: "must-not-be-stored" };
    });
    expect(await service.save(scope, "business", draft)).toEqual({
      counterpartyId: scope.counterpartyId,
      state: "linked",
    });
    expect(await repo.get(scope)).toMatchObject({
      status: "linked",
      organization_guid: childGuid,
      moderator_guid: moderatorGuid,
    });
    expect(JSON.stringify(await repo.get(scope))).not.toMatch(/tax_id|GB-ABC|must-not/);
  });
  it("lets exactly one concurrent create reach WisdomTree even with different HTTP keys", async () => {
    const started = deferred<void>();
    const release = deferred<void>();
    vi.spyOn(provider, "saveBusiness").mockImplementation(async () => {
      started.resolve();
      await release.promise;
      return { organization_guid: childGuid };
    });
    const first = service.save(scope, "business", draft);
    await started.promise;
    try {
      await expect(service.save(scope, "business", draft)).rejects.toThrow(/already claimed/);
      expect(provider.saveBusiness).toHaveBeenCalledTimes(1);
    } finally {
      release.resolve();
      await first;
    }
  });
  it("never creates twice after a timeout without a returned GUID", async () => {
    vi.spyOn(provider, "saveBusiness").mockRejectedValue(
      new SdpEarnError("PROVIDER_UNAVAILABLE", "timeout")
    );
    await expect(service.save(scope, "business", draft)).rejects.toThrow("timeout");
    await expect(service.save(scope, "business", draft)).rejects.toThrow(/reconcile/);
    expect(provider.saveBusiness).toHaveBeenCalledTimes(1);
    expect(await service.status(scope)).toMatchObject({
      state: "claimed",
      reconciliationRequired: true,
    });
  });
  it("recovers the saved child GUID on a partial 400, then resumes that same application", async () => {
    vi.spyOn(provider, "saveBusiness").mockRejectedValueOnce(
      new SdpEarnError("BAD_REQUEST", "partial save", { organization_guid: childGuid })
    );
    await expect(service.save(scope, "business", draft)).rejects.toThrow("partial save");
    expect((await repo.get(scope))?.organization_guid).toBe(childGuid);
    await service.save(scope, "business", {
      application: { entity_type: "organization", status: "submit" },
    });
    expect(provider.saveBusiness).toHaveBeenLastCalledWith(runtime, {
      entity_type: "organization",
      status: "submit",
      org_guid: childGuid,
    });
  });
  it("refuses before claiming when the current form denies onboarding", async () => {
    vi.spyOn(provider, "getBusinessForm").mockResolvedValue({ ...form, can_create: false });
    await expect(service.save(scope, "business", draft)).rejects.toThrow(/does not permit/);
    expect(await repo.get(scope)).toBeNull();
    expect(provider.saveBusiness).not.toHaveBeenCalled();
  });
  it("never records the moderator as the child and never overwrites an identity", async () => {
    await repo.claim(scope, { moderatorGuid, entityType: "business" });
    await expect(
      repo.link(scope, { moderatorGuid, organizationGuid: moderatorGuid, personGuid: null })
    ).rejects.toThrow();
    await repo.link(scope, { moderatorGuid, organizationGuid: childGuid, personGuid: null });
    expect(
      await repo.link(scope, { moderatorGuid, organizationGuid: personGuid, personGuid: null })
    ).toBeNull();
    expect((await repo.get(scope))?.organization_guid).toBe(childGuid);
  });
  it("prevents the same provider identity belonging to two SDP customers", async () => {
    await linkBusiness();
    await repo.claim(sibling, { moderatorGuid, entityType: "business" });
    await expect(
      repo.link(sibling, { moderatorGuid, organizationGuid: childGuid, personGuid: null })
    ).rejects.toThrow();
  });
  it("stores a retail person without substituting its moderator organization as a child", async () => {
    vi.spyOn(provider, "submitPerson").mockResolvedValue({ person_guid: personGuid });
    const input = onboardingApplicationSchema.parse({
      application: {
        entity_type: "retail",
        first_name: "Jane",
        last_name: "Doe",
        email: "jane@example.com",
        phone_number: "+12025550123",
        date_of_birth: "01-31-1990",
        tax_id: "666123456",
        address: "123 Main",
        city: "New York",
        state: "NY",
        postal_code: "10001",
        country: "US",
        primary_source_of_funds: "Savings",
        agreement_set_version: "v1",
        agreements: [{ key: "privacy", version: "v1", accepted: true }],
      },
    });
    await service.save(scope, "individual", input);
    expect(await repo.get(scope)).toMatchObject({
      person_guid: personGuid,
      organization_guid: null,
      status: "linked",
    });
  });
  it("refuses a rotated moderator before reading customer data", async () => {
    await linkBusiness();
    vi.spyOn(provider, "getModerator").mockResolvedValue({
      guid: personGuid,
      client_organizations: [],
    });
    await expect(service.status(scope)).rejects.toThrow(/credentials changed/);
    expect(provider.getBusiness).not.toHaveBeenCalled();
  });
});

describe("document and tenant boundaries", () => {
  it("encrypts references and resolves documents only for their exact customer scope", async () => {
    vi.spyOn(provider, "uploadDocument").mockResolvedValue({
      blob_path: "secret/blob.pdf",
      original_filename: "jane-id.pdf",
    });
    const { documentId } = await service.upload(scope, {
      documentType: "formation_document",
      file: new File(["%PDF"], "a.pdf", { type: "application/pdf" }),
    });
    const encrypted = await repo.getDocument(scope, documentId);
    expect(encrypted).not.toMatch(/secret|jane/);
    expect(await repo.getDocument(sibling, documentId)).toBeNull();
    expect(await repo.getDocument({ ...scope, environment: "production" }, documentId)).toBeNull();
    await expect(
      service.save(sibling, "business", { ...draft, documents: { formation_document: documentId } })
    ).rejects.toThrow(/not found/i);
    expect(provider.saveBusiness).not.toHaveBeenCalled();
    await service.save(scope, "business", {
      ...draft,
      documents: { formation_document: documentId },
    });
    expect(provider.saveBusiness).toHaveBeenCalledWith(
      runtime,
      expect.objectContaining({
        formation_document: { blob_path: "secret/blob.pdf", original_filename: "jane-id.pdf" },
      })
    );
  });
  it("keeps claimed and linked records inaccessible across tenant, project, environment and parent", async () => {
    await linkBusiness();
    for (const wrong of [
      { ...scope, organizationId: "another-org" },
      { ...scope, projectId: "another-project" },
      { ...scope, environment: "production" as const },
      sibling,
    ]) {
      expect(await repo.get(wrong)).toBeNull();
      expect(
        await repo.link(wrong, { moderatorGuid, organizationGuid: personGuid, personGuid: null })
      ).toBeNull();
    }
    const other = await runWithDatabaseIdentity(
      { kind: "tenant", organizationId: "another-org" },
      () => db.prepare("SELECT * FROM earn_onboarding_customers").all()
    );
    expect(other.results).toEqual([]);
  });
  it("refuses caller-supplied child GUIDs and raw provider document paths", () => {
    for (const application of [
      { ...draft.application, org_guid: childGuid },
      { ...draft.application, parent_org_guid: childGuid },
      { ...draft.application, formation_document: { blob_path: "arbitrary" } },
    ]) {
      expect(onboardingApplicationSchema.safeParse({ application }).success).toBe(false);
    }
  });
});

describe("wallet onboarding and deposit admission", () => {
  it("will not register a wallet until the business is active", async () => {
    await linkBusiness();
    vi.spyOn(provider, "getModerator").mockResolvedValue({
      guid: moderatorGuid,
      client_organizations: [{ guid: childGuid }],
    });
    const register = vi.spyOn(provider, "registerSolanaWallet");
    await expect(service.registerWallet(scope, "owner")).rejects.toThrow(/not active/);
    expect(register).not.toHaveBeenCalled();
  });
  it("claims a wallet once, then passes only its stored child context to admission", async () => {
    await linkBusiness();
    vi.spyOn(provider, "getModerator").mockResolvedValue({
      guid: moderatorGuid,
      client_organizations: [{ guid: childGuid }],
    });
    vi.spyOn(provider, "getBusiness").mockResolvedValue({
      org_guid: childGuid,
      onboarding_status: "active",
      sensitive_data_redacted: true,
    });
    vi.spyOn(provider, "registerSolanaWallet").mockResolvedValue({});
    await service.registerWallet(scope, "owner");
    await expect(service.registerWallet(scope, "owner")).rejects.toThrow(/already claimed/);
    expect(provider.registerSolanaWallet).toHaveBeenCalledTimes(1);
    const earn = new WisdomTreeEarnClient();
    const check = vi.spyOn(earn, "checkDepositEligibility").mockResolvedValue({ eligible: true });
    await assertVaultDepositEligible(
      earn,
      runtime,
      { providerReference: "fund", owner: "owner" },
      { ...scope, database: env }
    );
    expect(check).toHaveBeenCalledWith(runtime, {
      providerReference: "fund",
      owner: "owner",
      customer: { moderatorReference: moderatorGuid, customerReference: childGuid },
    });
    expect(await repo.findByWallet({ ...scope, projectId: "other" }, "owner")).toBeNull();
  });
  it("releases the shared address when WisdomTree rejects the registration", async () => {
    await linkBusiness();
    vi.spyOn(provider, "getModerator").mockResolvedValue({
      guid: moderatorGuid,
      client_organizations: [{ guid: childGuid }],
    });
    vi.spyOn(provider, "getBusiness").mockResolvedValue({
      org_guid: childGuid,
      onboarding_status: "active",
      sensitive_data_redacted: true,
    });
    const register = vi.spyOn(provider, "registerSolanaWallet").mockResolvedValue({});
    register.mockRejectedValueOnce(new SdpEarnError("BAD_REQUEST", "wallet already registered"));
    await expect(service.registerWallet(scope, "owner")).rejects.toThrow("already registered");
    // The address is globally unique per environment: an unverified claim must
    // not block the real owner, so another customer can win it after a reject.
    expect(await repo.claimWallet(sibling, "owner")).toBe(true);
    await repo.releaseWallet(sibling, "owner");
    await service.registerWallet(scope, "owner");
    expect(register).toHaveBeenCalledTimes(2);
  });
  it("keeps the claim for reconciliation when the registration outcome is unknown", async () => {
    await linkBusiness();
    vi.spyOn(provider, "getModerator").mockResolvedValue({
      guid: moderatorGuid,
      client_organizations: [{ guid: childGuid }],
    });
    vi.spyOn(provider, "getBusiness").mockResolvedValue({
      org_guid: childGuid,
      onboarding_status: "active",
      sensitive_data_redacted: true,
    });
    vi.spyOn(provider, "registerSolanaWallet").mockRejectedValue(
      new SdpEarnError("PROVIDER_UNAVAILABLE", "timeout")
    );
    await expect(service.registerWallet(scope, "owner")).rejects.toThrow("timeout");
    // A timeout may have registered the wallet: the claim stays so no other
    // provider write starts before an operator reconciles the outcome.
    await expect(service.registerWallet(scope, "owner")).rejects.toThrow(/already claimed/);
    expect(provider.registerSolanaWallet).toHaveBeenCalledTimes(1);
  });
  it("refuses an unlinked wallet before contacting the eligibility provider", async () => {
    const earn = new WisdomTreeEarnClient();
    const check = vi.spyOn(earn, "checkDepositEligibility");
    await expect(
      assertVaultDepositEligible(
        earn,
        runtime,
        { providerReference: "fund", owner: "owner" },
        { ...scope, database: env }
      )
    ).rejects.toThrow(/unavailable/);
    expect(check).not.toHaveBeenCalled();
  });
});
