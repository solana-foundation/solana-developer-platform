"use client";

import { z } from "zod";
import { useDashboardKeyScope, useDashboardRead } from "@/lib/dashboard-swr";
import { mainnetAccessSchema } from "./mainnet-access";
import { organizationQueryKeys } from "./organization-query-key";
import { alertEmailsEnabledOf, allowedIpsOf } from "./organization-settings";

const currentOrganizationResponseSchema = z.object({
  data: z
    .object({
      id: z.string().min(1),
      name: z.string(),
      settings: z
        .object({
          allowedIpAddresses: z.array(z.string()).optional(),
          alertEmails: z.boolean().optional(),
        })
        .nullable(),
    })
    .transform((organization) => ({
      id: organization.id,
      name: organization.name,
      allowedIps: allowedIpsOf(organization.settings),
      alertEmailsEnabled: alertEmailsEnabledOf(organization.settings),
    })),
});

const mainnetAccessResponseSchema = z.object({ data: mainnetAccessSchema });

/** The signed-in organization's SDP record: its id, name and organization-wide settings. */
export function useCurrentOrganization() {
  const scope = useDashboardKeyScope();
  const response = useDashboardRead(
    organizationQueryKeys.current(scope),
    currentOrganizationResponseSchema
  );
  return { ...response, data: response.data?.data };
}

/** Pass `null` until the organization's id is known, and nothing is read. */
export function useMainnetAccess(organizationId: string | null) {
  const scope = useDashboardKeyScope();
  const response = useDashboardRead(
    organizationId === null ? null : organizationQueryKeys.mainnetAccess(scope, { organizationId }),
    mainnetAccessResponseSchema
  );
  return { ...response, data: response.data?.data };
}
