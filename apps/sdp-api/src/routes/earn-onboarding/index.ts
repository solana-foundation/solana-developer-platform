import { Hono } from "hono";
import { authorize } from "@/middleware/authorize";
import { idempotent } from "@/middleware/idempotency";
import { meteredQuota } from "@/middleware/metered-quota";
import { requireAction } from "@/middleware/require-action";
import { validateBody, validateParams } from "@/middleware/validate";
import type { Env } from "@/types/env";
import {
  answerOnboardingCorrection,
  authorizeOnboardingCustomer,
  getOnboardingForm,
  getOnboardingStatus,
  registerOnboardingWallet,
  saveOnboardingApplication,
  uploadOnboardingDocument,
} from "./handlers";
import {
  onboardingApplicationSchema,
  onboardingCorrectionBodySchema,
  onboardingCorrectionParamsSchema,
  onboardingFormParamsSchema,
  onboardingParamsSchema,
  onboardingUploadSchema,
  onboardingWalletSchema,
} from "./schemas";

// Mounted under Earn's credential, feature, release-channel and project scope.
export const earnOnboardingRoutes = new Hono<{ Bindings: Env }>();
const quota = { name: "earn-onboarding", actorMax: 20, orgMax: 60 } as const;
earnOnboardingRoutes.use("*", async (c, next) => {
  c.header("Cache-Control", "no-store");
  await next();
});
earnOnboardingRoutes.get(
  "/forms/:entityType",
  requireAction("earn.read"),
  validateParams(onboardingFormParamsSchema),
  meteredQuota(quota),
  getOnboardingForm
);
earnOnboardingRoutes.get(
  "/:counterpartyId",
  requireAction("earn.read"),
  validateParams(onboardingParamsSchema),
  authorize(authorizeOnboardingCustomer),
  meteredQuota(quota),
  getOnboardingStatus
);
earnOnboardingRoutes.post(
  "/:counterpartyId",
  requireAction("earn.execute"),
  validateParams(onboardingParamsSchema),
  validateBody(onboardingApplicationSchema),
  authorize(authorizeOnboardingCustomer),
  idempotent({ key: "required", serverErrors: "store" }),
  meteredQuota(quota),
  saveOnboardingApplication
);
earnOnboardingRoutes.post(
  "/:counterpartyId/documents",
  requireAction("earn.execute"),
  validateParams(onboardingParamsSchema),
  validateBody(onboardingUploadSchema),
  authorize(authorizeOnboardingCustomer),
  idempotent({ key: "required", serverErrors: "store" }),
  meteredQuota(quota),
  uploadOnboardingDocument
);
earnOnboardingRoutes.post(
  "/:counterpartyId/corrections/:reasonId",
  requireAction("earn.execute"),
  validateParams(onboardingCorrectionParamsSchema),
  validateBody(onboardingCorrectionBodySchema),
  authorize(authorizeOnboardingCustomer),
  idempotent({ key: "required", serverErrors: "store" }),
  meteredQuota(quota),
  answerOnboardingCorrection
);

earnOnboardingRoutes.post(
  "/:counterpartyId/wallets",
  requireAction("earn.execute"),
  validateParams(onboardingParamsSchema),
  validateBody(onboardingWalletSchema),
  authorize(authorizeOnboardingCustomer),
  idempotent({ key: "required", serverErrors: "store" }),
  meteredQuota(quota),
  registerOnboardingWallet
);
