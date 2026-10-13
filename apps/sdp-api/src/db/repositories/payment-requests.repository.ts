import type { PaymentRequestLifecycleEvent, PaymentRequestStatus } from "@sdp/types";
import { generateKeyPairSigner } from "@solana/kit";
import { customAlphabet } from "nanoid";
import { z } from "zod";
import type { SponsorshipAccountingIdentity } from "@/services/sponsorship.service";

// URL-safe, dash-only alphabet (nanoid's default also includes "_").
// biome-ignore lint/security/noSecrets: token alphabet constant, not a secret.
const PUBLIC_TOKEN_ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz-";
const generatePublicToken = customAlphabet(PUBLIC_TOKEN_ALPHABET, 16);

export function generatePaymentRequestId(): string {
  return `preq_${crypto.randomUUID()}`;
}

export function generatePaymentRequestPublicToken(): string {
  return generatePublicToken();
}

export async function generatePaymentRequestReference(): Promise<string> {
  return (await generateKeyPairSigner()).address;
}

export interface PaymentRequestRow {
  id: string;
  public_token: string;
  organization_id: string;
  project_id: string | null;
  counterparty_id: string | null;
  custody_wallet_id: string | null;
  wallet_id: string;
  destination_address: string;
  token: string;
  amount: string;
  reference: string;
  status: PaymentRequestStatus;
  expires_at: string | null;
  fulfilled_by_transfer_id: string | null;
  canceled_by: string | null;
  lifecycle: PaymentRequestLifecycleEvent[];
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface CreatePaymentRequestInput {
  organizationId: string;
  projectId: string;
  counterpartyId: string | null;
  custodyWalletId: string;
  walletId: string;
  destinationAddress: string;
  token: string;
  amount: string;
  expiresAt: string | null;
  createdBy: string | null;
}

export interface MarkPaymentRequestInput {
  requestId: string;
  organizationId: string;
  projectId: string;
  status: Exclude<PaymentRequestStatus, "awaiting_payment">;
  fulfilledByTransferId: string | null;
  canceledBy: string | null;
}

export interface ListPaymentRequestsInput {
  organizationId: string;
  projectId: string;
  status?: PaymentRequestStatus;
  limit: number;
  offset: number;
}

export interface ListPaymentRequestsResult {
  rows: PaymentRequestRow[];
  total: number;
}

const sponsoredTransactionWindowFields = {
  account: z.string().min(1),
  unsignedTransaction: z.string().min(1),
  lastValidBlockHeight: z
    .string()
    .regex(/^\d+$/)
    .transform((height) => BigInt(height)),
};

export const sponsoredTransactionContinuitySchema = z.discriminatedUnion("deploymentMode", [
  z.object({
    ...sponsoredTransactionWindowFields,
    deploymentMode: z.literal("managed"),
    accountingIdentity: z
      .object({
        reservationId: z.string().min(1),
        attempt: z.number().int().positive(),
        network: z.enum(["devnet", "mainnet"]),
        environment: z.enum(["sandbox", "production"]),
        organizationId: z.string().min(1),
        projectId: z.string().min(1).nullable(),
        actor: z.object({
          type: z.enum(["api_key", "project", "user", "wallet"]),
          id: z.string().min(1),
        }),
        transactionDigest: z.string().regex(/^[a-f0-9]{64}$/),
        feePayer: z.string().min(1),
        providerConfigFingerprint: z.string().min(1),
      })
      .nullable(),
  }),
  z.object({
    ...sponsoredTransactionWindowFields,
    deploymentMode: z.literal("self_hosted"),
    accountingIdentity: z.null(),
  }),
]);

const sponsoredTransactionClaimSchema = z.discriminatedUnion("deploymentMode", [
  ...sponsoredTransactionContinuitySchema.options,
  z.object({
    ...sponsoredTransactionWindowFields,
    deploymentMode: z.null(),
    accountingIdentity: z.null(),
  }),
]);

export type SponsoredTransactionClaim = z.infer<typeof sponsoredTransactionClaimSchema> & {
  signedTransaction: string | null;
};

export interface PaymentRequestsRepository {
  createPaymentRequest(input: CreatePaymentRequestInput): Promise<PaymentRequestRow>;
  markPaymentRequest(input: MarkPaymentRequestInput): Promise<PaymentRequestRow | null>;
  getPaymentRequestById(params: {
    requestId: string;
    organizationId: string;
    projectId: string;
  }): Promise<PaymentRequestRow | null>;
  getPaymentRequestByPublicToken(publicToken: string): Promise<PaymentRequestRow | null>;
  claimSponsoredTransactionWindow(params: {
    requestId: string;
    account: string;
    unsignedTransaction: string;
    lastValidBlockHeight: bigint;
    currentBlockHeight: bigint;
    deploymentMode?: "managed" | "self_hosted";
    expectedClaim?: SponsoredTransactionClaim | null;
  }): Promise<boolean>;
  getSponsoredTransactionClaim(requestId: string): Promise<SponsoredTransactionClaim | null>;
  persistSponsoredTransactionAccountingIdentity(params: {
    requestId: string;
    account: string;
    unsignedTransaction: string;
    lastValidBlockHeight: bigint;
    identity: SponsorshipAccountingIdentity;
  }): Promise<boolean>;
  storeSponsoredTransactionSignature(params: {
    requestId: string;
    account: string;
    unsignedTransaction: string;
    signedTransaction: string;
  }): Promise<boolean>;
  listPaymentRequests(params: ListPaymentRequestsInput): Promise<ListPaymentRequestsResult>;
}
