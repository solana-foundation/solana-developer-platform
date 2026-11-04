import { z } from "zod";
import { type DashboardFetchResult, dashboardFetch } from "@/lib/dashboard-fetch";
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

const saveFailureSchema = z.object({ ok: z.literal(false), error: z.string() });

const allowlistSaveResultSchema = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), value: z.array(z.string()) }),
  saveFailureSchema,
]);

const alertEmailsSaveResultSchema = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), value: z.boolean() }),
  saveFailureSchema,
]);

function patchOrganizationSettings(
  organizationId: string,
  settings: { allowedIpAddresses: string[] } | { alertEmails: boolean },
  idempotencyKey: string
): Promise<DashboardFetchResult<unknown>> {
  return dashboardFetch<unknown>(
    `/api/dashboard/organizations/${encodeURIComponent(organizationId)}`,
    {
      method: "PATCH",
      headers: { [IDEMPOTENCY_KEY_HEADER]: idempotencyKey },
      body: { settings },
    }
  );
}

/**
 * Replaces the organization's API-key IP allowlist; an empty value clears it. The API
 * canonicalizes each entry, so the saved list is the one it returns.
 */
export async function saveOrganizationIpAllowlist(
  organizationId: string,
  value: string,
  idempotencyKey: string
): Promise<z.infer<typeof allowlistSaveResultSchema>> {
  const result = await patchOrganizationSettings(
    organizationId,
    { allowedIpAddresses: parseAllowedIps(value) },
    idempotencyKey
  );
  if (!result.ok) return { ok: false, error: result.error };
  const parsed = z.object({ data: organizationAllowlistSchema }).safeParse(result.data);
  return parsed.success
    ? { ok: true, value: parsed.data.data }
    : { ok: false, error: z.prettifyError(parsed.error) };
}

/** Turns every alert email to the organization's admins on or off; the saved value is the API's. */
export async function saveOrganizationAlertEmails(
  organizationId: string,
  enabled: boolean,
  idempotencyKey: string
): Promise<z.infer<typeof alertEmailsSaveResultSchema>> {
  const result = await patchOrganizationSettings(
    organizationId,
    { alertEmails: enabled },
    idempotencyKey
  );
  if (!result.ok) return { ok: false, error: result.error };
  const parsed = z.object({ data: organizationAlertEmailsSchema }).safeParse(result.data);
  return parsed.success
    ? { ok: true, value: parsed.data.data }
    : { ok: false, error: z.prettifyError(parsed.error) };
}
