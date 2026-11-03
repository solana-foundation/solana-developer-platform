/**
 * Who an admin alert delivery goes to:
 *
 * - `admin`: an active admin of the organization, told of a change in it.
 * - `affected`: the person a removal or demotion took admin access from. They are no longer an
 *   admin, so only this delivery can tell them; it is sent whatever the alert-email setting says.
 */
export const ADMIN_ALERT_AUDIENCES = ["admin", "affected"] as const;

export type AdminAlertAudience = (typeof ADMIN_ALERT_AUDIENCES)[number];

/**
 * Admin alert email deliveries (HOO-2299): one row per admin an alert goes to.
 *
 * - `pending`: not sent yet; the Worker claims and sends it, and retries a failed send.
 * - `sent`: Iterable accepted it.
 * - `abandoned`: given up after repeated failures, or a day old.
 * - `suppressed`: not sent on purpose: the recipient is no longer an active admin, or the
 *   organization turned alert emails off before it went out (an `affected` delivery is suppressed
 *   only when its recipient's account is no longer active).
 */
export const ADMIN_ALERT_DELIVERY_STATUSES = [
  "pending",
  "sent",
  "abandoned",
  "suppressed",
] as const;

export type AdminAlertDeliveryStatus = (typeof ADMIN_ALERT_DELIVERY_STATUSES)[number];
