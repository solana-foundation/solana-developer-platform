import { RAMP_PROVIDER_CLIENTS } from "@sdp/payments/ramps";
import type { MuralCreateOrganizationRequest } from "@sdp/payments/ramps/providers/mural/client";
import { muralOnboardingRequirements } from "@sdp/payments/ramps/providers/mural/counterparty";
import {
  isMuralKycApproved,
  isMuralTosAccepted,
  type MuralAccountResolution,
  type MuralOrganizationResolution,
  type MuralPayinMethod,
  readMuralData,
  readMuralOrganization,
} from "@sdp/payments/ramps/providers/mural/provider-data";
import { readyCounterparty } from "@sdp/payments/ramps/requirements";
import { rampId } from "@sdp/payments/ramps/shared";
import type { MuralPaymentRampInstruction, PaymentRampQuote } from "@sdp/types";
import type { RampFiatCurrency } from "@sdp/types/generated/ramp-support";
import type { CounterpartyRequirements, RampDirection } from "@sdp/types/ramp-requirements";
import type { CounterpartyRow } from "@/db/repositories/counterparty.repository";
import { badRequest, counterpartyNotProvisioned } from "@/lib/errors";
import { getCounterpartiesRepository } from "@/routes/counterparties/context";
import { type AppContext, rampRuntime } from "../../context";

const MURAL_HOSTED_LINK_TTL_SECONDS = 12 * 60 * 60;

async function mintOrReuseMuralLink(
  c: AppContext,
  kind: "tos" | "kyc",
  organizationId: string,
  mint: () => Promise<string>
): Promise<string> {
  const cache = c.var.kv.cache;
  const cacheKey = `mural:${kind}-link:${organizationId}`;
  const cached = await cache.get(cacheKey);
  if (cached) {
    return cached;
  }
  const url = await mint();
  await cache.put(cacheKey, url, { expirationTtl: MURAL_HOSTED_LINK_TTL_SECONDS });
  return url;
}

function buildMuralOrgRequest(counterparty: CounterpartyRow): MuralCreateOrganizationRequest {
  const email = counterparty.email;
  if (counterparty.entity_type === "business") {
    return { type: "business", businessName: counterparty.display_name, email };
  }
  const { firstName, lastName } = counterparty.identity;
  if (!firstName || !lastName) {
    throw badRequest(
      "Mural individual organization requires the counterparty's first and last name."
    );
  }
  return { type: "individual", firstName, lastName, email };
}

/** Merges Mural organization state into `counterparty.provider_data.mural.organization`. */
async function persistMuralOrganization(
  c: AppContext,
  counterparty: CounterpartyRow,
  projectId: string,
  organization: MuralOrganizationResolution
): Promise<void> {
  const repo = getCounterpartiesRepository(c);
  const mural = readMuralData(counterparty.provider_data);
  await repo.updateCounterparty({
    counterpartyId: counterparty.id,
    organizationId: counterparty.organization_id,
    projectId,
    providerData: {
      ...counterparty.provider_data,
      mural: { ...mural, organization },
    },
  });
}

/**
 * Creates or refreshes the counterparty's Mural organization and returns the
 * transient hosted link required for the next onboarding step.
 */
export async function ensureMuralOrganization(
  c: AppContext,
  counterparty: CounterpartyRow,
  projectId: string
): Promise<MuralOrganizationResolution> {
  const ctx = rampRuntime(c);
  const client = RAMP_PROVIDER_CLIENTS.mural;
  let org = readMuralOrganization(counterparty.provider_data);

  if (!org.id) {
    org = await client.createOrganization(ctx, buildMuralOrgRequest(counterparty));
    await persistMuralOrganization(c, counterparty, projectId, org);
  } else if (!isMuralKycApproved(org.kycStatus)) {
    const latest = await client.getOrganization(ctx, org.id);
    const changed = latest.tosStatus !== org.tosStatus || latest.kycStatus !== org.kycStatus;
    org = latest;
    if (changed) {
      await persistMuralOrganization(c, counterparty, projectId, org);
    }
  }

  if (org.id && (org.kycStatus === undefined || org.kycStatus === "inactive")) {
    const organizationId = org.id;
    if (isMuralTosAccepted(org.tosStatus)) {
      return {
        ...org,
        kycLink: await mintOrReuseMuralLink(c, "kyc", organizationId, () =>
          client.getKycLink(ctx, organizationId)
        ),
      };
    }
    return {
      ...org,
      tosLink: await mintOrReuseMuralLink(c, "tos", organizationId, () =>
        client.getTosLink(ctx, organizationId)
      ),
    };
  }

  return org;
}

