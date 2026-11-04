import { z } from "zod";
import { dashboardFetch } from "@/lib/dashboard-fetch";
import { IDEMPOTENCY_KEY_HEADER } from "@/lib/idempotency";
import { parseAllowedIps } from "@/lib/ip-allowlist-input";

/** The organization read; an absent allowlist is an unrestricted one. */
export const organizationAllowlistSchema = z
  .object({
    settings: z.object({ allowedIpAddresses: z.array(z.string()).optional() }).nullable(),
  })
  .transform((organization) => organization.settings?.allowedIpAddresses ?? []);

/** The organization read; an unset `alertEmails` means alert emails are on. */
export const organizationAlertEmailsSchema = z
  .object({ settings: z.object({ alertEmails: z.boolean().optional() }).nullable() })
  .transform((organization) => organization.settings?.alertEmails !== false);

type SaveResult<T> = { ok: true; value: T } | { ok: false; error: string };

async function patchOrganizationSettings<T>(
  organizationId: string,
  settings: { allowedIpAddresses: string[] } | { alertEmails: boolean },
  idempotencyKey: string,
  answerSchema: z.ZodType<T>
): Promise<SaveResult<T>> {
  const result = await dashboardFetch<unknown>(
    `/api/dashboard/organizations/${encodeURIComponent(organizationId)}`,
    {
      method: "PATCH",
      headers: { [IDEMPOTENCY_KEY_HEADER]: idempotencyKey },
      body: { settings },
    }
  );
  if (!result.ok) return { ok: false, error: result.error };
  const parsed = z.object({ data: answerSchema }).safeParse(result.data);
  return parsed.success
    ? { ok: true, value: parsed.data.data }
    : { ok: false, error: z.prettifyError(parsed.error) };
}

/**
 * Replaces the organization's API-key IP allowlist; an empty value clears it. The API
 * canonicalizes each entry, so the saved list is the one it returns.
 */
export function saveOrganizationIpAllowlist(
  organizationId: string,
  value: string,
  idempotencyKey: string
): Promise<SaveResult<string[]>> {
  return patchOrganizationSettings(
    organizationId,
    { allowedIpAddresses: parseAllowedIps(value) },
    idempotencyKey,
    organizationAllowlistSchema
  );
}

/** Turns every alert email to the organization's admins on or off; the saved value is the API's. */
export function saveOrganizationAlertEmails(
  organizationId: string,
  enabled: boolean,
  idempotencyKey: string
): Promise<SaveResult<boolean>> {
  return patchOrganizationSettings(
    organizationId,
    { alertEmails: enabled },
    idempotencyKey,
    organizationAlertEmailsSchema
  );
}
