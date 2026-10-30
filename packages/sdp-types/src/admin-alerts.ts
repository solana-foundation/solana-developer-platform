/**
 * Admin alert email deliveries (HOO-2299): one row per admin an alert goes to.
 *
 * - `pending`: not sent yet; the Worker claims and sends it, and retries a failed send.
 * - `sent`: Iterable accepted it.
 * - `abandoned`: given up after repeated failures, or a day old.
 * - `suppressed`: not sent on purpose: the recipient is no longer an active admin, or the
 *   organization turned alert emails off before it went out.
 */
export const ADMIN_ALERT_DELIVERY_STATUSES = [
  "pending",
  "sent",
  "abandoned",
  "suppressed",
] as const;

export type AdminAlertDeliveryStatus = (typeof ADMIN_ALERT_DELIVERY_STATUSES)[number];
