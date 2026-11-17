/**
 * The daily post to #sdp-requests: the organizations created and the users who signed up on the
 * previous UTC day, against the day before and the last seven days. It reads only, and posts
 * through the same webhook as mainnet access requests (`slack-webhook.ts`), so a deployment
 * without that webhook posts nothing.
 */
import { getDb } from "@/db/client";
import { createKVStoreSet } from "@/runtime/kv-redis";
import {
  contextLine,
  escapeSlackText,
  fieldsSection,
  mrkdwnSection,
  postSlackMessage,
  requestsSlackWebhookUrl,
  SLACK_COLORS,
  type SlackMessage,
  slackMessage,
  truncate,
} from "@/services/slack-webhook";
import type { Env } from "@/types/env";

export interface NewOrganization {
  id: string;
  name: string;
  /** The first admin's email, which for a new organization is the one who created it. */
  adminEmail: string | null;
}

export interface NewSignup {
  email: string;
  name: string | null;
  /**
   * The user's first organization: `created` when they are its first admin, `joined` otherwise.
   * Null while they belong to none.
   */
  organization: { name: string; relation: "created" | "joined" } | null;
}

export interface DailyGrowth {
  /** The UTC day summarized, `YYYY-MM-DD`. */
  day: string;
  organizations: NewOrganization[];
  signups: NewSignup[];
  /** The day before's totals, for the change shown beside each count. */
  previousDay: { organizations: number; signups: number };
  /** The seven UTC days ending with `day`. */
  lastSevenDays: { organizations: number; signups: number; mainnetRequests: number };
}

/** A list longer than this ends with "and N more", so one busy day can't flood the channel. */
const LISTED_MAX = 15;
/** One list line's customer text is cut to this, which keeps a full list under Slack's 3,000. */
const LINE_TEXT_MAX = 120;

function shiftUtcDay(day: string, days: number): string {
  const shifted = new Date(`${day}T00:00:00Z`);
  shifted.setUTCDate(shifted.getUTCDate() + days);
  return shifted.toISOString().slice(0, 10);
}

/** The UTC day before `now`, as `YYYY-MM-DD`. */
export function previousUtcDay(now: Date): string {
  return shiftUtcDay(now.toISOString().slice(0, 10), -1);
}

/**
 * The day's new organizations and signups, and the totals around it. Timestamps are stored as UTC
 * text (`YYYY-MM-DD HH:MM:SS`, or ISO from some writers); both sort by their date prefix, so bounds
 * written as bare dates select whole days in either form. Erased accounts are left out.
 */
export async function readDailyGrowth(env: Env, day: string): Promise<DailyGrowth> {
  const db = getDb(env);
  const end = shiftUtcDay(day, 1);
  const previous = shiftUtcDay(day, -1);
  const weekStart = shiftUtcDay(day, -6);

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

  // Each signup's first membership, and whether they were that organization's first admin.
  const signups = await db
    .prepare(
      `SELECT u.email, u.name, first.name AS organization_name, first.created AS created
         FROM users u
         LEFT JOIN LATERAL (
           SELECT o.name,
                  m.role IN ('admin', 'owner') AND NOT EXISTS (
                    SELECT 1 FROM organization_members earlier
                     WHERE earlier.organization_id = m.organization_id
                       AND earlier.role IN ('admin', 'owner')
                       AND (earlier.created_at, earlier.id) < (m.created_at, m.id)
                  ) AS created
             FROM organization_members m
             JOIN organizations o ON o.id = m.organization_id
            WHERE m.user_id = u.id
            ORDER BY m.created_at, m.id
            LIMIT 1
         ) first ON TRUE
        WHERE u.created_at >= ? AND u.created_at < ? AND u.status <> 'deleted'
        ORDER BY u.created_at, u.id`
    )
    .bind(day, end)
    .all<{
      email: string;
      name: string | null;
      organization_name: string | null;
      created: boolean | null;
    }>();

  const totals = await db
    .prepare(
      `SELECT
         (SELECT COUNT(*) FROM organizations WHERE created_at >= ? AND created_at < ?) AS previous_organizations,
         (SELECT COUNT(*) FROM users WHERE created_at >= ? AND created_at < ? AND status <> 'deleted') AS previous_signups,
         (SELECT COUNT(*) FROM organizations WHERE created_at >= ? AND created_at < ?) AS week_organizations,
         (SELECT COUNT(*) FROM users WHERE created_at >= ? AND created_at < ? AND status <> 'deleted') AS week_signups,
         (SELECT COUNT(*) FROM organizations WHERE mainnet_requested_at >= ? AND mainnet_requested_at < ?) AS week_mainnet_requests`
    )
    .bind(previous, day, previous, day, weekStart, end, weekStart, end, weekStart, end)
    .first<Record<string, number | string>>();
  const count = (key: string) => Number(totals?.[key] ?? 0);

  return {
    day,
    organizations: (organizations.results ?? []).map((row) => ({
      id: row.id,
      name: row.name,
      adminEmail: row.admin_email,
    })),
    signups: (signups.results ?? []).map((row) => ({
      email: row.email,
      name: row.name,
      organization: row.organization_name
        ? { name: row.organization_name, relation: row.created ? "created" : "joined" }
        : null,
    })),
    previousDay: {
      organizations: count("previous_organizations"),
      signups: count("previous_signups"),
    },
    lastSevenDays: {
      organizations: count("week_organizations"),
      signups: count("week_signups"),
      mainnetRequests: count("week_mainnet_requests"),
    },
  };
}

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

