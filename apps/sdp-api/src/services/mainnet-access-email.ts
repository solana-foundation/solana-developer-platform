/**
 * Tells the SDP alias an organization asked for mainnet (HOO-2427), through Iterable
 * (`iterable-email.ts`). Approval stays manual: the email only asks an operator to look.
 */
import type { CountryCode } from "@sdp/types/countries";
import { z } from "zod";
import { serviceUnavailable } from "@/lib/errors";
import type { EmailContent } from "@/services/email-layout";
import {
  type IterableEmailConfig,
  iterableEmailConfig,
  sendIterableEmail,
} from "@/services/iterable-email";
import type { Env } from "@/types/env";

export interface MainnetAccessRequestEmail {
  organizationId: string;
  organizationName: string;
  requester: { userId: string; email: string | null; name: string | null };
  countryCode: CountryCode;
  countryName: string;
  termsVersion: string;
  requestedAt: string;
}

const aliasSchema = z.string().trim().pipe(z.email());

/**
 * Email configured and an alias to send to; either missing means the deployment takes no requests.
 * An alias that is not an address (a deployment's `placeholder` before the real one is set) is
 * missing too.
 */
export function mainnetAccessEmailConfig(env: Env): (IterableEmailConfig & { to: string }) | null {
  const email = iterableEmailConfig(env);
  const to = aliasSchema.safeParse(env.SDP_OPERATOR_EMAIL);
  return email && to.success ? { ...email, to: to.data } : null;
}

function requesterLabel(requester: MainnetAccessRequestEmail["requester"]): string {
  if (requester.name && requester.email) return `${requester.name} (${requester.email})`;
  return requester.name ?? requester.email ?? "Unknown";
}

const REQUESTED_AT_FORMAT = new Intl.DateTimeFormat("en-GB", {
  dateStyle: "medium",
  timeStyle: "short",
  timeZone: "UTC",
});

/** The email an operator reads: who asked, from where, under which terms, and how to approve. */
export function mainnetAccessRequestEmailContent(request: MainnetAccessRequestEmail): EmailContent {
  return {
    preheader: `${request.organizationName} accepted the SDP terms and asked to use mainnet.`,
    heading: "Mainnet access requested",
    summary: `${request.organizationName} asked to use SDP on mainnet. Review the details below, then approve the organization in Clerk.`,
    details: [
      { label: "Organization", value: request.organizationName },
      { label: "Organization ID", value: request.organizationId },
      { label: "Requested by", value: requesterLabel(request.requester) },
      { label: "Requester user ID", value: request.requester.userId },
      {
        label: "Requested at",
        value: `${REQUESTED_AT_FORMAT.format(new Date(request.requestedAt))} UTC`,
      },
      {
        label: "Jurisdiction",
        value: `${request.countryName} (${request.countryCode}), self-declared`,
      },
      { label: "Terms", value: `Version ${request.termsVersion}, accepted with the request` },
    ],
    action: { label: "Open Clerk", url: "https://dashboard.clerk.com" },
    note: "To approve, set enableProductionProject in the organization's Clerk private metadata.",
  };
}

/**
 * Sends the request email. A send whose answer is lost and is then retried through `notify` can
 * reach the alias twice; the alias is internal, and the second copy says the same thing.
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
  await sendIterableEmail(env, {
    to: config.to,
    subject: `Mainnet access request: ${request.organizationName}`,
    content: mainnetAccessRequestEmailContent(request),
    replyTo: request.requester.email ?? undefined,
  });
}
