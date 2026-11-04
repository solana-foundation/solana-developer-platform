import type { MainnetAccess } from "@sdp/types/mainnet-access";
import { z } from "zod";
import { createOrgSdpApiClient } from "@/lib/sdp-api";
import { readableApiError } from "@/lib/sdp-api-error";
import { mainnetAccessSchema } from "./mainnet-access";
import { resolveOrganizationId } from "./organization-id";

const organizationNameSchema = z.object({ name: z.string() });

export type MainnetAccessLoad =
  | { ok: true; organizationId: string; organizationName: string; access: MainnetAccess }
  | { ok: false; error: string };

/** Where the signed-in organization's mainnet access stands, with the name an admin accepts for. */
export async function loadMainnetAccess(): Promise<MainnetAccessLoad> {
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
