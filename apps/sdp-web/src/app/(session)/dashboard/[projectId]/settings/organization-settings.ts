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

function saveResultSchema<TValue extends z.ZodType>(valueSchema: TValue) {
  return z.discriminatedUnion("ok", [
    z.object({ ok: z.literal(true), value: valueSchema }),
    z.object({ ok: z.literal(false), error: z.string() }),
  ]);
}

const allowlistSaveResultSchema = saveResultSchema(z.array(z.string()));
const alertEmailsSaveResultSchema = saveResultSchema(z.boolean());

// `answerSchema` reads sdp-api's organization into the saved setting; `resultSchema` checks that
// setting as the save's value, so the two never parse each other's shape.
async function patchOrganizationSettings<TResult extends z.ZodType>(
  organizationId: string,
  settings: { allowedIpAddresses: string[] } | { alertEmails: boolean },
  idempotencyKey: string,
  answerSchema: z.ZodType,
  resultSchema: TResult
): Promise<z.output<TResult>> {
  const result = await dashboardFetch<unknown>(
    `/api/dashboard/organizations/${encodeURIComponent(organizationId)}`,
    {
      method: "PATCH",
      headers: { [IDEMPOTENCY_KEY_HEADER]: idempotencyKey },
      body: { settings },
    }
  );
  if (!result.ok) return resultSchema.parse({ ok: false, error: result.error });
  const answer = z.object({ data: answerSchema }).safeParse(result.data);
  return resultSchema.parse(
    answer.success
      ? { ok: true, value: answer.data.data }
      : { ok: false, error: z.prettifyError(answer.error) }
  );
}

/**
 * Replaces the organization's API-key IP allowlist; an empty value clears it. The API
 * canonicalizes each entry, so the saved list is the one it returns.
 */
export function saveOrganizationIpAllowlist(
  organizationId: string,
  value: string,
  idempotencyKey: string
): Promise<z.output<typeof allowlistSaveResultSchema>> {
  return patchOrganizationSettings(
    organizationId,
    { allowedIpAddresses: parseAllowedIps(value) },
    idempotencyKey,
    organizationAllowlistSchema,
    allowlistSaveResultSchema
  );
}

/** Turns every alert email to the organization's admins on or off; the saved value is the API's. */
export function saveOrganizationAlertEmails(
  organizationId: string,
  enabled: boolean,
  idempotencyKey: string
): Promise<z.output<typeof alertEmailsSaveResultSchema>> {
  return patchOrganizationSettings(
    organizationId,
    { alertEmails: enabled },
    idempotencyKey,
    organizationAlertEmailsSchema,
    alertEmailsSaveResultSchema
  );
}
