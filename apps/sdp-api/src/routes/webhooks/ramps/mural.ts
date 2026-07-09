import type { SdpEnvironment } from "@sdp/types";
import {
  createCounterpartiesRepository,
  createPaymentsRepository,
  type PaymentsRepository,
  type PaymentTransferRow,
  type PaymentTransferStatus,
} from "@/db/repositories";
import type { CounterpartyRow } from "@/db/repositories/counterparty.repository";
import { badRequest, providerNotConfigured, unauthorized } from "@/lib/errors";
import { RAMP_PROVIDER_CLIENTS } from "@/lib/ramps";
import type { MuralWebhookEvent } from "@/lib/ramps/providers/mural/client";
import type { RampWebhookValidationContext } from "@/lib/ramps/types";
import { verifyWebhookSignature } from "@/lib/webhook-signature";
import type { AppContext, WebhookProcessor } from "./processor";

function readMuralWebhookPublicKey(
  env: Record<string, string | undefined>,
  environment: SdpEnvironment
): string {
  const publicKey =
    environment === "sandbox"
      ? env.MURAL_PAY_SANDBOX_WEBHOOK_PUBLIC_KEY?.trim()
      : env.MURAL_PAY_WEBHOOK_PUBLIC_KEY?.trim();
  if (!publicKey) {
    throw providerNotConfigured(
      environment === "sandbox"
        ? "Mural sandbox webhook public key is not configured (MURAL_PAY_SANDBOX_WEBHOOK_PUBLIC_KEY)."
        : "Mural webhook public key is not configured (MURAL_PAY_WEBHOOK_PUBLIC_KEY)."
    );
  }
  return publicKey;
}

async function findMuralOnrampTransfer(
  payments: PaymentsRepository,
  counterparty: CounterpartyRow,
  statuses: PaymentTransferStatus[]
): Promise<PaymentTransferRow | undefined> {
  const { rows } = await payments.listTransfers({
    organizationId: counterparty.organization_id,
    projectId: counterparty.project_id,
    counterpartyId: counterparty.id,
    types: ["onramp"],
    statuses,
    limit: 20,
    offset: 0,
  });
  return rows.find((row) => row.provider === "mural");
}

async function handleAccountCredited(
  c: AppContext,
  event: { organizationId: string; accountId: string; tokenAmount: number }
): Promise<void> {
  console.log(
    `[mural webhook] account_credited account=${event.accountId} amount=${event.tokenAmount} org=${event.organizationId}`
  );
  const counterparty = await createCounterpartiesRepository(
    c.env
  ).findCounterpartyByMuralOrganizationId(event.organizationId);
  if (!counterparty) {
    console.warn(`[mural webhook] no counterparty for org ${event.organizationId}`);
    return;
  }
  const payments = createPaymentsRepository(c.env);
  const transfer = await findMuralOnrampTransfer(payments, counterparty, ["awaiting_payment"]);
  if (!transfer) {
    console.warn(
      `[mural webhook] no awaiting on-ramp transfer for counterparty ${counterparty.id}`
    );
    return;
  }

  const claimed = await payments.updateTransferStatusGuarded({
    transferId: transfer.id,
    organizationId: transfer.organization_id,
    projectId: transfer.project_id,
    fromStatuses: ["awaiting_payment"],
    toStatus: "completed",
    updatedAt: new Date().toISOString(),
  });
  if (!claimed) {
    return;
  }
  await payments.updateTransfer({
    transferId: transfer.id,
    organizationId: transfer.organization_id,
    projectId: transfer.project_id,
    amount: String(event.tokenAmount),
    updatedAt: new Date().toISOString(),
  });
  console.log(`[mural webhook] transfer ${transfer.id} completed (payin ${event.tokenAmount})`);
}

async function handleOrganizationLifecycleEvent(
  c: AppContext,
  event: Extract<MuralWebhookEvent, { kind: "kyc_status" | "tos_accepted" }>
): Promise<void> {
  const repo = createCounterpartiesRepository(c.env);
  const counterparty = await repo.findCounterpartyByMuralOrganizationId(event.organizationId);
  if (!counterparty) {
    console.warn(`[mural webhook] no counterparty for organization ${event.organizationId}`);
    return;
  }
  const organization: Record<string, unknown> =
    event.kind === "kyc_status" ? { kycStatus: event.kycStatus } : { tosStatus: "ACCEPTED" };
  await repo.patchMuralOrganizationById({
    organizationId: event.organizationId,
    organization,
  });
}

export class MuralWebhookProcessor implements WebhookProcessor<unknown, MuralWebhookEvent> {
  readonly provider = "mural";

  async verify({
    env,
    environment,
    headers,
    rawBody,
  }: RampWebhookValidationContext): Promise<unknown> {
    const publicKey = readMuralWebhookPublicKey(env, environment);
    const signature = headers.get("x-mural-webhook-signature")?.trim();
    if (!signature) {
      throw unauthorized("Mural webhook is missing x-mural-webhook-signature");
    }
    const timestamp = headers.get("x-mural-webhook-timestamp")?.trim();
    if (!timestamp) {
      throw unauthorized("Mural webhook is missing x-mural-webhook-timestamp");
    }

    await verifyWebhookSignature({
      provider: this.provider,
      signedPayload: `${timestamp}.${rawBody}`,
      signature,
      algorithm: { type: "ecdsa-sha256", publicKeyPem: publicKey, encoding: "base64" },
      timestampSeconds: Date.parse(timestamp) / 1000,
    });

    try {
      return JSON.parse(rawBody);
    } catch {
      throw badRequest("Mural webhook body must be valid JSON", { provider: this.provider });
    }
  }

  parse(payload: unknown): MuralWebhookEvent {
    return RAMP_PROVIDER_CLIENTS.mural.parseMuralWebhookEvent(payload);
  }

  async process(
    c: AppContext,
    _environment: SdpEnvironment,
    event: MuralWebhookEvent
  ): Promise<void> {
    switch (event.kind) {
      case "ignore":
        console.log(`[mural webhook] ignored event: ${event.reason}`);
        return;
      case "kyc_status":
      case "tos_accepted":
        return handleOrganizationLifecycleEvent(c, event);
      case "account_credited":
        return handleAccountCredited(c, event);
      case "payout_settled":
      case "payout_failed":
        console.log(`[mural webhook] ignored unimplemented payout event: ${event.kind}`);
        return;
    }
  }
}
