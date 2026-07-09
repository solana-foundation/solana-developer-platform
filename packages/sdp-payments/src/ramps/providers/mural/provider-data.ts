import type { CounterpartyProviderData } from "@sdp/types";
import { z } from "zod";
import { internalError } from "../../../errors";
import { readRecord } from "../../../json";

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

export function readMuralData(providerData: CounterpartyProviderData): Record<string, unknown> {
  const mural = readRecord(providerData.mural);
  if (mural === undefined) {
    return {};
  }
  return mural;
}

export function readMuralOrganization(
  providerData: CounterpartyProviderData
): MuralOrganizationResolution {
  const organization = readRecord(readMuralData(providerData).organization);
  if (organization === undefined) {
    return {};
  }
  const parsed = storedMuralOrganizationSchema.safeParse(organization);
  if (!parsed.success) {
    throw internalError("Malformed Mural organization state in provider_data.");
  }
  return parsed.data;
}

export function isMuralKycApproved(status: MuralKycStatus | undefined): boolean {
  return status === "approved";
}

export function isMuralTosAccepted(status: MuralTosStatus | undefined): boolean {
  return status === "ACCEPTED";
}
