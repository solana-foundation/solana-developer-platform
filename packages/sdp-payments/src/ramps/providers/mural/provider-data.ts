import type { CounterpartyProviderData } from "@sdp/types";
import { z } from "zod";
import { internalError } from "../../../errors";

export const MURAL_KYC_STATUSES = [
  "inactive",
  "pending",
  "approved",
  "errored",
  "rejected",
] as const;
export type MuralKycStatus = (typeof MURAL_KYC_STATUSES)[number];

export const MURAL_TOS_STATUSES = ["NOT_ACCEPTED", "NEEDS_REVIEW", "ACCEPTED"] as const;
export type MuralTosStatus = (typeof MURAL_TOS_STATUSES)[number];

export interface MuralOrganizationResolution {
  id?: string;
  type?: string;
  tosStatus?: MuralTosStatus;
  kycStatus?: MuralKycStatus;
  tosLink?: string;
  kycLink?: string;
}

export interface MuralPayinMethod {
  status: string;
  currency: string;
  payinRailDetails: Record<string, unknown>;
}

export interface MuralAccountResolution {
  id: string;
  isApiEnabled: boolean;
  status: string;
  payinMethods: MuralPayinMethod[];
}

const storedMuralOrganizationSchema = z.object({
  id: z.string().min(1).optional(),
  type: z.string().min(1).optional(),
  tosStatus: z.enum(MURAL_TOS_STATUSES).optional(),
  kycStatus: z.enum(MURAL_KYC_STATUSES).optional(),
  tosLink: z.string().min(1).optional(),
  kycLink: z.string().min(1).optional(),
});

const muralProviderDataSchema = z.looseObject({
  mural: z.record(z.string(), z.unknown()).optional(),
});

const muralOrganizationProviderDataSchema = z.looseObject({
  mural: z.looseObject({ organization: storedMuralOrganizationSchema.optional() }).optional(),
});

const muralTransferProviderDataSchema = z.looseObject({
  mural: z.looseObject({ accountId: z.string().min(1) }),
});

export function readMuralData(providerData: CounterpartyProviderData): Record<string, unknown> {
  const parsed = muralProviderDataSchema.safeParse(providerData);
  if (!parsed.success) {
    throw internalError("Malformed Mural state in provider_data.");
  }
  return parsed.data.mural === undefined ? {} : parsed.data.mural;
}

export function readMuralOrganization(
  providerData: CounterpartyProviderData
): MuralOrganizationResolution {
  const parsed = muralOrganizationProviderDataSchema.safeParse(providerData);
  if (!parsed.success) {
    throw internalError("Malformed Mural organization state in provider_data.");
  }
  const mural = parsed.data.mural;
  if (mural === undefined || mural.organization === undefined) {
    return {};
  }
  return mural.organization;
}

/**
 * Reads the Mural pay-in account id the on-ramp quote bound this transfer to.
 *
 * @param providerData - The transfer row's `provider_data` column.
 * @returns The Mural account id written at quote time.
 */
export function readMuralTransferAccountId(providerData: Record<string, unknown>): string {
  const parsed = muralTransferProviderDataSchema.safeParse(providerData);
  if (!parsed.success) {
    throw internalError("Mural on-ramp transfer has no bound pay-in account.");
  }
  return parsed.data.mural.accountId;
}

export function isMuralKycApproved(status: MuralKycStatus | undefined): boolean {
  return status === "approved";
}

export function isMuralTosAccepted(status: MuralTosStatus | undefined): boolean {
  return status === "ACCEPTED";
}
