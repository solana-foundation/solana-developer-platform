/**
 * Posts to the operators' Slack channel (#sdp-requests) through an incoming webhook. Each message
 * is one attachment: a colored bar down its left edge and Block Kit blocks inside. Email stays the
 * record for mainnet access; a post is best-effort, and a deployment without the webhook posts
 * nothing.
 */
import { z } from "zod";
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

/** The bar colors, one per kind of post, so the channel reads at a glance. */
export const SLACK_COLORS = {
  /** A new mainnet access request, waiting on an operator. */
  pending: "#F2A93B",
  /** A request whose details an operator corrected. */
  corrected: "#4A90E2",
  /** A request an operator reset; the earlier post no longer stands. */
  reset: "#E01E5A",
  /** The daily growth summary, in Solana purple. */
  daily: "#9945FF",
} as const;

/**
 * The three characters Slack reads as markup. Escaped, customer text can't write a mention
 * (`<!channel>`), a user ping or a link that hides where it goes.
 */
export function escapeSlackText(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Cuts text to `max` characters with an ellipsis. Cut before escaping, so no entity is split. */
export function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/** Slack's limits (Block Kit reference) for a section's text and one field's text. */
const SECTION_TEXT_MAX = 3000;
const FIELD_TEXT_MAX = 2000;

export type SlackText = { type: "plain_text" | "mrkdwn"; text: string };
export type SlackButton = {
  type: "button";
  text: SlackText;
  url: string;
  style?: "primary" | "danger";
};
export type SlackBlock =
  | { type: "section"; text?: SlackText; fields?: SlackText[] }
  | { type: "actions"; elements: SlackButton[] }
  | { type: "context"; elements: SlackText[] }
  | { type: "divider" };

export interface SlackMessage {
  /** What notifications and clients without blocks show. */
  text: string;
  attachments: [{ color: string; blocks: SlackBlock[] }];
}

/** A mrkdwn section; `text` is already escaped and is cut to Slack's limit. */
export function mrkdwnSection(text: string): SlackBlock {
  return { type: "section", text: { type: "mrkdwn", text: truncate(text, SECTION_TEXT_MAX) } };
}

/** A row of mrkdwn fields, two to a line; each is already escaped and is cut to Slack's limit. */
export function fieldsSection(fields: string[]): SlackBlock {
  return {
    type: "section",
    fields: fields.map((text) => ({ type: "mrkdwn", text: truncate(text, FIELD_TEXT_MAX) })),
  };
}

/** A small grey line; `text` is already escaped. */
export function contextLine(text: string): SlackBlock {
  return {
    type: "context",
    elements: [{ type: "mrkdwn", text: truncate(text, SECTION_TEXT_MAX) }],
  };
}

/** A link button; the label is plain text, so it needs no escaping, and is cut to Slack's 75. */
export function linkButton(label: string, url: string, style?: "primary"): SlackButton {
  return {
    type: "button",
    text: { type: "plain_text", text: truncate(label, 75) },
    url,
    ...(style ? { style } : {}),
  };
}

/**
 * One message. `text` is plain and escaped here: with the blocks inside an attachment, Slack
 * renders it as the message's visible mrkdwn line, so raw customer text in it could mention the
 * channel or disguise a link.
 */
export function slackMessage(text: string, color: string, blocks: SlackBlock[]): SlackMessage {
  return {
    text: escapeSlackText(truncate(text, SECTION_TEXT_MAX)),
    attachments: [{ color, blocks }],
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
