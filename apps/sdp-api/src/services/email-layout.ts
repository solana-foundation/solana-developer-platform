/**
 * The one layout every SDP email uses, rendered here so its look is reviewed in this repository.
 * An email is structured content (a heading, a summary, labelled details, at most one action);
 * this renders it twice from the same data: an HTML part in the shape transactional senders such
 * as Stripe and Linear use (a centred card, a details table, one button), built from tables with
 * inline styles because mail clients drop stylesheets; and a plain-text part.
 *
 * Every string is escaped here. Iterable's template renders the HTML part raw (`{{{bodyHtml}}}`),
 * so this is the only escape between customer-supplied text and the reader.
 */
import { z } from "zod";

export interface EmailDetail {
  label: string;
  value: string;
}

export interface EmailContent {
  /** Shown first in the inbox after the subject, and hidden in the body. */
  preheader: string;
  heading: string;
  summary: string;
  details?: readonly EmailDetail[];
  /** A link SDP itself chose, never one built from customer input. https, or http to localhost. */
  action?: { label: string; url: string };
  /** A closing note under the details, such as how to act on the email. */
  note?: string;
}

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** An https link, or an http one to this machine, so a local dashboard link works in local dev. */
const actionUrlSchema = z.url({ protocol: /^https?$/ }).refine((url) => {
  const parsed = new URL(url);
  return parsed.protocol === "https:" || LOOPBACK_HOSTS.has(parsed.hostname);
}, "An email action links over https, or over http only to localhost");

const HTML_ESCAPES = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
} as const satisfies Record<string, string>;

type HtmlEscaped = keyof typeof HTML_ESCAPES;

function isHtmlEscaped(character: string): character is HtmlEscaped {
  return Object.hasOwn(HTML_ESCAPES, character);
}

function escapeHtmlCharacter(character: string): string {
  if (!isHtmlEscaped(character)) throw new Error(`No HTML escape for ${JSON.stringify(character)}`);
  return HTML_ESCAPES[character];
}

/** Every character HTML reads, escaped; line breaks kept as `<br>`. */
export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, escapeHtmlCharacter).replace(/\r?\n/g, "<br>");
}

const FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Inter,Roboto,Helvetica,Arial,sans-serif";
const COLOR = {
  page: "#f5f6f8",
  card: "#ffffff",
  border: "#e6e8ec",
  divider: "#eef0f3",
  detailsBackground: "#fafbfc",
  heading: "#0f1115",
  text: "#3c4149",
  muted: "#6b7280",
  faint: "#9aa1ab",
  button: "#111318",
  buttonText: "#ffffff",
} as const satisfies Record<string, string>;

function detailsHtml(details: readonly EmailDetail[]): string {
  const rows = details
    .map((detail, index) => {
      const border = index === 0 ? "" : `border-top:1px solid ${COLOR.divider};`;
      return `<tr>
<td style="${border}padding:12px 16px;width:38%;vertical-align:top;font-size:13px;line-height:20px;color:${COLOR.muted};">${escapeHtml(detail.label)}</td>
<td style="${border}padding:12px 16px;vertical-align:top;font-size:14px;line-height:20px;color:${COLOR.heading};word-break:break-word;">${escapeHtml(detail.value)}</td>
</tr>`;
    })
    .join("\n");
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:24px 0 0;border:1px solid ${COLOR.border};border-radius:10px;background:${COLOR.detailsBackground};border-collapse:separate;">
${rows}
</table>`;
}

function actionHtml(action: NonNullable<EmailContent["action"]>): string {
  const url = escapeHtml(actionUrlSchema.parse(action.url));
  return `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:28px 0 0;">
<tr><td style="border-radius:8px;background:${COLOR.button};">
<a href="${url}" style="display:inline-block;padding:12px 20px;font-size:14px;font-weight:600;line-height:20px;color:${COLOR.buttonText};text-decoration:none;border-radius:8px;">${escapeHtml(action.label)}</a>
</td></tr>
</table>`;
}

/** The HTML part: a complete document, so the campaign's template only renders it. */
export function renderEmailHtml(content: EmailContent): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light">
<meta name="supported-color-schemes" content="light">
<title>${escapeHtml(content.heading)}</title>
</head>
<body style="margin:0;padding:0;background:${COLOR.page};">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;">${escapeHtml(content.preheader)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${COLOR.page};font-family:${FONT};">
<tr><td align="center" style="padding:40px 16px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;">
<tr><td style="padding:0 4px 16px;font-size:13px;font-weight:600;letter-spacing:0.2px;color:${COLOR.heading};">Solana Developer Platform</td></tr>
<tr><td style="background:${COLOR.card};border:1px solid ${COLOR.border};border-radius:12px;padding:32px;">
<h1 style="margin:0;font-size:20px;line-height:28px;font-weight:600;color:${COLOR.heading};">${escapeHtml(content.heading)}</h1>
<p style="margin:12px 0 0;font-size:15px;line-height:24px;color:${COLOR.text};">${escapeHtml(content.summary)}</p>
${content.details?.length ? detailsHtml(content.details) : ""}
${content.action ? actionHtml(content.action) : ""}
${content.note ? `<p style="margin:24px 0 0;font-size:13px;line-height:20px;color:${COLOR.muted};">${escapeHtml(content.note)}</p>` : ""}
</td></tr>
<tr><td style="padding:16px 4px 0;font-size:12px;line-height:18px;color:${COLOR.faint};">Sent by Solana Developer Platform, Solana Foundation.</td></tr>
</table>
</td></tr>
</table>
</body>
</html>`;
}

/** The plain-text part, from the same content. */
export function renderEmailText(content: EmailContent): string {
  const sections = [content.heading, content.summary];
  if (content.details?.length) {
    sections.push(content.details.map((detail) => `${detail.label}: ${detail.value}`).join("\n"));
  }
  if (content.action) {
    sections.push(`${content.action.label}: ${actionUrlSchema.parse(content.action.url)}`);
  }
  if (content.note) sections.push(content.note);
  sections.push("Sent by Solana Developer Platform, Solana Foundation.");
  return sections.join("\n\n");
}
