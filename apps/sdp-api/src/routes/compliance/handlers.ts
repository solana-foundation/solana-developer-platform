import { assertValidAddress } from "@sdp/solana/address";
import { getDb } from "@/db";
import { getAuth } from "@/lib/auth";
import { AppError, badRequest } from "@/lib/errors";
import { success } from "@/lib/response";
import { isSelfHostedDeployment } from "@/lib/runtime-env";
import type { ValidatedBodyContext } from "@/middleware/validate";
import { createComplianceService } from "@/services/compliance";
import { getEnabledProviders } from "@/services/provider-availability.service";
import type { screenAddressSchema } from "./schemas";

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

  const auth = getAuth(c);
  const enabledComplianceProviders = (
    await getEnabledProviders(c.env, getDb(c.env), auth.organizationId)
  ).compliance;

  if (enabledComplianceProviders.length === 0) {
    throw new AppError(
      "FORBIDDEN",
      isSelfHostedDeployment(c.env)
        ? "Compliance screening requires at least one configured compliance provider (set RANGE_API_KEY, ELLIPTIC_API_TOKEN, TRM_API_KEY, or CHAINALYSIS_API_KEY)."
        : "Compliance screening requires manual provider activation for this organization."
    );
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
