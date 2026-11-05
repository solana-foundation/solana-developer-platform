import { z } from "zod";
import { createOrgSdpApiClient } from "@/lib/sdp-api";
import { readableApiError } from "@/lib/sdp-api-error";
import { mainnetAccessSchema } from "./mainnet-access";
import { resolveOrganizationId } from "./organization-id";

const organizationNameSchema = z.object({ name: z.string() });

const mainnetAccessLoadSchema = z.discriminatedUnion("ok", [
  z.object({
    ok: z.literal(true),
    organizationId: z.string(),
    organizationName: z.string(),
    access: mainnetAccessSchema,
  }),
  z.object({ ok: z.literal(false), error: z.string() }),
]);

/** Where the signed-in organization's mainnet access stands, with the name an admin accepts for. */
export async function loadMainnetAccess(): Promise<z.infer<typeof mainnetAccessLoadSchema>> {
  try {
    const client = await createOrgSdpApiClient();
    const organizationId = await resolveOrganizationId(client);
    const organizationPath = `/v1/organizations/${encodeURIComponent(organizationId)}`;
    const [access, organization] = await Promise.all([
      client.fetch<unknown>(`${organizationPath}/mainnet-access`),
      client.fetch<unknown>(organizationPath),
    ]);
    return {
      ok: true,
      organizationId,
      organizationName: organizationNameSchema.parse(organization).name,
      access: mainnetAccessSchema.parse(access),
    };
  } catch (error) {
    return { ok: false, error: readableApiError(error) };
  }
}
