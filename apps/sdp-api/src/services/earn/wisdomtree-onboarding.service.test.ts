import { SdpEarnError } from "@sdp/earn/errors";
import { WisdomTreeEarnClient } from "@sdp/earn/providers/wisdomtree/client";
import { WisdomTreeOnboardingClient } from "@sdp/earn/providers/wisdomtree/onboarding";
import type { CustodyConnectionBindingLifecycle } from "@sdp/types/custody";
import { generateKeyPairSigner, getBase58Decoder, signBytes } from "@solana/kit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getDb } from "@/db/client";
import { runWithDatabaseIdentity } from "@/db/identity";
import type { EarnOnboardingScope } from "@/db/repositories/earn-onboarding.repository";
import { createPostgresEarnOnboardingRepository } from "@/db/repositories/earn-onboarding.repository.postgres";
import { createEarnOnboardingCipher } from "@/lib/earn-onboarding-crypto";
import { onboardingApplicationSchema } from "@/routes/earn-onboarding/schemas";
import { CustodyConfigStore } from "@/services/stores/custody-config.store";
import { TEST_ORG, TEST_USER } from "@/test/fixtures/organizations";
import { deferred } from "@/test/helpers/deferred";
import { env } from "@/test/helpers/env";
import { seedDefaultProjects } from "@/test/helpers/projects";
import { seedTestDatabase } from "@/test/mocks/db";
import { assertVaultDepositEligible } from "./deposit-eligibility";
import {
  WisdomTreeOnboardingService,
  wisdomTreeWalletRegistrationMessage,
} from "./wisdomtree-onboarding.service";

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
const service = new WisdomTreeOnboardingService(
  repo,
  provider,
  cipher,
  runtime,
  new CustodyConfigStore(db, env)
);
const draft = {
  application: {
    entity_type: "organization" as const,
    status: "draft" as const,
    org_details: { name: "Example", tax_id: "GB-ABC" },
  },
};
const form = { can_create: true, submission_template: {}, sections: [] };

async function linkBusiness(s: EarnOnboardingScope = scope) {
  await repo.claim(s, { moderatorGuid, entityType: "business" });
  await repo.link(s, { moderatorGuid, organizationGuid: childGuid, personGuid: null });
}

/** A fresh wallet plus its valid base58 proof-of-control signature for a scope. */
async function controlledWallet(forScope: EarnOnboardingScope = scope) {
  const wallet = await generateKeyPairSigner();
  return {
    owner: wallet.address,
    signature: await signRegistration(wallet, forScope),
  };
}

async function signRegistration(
  wallet: Awaited<ReturnType<typeof generateKeyPairSigner>>,
  forScope: EarnOnboardingScope
) {
  return getBase58Decoder().decode(
    await signBytes(
      wallet.keyPair.privateKey,
      wisdomTreeWalletRegistrationMessage(forScope, wallet.address)
    )
  );
}

async function activeBusiness() {
  vi.spyOn(provider, "getModerator").mockResolvedValue({
    guid: moderatorGuid,
    client_organizations: [{ guid: childGuid }],
  });
  vi.spyOn(provider, "getBusiness").mockResolvedValue({
    org_guid: childGuid,
    onboarding_status: "active",
    sensitive_data_redacted: true,
  });
}

/** An active SDP custody wallet bound to one project, as a project-authorized flow creates it. */
async function seedCustodyWallet(organizationId: string, projectId: string, publicKey: string) {
  const configId = `cfg_${crypto.randomUUID()}`;
  await db
    .prepare(
      "INSERT INTO organizations (id, name, slug, tier, status) VALUES (?, 'Other', 'other-custody', 'individual', 'active') ON CONFLICT (id) DO NOTHING"
    )
    .bind(organizationId)
    .run();
  await db
    .prepare(
      "INSERT INTO projects (id, organization_id, name, slug, environment, status, created_by) VALUES (?, ?, 'Other', 'other-custody', 'sandbox', 'active', ?) ON CONFLICT (id) DO NOTHING"
    )
    .bind(projectId, organizationId, TEST_USER.id)
    .run();
  await db
    .prepare(
      "INSERT INTO custody_configs (id, organization_id, project_id, provider, config_encrypted, status) VALUES (?, ?, ?, 'local', 'encrypted', 'active')"
    )
    .bind(configId, organizationId, projectId)
    .run();
  await db
    .prepare(
      "INSERT INTO custody_wallets (id, custody_config_id, wallet_id, public_key, status) VALUES (?, ?, ?, ?, 'active')"
    )
    .bind(`cwlt_${crypto.randomUUID()}`, configId, `wtl_${crypto.randomUUID()}`, publicKey)
    .run();
}

/**
 * A connection-owned (BYOK) wallet row, which shares custody_wallets but hangs
 * off a custody connection instead of a config. `connectionStatus` exercises
 * the connection lifecycle gate.
 */
