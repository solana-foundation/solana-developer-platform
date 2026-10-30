/**
 * Tells the SDP alias an organization asked for mainnet (HOO-2427), through Iterable
 * (`iterable-email.ts`). Approval stays manual: the email only asks an operator to look.
 */
import type { CountryCode } from "@sdp/types/countries";
import { z } from "zod";
import { serviceUnavailable } from "@/lib/errors";
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
  const to = aliasSchema.safeParse(env.MAINNET_ACCESS_EMAIL_TO);
  return email && to.success ? { ...email, to: to.data } : null;
}

function requesterLabel(requester: MainnetAccessRequestEmail["requester"]): string {
  const who = [requester.name, requester.email].filter(Boolean).join(" ");
  return who ? `${who} (${requester.userId})` : requester.userId;
}

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
    body: mainnetAccessRequestEmailText(request),
    replyTo: request.requester.email ?? undefined,
  });
}
