/**
 * The daily post to #sdp-requests: the organizations created and the users who signed up on the
 * previous UTC day. It reads only, and posts through the same webhook as mainnet access requests
 * (`slack-webhook.ts`), so a deployment without that webhook posts nothing.
 */
import { getDb } from "@/db/client";
import { createKVStoreSet } from "@/runtime/kv-redis";
import {
  escapeSlackText,
  postSlackMessage,
  requestsSlackWebhookUrl,
  type SlackMessage,
} from "@/services/slack-webhook";
import type { Env } from "@/types/env";

export interface NewOrganization {
  name: string;
  id: string;
  /** The first admin's email, which for a new organization is the one who created it. */
  adminEmail: string | null;
}

export interface NewSignup {
  email: string;
  name: string | null;
}

export interface DailyGrowth {
  /** The UTC day summarized, `YYYY-MM-DD`. */
  day: string;
  organizations: NewOrganization[];
  signups: NewSignup[];
}

/** A list longer than this ends with "and N more", so one busy day can't flood the channel. */
const LISTED_MAX = 25;

/** The UTC day before `now`, as `YYYY-MM-DD`. */
export function previousUtcDay(now: Date): string {
  const day = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - 1));
  return day.toISOString().slice(0, 10);
}

function nextUtcDay(day: string): string {
  const next = new Date(`${day}T00:00:00Z`);
  next.setUTCDate(next.getUTCDate() + 1);
  return next.toISOString().slice(0, 10);
}

/**
 * The day's new organizations and signups. Timestamps are stored as UTC text
 * (`YYYY-MM-DD HH:MM:SS`, or ISO from some writers); both sort by their date prefix, so bounds
 * written as bare dates select the whole day in either form. Erased accounts are left out.
 */
export async function readDailyGrowth(env: Env, day: string): Promise<DailyGrowth> {
  const db = getDb(env);
  const end = nextUtcDay(day);
  const organizations = await db
    .prepare(
      `SELECT o.id, o.name,
              (SELECT u.email FROM organization_members m
                 JOIN users u ON u.id = m.user_id
                WHERE m.organization_id = o.id AND m.role IN ('admin', 'owner')
                  AND u.status <> 'deleted'
                ORDER BY m.created_at, m.id LIMIT 1) AS admin_email
         FROM organizations o
        WHERE o.created_at >= ? AND o.created_at < ?
        ORDER BY o.created_at, o.id`
    )
    .bind(day, end)
    .all<{ id: string; name: string; admin_email: string | null }>();
  const signups = await db
    .prepare(
      `SELECT email, name FROM users
        WHERE created_at >= ? AND created_at < ? AND status <> 'deleted'
        ORDER BY created_at, id`
    )
    .bind(day, end)
    .all<{ email: string; name: string | null }>();
  return {
    day,
    organizations: (organizations.results ?? []).map((row) => ({
      id: row.id,
      name: row.name,
      adminEmail: row.admin_email,
    })),
    signups: signups.results ?? [],
  };
}

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

function bulletList(lines: string[]): string {
  const listed = lines.slice(0, LISTED_MAX).map((line) => `• ${line}`);
  if (lines.length > LISTED_MAX) listed.push(`…and ${lines.length - LISTED_MAX} more`);
  return listed.join("\n");
}

const DAY_FORMAT = new Intl.DateTimeFormat("en-GB", {
  weekday: "short",
  day: "numeric",
  month: "short",
  year: "numeric",
  timeZone: "UTC",
});

/** The day as a Slack message: totals in the header, then each list. Every value is escaped. */
export function dailyGrowthMessage(growth: DailyGrowth): SlackMessage {
  const date = DAY_FORMAT.format(new Date(`${growth.day}T00:00:00Z`));
  const totals = `${plural(growth.organizations.length, "new organization", "new organizations")}, ${plural(growth.signups.length, "signup", "signups")}`;
  const section = (title: string, lines: string[], empty: string) => ({
    type: "section" as const,
    text: {
      type: "mrkdwn" as const,
      text: `*${title}*\n${lines.length ? bulletList(lines) : `_${empty}_`}`,
    },
  });
  return {
    text: `SDP daily: ${totals} on ${date}`,
    blocks: [
      { type: "header", text: { type: "plain_text", text: `SDP daily · ${date}` } },
      { type: "section", text: { type: "mrkdwn", text: `${totals} (UTC day).` } },
      section(
        "New organizations",
        growth.organizations.map(
          (org) =>
            `${escapeSlackText(org.name)} (\`${escapeSlackText(org.id)}\`)${org.adminEmail ? ` · ${escapeSlackText(org.adminEmail)}` : ""}`
        ),
        "None"
      ),
      section(
        "New signups",
        growth.signups.map((user) =>
          user.name
            ? `${escapeSlackText(user.name)} · ${escapeSlackText(user.email)}`
            : escapeSlackText(user.email)
        ),
        "None"
      ),
    ],
  };
}

/** Posts while the requests webhook is set. */
export function dailyGrowthSummaryEnabled(env: Env): boolean {
  return requestsSlackWebhookUrl(env) !== null;
}

const CLAIM_TTL_SECONDS = 3 * 24 * 60 * 60;

/**
 * Posts the previous UTC day's summary once. The cron fires several times a morning; the first
 * slot claims the day in Redis and the rest find it taken. A failed post lets the claim go, so the
 * next slot tries again.
 *
 * @returns Whether this call posted.
 * @throws When the post fails, after releasing the day for the next slot.
 */
export async function postDailyGrowthSummary(env: Env, now = new Date()): Promise<boolean> {
  const webhookUrl = requestsSlackWebhookUrl(env);
  if (!webhookUrl) return false;
  const day = previousUtcDay(now);
  const key = `slack-daily-growth:${day}`;
  const token = crypto.randomUUID();
  const kv = createKVStoreSet(env).cache;
  if (!(await kv.compareAndSet(key, null, token, { expirationTtl: CLAIM_TTL_SECONDS }))) {
    return false;
  }
  try {
    await postSlackMessage(webhookUrl, dailyGrowthMessage(await readDailyGrowth(env, day)));
  } catch (error) {
    await kv.compareAndDelete(key, token);
    throw error;
  }
  return true;
}
