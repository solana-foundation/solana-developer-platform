import { createHash } from "node:crypto";
import { FeePaymentError, type FeePaymentPort } from "@sdp/payments/fee-payment";
import { createRpc, getTransactionNetworkFee } from "@sdp/rpc/solana";
import {
  type Address,
  getCompiledTransactionMessageDecoder,
  getTransactionDecoder,
  type Signature,
} from "@solana/kit";
import { getDb } from "@/db";
import {
  type CreateSponsorshipReservationInput,
  type SponsorshipBudgetPolicy,
  SponsorshipBudgetRepository,
  type SponsorshipNetwork,
  type SponsorshipReservation,
} from "@/db/repositories/sponsorship-budget.repository";
import { SponsorshipBudgetRedis } from "@/runtime/sponsorship-budget-redis";
import type { Env } from "@/types/env";
import type { SponsorshipScope } from "./sponsorship.service";

const MAX_SAFE_LAMPORTS = BigInt(Number.MAX_SAFE_INTEGER);

type BudgetRepository = Pick<
  SponsorshipBudgetRepository,
  | "resolvePolicies"
  | "getWindowUsage"
  | "getReservation"
  | "createReservation"
  | "reopenReleasedReservation"
  | "markSigned"
  | "markSubmitted"
  | "markChargedUnknown"
  | "markReleased"
  | "tripGlobalBreaker"
>;

type BudgetRedis = Pick<SponsorshipBudgetRedis, "reserve" | "cancel" | "syncPolicy">;

export interface BudgetedFeePaymentDependencies {
  repository?: BudgetRepository;
  budgetRedis?: BudgetRedis;
  getNetworkFee?: (transaction: Uint8Array) => Promise<bigint>;
  now?: () => Date;
}

type AdmissionOperation = "sign" | "send";
type AdmissionCancel = Parameters<SponsorshipBudgetRedis["cancel"]>[0];
type AdmissionResult = {
  id: string;
  replay: SponsorshipReservation | null;
  cancel: AdmissionCancel | null;
};
type AdmissionContext = {
  id: string;
  network: SponsorshipNetwork;
  amount: number;
  transactionDigest: string;
  feePayer: string;
  recentBlockhash: string;
  hourBucket: string;
  dayBucket: string;
};

function resolveNetwork(env: Pick<Env, "SOLANA_NETWORK">): SponsorshipNetwork {
  return env.SOLANA_NETWORK === "mainnet-beta" ? "mainnet" : "devnet";
}

function encodeBase64(value: Uint8Array): string {
  return Buffer.from(value).toString("base64");
}

function decodeBase64(value: string): Uint8Array {
  return new Uint8Array(Buffer.from(value, "base64"));
}

function getRecentBlockhash(transaction: Uint8Array): string {
  const decoded = getTransactionDecoder().decode(transaction);
  const message = getCompiledTransactionMessageDecoder().decode(decoded.messageBytes);
  if (!("lifetimeToken" in message) || typeof message.lifetimeToken !== "string") {
    throw new FeePaymentError(
      "Sponsored transaction does not contain a recent blockhash",
      "SIGNING_FAILED"
    );
  }
  return message.lifetimeToken;
}

function utcBuckets(now: Date): { hour: string; day: string } {
  const iso = now.toISOString();
  return { hour: `${iso.slice(0, 13)}:00:00.000Z`, day: `${iso.slice(0, 10)}T00:00:00.000Z` };
}

function policyVersions(policies: SponsorshipBudgetPolicy[]): Record<string, number> {
  return Object.fromEntries(policies.map((policy) => [policy.id, policy.version]));
}

export class BudgetedFeePayment implements FeePaymentPort {
  readonly providerId: string;
  private readonly repository: BudgetRepository;
  private readonly budgetRedis: BudgetRedis;
  private readonly getNetworkFee: (transaction: Uint8Array) => Promise<bigint>;
  private readonly now: () => Date;

  constructor(
    private readonly env: Env,
    private readonly scope: SponsorshipScope,
    private readonly provider: FeePaymentPort,
    dependencies: BudgetedFeePaymentDependencies = {}
  ) {
    this.providerId = provider.providerId;
    this.repository = dependencies.repository ?? new SponsorshipBudgetRepository(getDb(env));
    this.budgetRedis = dependencies.budgetRedis ?? new SponsorshipBudgetRedis(env);
    this.getNetworkFee =
      dependencies.getNetworkFee ??
      ((transaction) => getTransactionNetworkFee(createRpc(this.env), transaction));
    this.now = dependencies.now ?? (() => new Date());
  }

  getFeePayer(): Promise<Address> {
    return this.provider.getFeePayer();
  }

  async signAsFeePayer(transaction: Uint8Array): Promise<Uint8Array> {
    const reservation = await this.admit(transaction, "sign");
    if (reservation.replay?.signedTransaction) {
      return decodeBase64(reservation.replay.signedTransaction);
    }
    try {
      const signed = await this.provider.signAsFeePayer(transaction);
      await this.repository.markSigned(reservation.id, encodeBase64(signed));
      return signed;
    } catch (error) {
      await this.releaseDeterministic(reservation, error);
      throw error;
    }
  }

