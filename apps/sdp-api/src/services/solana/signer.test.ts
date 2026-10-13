import { SigningError } from "@sdp/custody/signing";
import { runInClusterScope } from "@sdp/rpc/scope";
import type { SdpEnvironment } from "@sdp/types";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getDb } from "@/db";
import type * as MoneyPathEvents from "@/runtime/money-path-events";
import { SigningService } from "@/services/domain/signing.service";
import { createOrgSignerForCustodyWallet } from "@/services/solana/signer";
import { env } from "@/test/helpers/env";
import { seedDefaultProjects } from "@/test/helpers/projects";
import { seedTestDatabase } from "@/test/mocks/db";

const logEvent = vi.hoisted(() => vi.fn<typeof MoneyPathEvents.logEvent>());
vi.mock("@/runtime/money-path-events", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/runtime/money-path-events")>()),
  logEvent,
}));

const ORGANIZATION_ID = "org_signer_scope_guard";
const OTHER_ORGANIZATION_ID = "org_signer_scope_guard_other";
const USER_ID = "usr_signer_scope_guard";
const PROJECT_IDS = {
  sandbox: "prj_signer_scope_guard_sandbox",
  production: "prj_signer_scope_guard_production",
} as const satisfies Record<SdpEnvironment, string>;
const OTHER_ORGANIZATION_PROJECT_IDS = {
  sandbox: "prj_signer_scope_guard_other_sandbox",
  production: "prj_signer_scope_guard_other_production",
} as const satisfies Record<SdpEnvironment, string>;
const CUSTODY_WALLET_ID = "cwlt_signer_scope_guard";
const WALLET_NOT_FOUND = new SigningError("Custody wallet not found", "WALLET_NOT_FOUND");

async function seedOrganization(
  organizationId: string,
  slug: string,
  projectIds: Record<SdpEnvironment, string>
): Promise<void> {
  await getDb(env).execute(
    `INSERT INTO organizations (id, name, slug, tier, status)
     VALUES (?, 'Signer Scope Guard', ?, 'individual', 'active')`,
    [organizationId, slug]
  );
  await seedDefaultProjects(getDb(env), {
    organizationId,
    createdBy: USER_ID,
    members: [],
    ids: projectIds,
  });
}

function scopeRefusals() {
  return logEvent.mock.calls.filter(
    ([, payload]) => payload.event === "sdp_api_custody_signer_scope_refused"
  );
}

describe("createOrgSignerForCustodyWallet cluster scope guard", () => {
  beforeEach(async () => {
    await seedTestDatabase(env);
    await getDb(env).execute(
      `INSERT INTO users (id, email, email_verified, status)
       VALUES (?, 'signer-scope-guard@example.com', 1, 'active')`,
      [USER_ID]
    );
    await seedOrganization(ORGANIZATION_ID, "signer-scope-guard", PROJECT_IDS);
    await seedOrganization(
      OTHER_ORGANIZATION_ID,
      "signer-scope-guard-other",
      OTHER_ORGANIZATION_PROJECT_IDS
    );
    logEvent.mockClear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("refuses another project's wallet in a request scope before any provider call", async () => {
    const resolveSigner = vi.spyOn(SigningService.prototype, "getTransactionSignerForWalletRecord");

    await expect(
      runInClusterScope({ projectId: PROJECT_IDS.sandbox, environment: "sandbox" }, () =>
        createOrgSignerForCustodyWallet(
          env,
          ORGANIZATION_ID,
          PROJECT_IDS.production,
          CUSTODY_WALLET_ID
        )
      )
    ).rejects.toEqual(WALLET_NOT_FOUND);

    expect(resolveSigner).not.toHaveBeenCalled();
    expect(scopeRefusals()).toEqual([
      [
        "warn",
        {
          event: "sdp_api_custody_signer_scope_refused",
          organization_id: ORGANIZATION_ID,
          project_id: PROJECT_IDS.production,
          custody_wallet_id: CUSTODY_WALLET_ID,
          reason: "project_mismatch",
          scope_project_id: PROJECT_IDS.sandbox,
          scope_environment: "sandbox",
          wallet_environment: null,
        },
      ],
    ]);
  });

  it("refuses a wallet whose project is in the other environment in a job scope", async () => {
    const resolveSigner = vi.spyOn(SigningService.prototype, "getTransactionSignerForWalletRecord");

    await expect(
      runInClusterScope({ projectId: null, environment: "sandbox" }, () =>
        createOrgSignerForCustodyWallet(
          env,
          ORGANIZATION_ID,
          PROJECT_IDS.production,
          CUSTODY_WALLET_ID
        )
      )
    ).rejects.toEqual(WALLET_NOT_FOUND);

    expect(resolveSigner).not.toHaveBeenCalled();
    expect(scopeRefusals()).toEqual([
      [
        "warn",
        {
          event: "sdp_api_custody_signer_scope_refused",
          organization_id: ORGANIZATION_ID,
          project_id: PROJECT_IDS.production,
          custody_wallet_id: CUSTODY_WALLET_ID,
          reason: "environment_mismatch",
          scope_project_id: null,
          scope_environment: "sandbox",
          wallet_environment: "production",
        },
      ],
    ]);
  });

  it("refuses a wallet whose project belongs to another organization in a job scope", async () => {
    const resolveSigner = vi.spyOn(SigningService.prototype, "getTransactionSignerForWalletRecord");

    await expect(
      runInClusterScope({ projectId: null, environment: "sandbox" }, () =>
        createOrgSignerForCustodyWallet(
          env,
          ORGANIZATION_ID,
          OTHER_ORGANIZATION_PROJECT_IDS.sandbox,
          CUSTODY_WALLET_ID
        )
      )
    ).rejects.toEqual(WALLET_NOT_FOUND);

    expect(resolveSigner).not.toHaveBeenCalled();
    expect(scopeRefusals()).toEqual([
      [
        "warn",
        {
          event: "sdp_api_custody_signer_scope_refused",
          organization_id: ORGANIZATION_ID,
          project_id: OTHER_ORGANIZATION_PROJECT_IDS.sandbox,
          custody_wallet_id: CUSTODY_WALLET_ID,
          reason: "project_not_found",
          scope_project_id: null,
          scope_environment: "sandbox",
          wallet_environment: null,
        },
      ],
    ]);
  });
});
