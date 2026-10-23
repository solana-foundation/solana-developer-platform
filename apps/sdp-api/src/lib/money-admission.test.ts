import { MOVEMENTS, type MovementId } from "@sdp/types/movements";
import { type MemberStatus, ORGANIZATION_STATUSES } from "@sdp/types/organizations";
import type { ProjectEnvironment } from "@sdp/types/projects";
import type { LegacyOrganizationRole } from "@sdp/types/roles";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getDb } from "@/db/client";
import { runWithSystemDatabaseIdentity, runWithTenantDatabaseIdentity } from "@/db/identity";
import {
  assertCallerWalletInScope,
  assertMoneyStartAdmitted,
  decideMoneyStart,
  decideMovement,
  decidePrincipal,
  type MoneyAdmissionFacts,
  type MoneyAdmissionRefused,
  MoneyMovementRefusedError,
  type MoneyPrincipalFacts,
  readMoneyAdmissionFacts,
} from "@/lib/money-admission";
import { type MoneyPrincipal, runAsMoneyPrincipal } from "@/lib/money-principal";
import * as moneyPathEvents from "@/runtime/money-path-events";
import { TEST_ORG, TEST_USER } from "@/test/fixtures/organizations";
import { TEST_PRODUCTION_PROJECT, TEST_PROJECT } from "@/test/fixtures/tokens";
import { env } from "@/test/helpers/env";
import { LIVE_KEY_PRINCIPAL_FACTS } from "@/test/helpers/money-admission";
import { seedDefaultProjects } from "@/test/helpers/projects";
import { seedTestDatabase } from "@/test/mocks/db";

const ENTITLED = JSON.stringify({ enableProductionProject: true });

function facts(overrides: Partial<MoneyAdmissionFacts> = {}): MoneyAdmissionFacts {
  return {
    organizationStatus: "active",
    projectEnvironment: "production",
    rawSettings: ENTITLED,
    principal: LIVE_KEY_PRINCIPAL_FACTS,
    readAt: Date.now(),
    ...overrides,
  };
}

const NO_WALLET = { custodyWalletId: null } as const;

describe("decideMoneyStart", () => {
  it.each<[string, Partial<MoneyAdmissionFacts>]>([
    ["an entitled production project", {}],
    [
      "a sandbox project without the entitlement",
      { projectEnvironment: "sandbox", rawSettings: null },
    ],
  ])("admits %s of an active organization", (_label, overrides) => {
    expect(decideMoneyStart(facts(overrides))).toEqual({ admitted: true });
  });

  it.each<[string, string | null]>([
    ["no settings", null],
    ["the entitlement off", JSON.stringify({ enableProductionProject: false })],
    ["other settings only", JSON.stringify({ defaultEnvironment: "production" })],
  ])("refuses a production project with %s", (_label, rawSettings) => {
    expect(decideMoneyStart(facts({ rawSettings }))).toEqual({
      admitted: false,
      reason: "production_not_enabled",
    });
  });

  it.each(
    ORGANIZATION_STATUSES.filter((status) => status !== "active").flatMap((status) =>
      (["sandbox", "production"] as const satisfies readonly ProjectEnvironment[]).map(
        (projectEnvironment) => [status, projectEnvironment] as const
      )
    )
  )("refuses a %s organization's %s project", (organizationStatus, projectEnvironment) => {
    expect(decideMoneyStart(facts({ organizationStatus, projectEnvironment }))).toEqual({
      admitted: false,
      reason: "organization_inactive",
    });
  });

  it("refuses an organization status it does not know", () => {
    expect(decideMoneyStart(facts({ organizationStatus: "archived" }))).toEqual({
      admitted: false,
      reason: "organization_inactive",
    });
  });

  it("refuses a project that is not in the organization", () => {
    expect(decideMoneyStart(null)).toEqual({ admitted: false, reason: "project_not_found" });
  });

  it("fails closed on settings that do not parse, and only where it reads them", () => {
    expect(() => decideMoneyStart(facts({ rawSettings: "{not json" }))).toThrow();
    expect(
      decideMoneyStart(facts({ projectEnvironment: "sandbox", rawSettings: "{not json" }))
    ).toEqual({ admitted: true });
  });
});

