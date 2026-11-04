import { COUNTRY_CODES, type CountryCode } from "@sdp/types/countries";
import { MAINNET_ACCESS_STATES, type MainnetAccess } from "@sdp/types/mainnet-access";
import { z } from "zod";
import { type DashboardFetchResult, dashboardFetch } from "@/lib/dashboard-fetch";

export const mainnetAccessSchema = z.object({
  state: z.enum(MAINNET_ACCESS_STATES),
  available: z.boolean(),
  countryCode: z.enum(COUNTRY_CODES).nullable(),
  request: z
    .object({
      requestedAt: z.string(),
      requestedByUserId: z.string(),
      termsVersion: z.string(),
      notified: z.boolean(),
    })
    .nullable(),
  contactEmail: z.string().nullable(),
}) satisfies z.ZodType<MainnetAccess>;

const requestInputSchema = z.object({
  countryCode: z.enum(COUNTRY_CODES),
  termsVersion: z.string().min(1).max(64),
});

const requestMainnetAccessResultSchema = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), access: mainnetAccessSchema }),
  z.object({ ok: z.literal(false), error: z.string() }),
]);

export type RequestMainnetAccessResult = z.infer<typeof requestMainnetAccessResultSchema>;

function mainnetAccessPath(organizationId: string): string {
  return `/api/dashboard/organizations/${encodeURIComponent(organizationId)}/mainnet-access`;
}

function accessAnswer(result: DashboardFetchResult<unknown>): RequestMainnetAccessResult {
  if (!result.ok) return { ok: false, error: result.error };
  const parsed = z.object({ data: mainnetAccessSchema }).safeParse(result.data);
  return parsed.success
    ? { ok: true, access: parsed.data.data }
    : { ok: false, error: z.prettifyError(parsed.error) };
}

/**
 * Sends the one-time request: the jurisdiction and the terms version the admin accepted. The
 * API refuses a second request, so a retried submit cannot ask twice; a request whose email
 * did not go out is sent with {@link notifyMainnetAccess}.
 */
export async function requestMainnetAccess(
  organizationId: string,
  input: { countryCode: CountryCode; termsVersion: string }
): Promise<RequestMainnetAccessResult> {
  const parsed = requestInputSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: z.prettifyError(parsed.error) };
  return accessAnswer(
    await dashboardFetch<unknown>(mainnetAccessPath(organizationId), {
      method: "POST",
      body: {
        countryCode: parsed.data.countryCode,
        termsVersion: parsed.data.termsVersion,
        acceptTerms: true,
      },
    })
  );
}

/** Sends the recorded request whose email did not go out. */
export async function notifyMainnetAccess(
  organizationId: string
): Promise<RequestMainnetAccessResult> {
  return accessAnswer(
    await dashboardFetch<unknown>(`${mainnetAccessPath(organizationId)}/notify`, {
      method: "POST",
    })
  );
}