  async signAndSend(transaction: Uint8Array): Promise<Signature> {
    const reservation = await this.admit(transaction, "send");
    if (reservation.replay?.signature) return reservation.replay.signature as Signature;
    try {
      const signature = await this.provider.signAndSend(transaction);
      await this.repository.markSubmitted(reservation.id, signature);
      return signature;
    } catch (error) {
      if (isDeterministicProviderRejection(error)) {
        await this.releaseDeterministic(reservation, error);
      } else {
        await this.markAmbiguous(reservation.id, error);
      }
      throw error;
    }
  }

  private async admit(
    transaction: Uint8Array,
    operation: AdmissionOperation
  ): Promise<AdmissionResult> {
    const context = await this.prepareAdmission(transaction);
    const durableReplay = await this.resolveDurableReplay(context.id, operation);
    if (durableReplay) return durableReplay;
    return this.admitAgainstCurrentPolicy(context);
  }

  private async prepareAdmission(transaction: Uint8Array): Promise<AdmissionContext> {
    if (!this.provider.getSponsorshipConfiguration) {
      throw new FeePaymentError(
        "Managed sponsorship provider does not expose fail-closed configuration",
        "PROVIDER_NOT_AVAILABLE"
      );
    }
    const network = resolveNetwork(this.env);
    let providerConfig: Awaited<
      ReturnType<NonNullable<FeePaymentPort["getSponsorshipConfiguration"]>>
    >;
    let networkFee: bigint;
    try {
      [providerConfig, networkFee] = await Promise.all([
        this.provider.getSponsorshipConfiguration(),
        this.getNetworkFee(transaction),
      ]);
    } catch (error) {
      throw new FeePaymentError(
        "Sponsorship preflight is unavailable",
        "PROVIDER_NOT_AVAILABLE",
        error instanceof Error ? error : undefined
      );
    }
    const providerOutflow = providerConfig.feePayerMayTransferLamports
      ? providerConfig.maxAllowedLamports
      : 0n;
    const ceiling = networkFee + providerOutflow;
    if (ceiling < 0n || ceiling > MAX_SAFE_LAMPORTS) {
      throw new FeePaymentError(
        "Sponsored transaction cost cannot be represented safely",
        "TRANSACTION_TOO_LARGE"
      );
    }
    const amount = Number(ceiling);
    const decodedTransaction = getTransactionDecoder().decode(transaction);
    const recentBlockhash = getRecentBlockhash(transaction);
    const transactionDigest = createHash("sha256")
      .update(new Uint8Array(decodedTransaction.messageBytes))
      .digest("hex");
    const id = `sbr_${createHash("sha256")
      .update(
        JSON.stringify({
          network,
          productEnvironment: this.scope.environment,
          organizationId: this.scope.organizationId,
          projectId: this.scope.projectId,
          actor: this.scope.actor,
          feePayer: providerConfig.signerAddress,
          transactionDigest,
        })
      )
      .digest("hex")}`;
    const buckets = utcBuckets(this.now());
    return {
      id,
      network,
      amount,
      transactionDigest,
      feePayer: providerConfig.signerAddress,
      recentBlockhash,
      hourBucket: buckets.hour,
      dayBucket: buckets.day,
    };
  }

  private async resolveDurableReplay(
    id: string,
    operation: AdmissionOperation
  ): Promise<AdmissionResult | null> {
    const durableReplay = await this.repository.getReservation(id);
    const hasOperationResponse =
      operation === "sign" ? durableReplay?.signedTransaction : durableReplay?.signature;
    if (
      durableReplay &&
      ["signed", "submitted", "committed"].includes(durableReplay.status) &&
      hasOperationResponse
    ) {
      return { id, replay: durableReplay, cancel: null };
    }
    if (durableReplay?.status === "charged_unknown") {
      throw new FeePaymentError(
        "Previous sponsorship outcome is ambiguous and cannot be retried safely",
        "PROVIDER_NOT_AVAILABLE"
      );
    }
    return null;
  }

