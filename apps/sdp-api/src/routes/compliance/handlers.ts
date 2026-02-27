import { AppError } from "@/lib/errors";
import { success } from "@/lib/response";
import { assertValidAddress } from "@/lib/solana";
import { createComplianceService } from "@/services/compliance";
import type { Env } from "@/types/env";
import type { Context } from "hono";
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

  const complianceService = createComplianceService(c.env);
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