export async function resolveMuralOnrampAccount(
  c: AppContext,
  org: MuralOrganizationResolution
): Promise<MuralAccountResolution | null> {
  if (!org.id || !isMuralKycApproved(org.kycStatus)) {
    throw counterpartyNotProvisioned("mural", "onramp", { kycStatus: org.kycStatus });
  }
  const ctx = rampRuntime(c);
  const client = RAMP_PROVIDER_CLIENTS.mural;
  const accounts = await client.listAccounts(ctx, org.id);
  const active = accounts.find((entry) => entry.isApiEnabled && entry.status === "ACTIVE");
  if (active) {
    return active;
  }
  if (!accounts.some((entry) => entry.isApiEnabled)) {
    await client.createAccount(ctx, org.id, "SDP onramp");
  }
  return null;
}

export async function muralOnrampRequirements(
  c: AppContext,
  org: MuralOrganizationResolution
): Promise<CounterpartyRequirements> {
  const account = await resolveMuralOnrampAccount(c, org);
  if (account) {
    return readyCounterparty("mural", "onramp");
  }
  return { provider: "mural", direction: "onramp", status: "funding_account_provisioning" };
}

/**
 * Creates or refreshes the counterparty's Mural organization, then maps its
 * onboarding/KYC state to the requirements the client should act on next.
 */
export async function resolveMuralRequirements(
  c: AppContext,
  counterparty: CounterpartyRow,
  projectId: string,
  direction: RampDirection
): Promise<CounterpartyRequirements> {
  const organization = await ensureMuralOrganization(c, counterparty, projectId);
  if (direction === "onramp" && isMuralKycApproved(organization.kycStatus)) {
    return muralOnrampRequirements(c, organization);
  }
  return muralOnboardingRequirements(organization, direction);
}

function buildMuralPayinInstruction(method: MuralPayinMethod): MuralPaymentRampInstruction {
  const payinRailsValue = method.payinRailDetails.payinRails;
  const payinRailValue = method.payinRailDetails.payinRail;
  let payinRails: string[] = [];
  if (Array.isArray(payinRailsValue)) {
    payinRails = payinRailsValue.map(String);
  } else if (typeof payinRailValue === "string") {
    payinRails = [payinRailValue];
  }

  const bankDetails: Record<string, string> = {};
  for (const [key, value] of Object.entries(method.payinRailDetails)) {
    if (
      key !== "type" &&
      key !== "currency" &&
      key !== "payinRail" &&
      key !== "payinRails" &&
      typeof value === "string"
    ) {
      bankDetails[key] = value;
    }
  }
  return {
    provider: "mural",
    fiatCurrency: method.currency,
    payinRails,
    bankDetails,
  };
}

export function muralOnrampQuote(input: {
  account: MuralAccountResolution;
  fiatCurrency?: RampFiatCurrency;
}): PaymentRampQuote {
  if (!input.fiatCurrency) {
    throw badRequest("fiatCurrency is required for Mural on-ramp.");
  }
  const fiatCurrency = input.fiatCurrency;
  const method = input.account.payinMethods.find(
    (entry) => entry.currency === fiatCurrency && entry.status === "ACTIVATED"
  );
  if (!method) {
    const available = input.account.payinMethods
      .filter((entry) => entry.status === "ACTIVATED")
      .map((entry) => entry.currency);
    const availableLabel = available.length > 0 ? available.join(", ") : "none";
    throw badRequest(
      `Mural account has no active ${fiatCurrency} payin method (available: ${availableLabel}).`,
      { provider: "mural", fiatCurrency, availablePayinCurrencies: available }
    );
  }
  return {
    provider: "mural",
    id: rampId("ramp"),
    status: "pending",
    deliveryMode: "manual_instructions",
    paymentInstructions: [buildMuralPayinInstruction(method)],
  };
}
