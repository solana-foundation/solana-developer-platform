/**
 * Email through Iterable, which the Foundation sends its email with. Every SDP email goes through
 * one triggered campaign whose template only passes our fields through: `{{subject}}`,
 * `{{{bodyHtml}}}` as the whole HTML part, `{{{body}}}` as the plain-text part and `{{replyTo}}`.
 * What a reader sees is laid out in `email-layout.ts` and reviewed here, not in Iterable.
 */
import { z } from "zod";
import { serviceUnavailable } from "@/lib/errors";
import { fetchProviderJson } from "@/lib/provider-json";
import { type EmailContent, renderEmailHtml, renderEmailText } from "@/services/email-layout";
import type { Env } from "@/types/env";

const iterableSendResponseSchema = z.object({ code: z.literal("Success") });

const iterableEmailConfigSchema = z.object({
  apiUrl: z
    .string()
    .trim()
    .pipe(z.url({ protocol: /^https?$/ })),
  // Iterable keys are 32 characters; a short value, like a deployment's `placeholder`, is unset.
  apiKey: z.string().trim().min(20),
  campaignId: z
    .string()
    .trim()
    .regex(/^[1-9]\d*$/)
    .transform(Number)
    .pipe(z.number().int().max(Number.MAX_SAFE_INTEGER)),
});

export type IterableEmailConfig = z.infer<typeof iterableEmailConfigSchema>;

export interface IterableEmail {
  to: string;
  subject: string;
  /** Rendered into both parts by `email-layout.ts`; customer-supplied text is escaped there. */
  content: EmailContent;
  replyTo?: string;
}

/**
 * Any key unset or malformed (a URL that is not http(s), a campaign id that is not a positive
 * integer) means this deployment sends no email. `ITERABLE_API_URL` is Iterable's API for the
 * project's data center (`https://api.iterable.com`), or a stub locally.
 */
export function iterableEmailConfig(env: Env): IterableEmailConfig | null {
  const parsed = iterableEmailConfigSchema.safeParse({
    apiUrl: env.ITERABLE_API_URL,
    apiKey: env.ITERABLE_API_KEY,
    campaignId: env.ITERABLE_TRANSACTIONAL_CAMPAIGN_ID,
  });
  return parsed.success ? parsed.data : null;
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
        dataFields: {
          subject: email.subject,
          body: renderEmailText(email.content),
          bodyHtml: renderEmailHtml(email.content),
          replyTo: email.replyTo,
        },
      }),
      timeoutMs: 10_000,
      maxBytes: 16_384,
    }
  );
}
