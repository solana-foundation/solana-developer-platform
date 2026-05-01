import type { Context } from "hono";
import { getDb } from "@/db";
import { getAuth } from "@/lib/auth";
import { AppError } from "@/lib/errors";
import { success } from "@/lib/response";
import { isSelfHostedDeployment } from "@/lib/runtime-env";
import { assertValidAddress } from "@/lib/solana";
import { createComplianceService } from "@/services/compliance";
import { getEnabledProviders } from "@/services/provider-availability.service";
import type { Env } from "@/types/env";
import { screenAddressSchema } from "./schemas";

type AppContext = Context<{ Bindings: Env }>;

export async function screenAddress(c: AppContext) {
  const body = await c.req.json();
  const parsed = screenAddressSchema.safeParse(body);

  if (!parsed.success) {
    throw new AppError("BAD_REQUEST", "Invalid request body", {
      errors: parsed.error.flatten().fieldErrors,
    });
  }

  const address = parsed.data.address.trim();
  const network = parsed.data.network;

  if (network === "solana") {
    try {
      assertValidAddress(address, "address");
    } catch {
      throw new AppError("BAD_REQUEST", "Invalid Solana address");
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
        : "Compliance screening is only available on enterprise tier organizations with an enabled provider."
    );
  }

  const complianceService = createComplianceService(c.env, enabledComplianceProviders);
  const providers = await complianceService.screenAddress({
    address,
    network,
    intent: parsed.data.intent,
  });

  return success(c, {
    screening: {
      address,
      network,
      intent: parsed.data.intent,
      checkedAt: new Date().toISOString(),
      providers,
    },
  });
}
