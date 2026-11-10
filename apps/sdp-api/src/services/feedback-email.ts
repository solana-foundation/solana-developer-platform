/**
 * Sends dashboard feedback (PRO-2421) to the SDP alias through Iterable (`iterable-email.ts`),
 * replying to the person who sent it. Attachments and the session replay stay in Sentry; the
 * email names the Sentry event that holds them.
 */
import { z } from "zod";
import { serviceUnavailable } from "@/lib/errors";
import type { FEEDBACK_CATEGORIES } from "@/routes/organization-feedback/schemas";
import type { EmailContent } from "@/services/email-layout";
import {
  type IterableEmailConfig,
  iterableEmailConfig,
  sendIterableEmail,
} from "@/services/iterable-email";
import type { Env } from "@/types/env";

export interface FeedbackEmail {
  organizationId: string;
  organizationName: string;
  sender: { userId: string; email: string | null; name: string | null };
  category?: (typeof FEEDBACK_CATEGORIES)[number];
  message: string;
  pageUrl?: string;
  attachmentCount: number;
  sentryEventId?: string;
}

const aliasSchema = z.string().trim().pipe(z.email());

/** Email configured and an alias to send to; either missing means the deployment takes no feedback. */
export function feedbackEmailConfig(env: Env): (IterableEmailConfig & { to: string }) | null {
  const email = iterableEmailConfig(env);
  const to = aliasSchema.safeParse(env.SDP_OPERATOR_EMAIL);
  return email && to.success ? { ...email, to: to.data } : null;
}

const CATEGORY_LABELS = {
  problem: "Something's broken",
  idea: "An idea",
  question: "A question",
} as const satisfies Record<(typeof FEEDBACK_CATEGORIES)[number], string>;

function senderLabel(sender: FeedbackEmail["sender"]): string {
  if (sender.name && sender.email) return `${sender.name} (${sender.email})`;
  return sender.name ?? sender.email ?? "Unknown";
}

/** The email the SDP team reads: what was said, by whom, from where, and where the files are. */
export function feedbackEmailContent(feedback: FeedbackEmail): EmailContent {
  const about = feedback.category ? CATEGORY_LABELS[feedback.category] : "Feedback";
  return {
    preheader: `${about} from ${feedback.organizationName}.`,
    heading: about,
    summary: feedback.message,
    details: [
      { label: "From", value: senderLabel(feedback.sender) },
      { label: "User ID", value: feedback.sender.userId },
      { label: "Organization", value: feedback.organizationName },
      { label: "Organization ID", value: feedback.organizationId },
      ...(feedback.pageUrl ? [{ label: "Page", value: feedback.pageUrl }] : []),
      {
        label: "Files",
        value:
          feedback.attachmentCount === 0
            ? "None"
            : `${feedback.attachmentCount} in Sentry${feedback.sentryEventId ? "" : " (no event ID)"}`,
      },
      ...(feedback.sentryEventId ? [{ label: "Sentry event", value: feedback.sentryEventId }] : []),
    ],
    note: feedback.sender.email
      ? "Reply to this email to answer them."
      : "They have no email on file, so a reply goes nowhere.",
  };
}

/**
 * Sends one feedback email. Iterable takes no idempotency key, so a retry after a lost answer can
 * send it twice; the alias is internal, and the copy says the same thing.
 *
 * @throws PROVIDER_UNAVAILABLE when Iterable does not accept it; SERVICE_UNAVAILABLE when unconfigured.
 */
export async function sendFeedbackEmail(env: Env, feedback: FeedbackEmail): Promise<void> {
  const config = feedbackEmailConfig(env);
  if (!config) throw serviceUnavailable("Feedback is not available on this deployment");
  const about = feedback.category ? CATEGORY_LABELS[feedback.category] : "Feedback";
  await sendIterableEmail(env, {
    to: config.to,
    subject: `${about}: ${feedback.organizationName}`,
    content: feedbackEmailContent(feedback),
    replyTo: feedback.sender.email ?? undefined,
  });
}
