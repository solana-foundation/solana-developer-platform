/**
 * Posts to the operators' Slack channel (#sdp-requests) through an incoming webhook. A post copies
 * an operator email into the channel, built from the same `EmailContent`, so the two never drift.
 * Email stays the record: a post is best-effort, and a deployment without the webhook posts nothing.
 */
import { z } from "zod";
import type { EmailContent } from "@/services/email-layout";
import type { Env } from "@/types/env";

/**
 * Only Slack's own webhook host: the URL is a deployment secret, and anything else (a
 * `placeholder`, another host) means this deployment posts nothing.
 */
const webhookUrlSchema = z
  .string()
  .trim()
  .pipe(z.url({ protocol: /^https$/, hostname: /^hooks\.slack\.com$/, abort: true }))
  .refine((url) => new URL(url).pathname.length > 1, "A Slack webhook URL names its hook");

/** The webhook this deployment posts operator requests to; null when it posts none. */
export function requestsSlackWebhookUrl(env: Env): string | null {
  const parsed = webhookUrlSchema.safeParse(env.SDP_REQUESTS_SLACK_WEBHOOK_URL);
  return parsed.success ? parsed.data : null;
}

/** Slack's limits (Block Kit reference): header text, section text and one field's text. */
const HEADER_MAX = 150;
const SECTION_TEXT_MAX = 3000;
const FIELD_TEXT_MAX = 2000;
const FIELDS_PER_SECTION = 10;

/**
 * The three characters Slack reads as markup. Escaped, customer text can't write a mention
 * (`<!channel>`), a user ping or a link that hides where it goes.
 */
export function escapeSlackText(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

type SlackText = { type: "plain_text" | "mrkdwn"; text: string };
type SlackBlock =
  | { type: "header"; text: SlackText }
  | { type: "section"; text?: SlackText; fields?: SlackText[] }
  | {
      type: "actions";
      elements: { type: "button"; text: SlackText; url: string; style: "primary" }[];
    }
  | { type: "context"; elements: SlackText[] };

export interface SlackMessage {
  /** What notifications and clients without blocks show. */
  text: string;
  blocks: SlackBlock[];
}

/**
 * The email as a Slack message: its heading, its summary, each detail as a labelled field, its
 * button and its note. Every value is escaped and cut to Slack's limits.
 */
export function slackMessageFromEmail(content: EmailContent): SlackMessage {
  const mrkdwn = (text: string, max: number): SlackText => ({
    type: "mrkdwn",
    text: truncate(text, max),
  });
  const fields = (content.details ?? []).map(({ label, value }) =>
    mrkdwn(`*${escapeSlackText(label)}*\n${escapeSlackText(value)}`, FIELD_TEXT_MAX)
  );
  const fieldSections: SlackBlock[] = [];
  for (let start = 0; start < fields.length; start += FIELDS_PER_SECTION) {
    fieldSections.push({
      type: "section",
      fields: fields.slice(start, start + FIELDS_PER_SECTION),
    });
  }
  return {
    text: truncate(content.preheader, SECTION_TEXT_MAX),
    blocks: [
      { type: "header", text: { type: "plain_text", text: truncate(content.heading, HEADER_MAX) } },
      { type: "section", text: mrkdwn(escapeSlackText(content.summary), SECTION_TEXT_MAX) },
      ...fieldSections,
      ...(content.action
        ? [
            {
              type: "actions" as const,
              elements: [
                {
                  type: "button" as const,
                  text: { type: "plain_text" as const, text: content.action.label },
                  url: content.action.url,
                  style: "primary" as const,
                },
              ],
            },
          ]
        : []),
      ...(content.note
        ? [
            {
              type: "context" as const,
              elements: [mrkdwn(escapeSlackText(content.note), SECTION_TEXT_MAX)],
            },
          ]
        : []),
    ],
  };
}

export class SlackWebhookError extends Error {
  constructor(reason: string) {
    super(`Slack refused the post: ${reason}`);
    this.name = "SlackWebhookError";
  }
}

/**
 * Posts one message. Slack's webhooks take no idempotency key, so a caller that retries can post
 * twice. The error never carries the URL, which is the secret.
 *
 * @throws SlackWebhookError when Slack does not answer, or answers anything but 2xx.
 */
export async function postSlackMessage(webhookUrl: string, message: SlackMessage): Promise<void> {
  const response = await fetch(webhookUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(message),
    signal: AbortSignal.timeout(5_000),
  }).catch((cause: unknown) => {
    throw new SlackWebhookError(cause instanceof Error ? cause.name : "no answer");
  });
  // Slack answers a short plain-text `ok`, or an error word such as `invalid_blocks`.
  await response.body?.cancel();
  if (!response.ok) throw new SlackWebhookError(`status ${response.status}`);
}