// Jobs and `/pay` read under the system identity (cron/runner.ts,
// middleware/database-identity.ts); the reads here do too.
const asSystem = <T>(read: () => Promise<T>) =>
  runWithSystemDatabaseIdentity("test:money-admission", read);

describe("MOVEMENTS exits", () => {
  // SECURITY REVIEW GATE: an exit is never refused for the organization, only
  // for its credential, so this list changes only with a named security
  // reviewer (see packages/sdp-types/src/movements.ts).
  it("exempts exactly the reviewed exits from admission", () => {
    const exits = (Object.keys(MOVEMENTS) as MovementId[])
      .filter((movement) => MOVEMENTS[movement].kind === "exit")
      .sort();
    expect(exits).toEqual([
      "dvp.cancel",
      "dvp.reclaim",
      "earn.queued_withdraw_request",
      "earn.withdraw",
      "helius_rings.gateway_transaction",
      "helius_rings.key_derivation",
      "helius_rings.operation_exit",
      "issuance.control",
      "private_channels.withdraw",
      "recurring.cancel",
      "recurring.revoke_authority",
      "recurring.update_cancel_old",
    ]);
  });
});

describe("decideMovement", () => {
  const cases: [string, MoneyAdmissionFacts | null][] = [
    ["a deleted organization", facts({ organizationStatus: "deleted" })],
    ["a suspended organization", facts({ organizationStatus: "suspended" })],
    ["a production project without the entitlement", facts({ rawSettings: null })],
    ["a project it cannot find", null],
    ["an active, entitled organization", facts()],
  ];

  it.each(
    (Object.keys(MOVEMENTS) as MovementId[]).flatMap((movement) =>
      cases.map(([label, subject]) => [movement, label, subject] as const)
    )
  )("decides %s for %s", (movement, _label, subject) => {
    // An exit never depends on the organization (ADR 0002) and these facts
    // carry a live principal; a start is exactly the start decision.
    expect(decideMovement(movement, subject, NO_WALLET)).toEqual(
      MOVEMENTS[movement].kind === "exit" ? { admitted: true } : decideMoneyStart(subject)
    );
  });
});

const PRODUCTION_KEY_ID = "key_money_admission_production";
const PRODUCTION_KEY: MoneyPrincipal = { kind: "api_key", apiKeyId: PRODUCTION_KEY_ID };

async function seedProductionKey(
  overrides: { grants?: readonly string[]; walletScope?: "all" | "selected" } = {}
): Promise<void> {
  await getDb(env)
    .prepare(
      `INSERT INTO api_keys (id, organization_id, project_id, created_by, name, key_prefix,
                             key_hash, grants, wallet_scope, status)
       VALUES (?, ?, ?, ?, 'Money admission key', 'sk_live', ?, ?, ?, 'active')
       ON CONFLICT (id) DO UPDATE SET grants = EXCLUDED.grants,
                                      wallet_scope = EXCLUDED.wallet_scope`
    )
    .bind(
      PRODUCTION_KEY_ID,
      TEST_ORG.id,
      TEST_PRODUCTION_PROJECT.id,
      TEST_USER.id,
      `hash_${PRODUCTION_KEY_ID}`,
      [...(overrides.grants ?? ["recurring.execute"])],
      overrides.walletScope ?? "all"
    )
    .run();
}

