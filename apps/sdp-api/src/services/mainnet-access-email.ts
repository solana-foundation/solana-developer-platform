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

export interface MainnetAccessCorrectionEmail {
  /** The request as it stood before the correction, as its request email described it. */
  request: MainnetAccessRequestEmail;
  correction:
    | { operation: "set-country"; countryCode: CountryCode; countryName: string }
    | { operation: "reset" };
  operator: string;
  reason: string;
  ticket: string;
}

/**
 * The follow-up to a request email that is now out of date: an operator corrected the request's
 * jurisdiction or reset it. It lands in the same inbox, so whoever would approve from the earlier
 * email sees it first.
 */
export function mainnetAccessCorrectionEmailContent(
  email: MainnetAccessCorrectionEmail
): EmailContent {
  const { request, correction } = email;
  const requestedAt = `${REQUESTED_AT_FORMAT.format(new Date(request.requestedAt))} UTC`;
  const reset = correction.operation === "reset";
  return {
    preheader: reset
      ? `${request.organizationName}'s mainnet access request was reset. Don't approve from the earlier email.`
      : `${request.organizationName}'s jurisdiction was corrected. The earlier email is out of date.`,
    heading: reset ? "Mainnet access request reset" : "Mainnet access request corrected",
    summary: reset
      ? `The request ${request.organizationName} sent on ${requestedAt} no longer stands. Don't approve the organization from the earlier email; a new request sends a new one.`
      : `An operator corrected the jurisdiction on the request ${request.organizationName} sent on ${requestedAt}. Review the request with the corrected jurisdiction before approving.`,
    details: [
      { label: "Organization", value: request.organizationName },
      { label: "Organization ID", value: request.organizationId },
      { label: "Requested at", value: requestedAt },
      {
        label: reset ? "Jurisdiction" : "Previous jurisdiction",
        value: `${request.countryName} (${request.countryCode}), self-declared`,
      },
      ...(correction.operation === "set-country"
        ? [
            {
              label: "Corrected jurisdiction",
              value: `${correction.countryName} (${correction.countryCode})`,
            },
          ]
        : []),
      { label: "Terms", value: `Version ${request.termsVersion}` },
      { label: "Changed by", value: email.operator },
      { label: "Reason", value: email.reason },
      { label: "Ticket", value: email.ticket },
    ],
    note: reset
      ? "The organization's request is cleared, so it can ask again."
      : "The request is otherwise unchanged and still awaits approval in Clerk.",
  };
}

/**
 * Tells the operator address that an earlier request email is out of date.
 *
 * @throws PROVIDER_UNAVAILABLE when Iterable does not accept it; SERVICE_UNAVAILABLE when unconfigured.
 */
export async function sendMainnetAccessCorrectionEmail(
  env: Env,
  email: MainnetAccessCorrectionEmail
): Promise<void> {
  const config = mainnetAccessEmailConfig(env);
  if (!config) {
    throw serviceUnavailable("Mainnet access emails are not configured on this deployment");
  }
  const what = email.correction.operation === "reset" ? "reset" : "corrected";
  await sendIterableEmail(env, {
    to: config.to,
    subject: `Mainnet access request ${what}: ${email.request.organizationName}`,
    content: mainnetAccessCorrectionEmailContent(email),
  });
}
