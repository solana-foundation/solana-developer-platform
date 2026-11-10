import type { EarnProviderId } from "@sdp/types/provider-access";
import { Hono } from "hono";
import { authorize } from "@/middleware/authorize";
import { idempotent } from "@/middleware/idempotency";
import { meteredQuota } from "@/middleware/metered-quota";
import { requireAction } from "@/middleware/require-action";
import { validateBody, validateParams } from "@/middleware/validate";
import type { Env } from "@/types/env";
import { createEarnOnboardingHandlers } from "./handlers";
import {
  onboardingApplicationSchema,
  onboardingCorrectionBodySchema,
  onboardingCorrectionParamsSchema,
  onboardingFormParamsSchema,
  onboardingParamsSchema,
  onboardingUploadSchema,
  onboardingWalletSchema,
} from "./schemas";

/**
 * The SHARED onboarding route stack for one provider — mounted under Earn's
 * credential, feature, release-channel and project scope, one line per
 * provider (`earn.route("/onboarding/<provider>", createEarnOnboardingRoutes(...))`).
 * The body schemas in ./schemas carry the provider's own application and
 * correction vocabulary (kept in its adapter); every handler, the service and
 * the capability dispatch are shared.
 */
export function createEarnOnboardingRoutes(provider: EarnProviderId) {
  const handlers = createEarnOnboardingHandlers(provider);
  const quota = { name: "earn-onboarding", actorMax: 20, orgMax: 60 } as const;
  const routes = new Hono<{ Bindings: Env }>();
  routes.use("*", async (c, next) => {
    c.header("Cache-Control", "no-store");
    await next();
  });
  routes.get(
    "/forms/:entityType",
    requireAction("earn.read"),
    validateParams(onboardingFormParamsSchema),
    meteredQuota(quota),
    handlers.getOnboardingForm
  );
  routes.get(
    "/:counterpartyId",
    requireAction("earn.read"),
    validateParams(onboardingParamsSchema),
    authorize(handlers.authorizeOnboardingCustomer),
    meteredQuota(quota),
    handlers.getOnboardingStatus
  );
  routes.post(
    "/:counterpartyId",
    requireAction("earn.execute"),
    validateParams(onboardingParamsSchema),
    validateBody(onboardingApplicationSchema),
    authorize(handlers.authorizeOnboardingCustomer),
    idempotent({ key: "required", serverErrors: "store" }),
    meteredQuota(quota),
    handlers.saveOnboardingApplication
  );
  routes.post(
    "/:counterpartyId/documents",
    requireAction("earn.execute"),
    validateParams(onboardingParamsSchema),
    validateBody(onboardingUploadSchema),
    authorize(handlers.authorizeOnboardingCustomer),
    idempotent({ key: "required", serverErrors: "store" }),
    meteredQuota(quota),
    handlers.uploadOnboardingDocument
  );
  routes.post(
    "/:counterpartyId/corrections/:reasonId",
    requireAction("earn.execute"),
    validateParams(onboardingCorrectionParamsSchema),
    validateBody(onboardingCorrectionBodySchema),
    authorize(handlers.authorizeOnboardingCustomer),
    idempotent({ key: "required", serverErrors: "store" }),
    meteredQuota(quota),
    handlers.answerOnboardingCorrection
  );

  routes.post(
    "/:counterpartyId/wallets",
    requireAction("earn.execute"),
    validateParams(onboardingParamsSchema),
    validateBody(onboardingWalletSchema),
    authorize(handlers.authorizeOnboardingCustomer),
    idempotent({ key: "required", serverErrors: "store" }),
    meteredQuota(quota),
    handlers.registerOnboardingWallet
  );
  return routes;
}