describe("money admission reads", () => {
  beforeEach(async () => {
    await seedTestDatabase(env);
    const db = getDb(env);
    await db.batch([
      db
        .prepare("INSERT INTO organizations (id, name, slug, tier, status) VALUES (?, ?, ?, ?, ?)")
        .bind(TEST_ORG.id, TEST_ORG.name, TEST_ORG.slug, TEST_ORG.tier, TEST_ORG.status),
      db
        .prepare("INSERT INTO users (id, email, email_verified, status) VALUES (?, ?, 1, 'active')")
        .bind(TEST_USER.id, TEST_USER.email),
    ]);
    await seedDefaultProjects(db, {
      organizationId: TEST_ORG.id,
      createdBy: TEST_USER.id,
      members: [TEST_USER.id],
      ids: { sandbox: TEST_PROJECT.id, production: TEST_PRODUCTION_PROJECT.id },
    });
  });

  it("reads the project's environment and its organization's status and settings in one join", async () => {
    await expect(
      asSystem(() =>
        readMoneyAdmissionFacts(
          env,
          { organizationId: TEST_ORG.id, projectId: TEST_PROJECT.id },
          NO_WALLET
        )
      )
    ).resolves.toMatchObject({ organizationStatus: "active", projectEnvironment: "sandbox" });
    await expect(
      asSystem(() =>
        readMoneyAdmissionFacts(
          env,
          { organizationId: "org_other", projectId: TEST_PROJECT.id },
          NO_WALLET
        )
      )
    ).resolves.toBeNull();
  });

  it("refuses a deleted organization on the next movement, uncached", async () => {
    const scope = { organizationId: TEST_ORG.id, projectId: TEST_PRODUCTION_PROJECT.id };
    const context = {
      surface: "job",
      movement: "recurring.collect",
      subjectId: "prp_test",
    } as const;
    await getDb(env)
      .prepare("UPDATE organizations SET status = 'deleted' WHERE id = ?")
      .bind(TEST_ORG.id)
      .run();

    const refusal = await asSystem(() =>
      assertMoneyStartAdmitted(env, scope, context, NO_WALLET)
    ).catch((error: unknown) => error);

    expect(refusal).toBeInstanceOf(MoneyMovementRefusedError);
    expect(refusal).toMatchObject({
      code: "FORBIDDEN",
      reason: "organization_inactive",
      message: "Organization is not active",
    });
  });

  it("refuses a production project on the next movement once its organization loses production access, uncached", async () => {
    const scope = { organizationId: TEST_ORG.id, projectId: TEST_PRODUCTION_PROJECT.id };
    const context = {
      surface: "job",
      movement: "recurring.collect",
      subjectId: "prp_test",
    } as const;
    const setSettings = (settings: string) =>
      getDb(env)
        .prepare("UPDATE organizations SET settings = ? WHERE id = ?")
        .bind(settings, TEST_ORG.id)
        .run();

    await setSettings(ENTITLED);
    await seedProductionKey();
    await expect(
      asSystem(() =>
        runAsMoneyPrincipal(PRODUCTION_KEY, () =>
          assertMoneyStartAdmitted(env, scope, context, NO_WALLET)
        )
      )
    ).resolves.toBeUndefined();

    await setSettings(JSON.stringify({}));
    const refusal = await asSystem(() =>
      assertMoneyStartAdmitted(env, scope, context, NO_WALLET)
    ).catch((error: unknown) => error);

    expect(refusal).toBeInstanceOf(MoneyMovementRefusedError);
    expect(refusal).toMatchObject({
      code: "FORBIDDEN",
      reason: "production_not_enabled",
      message: "Production is not enabled for this organization",
    });
    // The sandbox project needs no entitlement; it still needs a principal.
    await expect(
      asSystem(() =>
        assertMoneyStartAdmitted(
          env,
          { organizationId: TEST_ORG.id, projectId: TEST_PROJECT.id },
          context,
          NO_WALLET
        )
      )
    ).rejects.toMatchObject({ reason: "principal_missing" });
  });
});