  private async admitAgainstCurrentPolicy(context: AdmissionContext): Promise<AdmissionResult> {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const policies = await this.repository.resolvePolicies({
        network: context.network,
        organizationId: this.scope.organizationId,
        projectId: this.scope.projectId,
      });
      if (policies.some((policy) => !policy.enabled)) {
        throw new FeePaymentError(
          "Sponsorship is disabled for this scope",
          "PROVIDER_NOT_AVAILABLE"
        );
      }
      const admission = await this.reserveBudget(context, policies);
      if (admission === "stale_policy" && attempt === 0) continue;
      if (admission === "denied" || admission === "stale_policy") {
        throw new FeePaymentError(
          admission === "denied"
            ? "Sponsorship budget exceeded"
            : "Sponsorship policy changed during admission",
          admission === "denied" ? "RATE_LIMITED" : "PROVIDER_NOT_AVAILABLE"
        );
      }
      const replay = await this.repository.getReservation(context.id);
      if (admission === "duplicate" && replay) {
        return { id: context.id, replay, cancel: null };
      }
      return this.persistReservation(context, policies);
    }
    throw new FeePaymentError(
      "Sponsorship policy changed during admission",
      "PROVIDER_NOT_AVAILABLE"
    );
  }

  private async reserveBudget(
    context: AdmissionContext,
    policies: SponsorshipBudgetPolicy[]
  ): Promise<Awaited<ReturnType<SponsorshipBudgetRedis["reserve"]>>> {
    const usage = await this.repository.getWindowUsage({
      network: context.network,
      organizationId: this.scope.organizationId,
      projectId: this.scope.projectId,
      hourBucket: context.hourBucket,
      dayBucket: context.dayBucket,
    });
    try {
      return await this.budgetRedis.reserve({
        network: context.network,
        organizationId: this.scope.organizationId,
        projectId: this.scope.projectId,
        hourBucket: context.hourBucket,
        dayBucket: context.dayBucket,
        reservationId: context.id,
        amount: context.amount,
        policies,
        usage,
      });
    } catch (error) {
      throw new FeePaymentError(
        "Sponsorship budget admission is unavailable",
        "PROVIDER_NOT_AVAILABLE",
        error instanceof Error ? error : undefined
      );
    }
  }

  private async persistReservation(
    context: AdmissionContext,
    policies: SponsorshipBudgetPolicy[]
  ): Promise<AdmissionResult> {
    const cancel = this.cancelInput(context);
    const reservationInput: CreateSponsorshipReservationInput = {
      id: context.id,
      network: context.network,
      productEnvironment: this.scope.environment,
      organizationId: this.scope.organizationId,
      projectId: this.scope.projectId,
      actorType: this.scope.actor.type,
      actorId: this.scope.actor.id,
      transactionDigest: context.transactionDigest,
      feePayer: context.feePayer,
      recentBlockhash: context.recentBlockhash,
      reservedLamports: context.amount,
      hourBucket: context.hourBucket,
      dayBucket: context.dayBucket,
      policyVersions: policyVersions(policies),
    };
    try {
      if (await this.repository.createReservation(reservationInput)) {
        return { id: context.id, replay: null, cancel };
      }
      const existing = await this.repository.getReservation(context.id);
      if (
        existing?.status === "released" &&
        (await this.repository.reopenReleasedReservation(reservationInput))
      ) {
        return { id: context.id, replay: null, cancel };
      }
      if (existing) return { id: context.id, replay: existing, cancel: null };
      throw new Error("Reservation insert conflicted without a durable ledger row");
    } catch (error) {
      await this.compensateReservation(context);
      throw error;
    }
  }

  private cancelInput(context: AdmissionContext): AdmissionCancel {
    return {
      network: context.network,
      organizationId: this.scope.organizationId,
      projectId: this.scope.projectId,
      hourBucket: context.hourBucket,
      dayBucket: context.dayBucket,
      reservationId: context.id,
    };
  }

  private async compensateReservation(context: AdmissionContext): Promise<void> {
    try {
      await this.budgetRedis.cancel(this.cancelInput(context));
    } catch (compensationError) {
      await this.tripBreaker(context.network, "Redis compensation invariant failed");
      throw compensationError;
    }
  }

  private async tripBreaker(network: SponsorshipNetwork, reason: string): Promise<void> {
    const policy = await this.repository.tripGlobalBreaker(network, reason);
    if (policy) await this.budgetRedis.syncPolicy(policy);
  }

  private async markAmbiguous(id: string, error: unknown): Promise<void> {
    const reason = error instanceof Error ? error.message : "Unknown Kora failure";
    try {
      await this.repository.markChargedUnknown(id, reason);
    } catch {
      await this.tripBreaker(resolveNetwork(this.env), "Failed to persist ambiguous Kora outcome");
    }
  }

  private async releaseDeterministic(
    reservation: Awaited<ReturnType<BudgetedFeePayment["admit"]>>,
    error: unknown
  ): Promise<void> {
    const reason = error instanceof Error ? error.message : "Kora rejected sponsorship";
    await this.repository.markReleased(reservation.id, reason);
    if (!reservation.cancel) return;
    try {
      await this.budgetRedis.cancel(reservation.cancel);
    } catch (compensationError) {
      await this.tripBreaker(resolveNetwork(this.env), "Redis release invariant failed");
      throw compensationError;
    }
  }
}

function isDeterministicProviderRejection(error: unknown): boolean {
  return (
    error instanceof FeePaymentError &&
    ["SIGNING_FAILED", "TRANSACTION_TOO_LARGE", "INSUFFICIENT_BALANCE", "RATE_LIMITED"].includes(
      error.code
    )
  );
}
