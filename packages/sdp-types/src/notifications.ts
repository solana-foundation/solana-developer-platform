// Notification center domain: the shared vocabulary between sdp-api (producers,
// dispatcher, preferences API) and sdp-web (bell, settings UI). SHAPES ONLY — the
// dispatch/fan-out logic lives in apps/sdp-api/src/services/notifications.

// ── Vocabulary (stable string keys; validated app-side, stored as open TEXT) ──

// Preference categories: the rows of the settings matrix. Coarse on purpose — users
// opt out of a kind of noise ("workflow emails"), not individual event types.
export const NOTIFICATION_CATEGORIES = [
  "workflows",
  "approvals",
  "members",
  "payments",
  "compliance",
] as const;
export type NotificationCategory = (typeof NOTIFICATION_CATEGORIES)[number];

// Delivery channels: the columns of the settings matrix.
export const NOTIFICATION_CHANNELS = ["in_app", "email"] as const;
export type NotificationChannel = (typeof NOTIFICATION_CHANNELS)[number];

// type → category. `type` is the stable per-event key the bell localizes from
// (Shared.notifications.types.<type>); category is DERIVED here in code and never
// stored, so extending the taxonomy is a code change, not a migration.
export const NOTIFICATION_TYPE_CATEGORY = {
  // Existing notify-action type — value unchanged so shipped rows keep rendering.
  workflow_execution: "workflows",
  workflow_run_failed: "workflows",
  workflow_approval_requested: "approvals",
  // params.decision: "approved" | "rejected"
  workflow_approval_decided: "approvals",
  member_invited: "members",
  member_joined: "members",
  member_invite_revoked: "members",
  member_removed: "members",
  // params.direction: "onramp" | "offramp"
  payment_settled: "payments",
  recurring_payment_failed: "payments",
  kyc_approved: "compliance",
  kyc_rejected: "compliance",
} as const satisfies Record<string, NotificationCategory>;
export type NotificationType = keyof typeof NOTIFICATION_TYPE_CATEGORY;

export function notificationCategoryFor(type: NotificationType): NotificationCategory {
  return NOTIFICATION_TYPE_CATEGORY[type];
}

// ── Wire shapes ──

// A notification row as the API returns it (snake_case — raw DB row shape).
export interface NotificationDto {
  id: string;
  organization_id: string;
  user_id: string;
  type: string;
  title: string;
  body: string | null;
  resource_type: string | null;
  resource_id: string | null;
  // Structured facts for client-side (localized) rendering; title/body are the fallback.
  params: Record<string, unknown> | null;
  read_at: string | null;
  created_at: string;
}

// One cell of the preferences matrix. The API always returns the EFFECTIVE matrix
// (every category × channel with the all-enabled default applied); PUT accepts a
// partial list and upserts only the cells sent.
export interface NotificationPreferenceDto {
  category: NotificationCategory;
  channel: NotificationChannel;
  enabled: boolean;
}

export interface NotificationPreferencesResponse {
  preferences: NotificationPreferenceDto[];
  emailEnabled: boolean;
}

// ── Realtime nudge contract (Redis pub/sub → SSE → browser) ──

// Payload pushed when a user's inbox changes. Deliberately tiny: the client treats it
// as "refetch now" plus a badge fast-path — the REST list stays the only data contract.
export interface NotificationInboxNudge {
  unread: number;
  // ISO timestamp of the publish, for debugging staleness; not used for ordering.
  ts: string;
}

// Redis channel per (org, user) inbox. Exact-channel SUBSCRIBE only — never pattern-
// subscribe to `notifications:inbox:*`, which would fan every org's nudges to every
// replica.
export function notificationInboxChannel(organizationId: string, userId: string): string {
  return `notifications:inbox:${organizationId}:${userId}`;
}
