import type { OrganizationProviderOverrides } from "@sdp/types";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getDb } from "@/db";
import { getLogger } from "@/runtime/logger";
import {
  assertProjectProviderAdmitted,
  custodyProviderNotInReleaseChannel,
  type ProjectProviderRequest,
} from "@/services/provider-availability.service";
import { custodyReleaseChannel } from "@/test/helpers/custody-release-channel";
import { env } from "@/test/helpers/env";
import {
  type SeededDefaultProjects,
  type SeededProject,
  seedDefaultProjects,
} from "@/test/helpers/projects";
import { providerStages } from "@/test/helpers/provider-stages";
import { seedTestDatabase } from "@/test/mocks/db";
import type { Env } from "@/types/env";

vi.mock("@sdp/types/release-channels", async (importOriginal) => {
  const { mockCustodyReleaseChannels } = await import("@/test/helpers/custody-release-channel");
  return mockCustodyReleaseChannels(
    await importOriginal<typeof import("@sdp/types/release-channels")>()
  );
});

vi.mock("@sdp/types", async (importOriginal) => {
  const { mockProviderStages } = await import("@/test/helpers/provider-stages");
  return mockProviderStages(await importOriginal<typeof import("@sdp/types")>());
});

const ORGANIZATION_ID = "org_project_provider_rule";
const USER_ID = "usr_project_provider_rule";
const BETA_CHANNEL = { SDP_RELEASE_CHANNEL: "beta" } as const satisfies Partial<Env>;
const PRIVY_CREDENTIALS = {
  PRIVY_APP_ID: "privy_project_provider_rule_app",
  PRIVY_APP_SECRET: "privy_project_provider_rule_secret",
} as const satisfies Partial<Env>;
const MOONPAY_PRODUCTION_CREDENTIALS = {
  MOONPAY_API_KEY: "moonpay_project_provider_rule_key",
  MOONPAY_SECRET_KEY: "moonpay_project_provider_rule_secret",
} as const satisfies Partial<Env>;
const MOONPAY_SANDBOX_CREDENTIALS = {
  MOONPAY_SANDBOX_API_KEY: "moonpay_sandbox_project_provider_rule_key",
  MOONPAY_SANDBOX_SECRET_KEY: "moonpay_sandbox_project_provider_rule_secret",
} as const satisfies Partial<Env>;
const MOONPAY: ProjectProviderRequest = { family: "ramps", provider: "moonpay" };
const RANGE: ProjectProviderRequest = { family: "compliance", provider: "range" };
const UPSHIFT: ProjectProviderRequest = { family: "earn", provider: "upshift" };
const MANAGED_PRIVY: ProjectProviderRequest = {
  family: "custody",
  provider: "privy",
  mode: "managed",
};
const BYOK_PRIVY: ProjectProviderRequest = { family: "custody", provider: "privy", mode: "byok" };

let projects: SeededDefaultProjects;

function deploymentEnv(overrides: Partial<Env>): Env {
  return { ...env, ...overrides };
}

function admit(
  project: SeededProject,
  deployment: Env,
  request: ProjectProviderRequest
): Promise<void> {
  return assertProjectProviderAdmitted(
    deployment,
    getDb(env),
    { organizationId: project.organizationId, projectId: project.id },
    request
  );
}

function refusal(message: string, reason: string) {
  return { code: "FORBIDDEN", statusCode: 403, message, details: { reason } };
}

function notConfigured(message: string) {
  return {
    code: "PROVIDER_NOT_CONFIGURED",
    statusCode: 503,
    message,
    details: { reason: "provider_not_configured" },
  };
}

async function setProviderOverrides(overrides: OrganizationProviderOverrides): Promise<void> {
  await getDb(env).execute("UPDATE organizations SET settings = ? WHERE id = ?", [
    JSON.stringify({ providerOverrides: overrides }),
    ORGANIZATION_ID,
  ]);
}

