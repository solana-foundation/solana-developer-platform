import { assertValidAddress } from "@sdp/solana/address";
import { COMPLIANCE_PROVIDERS } from "@sdp/types";
import { AppError, badRequest } from "@/lib/errors";
import { success } from "@/lib/response";
import { isSelfHostedDeployment } from "@/lib/runtime-env";
import type { ValidatedBodyContext } from "@/middleware/validate";
import { createComplianceService } from "@/services/compliance";
import {
  loadProjectProviderVerdict,
  refuseProjectProvider,
} from "@/services/provider-availability.service";
import type { screenAddressSchema } from "./schemas";

/**
 * POST /v1/compliance/address-screenings: screens an address with every
 * compliance provider the organization has enabled. The only compliance path
 * that starts provider work, so it is the family's gate: each provider this
 * request bills must be admitted for the request's project by the project
 * provider rule before any provider is called.
 *
 * @param c - Request context with the validated screening body.
 * @returns One result per enabled compliance provider.
 * @throws 403 `FORBIDDEN` when no provider is enabled, or whose `details.reason`
 *   is `provider_not_in_release_channel` or `provider_not_entitled` when the project may not use an enabled provider;
 *   503 `PROVIDER_NOT_CONFIGURED` when the deployment lacks an enabled
 *   provider's credentials for the project's environment.
 */
export async function screenAddress(c: ValidatedBodyContext<typeof screenAddressSchema>) {
  const body = c.req.valid("json");

  const address = body.address.trim();
  const network = body.network;

  if (network === "solana") {
    try {
      assertValidAddress(address, "address");
    } catch {
      throw badRequest("Invalid Solana address");
    }
  }

  const verdict = await loadProjectProviderVerdict(c);
  const enabledComplianceProviders = COMPLIANCE_PROVIDERS.filter(
    (provider) => verdict.availability.providers.compliance[provider].enabled
  );

  if (enabledComplianceProviders.length === 0) {
    throw new AppError(
      "FORBIDDEN",
      isSelfHostedDeployment(c.env)
        ? "Compliance screening requires at least one configured compliance provider (set RANGE_API_KEY, ELLIPTIC_API_TOKEN, TRM_API_KEY, or CHAINALYSIS_API_KEY)."
        : "Compliance screening requires manual provider activation for this organization."
    );
  }

  for (const provider of enabledComplianceProviders) {
    const decision = verdict.decide({ family: "compliance", provider });
    if (!decision.admitted) {
      throw refuseProjectProvider(decision);
    }
  }

  const complianceService = createComplianceService(c.env, enabledComplianceProviders);
  const providers = await complianceService.screenAddress({
    address,
    network,
    intent: body.intent,
  });

  return success(c, {
    screening: {
      address,
      network,
      intent: body.intent,
      checkedAt: new Date().toISOString(),
      providers,
    },
  });
}