describe("MOVEMENTS starts", () => {
  // Each start names the actions that may sign it (HOO-2099). The waist
  // refuses a principal holding none of them; this pins every pairing.
  it("name the actions that sign them", () => {
    const actions = Object.fromEntries(
      Object.entries(MOVEMENTS).flatMap(([movement, definition]) =>
        definition.kind === "start" ? [[movement, [...definition.actions]]] : []
      )
    );
    expect(actions).toEqual({
      "custody.signer_check": ["wallets.execute"],
      "payments.transfer": ["transfers.execute"],
      "payments.transfer_batch": ["transfer_batches.execute"],
      "payments.pay_request": ["payment_requests.manage"],
      "ramps.onramp_quote": ["onramp.execute"],
      "ramps.offramp_quote": ["offramp.execute"],
      "recurring.activate": ["recurring.execute"],
      "recurring.update": ["recurring.execute"],
      "recurring.collect": ["recurring.execute"],
      "recurring.resume": ["recurring.execute"],
      "issuance.authority": [
        "issuance.manage",
        "issuance.execute",
        "issuance.enforce",
        "issuance.authority",
      ],
      "issuance.seize": ["issuance.enforce"],
      "dvp.create": ["dvp.manage"],
      "dvp.fund": ["dvp.execute"],
      "dvp.settle": ["dvp.execute"],
      "earn.deposit": ["earn.execute"],
      "earn.queued_withdraw_cancel": ["earn.manage"],
      "private_channels.session": ["private_channels.execute"],
      "private_channels.deposit": ["private_channels.execute"],
      "private_channels.transfer": ["private_channels.execute"],
      "helius_rings.operation_start": ["helius_rings.execute"],
      "helius_rings.bring_up": ["helius_rings.manage", "helius_rings.execute"],
    });
  });
});

