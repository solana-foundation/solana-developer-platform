import type { Member } from "@/app/members/actions";

/**
 * A misconfigured Clerk JWT template can store an unsubstituted placeholder —
 * literally `{{user.primary_email_address.email_address}}` — as a user's email.
 * Printing that verbatim reads as a rendering bug rather than as the data problem
 * it is, so anything that is not an address is discarded.
 */
function usableEmail(value: string): string | null {
  const trimmed = value?.trim() ?? "";
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed) ? trimmed : null;
}

/**
 * `usr_d3f5b5bf-8f8c-448b-bb40-7e31b35baba1` → `usr_d3f5b5bf…baba1`
 *
 * 12 leading characters, not 13: ids are `usr_` plus a UUID, so 13 would end on the
 * first hyphen and leave a dangling separator before the ellipsis.
 */
function shortenUserId(userId: string): string {
  return userId.length > 20 ? `${userId.slice(0, 12)}…${userId.slice(-5)}` : userId;
}

export interface MemberIdentity {
  /** Always non-empty: what the row and the remove confirmation both display. */
  label: string;
  /** Secondary line, only when the label is already the name. */
  email: string | null;
  /** True when neither a name nor a usable email was available. */
  isUnresolved: boolean;
}

/**
 * Every row has to identify somebody: an admin reads it to decide whether to remove
 * that person, and the confirmation dialog quotes the same label back. Name and email
 * can *both* be unusable — migration 0040 deliberately leaves a row alone when both
 * copies of the email hold the placeholder, because nothing local can recover it — and
 * the previous fallback rendered a bare em-dash, which identified nobody and made the
 * remove dialog read "Remove —". The user id is the last resort: it is always present
 * and it is what support correlates on anyway.
 */
export function resolveMemberIdentity(user: Member["user"]): MemberIdentity {
  const name = user.name?.trim();
  const email = usableEmail(user.email);

  if (name) return { label: name, email, isUnresolved: false };
  if (email) return { label: email, email: null, isUnresolved: false };
  return { label: shortenUserId(user.id), email: null, isUnresolved: true };
}
