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

type SaveResult<TValue extends z.ZodType> = z.infer<ReturnType<typeof saveResultSchema<TValue>>>;

async function patchOrganizationSettings<TValue extends z.ZodType>(
  organizationId: string,
  settings: { allowedIpAddresses: string[] } | { alertEmails: boolean },
  idempotencyKey: string,
  answerSchema: TValue
): Promise<SaveResult<TValue>> {
  const result = await dashboardFetch<unknown>(
    `/api/dashboard/organizations/${encodeURIComponent(organizationId)}`,
    {
      method: "PATCH",
      headers: { [IDEMPOTENCY_KEY_HEADER]: idempotencyKey },
      body: { settings },
    }
  );
  const resultSchema = saveResultSchema(answerSchema);
  if (!result.ok) return resultSchema.parse({ ok: false, error: result.error });
  // sdp-api answers `{ data, meta }`; the setting is the organization under `data`.
  const answer = z
    .object({ data: z.unknown() })
    .transform((envelope) => envelope.data)
    .pipe(answerSchema)
    .safeParse(result.data);
  return resultSchema.parse(
    answer.success
      ? { ok: true, value: answer.data }
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
): Promise<SaveResult<typeof organizationAllowlistSchema>> {
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
): Promise<SaveResult<typeof organizationAlertEmailsSchema>> {
  return patchOrganizationSettings(
    organizationId,
    { alertEmails: enabled },
    idempotencyKey,
    organizationAlertEmailsSchema
  );
}