async function seedConnectionWallet(
  projectId: string,
  publicKey: string,
  connectionStatus: CustodyConnectionBindingLifecycle = "active"
) {
  const credentialId = `cred_${crypto.randomUUID()}`;
  const connectionId = `conn_${crypto.randomUUID()}`;
  await db
    .prepare(
      "INSERT INTO provider_credentials (id, organization_id, project_id, provider, label, scope, source, storage_backend, encrypted_secret_payload, status) VALUES (?, ?, ?, 'fireblocks', 'Connection', 'project', 'stored', 'encrypted_db', 'encrypted', 'active')"
    )
    .bind(credentialId, TEST_ORG.id, projectId)
    .run();
  // status = 'active' requires activated_at, a successful last check and its
  // timestamp (custody_connections_activated_at_lifecycle_check and
  // custody_connections_active_lifecycle_check); every other lifecycle state
  // requires activated_at to stay NULL.
  const activatedAt = connectionStatus === "active" ? "sdp_iso_now()" : "NULL";
  const lastCheck = connectionStatus === "active" ? "'success', sdp_iso_now()" : "NULL, NULL";
  await db
    .prepare(
      `INSERT INTO custody_connections (id, organization_id, project_id, provider, scope, provider_credential_id, provider_credential_scope_key, status, activated_at, last_check_status, last_check_at)
       VALUES (?, ?, ?, 'fireblocks', 'project', ?, ?, ?, ${activatedAt}, ${lastCheck})`
    )
    .bind(connectionId, TEST_ORG.id, projectId, credentialId, projectId, connectionStatus)
    .run();
  await db
    .prepare(
      "INSERT INTO custody_wallets (id, custody_config_id, custody_connection_id, wallet_id, public_key, purpose, status) VALUES (?, NULL, ?, ?, ?, 'transfer', 'active')"
    )
    .bind(`cwlt_${crypto.randomUUID()}`, connectionId, `wtl_${crypto.randomUUID()}`, publicKey)
    .run();
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
    vi.spyOn(provider, "getBusiness").mockResolvedValue({
      org_guid: childGuid,
      onboarding_status: "submitted",
      sensitive_data_redacted: true,
    });
    const register = vi.spyOn(provider, "registerSolanaWallet");
    const { owner, signature } = await controlledWallet();
    await expect(service.registerWallet(scope, owner, signature)).rejects.toThrow(/not active/);
    expect(register).not.toHaveBeenCalled();
  });
  it("refuses an address the caller cannot prove control of, claiming nothing", async () => {
    await linkBusiness();
    await activeBusiness();
    const register = vi.spyOn(provider, "registerSolanaWallet").mockResolvedValue({});
    const owner = await generateKeyPairSigner();
    // The attacker signs the scope-bound message with the WRONG key for `owner`.
    const attacker = await generateKeyPairSigner();
    const stolen = getBase58Decoder().decode(
      await signBytes(
        attacker.keyPair.privateKey,
        wisdomTreeWalletRegistrationMessage(scope, owner.address)
      )
    );
    await expect(service.registerWallet(scope, owner.address, stolen)).rejects.toThrow(
      /does not prove control/
    );
    await expect(service.registerWallet(scope, owner.address, "not-a-signature")).rejects.toThrow(
      /does not prove control/
    );
    expect(register).not.toHaveBeenCalled();
    // Nothing was claimed: the real owner can still register the address.
    await expect(
      service.registerWallet(scope, owner.address, await signRegistration(owner, scope))
    ).resolves.toMatchObject({ registered: true });
    expect(register).toHaveBeenCalledTimes(1);
  });
  it("binds the proof of control to the exact customer scope", async () => {
    await linkBusiness();
    // Each customer carries its own provider identity (unique per environment).
    const siblingChildGuid = "c1d2e3f4-a5b6-4c7d-8e9f-0a1b2c3d4e5f";
    await repo.claim(sibling, { moderatorGuid, entityType: "business" });
    await repo.link(sibling, {
      moderatorGuid,
      organizationGuid: siblingChildGuid,
      personGuid: null,
    });
    await activeBusiness();
    const register = vi.spyOn(provider, "registerSolanaWallet").mockResolvedValue({});
    const { owner, signature } = await controlledWallet(scope);
    // A signature captured for one customer cannot register any wallet for another.
    await expect(service.registerWallet(sibling, owner, signature)).rejects.toThrow(
      /does not prove control/
    );
    expect(register).not.toHaveBeenCalled();
  });
  it("registers an SDP custody wallet of the same project without a signature", async () => {
    await linkBusiness();
    await activeBusiness();
    const register = vi.spyOn(provider, "registerSolanaWallet").mockResolvedValue({});
    // Custody callers have no private key and no arbitrary-message signing
    // endpoint: the wallet's authorized project binding is the alternative
    // proof, because SDP generated and holds that key.
    const custody = await generateKeyPairSigner();
    await seedCustodyWallet(TEST_ORG.id, scope.projectId, custody.address);
    await expect(service.registerWallet(scope, custody.address)).resolves.toMatchObject({
      counterpartyId: scope.counterpartyId,
      owner: custody.address,
      registered: true,
    });
    expect(register).toHaveBeenCalledWith(runtime, childGuid, custody.address);
    // The linked claim is what the custody deposit path's eligibility gate reads.
    expect(await repo.findByWallet(scope, custody.address)).not.toBeNull();
  });
  it("accepts no custody binding outside the caller's organization and project", async () => {
    await linkBusiness();
    await activeBusiness();
    const register = vi.spyOn(provider, "registerSolanaWallet");
    const custody = await generateKeyPairSigner();
    await seedCustodyWallet("org_other_custody", "prj_other_custody", custody.address);
    await expect(service.registerWallet(scope, custody.address)).rejects.toThrow(
      /custody wallet of this project/
    );
    expect(register).not.toHaveBeenCalled();
    expect(await repo.findByWallet(scope, custody.address)).toBeNull();
  });
  it("accepts a connection-owned custody wallet of the same project as the binding", async () => {
    await linkBusiness();
    await activeBusiness();
    const register = vi.spyOn(provider, "registerSolanaWallet").mockResolvedValue({});
    // Connection (BYOK) wallets share custody_wallets but hang off a custody
    // connection, which no config lookup joins: the binding must see them too.
    const connection = await generateKeyPairSigner();
    await seedConnectionWallet(scope.projectId, connection.address);
    await expect(service.registerWallet(scope, connection.address)).resolves.toMatchObject({
      counterpartyId: scope.counterpartyId,
      owner: connection.address,
      registered: true,
    });
    expect(register).toHaveBeenCalledWith(runtime, childGuid, connection.address);
  });
  it("accepts no binding from a connection that is not active", async () => {
    await linkBusiness();
    await activeBusiness();
    const register = vi.spyOn(provider, "registerSolanaWallet");
    const connection = await generateKeyPairSigner();
    await seedConnectionWallet(scope.projectId, connection.address, "pending");
    await expect(service.registerWallet(scope, connection.address)).rejects.toThrow(
      /custody wallet of this project/
    );
    expect(register).not.toHaveBeenCalled();
    expect(await repo.findByWallet(scope, connection.address)).toBeNull();
  });
  it("still demands proof from an unbound address, claiming nothing", async () => {
    await linkBusiness();
    await activeBusiness();
    const register = vi.spyOn(provider, "registerSolanaWallet");
    const wallet = await generateKeyPairSigner();
    await expect(service.registerWallet(scope, wallet.address)).rejects.toThrow(
      /custody wallet of this project/
    );
    expect(register).not.toHaveBeenCalled();
    expect(await repo.findByWallet(scope, wallet.address)).toBeNull();
  });
  it("claims a wallet once, then passes only its stored child context to admission", async () => {
    await linkBusiness();
    await activeBusiness();
    vi.spyOn(provider, "registerSolanaWallet").mockResolvedValue({});
    const { owner, signature } = await controlledWallet();
    await service.registerWallet(scope, owner, signature);
    await expect(service.registerWallet(scope, owner, signature)).rejects.toThrow(
      /already claimed/
    );
    expect(provider.registerSolanaWallet).toHaveBeenCalledTimes(1);
    const earn = new WisdomTreeEarnClient();
    const check = vi.spyOn(earn, "checkDepositEligibility").mockResolvedValue({ eligible: true });
    await assertVaultDepositEligible(
      earn,
      runtime,
      { providerReference: "fund", owner },
      { ...scope, database: env }
    );
    expect(check).toHaveBeenCalledWith(runtime, {
      providerReference: "fund",
      owner,
      customer: { moderatorReference: moderatorGuid, customerReference: childGuid },
    });
    expect(await repo.findByWallet({ ...scope, projectId: "other" }, owner)).toBeNull();
  });
  it("releases the shared address when WisdomTree rejects the registration", async () => {
    await linkBusiness();
    await activeBusiness();
    const register = vi.spyOn(provider, "registerSolanaWallet").mockResolvedValue({});
    register.mockRejectedValueOnce(new SdpEarnError("BAD_REQUEST", "wallet already registered"));
    const { owner, signature } = await controlledWallet();
    await expect(service.registerWallet(scope, owner, signature)).rejects.toThrow(
      "already registered"
    );
    // The address is globally unique per environment: an unverified claim must
    // not block the real owner, so another customer can win it after a reject.
    expect(await repo.claimWallet(sibling, owner)).toBe(true);
    await repo.releaseWallet(sibling, owner);
    await service.registerWallet(scope, owner, signature);
    expect(register).toHaveBeenCalledTimes(2);
  });
  it("keeps the claim for reconciliation when the registration outcome is unknown", async () => {
    await linkBusiness();
    await activeBusiness();
    vi.spyOn(provider, "registerSolanaWallet").mockRejectedValue(
      new SdpEarnError("PROVIDER_UNAVAILABLE", "timeout")
    );
    const { owner, signature } = await controlledWallet();
    await expect(service.registerWallet(scope, owner, signature)).rejects.toThrow("timeout");
    // A timeout may have registered the wallet: the claim stays so no other
    // provider write starts before an operator reconciles the outcome.
    await expect(service.registerWallet(scope, owner, signature)).rejects.toThrow(
      /already claimed/
    );
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