describe("decidePrincipal", () => {
  const WALLET = { custodyWalletId: "cwlt_signing" } as const;
  const readAt = Date.parse("2026-10-14T00:00:00.000Z");
  const liveKey = (
    key: Partial<NonNullable<Extract<MoneyPrincipalFacts, { kind: "api_key" }>["key"]>> = {}
  ): MoneyPrincipalFacts => ({
    kind: "api_key",
    key: {
      status: "active",
      expires_at: null,
      rotation_deadline: null,
      grants: ["transfers.execute"],
      walletScope: "all",
      walletListed: true,
      ...key,
    },
  });
  const decide = (
    principal: MoneyPrincipalFacts,
    subject: { custodyWalletId: string | null } = WALLET,
    movement: MovementId = "payments.transfer"
  ) => decidePrincipal(movement, { principal, readAt }, subject);

  it("refuses a start with no principal", () => {
    expect(decide({ kind: "none" })).toEqual({ admitted: false, reason: "principal_missing" });
  });

  // An exit is decided by its credential alone (HOO-2099): no action, and a
  // reconciler with no principal still finishes a payout.
  it("admits an exit with no principal", () => {
    expect(decide({ kind: "none" }, WALLET, "private_channels.withdraw")).toEqual({
      admitted: true,
    });
  });

  it("admits an exit by a live key in scope that holds no start action", () => {
    expect(decide(liveKey({ grants: [] }), WALLET, "private_channels.withdraw")).toEqual({
      admitted: true,
    });
  });

  it.each<[string, MoneyPrincipalFacts, string]>([
    ["a revoked key", liveKey({ status: "deactivated" }), "principal_not_live"],
    [
      "a key whose scope leaves the wallet out",
      liveKey({ walletScope: "selected", walletListed: false }),
      "wallet_out_of_scope",
    ],
    [
      "a mandate for another wallet",
      { kind: "mandate", mandate: { status: "canceling", sourceCustodyWalletId: "cwlt_other" } },
      "wallet_out_of_scope",
    ],
  ])("refuses an exit by %s", (_label, principal, reason) => {
    expect(decide(principal, WALLET, "private_channels.withdraw")).toEqual({
      admitted: false,
      reason,
    });
  });

  it("admits a mandate's own exit in any status", () => {
    expect(
      decide(
        {
          kind: "mandate",
          mandate: { status: "canceling", sourceCustodyWalletId: "cwlt_signing" },
        },
        WALLET,
        "recurring.cancel"
      )
    ).toEqual({ admitted: true });
  });

  it("admits a live key that holds the action", () => {
    expect(decide(liveKey())).toEqual({ admitted: true });
  });

  it.each<[string, Partial<Extract<MoneyPrincipalFacts, { kind: "api_key" }>["key"] & object>]>([
    ["revoked", { status: "deactivated" }],
    ["expired", { expires_at: "2026-10-13T00:00:00.000Z" }],
    ["past its rotation deadline", { rotation_deadline: "2026-10-13T00:00:00.000Z" }],
  ])("refuses a %s key", (_label, key) => {
    expect(decide(liveKey(key))).toEqual({ admitted: false, reason: "principal_not_live" });
  });

  it("refuses a key that is not in the project", () => {
    expect(decide({ kind: "api_key", key: null })).toEqual({
      admitted: false,
      reason: "principal_not_live",
    });
  });

  it("refuses a key that does not hold the movement's action", () => {
    expect(decide(liveKey({ grants: ["transfers.read", "recurring.execute"] }))).toEqual({
      admitted: false,
      reason: "action_not_held",
      action: "transfers.execute",
    });
  });

  // One refusal shape for keys: a missing action reads like the route's own.
  it.each<[MoneyAdmissionRefused, Record<string, unknown>]>([
    [
      { admitted: false, reason: "action_not_held", action: "transfers.execute" },
      {
        code: "INSUFFICIENT_PERMISSIONS",
        statusCode: 403,
        reason: "action_not_held",
        details: { action: "transfers.execute" },
      },
    ],
    [
      { admitted: false, reason: "wallet_out_of_scope" },
      { code: "FORBIDDEN", statusCode: 403, details: { reason: "wallet_out_of_scope" } },
    ],
  ])("turns %o into its error", (decision, error) => {
    const refusal = MoneyMovementRefusedError.of(decision);
    expect(refusal).toMatchObject(error);
    expect(refusal.details).toEqual(error.details);
  });

  it("scopes a selected key to its listed wallets, and never widens an empty list", () => {
    expect(decide(liveKey({ walletScope: "selected", walletListed: true }))).toEqual({
      admitted: true,
    });
    expect(decide(liveKey({ walletScope: "selected", walletListed: false }))).toEqual({
      admitted: false,
      reason: "wallet_out_of_scope",
    });
    // A sponsor signature names no custody wallet: the custody signer scopes it.
    expect(decide(liveKey({ walletScope: "selected", walletListed: null }), NO_WALLET)).toEqual({
      admitted: true,
    });
  });

  const member = (
    status: MemberStatus,
    role: LegacyOrganizationRole,
    inProject: boolean
  ): MoneyPrincipalFacts => ({
    kind: "member",
    member: { status, role, inProject },
  });

  it("admits an active member whose role holds the action, and refuses one who left", () => {
    expect(decide(member("active", "member", true))).toEqual({ admitted: true });
    expect(decide(member("removed", "admin", true))).toEqual({
      admitted: false,
      reason: "principal_not_live",
    });
    expect(decide(member("active", "member", true), WALLET, "issuance.seize")).toEqual({
      admitted: false,
      reason: "action_not_held",
      action: "issuance.enforce",
    });
  });

  // SOLA9-790: ingress admits a dashboard member to a project by their
  // `project_members` row; one removed from the project since starts nothing
  // there, whatever their organization role, and still unwinds.
  it.each(["member", "admin", "owner"] as const satisfies readonly LegacyOrganizationRole[])(
    "refuses a start by an active %s no longer in the project",
    (role) => {
      expect(decide(member("active", role, false))).toEqual({
        admitted: false,
        reason: "principal_not_live",
      });
      expect(decide(member("active", role, false), NO_WALLET, "payments.transfer")).toEqual({
        admitted: false,
        reason: "principal_not_live",
      });
    }
  );

  it("admits an exit by a live member no longer in the project", () => {
    expect(decide(member("active", "member", false), WALLET, "private_channels.withdraw")).toEqual({
      admitted: true,
    });
  });

  it("admits a mandate only for its own movement, status and source wallet", () => {
    const mandate = (status: string): MoneyPrincipalFacts => ({
      kind: "mandate",
      mandate: { status, sourceCustodyWalletId: WALLET.custodyWalletId },
    });
    expect(decide(mandate("active"), WALLET, "recurring.collect")).toEqual({ admitted: true });
    expect(decide(mandate("canceled"), WALLET, "recurring.collect")).toEqual({
      admitted: false,
      reason: "principal_not_live",
    });
    expect(decide(mandate("active"), WALLET, "payments.transfer")).toEqual({
      admitted: false,
      reason: "principal_not_live",
    });
    expect(
      decide(mandate("active"), { custodyWalletId: "cwlt_other" }, "recurring.collect")
    ).toEqual({ admitted: false, reason: "wallet_out_of_scope" });
    expect(decide(mandate("activating"), WALLET, "recurring.activate")).toEqual({
      admitted: true,
    });
  });

  it("admits a payment link only for its open request's sponsorship", () => {
    const link = (status: string, expiresAt: string | null): MoneyPrincipalFacts => ({
      kind: "payment_request",
      request: { status, expiresAt },
    });
    expect(decide(link("awaiting_payment", null), NO_WALLET, "payments.pay_request")).toEqual({
      admitted: true,
    });
    expect(decide(link("paid", null), NO_WALLET, "payments.pay_request")).toEqual({
      admitted: false,
      reason: "principal_not_live",
    });
    expect(decide(link("awaiting_payment", null), WALLET, "payments.pay_request")).toEqual({
      admitted: false,
      reason: "wallet_out_of_scope",
    });
  });

  it("refuses a payment link's sponsorship once the request is past its deadline", () => {
    const link = (expiresAt: string): MoneyPrincipalFacts => ({
      kind: "payment_request",
      request: { status: "awaiting_payment", expiresAt },
    });
    expect(
      decide(link(new Date(readAt + 1_000).toISOString()), NO_WALLET, "payments.pay_request")
    ).toEqual({ admitted: true });
    expect(decide(link(new Date(readAt).toISOString()), NO_WALLET, "payments.pay_request")).toEqual(
      { admitted: false, reason: "principal_not_live" }
    );
  });
});

