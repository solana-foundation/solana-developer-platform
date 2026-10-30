/**
 * Tells the SDP alias an organization asked for mainnet (HOO-2427), through Iterable, which
 * the Foundation sends its email with. Approval stays manual: the email only
 * asks an operator to look.
 *
 * The campaign's template passes our text through (`{{subject}}`, `{{body}}`), so what the alias
 * reads is written and reviewed here, not in Iterable.
 */
import type { CountryCode } from "@sdp/types/countries";
import { z } from "zod";
import { serviceUnavailable } from "@/lib/errors";
import { fetchProviderJson } from "@/lib/provider-json";
import type { Env } from "@/types/env";

const iterableSendResponseSchema = z.object({ code: z.literal("Success") });

export interface MainnetAccessRequestEmail {
  organizationId: string;
  organizationName: string;
  requester: { userId: string; email: string | null; name: string | null };
  countryCode: CountryCode;
  countryName: string;
  termsVersion: string;
  requestedAt: string;
}

/**
 * Where a request email goes and which Iterable campaign sends it. Any key unset, or a campaign id
 * that is not a positive integer, means the deployment cannot take requests. `ITERABLE_API_URL` is
 * Iterable's API for the project's data center (`https://api.iterable.com`), or a stub locally.
 */
export function mainnetAccessEmailConfig(
  env: Env
): { apiUrl: string; apiKey: string; campaignId: number; to: string } | null {
  const apiUrl = env.ITERABLE_API_URL?.trim();
  const apiKey = env.ITERABLE_API_KEY?.trim();
  const campaignId = Number(env.MAINNET_ACCESS_ITERABLE_CAMPAIGN_ID?.trim());
  const to = env.MAINNET_ACCESS_EMAIL_TO?.trim();
  return apiUrl && apiKey && Number.isSafeInteger(campaignId) && campaignId > 0 && to
    ? { apiUrl, apiKey, campaignId, to }
    : null;
}

function requesterLabel(requester: MainnetAccessRequestEmail["requester"]): string {
  const who = [requester.name, requester.email].filter(Boolean).join(" ");
  return who ? `${who} (${requester.userId})` : requester.userId;
}

/** Plain text only: every field is customer-supplied, and the template escapes what it renders. */
function mainnetAccessRequestEmailText(request: MainnetAccessRequestEmail): string {
  return [
    "An organization asked for SDP mainnet access.",
    "",
    `Organization: ${request.organizationName}`,
    `Organization id: ${request.organizationId}`,
    `Requested by: ${requesterLabel(request.requester)}`,
    `Requested at: ${request.requestedAt}`,
    `Jurisdiction (self-declared): ${request.countryName} (${request.countryCode})`,
    `Terms and Conditions: version ${request.termsVersion}, accepted with the request`,
    "",
    "To approve, set enableProductionProject in the organization's Clerk private metadata.",
  ].join("\n");
}

/**
 * Sends the request email. Iterable takes no idempotency key, so a send whose answer is lost and
 * is then retried through `notify` can reach the alias twice; the alias is internal, and the
 * second copy says the same thing.
 *
 * @throws PROVIDER_UNAVAILABLE when Iterable does not accept it; SERVICE_UNAVAILABLE when unconfigured.
 */
export async function sendMainnetAccessRequestEmail(
  env: Env,
  request: MainnetAccessRequestEmail
): Promise<void> {
  const config = mainnetAccessEmailConfig(env);
  if (!config) {
    throw serviceUnavailable("Mainnet access requests are not available on this deployment");
  }
  await fetchProviderJson(
    "Iterable",
    `${config.apiUrl.replace(/\/+$/, "")}/api/email/target`,
    iterableSendResponseSchema,
    {
      method: "POST",
      headers: { "api-key": config.apiKey, "content-type": "application/json" },
      body: JSON.stringify({
        campaignId: config.campaignId,
        recipientEmail: config.to,
        dataFields: {
          subject: `Mainnet access request: ${request.organizationName}`,
          body: mainnetAccessRequestEmailText(request),
          replyTo: request.requester.email ?? undefined,
        },
      }),
      timeoutMs: 10_000,
      maxBytes: 16_384,
    }
  );
}
