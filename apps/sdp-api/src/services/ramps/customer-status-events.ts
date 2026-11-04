import type { RampCustomerStatusEvent } from "@sdp/payments/ramps/types";
import type { SdpEnvironment } from "@sdp/types/api-keys";
import type { RampWebhookProcessResult } from "@sdp/types/payments";
import { getDb } from "@/db/client";
import { createPostgresCounterpartyProviderAccountsRepository } from "@/db/repositories/counterparty-provider-account.repository.postgres";
import { logEvent } from "@/runtime/money-path-events";
import type { Env } from "@/types/env";

/**
 * Records a provider's verified event about one of its customers on the customer link that names it.
 * The event carries no tenant: the link it names decides the tenant, and the link's project must run in the endpoint's environment.
 * The link keeps the newest report, so a duplicate or an older event changes nothing and is `ignored`.
 * An account SDP holds no active link for, such as an archived counterparty's, is `ignored` too, since nothing waits on it.
 *
 * @param env - Worker bindings.
 * @param environment - The environment of the webhook endpoint that verified the event.
 * @param event - The customer status event.
 * @returns `applied` when the link took the status.
 */
export async function applyRampCustomerStatusEvent(
  env: Env,
  environment: SdpEnvironment,
  event: RampCustomerStatusEvent
): Promise<RampWebhookProcessResult> {
  const accounts = createPostgresCounterpartyProviderAccountsRepository(getDb(env));
  const found = await accounts.findCustomerLinkByProviderReference({
    provider: event.provider,
    providerCustomerReference: event.providerCustomerReference,
  });
  if (found === null) {
    logEvent("warn", {
      event: "sdp_api_ramp_customer_status_unmatched",
      flow: "ramp-customer-status",
      provider: event.provider,
      environment,
    });
    return { outcome: "ignored" };
  }
  const { link } = found;
  if (found.environment !== environment) {
    logEvent("error", {
      event: "sdp_api_ramp_customer_status_environment_mismatch",
      flow: "ramp-customer-status",
      provider: event.provider,
      environment,
      link_environment: found.environment,
      organization_id: link.organization_id,
      counterparty_id: link.counterparty_id,
    });
    return { outcome: "refused", reason: "environment_mismatch" };
  }
  const outcome = await accounts.recordCustomerLinkStatus({
    organizationId: link.organization_id,
    projectId: link.project_id,
    counterpartyId: link.counterparty_id,
    provider: event.provider,
    observation: event.observation,
  });
  return outcome === "recorded" ? { outcome: "applied" } : { outcome: "ignored" };
}