/** Customer text for one list line: cut, then escaped. */
function text(value: string): string {
  return escapeSlackText(truncate(value, LINE_TEXT_MAX));
}

function bulletList(lines: string[]): string {
  if (lines.length === 0) return "_None_";
  const listed = lines.slice(0, LISTED_MAX).map((line) => `• ${line}`);
  if (lines.length > LISTED_MAX) listed.push(`_…and ${lines.length - LISTED_MAX} more_`);
  return listed.join("\n");
}

/** The change from the day before, such as `↑ 2 vs Sun`. */
function change(today: number, before: number, beforeName: string): string {
  if (today === before) return `same as ${beforeName}`;
  return `${today > before ? "↑" : "↓"} ${Math.abs(today - before)} vs ${beforeName}`;
}

const DAY_FORMAT = new Intl.DateTimeFormat("en-GB", {
  weekday: "short",
  day: "numeric",
  month: "short",
  timeZone: "UTC",
});
const WEEKDAY_FORMAT = new Intl.DateTimeFormat("en-GB", { weekday: "short", timeZone: "UTC" });

function signupLine(signup: NewSignup): string {
  const who = signup.name ? `${text(signup.name)} · ${text(signup.email)}` : text(signup.email);
  const organization = signup.organization
    ? `_${signup.organization.relation} ${text(signup.organization.name)}_`
    : "_no organization yet_";
  return `${who} · ${organization}`;
}

/** The day as a Slack message: totals and their change, the week, then each list. */
export function dailyGrowthMessage(growth: DailyGrowth): SlackMessage {
  const date = new Date(`${growth.day}T00:00:00Z`);
  const dayName = DAY_FORMAT.format(date);
  const beforeName = WEEKDAY_FORMAT.format(new Date(`${shiftUtcDay(growth.day, -1)}T00:00:00Z`));
  const orgs = growth.organizations.length;
  const signups = growth.signups.length;
  const week = growth.lastSevenDays;
  return slackMessage(
    `SDP daily: ${plural(orgs, "new organization", "new organizations")}, ${plural(signups, "signup", "signups")} on ${dayName}`,
    SLACK_COLORS.daily,
    [
      mrkdwnSection(`*:chart_with_upwards_trend: SDP daily · ${dayName}*`),
      fieldsSection([
        `*New organizations*\n*${orgs}*  ${change(orgs, growth.previousDay.organizations, beforeName)}`,
        `*New signups*\n*${signups}*  ${change(signups, growth.previousDay.signups, beforeName)}`,
      ]),
      contextLine(
        `Last 7 days: *${week.organizations}* organizations · *${week.signups}* signups · *${week.mainnetRequests}* mainnet ${week.mainnetRequests === 1 ? "request" : "requests"} · UTC days`
      ),
      { type: "divider" },
      mrkdwnSection(
        `*:office: New organizations*\n${bulletList(
          growth.organizations.map(
            (org) => `*${text(org.name)}*${org.adminEmail ? ` · ${text(org.adminEmail)}` : ""}`
          )
        )}`
      ),
      mrkdwnSection(
        `*:bust_in_silhouette: New signups*\n${bulletList(growth.signups.map(signupLine))}`
      ),
    ]
  );
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