describe("money admission reads the principal in the same statement", () => {
  beforeEach(async () => {
    await seedTestDatabase(env);
    const db = getDb(env);
    await db.batch([
      db
        .prepare("INSERT INTO organizations (id, name, slug, tier, status) VALUES (?, ?, ?, ?, ?)")
        .bind(TEST_ORG.id, TEST_ORG.name, TEST_ORG.slug, TEST_ORG.tier, TEST_ORG.status),
      db
        .prepare("INSERT INTO users (id, email, email_verified, status) VALUES (?, ?, 1, 'active')")
        .bind(TEST_USER.id, TEST_USER.email),
    ]);
    await seedDefaultProjects(db, {
      organizationId: TEST_ORG.id,
      createdBy: TEST_USER.id,
      members: [TEST_USER.id],
      ids: { sandbox: TEST_PROJECT.id, production: TEST_PRODUCTION_PROJECT.id },
    });
  });

  const scope = { organizationId: TEST_ORG.id, projectId: TEST_PRODUCTION_PROJECT.id };

  it("reads a key's live row, grants and wallet listing", async () => {
    await seedProductionKey({ walletScope: "selected" });
    const read = await asSystem(() =>
      runAsMoneyPrincipal(PRODUCTION_KEY, () =>
        readMoneyAdmissionFacts(env, scope, { custodyWalletId: "cwlt_not_listed" })
      )
    );
    expect(read?.principal).toEqual({
      kind: "api_key",
      key: {
        status: "active",
        expires_at: null,
        rotation_deadline: null,
        grants: ["recurring.execute"],
        walletScope: "selected",
        walletListed: false,
      },
    });
  });

  it("refuses a key's next start once it is revoked, uncached", async () => {
    await seedProductionKey();
    await getDb(env)
      .prepare("UPDATE organizations SET settings = ? WHERE id = ?")
      .bind(ENTITLED, TEST_ORG.id)
      .run();
    const start = () =>
      asSystem(() =>
        runAsMoneyPrincipal(PRODUCTION_KEY, () =>
          assertMoneyStartAdmitted(
            env,
            scope,
            { surface: "http", movement: "recurring.collect", subjectId: "prp_test" },
            NO_WALLET
          )
        )
      );
    await expect(start()).resolves.toBeUndefined();
    await getDb(env)
      .prepare("UPDATE api_keys SET status = 'deactivated' WHERE id = ?")
      .bind(PRODUCTION_KEY_ID)
      .run();
    await expect(start()).rejects.toMatchObject({
      code: "FORBIDDEN",
      reason: "principal_not_live",
    });
  });

  // SOLA9-790: the same statement proves the member still belongs to the
  // project, read under the tenant identity a signed-in request signs with.
  it("refuses a member's next start once they are removed from the project, uncached", async () => {
    const db = getDb(env);
    await db
      .prepare(
        `INSERT INTO organization_members (id, organization_id, user_id, role, status)
         VALUES (?, ?, ?, 'owner', 'active') ON CONFLICT DO NOTHING`
      )
      .bind("om_money_admission", TEST_ORG.id, TEST_USER.id)
      .run();
    const sandbox = { organizationId: TEST_ORG.id, projectId: TEST_PROJECT.id };
    const asMember = <T>(fn: () => Promise<T>) =>
      runWithTenantDatabaseIdentity({ organizationId: TEST_ORG.id }, () =>
        runAsMoneyPrincipal({ kind: "member", userId: TEST_USER.id }, fn)
      );
    const start = (movement: MovementId) =>
      asMember(() =>
        assertMoneyStartAdmitted(
          env,
          sandbox,
          { surface: "http", movement, subjectId: "tr_test" },
          NO_WALLET
        )
      );

    await expect(
      asMember(() => readMoneyAdmissionFacts(env, sandbox, NO_WALLET))
    ).resolves.toMatchObject({
      principal: { kind: "member", member: { status: "active", role: "owner", inProject: true } },
    });
    await expect(start("payments.transfer")).resolves.toBeUndefined();

    await db
      .prepare("DELETE FROM project_members WHERE project_id = ? AND user_id = ?")
      .bind(TEST_PROJECT.id, TEST_USER.id)
      .run();
    await expect(start("payments.transfer")).rejects.toMatchObject({
      code: "FORBIDDEN",
      reason: "principal_not_live",
    });
    // Still in the organization: an exit unwinds.
    await expect(
      asMember(async () =>
        decideMovement(
          "private_channels.withdraw",
          await readMoneyAdmissionFacts(env, sandbox, NO_WALLET),
          NO_WALLET
        )
      )
    ).resolves.toEqual({ admitted: true });
  });

  it("finds no key of another project", async () => {
    await seedProductionKey();
    const read = await asSystem(() =>
      runAsMoneyPrincipal(PRODUCTION_KEY, () =>
        readMoneyAdmissionFacts(
          env,
          { organizationId: TEST_ORG.id, projectId: TEST_PROJECT.id },
          NO_WALLET
        )
      )
    );
    expect(read?.principal).toEqual({ kind: "api_key", key: null });
  });
});