describe("assertProjectProviderAdmitted", () => {
  beforeEach(async () => {
    custodyReleaseChannel.outOfChannelMode = null;
    custodyReleaseChannel.stageOverride = null;
    providerStages.rampStageOverride = null;
    providerStages.moduleStageOverride = null;
    await seedTestDatabase(env);
    const db = getDb(env);
    await db.execute(
      `INSERT INTO organizations (id, name, slug, tier, status)
       VALUES (?, 'Project Provider Rule', 'project-provider-rule', 'individual', 'active')`,
      [ORGANIZATION_ID]
    );
    await db.execute(
      `INSERT INTO users (id, email, email_verified, status)
       VALUES (?, 'project-provider-rule@example.com', 1, 'active')`,
      [USER_ID]
    );
    projects = await seedDefaultProjects(db, {
      organizationId: ORGANIZATION_ID,
      createdBy: USER_ID,
      members: [],
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("checks a ramp provider's channel, stage, entitlement and credentials in that order", async () => {
    await setProviderOverrides({ ramps: { moonpay: false } });

    await expect(
      admit(projects.production, deploymentEnv(BETA_CHANNEL), MOONPAY)
    ).rejects.toMatchObject(
      refusal(
        "MoonPay is not available in this release channel.",
        "provider_not_in_release_channel"
      )
    );
    await expect(admit(projects.production, deploymentEnv({}), MOONPAY)).rejects.toMatchObject(
      refusal(
        "MoonPay is not stable yet, so a production project cannot use it.",
        "provider_stage_not_allowed"
      )
    );
    providerStages.rampStageOverride = { provider: "moonpay", stage: "stable" };
    await expect(admit(projects.production, deploymentEnv({}), MOONPAY)).rejects.toMatchObject(
      refusal("MoonPay requires manual activation for this organization.", "provider_not_entitled")
    );
    await setProviderOverrides({});
    await expect(
      admit(projects.production, deploymentEnv(MOONPAY_SANDBOX_CREDENTIALS), MOONPAY)
    ).rejects.toMatchObject(
      notConfigured("MoonPay is not configured for production projects in this deployment.")
    );
    await expect(
      admit(projects.production, deploymentEnv(MOONPAY_PRODUCTION_CREDENTIALS), MOONPAY)
    ).resolves.toBeUndefined();
  });

  it("requires a ramp provider's sandbox credentials in a Sandbox project", async () => {
    await expect(
      admit(projects.sandbox, deploymentEnv(MOONPAY_PRODUCTION_CREDENTIALS), MOONPAY)
    ).rejects.toMatchObject(
      notConfigured("MoonPay is not configured for sandbox projects in this deployment.")
    );
    await expect(
      admit(projects.sandbox, deploymentEnv(MOONPAY_SANDBOX_CREDENTIALS), MOONPAY)
    ).resolves.toBeUndefined();
  });

  it("checks a compliance provider's channel, stage, entitlement and credentials in that order", async () => {
    providerStages.moduleStageOverride = { module: "compliance", stage: "experimental" };

    await expect(
      admit(projects.production, deploymentEnv(BETA_CHANNEL), RANGE)
    ).rejects.toMatchObject(
      refusal("Range is not available in this release channel.", "provider_not_in_release_channel")
    );
    await expect(admit(projects.production, deploymentEnv({}), RANGE)).rejects.toMatchObject(
      refusal(
        "Range is not stable yet, so a production project cannot use it.",
        "provider_stage_not_allowed"
      )
    );
    providerStages.moduleStageOverride = null;
    await expect(admit(projects.production, deploymentEnv({}), RANGE)).rejects.toMatchObject(
      refusal("Range requires manual activation for this organization.", "provider_not_entitled")
    );
    await setProviderOverrides({ compliance: { range: true } });
    await expect(admit(projects.production, deploymentEnv({}), RANGE)).rejects.toMatchObject(
      notConfigured("Range is not configured for production projects in this deployment.")
    );
    await expect(
      admit(
        projects.production,
        deploymentEnv({ RANGE_API_KEY: "range_project_provider_rule_key" }),
        RANGE
      )
    ).resolves.toBeUndefined();
  });

  it("checks an Earn provider's channel, stage, entitlement and credentials in that order", async () => {
    await expect(
      admit(projects.production, deploymentEnv(BETA_CHANNEL), UPSHIFT)
    ).rejects.toMatchObject(
      refusal(
        "Upshift is not available in this release channel.",
        "provider_not_in_release_channel"
      )
    );
    await expect(admit(projects.production, deploymentEnv({}), UPSHIFT)).rejects.toMatchObject(
      refusal(
        "Upshift is not stable yet, so a production project cannot use it.",
        "provider_stage_not_allowed"
      )
    );
    providerStages.moduleStageOverride = { module: "earn", stage: "stable" };
    await expect(admit(projects.production, deploymentEnv({}), UPSHIFT)).rejects.toMatchObject(
      refusal("Upshift requires manual activation for this organization.", "provider_not_entitled")
    );
    await setProviderOverrides({ earn: { upshift: true } });
    await expect(
      admit(
        projects.production,
        deploymentEnv({ UPSHIFT_SANDBOX_API_KEY: "upshift_sandbox_project_provider_rule_key" }),
        UPSHIFT
      )
    ).rejects.toMatchObject(
      notConfigured("Upshift is not configured for production projects in this deployment.")
    );
    await expect(
      admit(
        projects.production,
        deploymentEnv({ UPSHIFT_API_KEY: "upshift_project_provider_rule_key" }),
        UPSHIFT
      )
    ).resolves.toBeUndefined();
  });

  it("checks Managed custody's channel, environment mode, entitlement and credentials in that order", async () => {
    custodyReleaseChannel.outOfChannelMode = "managed";
    await setProviderOverrides({ custody: { privy: false } });

    await expect(
      admit(projects.production, deploymentEnv({}), MANAGED_PRIVY)
    ).rejects.toMatchObject(
      refusal(
        custodyProviderNotInReleaseChannel("privy", "managed").message,
        "custody_provider_not_in_release_channel"
      )
    );
    custodyReleaseChannel.outOfChannelMode = null;
    await expect(
      admit(projects.production, deploymentEnv({}), MANAGED_PRIVY)
    ).rejects.toMatchObject(
      refusal(
        "Privy Managed custody is not allowed in a production project.",
        "custody_mode_not_allowed"
      )
    );
    await expect(admit(projects.sandbox, deploymentEnv({}), MANAGED_PRIVY)).rejects.toMatchObject(
      refusal("Privy requires manual activation for this organization.", "provider_not_entitled")
    );
    await setProviderOverrides({});
    await expect(admit(projects.sandbox, deploymentEnv({}), MANAGED_PRIVY)).rejects.toMatchObject(
      notConfigured("Privy is not configured for sandbox projects in this deployment.")
    );
    await expect(
      admit(projects.sandbox, deploymentEnv(PRIVY_CREDENTIALS), MANAGED_PRIVY)
    ).resolves.toBeUndefined();
  });

  it("checks BYOK custody's stage before entitlement and admits it without deployment credentials", async () => {
    custodyReleaseChannel.stageOverride = { provider: "privy", mode: "byok", stage: "beta" };
    await setProviderOverrides({ custody: { privy: false } });

    await expect(admit(projects.production, deploymentEnv({}), BYOK_PRIVY)).rejects.toMatchObject(
      refusal(
        "Privy BYOK custody is not stable yet, so a production project cannot use it.",
        "custody_mode_not_allowed"
      )
    );
    custodyReleaseChannel.stageOverride = null;
    await expect(admit(projects.production, deploymentEnv({}), BYOK_PRIVY)).rejects.toMatchObject(
      refusal("Privy requires manual activation for this organization.", "provider_not_entitled")
    );
    await setProviderOverrides({});
    await expect(
      admit(projects.production, deploymentEnv({}), BYOK_PRIVY)
    ).resolves.toBeUndefined();
  });

  it("refuses BYOK custody for a provider without a BYOK runtime as outside the release channel", async () => {
    await expect(
      admit(projects.sandbox, deploymentEnv({}), {
        family: "custody",
        provider: "turnkey",
        mode: "byok",
      })
    ).rejects.toMatchObject(
      refusal(
        custodyProviderNotInReleaseChannel("turnkey", "byok").message,
        "custody_provider_not_in_release_channel"
      )
    );
  });

  it("logs a refusal with the project, its environment, the request and the failed check", async () => {
    const logger = getLogger();
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => logger);

    await expect(
      admit(projects.production, deploymentEnv(PRIVY_CREDENTIALS), MANAGED_PRIVY)
    ).rejects.toMatchObject({ details: { reason: "custody_mode_not_allowed" } });

    expect(warn).toHaveBeenCalledExactlyOnceWith(
      {
        event: "sdp_api_project_provider_refused",
        organization_id: ORGANIZATION_ID,
        project_id: projects.production.id,
        environment: "production",
        family: "custody",
        provider: "privy",
        mode: "managed",
        reason: "custody_mode_not_allowed",
      },
      "sdp_api_project_provider_refused"
    );
  });

  it("returns 404 for a project outside the organization", async () => {
    await expect(
      assertProjectProviderAdmitted(
        deploymentEnv(MOONPAY_SANDBOX_CREDENTIALS),
        getDb(env),
        { organizationId: "org_project_provider_rule_other", projectId: projects.sandbox.id },
        MOONPAY
      )
    ).rejects.toMatchObject({ code: "NOT_FOUND", statusCode: 404, message: "Project not found" });
  });
});
