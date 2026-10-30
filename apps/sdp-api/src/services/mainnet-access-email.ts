/**
 * Tells the SDP alias an organization asked for mainnet (HOO-2427), through Resend's HTTP API,
 * the provider other Foundation apps on solana.com already send with. Approval stays manual:
 * the email only asks an operator to look.
 */
import { z } from "zod";
import { serviceUnavailable } from "@/lib/errors";
import { fetchProviderJson } from "@/lib/provider-json";
import type { Env } from "@/types/env";

/** Resend's API; `RESEND_API_URL` points it at a local stub for development. */
const DEFAULT_RESEND_API_URL = "https://api.resend.com";

const resendSendResponseSchema = z.object({ id: z.string().min(1) });

export interface MainnetAccessRequestEmail {
  organizationId: string;
  organizationName: string;
  requester: { userId: string; email: string | null; name: string | null };
  countryCode: string;
  countryName: string;
  termsVersion: string;
  termsAcceptedAt: string;
  requestedAt: string;
}

/** Where a request email goes and who sends it; unset means the deployment cannot take requests. */
export function mainnetAccessEmailConfig(
  env: Env
): { apiKey: string; from: string; to: string } | null {
  const apiKey = env.RESEND_API_KEY?.trim();
  const from = env.MAINNET_ACCESS_EMAIL_FROM?.trim();
  const to = env.MAINNET_ACCESS_EMAIL_TO?.trim();
  return apiKey && from && to ? { apiKey, from, to } : null;
}

function requesterLabel(requester: MainnetAccessRequestEmail["requester"]): string {
  const who = [requester.name, requester.email].filter(Boolean).join(" ");
  return who ? `${who} (${requester.userId})` : requester.userId;
}

/** Plain text only: every field is customer-supplied, and text needs no escaping. */
export function mainnetAccessRequestEmailText(request: MainnetAccessRequestEmail): string {
  return [
    "An organization asked for SDP mainnet access.",
    "",
    `Organization: ${request.organizationName}`,
    `Organization id: ${request.organizationId}`,
    `Requested by: ${requesterLabel(request.requester)}`,
    `Requested at: ${request.requestedAt}`,
    `Jurisdiction (self-declared): ${request.countryName} (${request.countryCode})`,
    `Terms and Conditions: version ${request.termsVersion}, accepted ${request.termsAcceptedAt}`,
    "",
    "To approve, set enableProductionProject in the organization's Clerk private metadata.",
  ].join("\n");
}

/**
 * Sends the request email. Resend's Idempotency-Key makes a resend of the same request one email,
 * so a retry after a lost answer does not reach the alias twice.
 *
 * @throws PROVIDER_UNAVAILABLE when Resend does not accept it; SERVICE_UNAVAILABLE when unconfigured.
 */
export async function sendMainnetAccessRequestEmail(
  env: Env,
  request: MainnetAccessRequestEmail
): Promise<void> {
  const config = mainnetAccessEmailConfig(env);
  if (!config) {
    throw serviceUnavailable("Mainnet access requests are not available on this deployment");
  }
  const baseUrl = env.RESEND_API_URL?.trim() || DEFAULT_RESEND_API_URL;
  await fetchProviderJson(
    "Resend",
    `${baseUrl.replace(/\/+$/, "")}/emails`,
    resendSendResponseSchema,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${config.apiKey}`,
        "content-type": "application/json",
        "idempotency-key": `mainnet-access/${request.organizationId}/${request.requestedAt}`,
      },
      body: JSON.stringify({
        from: config.from,
        to: [config.to],
        ...(request.requester.email ? { reply_to: request.requester.email } : {}),
        subject: `Mainnet access request: ${request.organizationName}`,
        text: mainnetAccessRequestEmailText(request),
      }),
      timeoutMs: 10_000,
      maxBytes: 16_384,
    }
  );
}