describe("assertCallerWalletInScope", () => {
  const caller = {
    organizationId: "org_early",
    projectId: "prj_early",
    walletAccess: { scope: "selected", custodyWalletIds: ["cwlt_listed"] },
  } as const;

  it("admits a listed wallet and logs nothing", () => {
    const events = vi.spyOn(moneyPathEvents, "logEvent").mockImplementation(() => {});
    expect(() => assertCallerWalletInScope(caller, "cwlt_listed")).not.toThrow();
    expect(events).not.toHaveBeenCalled();
    events.mockRestore();
  });

  // Zach (#2434): early refusals skipped the waist's event.
  it("logs the waist's refusal event when it refuses early", () => {
    const events = vi.spyOn(moneyPathEvents, "logEvent").mockImplementation(() => {});
    const refusal = (() => {
      try {
        runAsMoneyPrincipal({ kind: "api_key", apiKeyId: "key_early" }, () =>
          assertCallerWalletInScope(caller, "cwlt_other")
        );
      } catch (error) {
        return error;
      }
      return null;
    })();

    expect(refusal).toBeInstanceOf(MoneyMovementRefusedError);
    expect(events).toHaveBeenCalledWith("warn", {
      event: "sdp_money_refused",
      surface: "early",
      movement: null,
      module: null,
      subject_id: "cwlt_other",
      organization_id: "org_early",
      project_id: "prj_early",
      principal_kind: "api_key",
      principal: "api_key:key_early",
      reason: "wallet_out_of_scope",
    });
    events.mockRestore();
  });
});
