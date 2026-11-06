import { EARN_PROVIDER_CLIENTS } from "@sdp/earn";
import { supportsOnboarding } from "@sdp/earn/capabilities";
import type { EarnOnboardingProvider } from "@sdp/earn/types";
import { currentClusterScope } from "@sdp/rpc/scope";
import type { EarnProviderId } from "@sdp/types/provider-access";
import { getDb } from "@/db/client";
import { createPostgresEarnOnboardingRepository } from "@/db/repositories/earn-onboarding.repository.postgres";
import { createCounterpartiesRepository } from "@/db/repositories/repository-factory";
import { getAuth, requireProjectId } from "@/lib/auth";
import { createEarnOnboardingCipher } from "@/lib/earn-onboarding-crypto";
import { badRequest, conflict, notFound } from "@/lib/errors";
import { success } from "@/lib/response";
import { getRequestTenantScope } from "@/lib/tenant-scope";
import { type AuthorizeInput, getAuthorized } from "@/middleware/authorize";
import type { ValidatedBodyContext, ValidatedContext } from "@/middleware/validate";
import type { AppContext } from "@/routes/earn/context";
import { EarnOnboardingService } from "@/services/earn/earn-onboarding.service";
import { earnRuntime } from "@/services/earn/runtime";
import { CustodyConfigStore } from "@/services/stores/custody-config.store";
import {
  EARN_ONBOARDING_MAX_FILE_BYTES,
  type onboardingApplicationSchema,
  type onboardingCorrectionBodySchema,
  type onboardingCorrectionParamsSchema,
  type onboardingFormParamsSchema,
  onboardingParamsSchema,
  type onboardingUploadSchema,
  type onboardingWalletSchema,
} from "./schemas";

/**
 * The SHARED onboarding handlers for one provider, dispatched by the provider's
 * onboarding capability (`supportsOnboarding` over `EARN_PROVIDER_CLIENTS`) —
 * never a provider-id branch inside the handlers. Mounting this module for a
 * provider that has not implemented the capability is a deploy bug and fails
 * loudly at boot.
 */
export function createEarnOnboardingHandlers(provider: EarnProviderId) {
  const client = EARN_PROVIDER_CLIENTS[provider];
  if (!supportsOnboarding(client)) {
    throw new Error(`Earn provider "${provider}" does not implement the onboarding capability`);
  }
  const onboardingProvider: EarnOnboardingProvider = client;
  function scope(c: AppContext, counterpartyId: string) {
    return {
      organizationId: getAuth(c).organizationId,
      projectId: requireProjectId(c),
      environment: currentClusterScope().environment,
      provider,
      counterpartyId,
    };
  }
  function service(c: AppContext) {
    return new EarnOnboardingService(
      createPostgresEarnOnboardingRepository(getDb(c.env)),
      onboardingProvider,
      {
        encrypt: (aad, plaintext) => createEarnOnboardingCipher(c.env).encrypt(aad, plaintext),
        decrypt: (aad, ciphertext) => createEarnOnboardingCipher(c.env).decrypt(aad, ciphertext),
      },
      earnRuntime(c.env),
      new CustodyConfigStore(getDb(c.env), c.env)
    );
  }
  async function authorizeOnboardingCustomer(c: AppContext, input: AuthorizeInput) {
    const { counterpartyId } = onboardingParamsSchema.parse(input.params);
    const counterparty = await createCounterpartiesRepository(
      c.env,
      getRequestTenantScope(c)
    ).getCounterpartyById({
      ...scope(c, counterpartyId),
      status: "any",
    });
    if (counterparty === null) throw notFound("Counterparty");
    return counterparty;
  }
  type Customer = Awaited<ReturnType<typeof authorizeOnboardingCustomer>>;
  function activeCustomer(c: AppContext) {
    const customer = getAuthorized<Customer>(c);
    if (customer.status !== "active") throw conflict("Counterparty is archived");
    return customer;
  }
  return {
    authorizeOnboardingCustomer,
    async getOnboardingForm(c: ValidatedContext<{ param: typeof onboardingFormParamsSchema }>) {
      return success(c, { form: await service(c).form(c.req.valid("param").entityType) });
    },
    async getOnboardingStatus(c: AppContext) {
      const customer = getAuthorized<Customer>(c);
      return success(c, await service(c).status(scope(c, customer.id)));
    },
    async saveOnboardingApplication(c: ValidatedBodyContext<typeof onboardingApplicationSchema>) {
      const customer = activeCustomer(c);
      return success(
        c,
        await service(c).save(scope(c, customer.id), customer.entity_type, c.req.valid("json"))
      );
    },
    async uploadOnboardingDocument(c: ValidatedBodyContext<typeof onboardingUploadSchema>) {
      const customer = activeCustomer(c);
      if (customer.entity_type !== "business")
        throw badRequest("Documents are accepted for business onboarding only");
      const body = c.req.valid("json");
      const bytes = Buffer.from(body.contentBase64, "base64");
      if (bytes.length === 0 || bytes.length > EARN_ONBOARDING_MAX_FILE_BYTES)
        throw badRequest("Onboarding document exceeds 20 MB");
      // Refuse missing encryption configuration before creating an upstream upload.
      createEarnOnboardingCipher(c.env);
      const file = new File([bytes], body.filename, { type: body.contentType });
      return success(
        c,
        await service(c).upload(scope(c, customer.id), { documentType: body.documentType, file }),
        201
      );
    },
    async answerOnboardingCorrection(
      c: ValidatedContext<{
        json: typeof onboardingCorrectionBodySchema;
        param: typeof onboardingCorrectionParamsSchema;
      }>
    ) {
      const customer = activeCustomer(c);
      return success(
        c,
        await service(c).correct(
          scope(c, customer.id),
          c.req.valid("param").reasonId,
          c.req.valid("json")
        )
      );
    },
    async registerOnboardingWallet(c: ValidatedBodyContext<typeof onboardingWalletSchema>) {
      const customer = activeCustomer(c);
      const body = c.req.valid("json");
      return success(
        c,
        await service(c).registerWallet(scope(c, customer.id), body.owner, body.signature)
      );
    },
  };
}
