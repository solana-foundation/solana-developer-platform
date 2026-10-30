/**
 * Email through Iterable, which the Foundation sends its email with. Every SDP email goes through
 * one triggered campaign whose template only passes our fields through (`{{subject}}`, `{{body}}`,
 * `{{replyTo}}`), so what a reader sees is written and reviewed in this repository, not in Iterable.
 */
import { z } from "zod";
import { serviceUnavailable } from "@/lib/errors";
import { fetchProviderJson } from "@/lib/provider-json";
import type { Env } from "@/types/env";

const iterableSendResponseSchema = z.object({ code: z.literal("Success") });

export interface IterableEmailConfig {
  apiUrl: string;
  apiKey: string;
  campaignId: number;
}

export interface IterableEmail {
  to: string;
  subject: string;
  /** Plain text: the template renders it escaped, so customer-supplied fields need no escaping. */
  body: string;
  replyTo?: string;
}

/**
 * Any key unset, or a campaign id that is not a positive integer, means this deployment sends no
 * email. `ITERABLE_API_URL` is Iterable's API for the project's data center
 * (`https://api.iterable.com`), or a stub locally.
 */
export function iterableEmailConfig(env: Env): IterableEmailConfig | null {
  const apiUrl = env.ITERABLE_API_URL?.trim();
  const apiKey = env.ITERABLE_API_KEY?.trim();
  const campaignId = Number(env.ITERABLE_TRANSACTIONAL_CAMPAIGN_ID?.trim());
  return apiUrl && apiKey && Number.isSafeInteger(campaignId) && campaignId > 0
    ? { apiUrl, apiKey, campaignId }
    : null;
}

/**
 * Sends one email. Iterable takes no idempotency key, so a caller that retries after a lost answer
 * can send the same email twice; a caller that must not keeps its own record of what it sent.
 *
 * @throws PROVIDER_UNAVAILABLE when Iterable does not accept it; SERVICE_UNAVAILABLE when unconfigured.
 */
export async function sendIterableEmail(env: Env, email: IterableEmail): Promise<void> {
  const config = iterableEmailConfig(env);
  if (!config) throw serviceUnavailable("Email is not configured on this deployment");
  await fetchProviderJson(
    "Iterable",
    `${config.apiUrl.replace(/\/+$/, "")}/api/email/target`,
    iterableSendResponseSchema,
    {
      method: "POST",
      headers: { "api-key": config.apiKey, "content-type": "application/json" },
      body: JSON.stringify({
        campaignId: config.campaignId,
        recipientEmail: email.to,
        dataFields: { subject: email.subject, body: email.body, replyTo: email.replyTo },
      }),
      timeoutMs: 10_000,
      maxBytes: 16_384,
    }
  );
}
