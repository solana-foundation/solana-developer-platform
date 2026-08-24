import { createHash } from "node:crypto";
import {
  FeePaymentError,
  type FeePaymentPort,
  type SponsorshipProviderConfiguration,
} from "@sdp/payments/fee-payment";
import { createRpc, getTransactionNetworkFee } from "@sdp/rpc/solana";
import {
  type Address,
  assertIsFullySignedTransaction,
  assertIsSignature,
  getBase64Decoder,
  getBase64Encoder,
  getCompiledTransactionMessageDecoder,
  getSignatureFromTransaction,
  getTransactionDecoder,
  type Signature,
} from "@solana/kit";
import { getDb } from "@/db";
import {
  type CreateSponsorshipReservationInput,
  type SignaturePersistResult,
  type SponsorshipBudgetPolicy,
  SponsorshipBudgetRepository,
  type SponsorshipNetwork,
  type SponsorshipReservation,
  type SponsorshipReservationStatus,
} from "@/db/repositories/sponsorship-budget.repository";
import { describeError, logEvent } from "@/runtime/money-path-events";
import { SponsorshipBudgetRedis } from "@/runtime/sponsorship-budget-redis";
import type { Env } from "@/types/env";
import type {
  OwnedSignedSubmission,
  OwnedSubmissionLifecycle,
  PreparedOwnedSubmission,
  SponsorshipFeePayment,
  SponsorshipScope,
} from "./sponsorship.service";

const MAX_SAFE_LAMPORTS = BigInt(Number.MAX_SAFE_INTEGER);

type BudgetRepository = Pick<
  SponsorshipBudgetRepository,
  | "resolvePolicies"
  | "loadWindowAdmissionSnapshot"
  | "getReservation"
  | "createReservation"
  | "reopenReleasedReservation"
  | "markSigned"
  | "markSubmitted"
  | "markChargedUnknown"
  | "markReleased"
  | "settleReservation"
  | "markRedisSettled"
  | "tripGlobalBreaker"
>;

export function getFullySignedSubmission(signedTransaction: Uint8Array): OwnedSignedSubmission {
  const decoded = getTransactionDecoder().decode(signedTransaction);
  try {
    assertIsFullySignedTransaction(decoded);
  } catch {
    throw new Error("Sponsored transaction is not fully signed");
  }
  return {
    signedTransaction,
    signature: getSignatureFromTransaction(decoded),
  };
}

type BudgetRedis = Pick<SponsorshipBudgetRedis, "reserve" | "cancel" | "settle" | "syncPolicy">;

export interface BudgetedFeePaymentDependencies {
  repository?: BudgetRepository;
  budgetRedis?: BudgetRedis;
  getNetworkFee?: (transaction: Uint8Array) => Promise<bigint>;
  now?: () => Date;
}

type AdmissionOperation = "sign" | "send";
type AdmissionCancel = Parameters<SponsorshipBudgetRedis["cancel"]>[0];
type AdmissionSettlement = Parameters<SponsorshipBudgetRedis["settle"]>[0];
type AdmissionResult = {
  id: string;
  attempt: number;
  replay: SponsorshipReservation | null;
  cancel: AdmissionCancel | null;
  settlement: AdmissionSettlement | null;
};
type DurableAdmission =
  | { kind: "owned" | "replay"; result: AdmissionResult }
  | { kind: "in_progress" };
type AdmissionContext = {
  id: string;
  network: SponsorshipNetwork;
  amount: number;
  transactionDigest: string;
  feePayer: string;
  providerConfigFingerprint: string;
  recentBlockhash: string;
  hourBucket: string;
  dayBucket: string;
};

function resolveNetwork(env: Pick<Env, "SOLANA_NETWORK">): SponsorshipNetwork {
  return env.SOLANA_NETWORK === "mainnet-beta" ? "mainnet" : "devnet";
}

function encodeBase64(value: Uint8Array): string {
  return getBase64Decoder().decode(value);
}

function decodeBase64(value: string): Uint8Array {
  return new Uint8Array(getBase64Encoder().encode(value));
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

function canonicalJson(value: unknown): string {
  if (value === null) return "null";
  if (value === undefined) return '"__undefined__"';
  if (typeof value === "boolean" || typeof value === "number") return JSON.stringify(value);
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "bigint") return JSON.stringify(value.toString());
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
      a.localeCompare(b)
    );
    return `{${entries
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
      .join(",")}}`;
  }
  throw new Error("Unsupported sponsorship provider configuration value");
}

/** Stable digest of every provider setting that can increase fee-payer outflow. */
export function sponsorshipProviderConfigFingerprint(
  configuration: SponsorshipProviderConfiguration
): string {
  return createHash("sha256")
    .update(
      canonicalJson({
        maxAllowedLamports: configuration.maxAllowedLamports,
        feePayerMayTransferLamports: configuration.feePayerMayTransferLamports,
        feePayerPolicy: configuration.feePayerPolicy,
      })
    )
    .digest("hex");
}

export class BudgetedFeePayment implements SponsorshipFeePayment {
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
    let signed: Uint8Array;
    try {
      signed = await this.provider.signAsFeePayer(transaction);
    } catch (error) {
      // Once custody has been asked to sign, no error proves that a usable
      // signature was not produced before the response was lost. Retain the
      // full reservation and block an unsafe replay.
      await this.markAmbiguous(reservation, error);
      throw error;
    }
    let signature: Signature;
    try {
      signature = getSignatureFromTransaction(getTransactionDecoder().decode(signed));
    } catch (error) {
      return this.accountingUnavailable(
        resolveNetwork(this.env),
        "Signed sponsorship result could not be reconstructed",
        "Signed sponsorship signature extraction failed",
        error
      );
    }
    let result: SignaturePersistResult;
    try {
      result = await this.repository.markSigned(
        reservation.id,
        reservation.attempt,
        encodeBase64(signed),
        signature
      );
    } catch (error) {
      return this.accountingUnavailable(
        resolveNetwork(this.env),
        "Signed sponsorship outcome could not be persisted",
        "Signed sponsorship persistence failed",
        error
      );
    }
    if (result === "duplicate_signature") {
      await this.releaseDuplicateSignature(reservation);
      return signed;
    }
    if (
      result !== "persisted" &&
      !(await this.durablyAdvanced(reservation, [
        "signed",
        "submitted",
        "committed",
        "charged_unknown",
      ]))
    ) {
      return this.accountingUnavailable(
        resolveNetwork(this.env),
        "Signed sponsorship outcome could not be persisted",
        "Signed sponsorship outcome lost its durable state transition"
      );
    }
    return signed;
  }

  async prepareOwnedSubmission(
    transaction: Uint8Array,
    lifecycle: OwnedSubmissionLifecycle
  ): Promise<PreparedOwnedSubmission> {
    const reservation = await this.admit(transaction, "sign");
    if (reservation.replay) {
      throw new FeePaymentError(
        "An identical owned submission is already in progress",
        "PROVIDER_NOT_AVAILABLE"
      );
    }
    let submission: PreparedOwnedSubmission;
    try {
      const signedTransaction = await this.provider.signAsFeePayer(transaction);
      submission = {
        ...getFullySignedSubmission(signedTransaction),
        releaseDefinitelyUnbroadcast: (error) =>
          this.releaseDeterministic(reservation, error, "after_submission"),
      };
      const signedResult = await this.repository.markSigned(
        reservation.id,
        reservation.attempt,
        encodeBase64(signedTransaction),
        submission.signature
      );
      if (signedResult !== "persisted") {
        throw new FeePaymentError(
          "Owned sponsorship signature could not be persisted",
          "PROVIDER_NOT_AVAILABLE"
        );
      }
      await lifecycle.persistSigned(submission);
      const policies = await this.resolveEnabledPolicies(resolveNetwork(this.env));
      if (policies.some((policy) => !policy.enabled)) {
        throw new FeePaymentError(
          "Sponsorship is disabled for this scope",
          "PROVIDER_NOT_AVAILABLE"
        );
      }
    } catch (error) {
      await this.releaseDeterministic(reservation, error);
      throw error;
    }
    try {
      await lifecycle.markStarted();
    } catch (error) {
      let started: boolean;
      try {
        started = await lifecycle.hasStarted();
      } catch {
        // An unreadable marker is an ambiguous ownership boundary. Releasing
        // here could refund a submission that has already become sendable.
        throw error;
      }
      if (!started) {
        await this.releaseDeterministic(reservation, error);
      }
      throw error;
    }
    let submittedResult: SignaturePersistResult;
    try {
      submittedResult = await this.repository.markSubmitted(
        reservation.id,
        reservation.attempt,
        submission.signature
      );
    } catch (error) {
      return this.accountingUnavailable(
        resolveNetwork(this.env),
        "Owned submission accounting could not be persisted",
        "Owned submission accounting persistence failed",
        error,
        { signature: submission.signature, reservationId: reservation.id }
      );
    }
    if (
      submittedResult !== "persisted" &&
      !(await this.durablyAdvanced(reservation, ["submitted", "committed", "charged_unknown"]))
    ) {
      return this.accountingUnavailable(
        resolveNetwork(this.env),
        "Owned submission accounting could not be persisted",
        "Owned submission accounting lost its durable state transition",
        undefined,
        { signature: submission.signature, reservationId: reservation.id }
      );
    }
    return submission;
  }

  async signAndSend(transaction: Uint8Array): Promise<Signature> {
    const reservation = await this.admit(transaction, "send");
    if (reservation.replay?.signature) {
      assertIsSignature(reservation.replay.signature);
      return reservation.replay.signature;
    }
    let signature: Signature;
    try {
      signature = await this.provider.signAndSend(transaction);
    } catch (error) {
      if (isDeterministicProviderRejection(error)) {
        await this.releaseDeterministic(reservation, error);
      } else {
        await this.markAmbiguous(reservation, error);
      }
      throw error;
    }
    let result: SignaturePersistResult;
    try {
      result = await this.repository.markSubmitted(reservation.id, reservation.attempt, signature);
    } catch (error) {
      return this.accountingUnavailable(
        resolveNetwork(this.env),
        "Submitted sponsorship outcome could not be persisted",
        "Submitted sponsorship persistence failed",
        error
      );
    }
    if (result === "duplicate_signature") {
      await this.releaseDuplicateSignature(reservation);
      return signature;
    }
    if (
      result !== "persisted" &&
      !(await this.durablyAdvanced(reservation, ["submitted", "committed", "charged_unknown"]))
    ) {
      return this.accountingUnavailable(
        resolveNetwork(this.env),
        "Submitted sponsorship outcome could not be persisted",
        "Submitted sponsorship outcome lost its durable state transition"
      );
    }
    return signature;
  }

  private async admit(
    transaction: Uint8Array,
    operation: AdmissionOperation
  ): Promise<AdmissionResult> {
    const context = await this.prepareAdmission(transaction);
    const durableReservation = await this.readReservation(context);
    const durableReplay = this.resolveDurableReplay(context, operation, durableReservation);
    if (durableReplay) return durableReplay;
    const attempt =
      durableReservation?.status === "released"
        ? durableReservation.attempt + 1
        : (durableReservation?.attempt ?? 1);
    return this.admitAgainstCurrentPolicy(context, operation, attempt);
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
    const providerConfigFingerprint = sponsorshipProviderConfigFingerprint(providerConfig);
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
      providerConfigFingerprint,
      recentBlockhash,
      hourBucket: buckets.hour,
      dayBucket: buckets.day,
    };
  }

  private resolveDurableReplay(
    context: AdmissionContext,
    operation: AdmissionOperation,
    durableReplay: SponsorshipReservation | null
  ): AdmissionResult | null {
    const hasOperationResponse = durableReplay
      ? reservationHasResponse(durableReplay, operation)
      : false;
    if (
      durableReplay &&
      ["signed", "submitted", "committed"].includes(durableReplay.status) &&
      hasOperationResponse
    ) {
      return {
        id: context.id,
        attempt: durableReplay.attempt,
        replay: durableReplay,
        cancel: null,
        settlement: null,
      };
    }
    if (durableReplay?.status === "charged_unknown") {
      throw new FeePaymentError(
        "Previous sponsorship outcome is ambiguous and cannot be retried safely",
        "PROVIDER_NOT_AVAILABLE"
      );
    }
    return null;
  }

  private async resolveEnabledPolicies(
    network: SponsorshipNetwork
  ): Promise<SponsorshipBudgetPolicy[]> {
    let policies: SponsorshipBudgetPolicy[];
    try {
      policies = await this.repository.resolvePolicies({
        network,
        organizationId: this.scope.organizationId,
        projectId: this.scope.projectId,
      });
    } catch (error) {
      return this.accountingUnavailable(
        network,
        "Sponsorship policy resolution is unavailable",
        "Policy resolution failed",
        error
      );
    }
    return policies;
  }

  private async assertSponsorshipEnabled(
    context: AdmissionContext,
    policies: SponsorshipBudgetPolicy[],
    durable: DurableAdmission | null,
    reservationAttempt: number
  ): Promise<void> {
    if (policies.every((policy) => policy.enabled)) return;
    if (durable?.kind === "owned") {
      await this.releaseDurable(
        context,
        reservationAttempt,
        "sponsorship disabled during admission"
      );
    }
    throw new FeePaymentError("Sponsorship is disabled for this scope", "PROVIDER_NOT_AVAILABLE");
  }

  private async admitAgainstCurrentPolicy(
    context: AdmissionContext,
    operation: AdmissionOperation,
    reservationAttempt: number
  ): Promise<AdmissionResult> {
    let durable: DurableAdmission | null = null;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const policies = await this.resolveEnabledPolicies(context.network);
      await this.assertSponsorshipEnabled(context, policies, durable, reservationAttempt);
      if (!durable) {
        durable = await this.persistReservationDurable(
          context,
          operation,
          policies,
          reservationAttempt
        );
        if (durable.kind === "replay") return durable.result;
        if (durable.kind === "in_progress") {
          throw new FeePaymentError(
            "An identical sponsorship operation is already in progress",
            "PROVIDER_NOT_AVAILABLE"
          );
        }
      }
      const admission = await this.reserveBudget(context, policies, reservationAttempt);
      if (admission === "stale_policy" && attempt === 0) continue;
      if (admission === "denied" || admission === "stale_policy") {
        await this.releaseDurable(
          context,
          reservationAttempt,
          admission === "denied"
            ? "budget exceeded during admission"
            : "policy changed during admission"
        );
        throw new FeePaymentError(
          admission === "denied"
            ? "Sponsorship budget exceeded"
            : "Sponsorship policy changed during admission",
          admission === "denied" ? "RATE_LIMITED" : "PROVIDER_NOT_AVAILABLE"
        );
      }
      if (admission === "duplicate") {
        await this.releaseDurable(
          context,
          reservationAttempt,
          "redundant redis reservation during admission"
        );
        throw new FeePaymentError(
          "An identical sponsorship operation is already in progress",
          "PROVIDER_NOT_AVAILABLE"
        );
      }
      return durable.result;
    }
    if (durable?.kind === "owned") {
      await this.releaseDurable(context, reservationAttempt, "policy changed during admission");
    }
    throw new FeePaymentError(
      "Sponsorship policy changed during admission",
      "PROVIDER_NOT_AVAILABLE"
    );
  }

  private async reserveBudget(
    context: AdmissionContext,
    policies: SponsorshipBudgetPolicy[],
    attempt: number
  ): Promise<Awaited<ReturnType<SponsorshipBudgetRedis["reserve"]>>> {
    try {
      const { usage, liveReservations } = await this.repository.loadWindowAdmissionSnapshot({
        network: context.network,
        organizationId: this.scope.organizationId,
        projectId: this.scope.projectId,
        hourBucket: context.hourBucket,
        dayBucket: context.dayBucket,
        excludeReservationId: context.id,
      });
      return await this.budgetRedis.reserve({
        network: context.network,
        organizationId: this.scope.organizationId,
        projectId: this.scope.projectId,
        hourBucket: context.hourBucket,
        dayBucket: context.dayBucket,
        reservationId: context.id,
        attempt,
        amount: context.amount,
        policies,
        usage,
        liveReservations,
      });
    } catch (error) {
      return this.accountingUnavailable(
        context.network,
        "Sponsorship budget admission is unavailable",
        "Budget reconstruction or Redis admission failed",
        error
      );
    }
  }

  private async persistReservationDurable(
    context: AdmissionContext,
    operation: AdmissionOperation,
    policies: SponsorshipBudgetPolicy[],
    attempt: number
  ): Promise<DurableAdmission> {
    const cancel = this.cancelInput(context, attempt);
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
      providerConfigFingerprint: context.providerConfigFingerprint,
      recentBlockhash: context.recentBlockhash,
      reservedLamports: context.amount,
      hourBucket: context.hourBucket,
      dayBucket: context.dayBucket,
      policyVersions: policyVersions(policies),
    };
    const owned = (): DurableAdmission => ({
      kind: "owned",
      result: {
        id: context.id,
        attempt,
        replay: null,
        cancel,
        settlement: this.settlementInput(context, attempt),
      },
    });
    try {
      if (attempt === 1 && (await this.repository.createReservation(reservationInput))) {
        return owned();
      }
      const existing = await this.repository.getReservation(context.id);
      if (existing?.status === "released" && existing.attempt + 1 === attempt) {
        const reopenedAttempt = await this.repository.reopenReleasedReservation(
          reservationInput,
          existing.attempt
        );
        if (reopenedAttempt === attempt) {
          return owned();
        }
      }
      if (
        existing &&
        ["signed", "submitted", "committed"].includes(existing.status) &&
        reservationHasResponse(existing, operation)
      ) {
        return {
          kind: "replay",
          result: {
            id: context.id,
            attempt: existing.attempt,
            replay: existing,
            cancel: null,
            settlement: null,
          },
        };
      }
      if (existing) {
        return { kind: "in_progress" };
      }
      throw new Error("Reservation insert conflicted without a durable ledger row");
    } catch (error) {
      if (error instanceof FeePaymentError) {
        throw error;
      }
      return this.accountingUnavailable(
        context.network,
        "Sponsorship reservation persistence is unavailable",
        "Durable reservation persistence failed",
        error
      );
    }
  }

  private async releaseDurable(
    context: AdmissionContext,
    attempt: number,
    reason: string
  ): Promise<void> {
    try {
      await this.repository.markReleased(context.id, attempt, reason);
      await this.repository.markRedisSettled(context.id, attempt);
    } catch (error) {
      return this.accountingUnavailable(
        context.network,
        "Sponsorship reservation release is unavailable",
        "Durable reservation release failed",
        error
      );
    }
  }

  private async readReservation(context: AdmissionContext): Promise<SponsorshipReservation | null> {
    try {
      return await this.repository.getReservation(context.id);
    } catch (error) {
      return this.accountingUnavailable(
        context.network,
        "Sponsorship reservation state is unavailable",
        "Durable reservation read failed",
        error
      );
    }
  }

  private cancelInput(context: AdmissionContext, attempt: number): AdmissionCancel {
    return {
      network: context.network,
      organizationId: this.scope.organizationId,
      projectId: this.scope.projectId,
      hourBucket: context.hourBucket,
      dayBucket: context.dayBucket,
      reservationId: context.id,
      attempt,
    };
  }

  private settlementInput(context: AdmissionContext, attempt: number): AdmissionSettlement {
    return {
      ...this.cancelInput(context, attempt),
      reservedLamports: context.amount,
      actualLamports: context.amount,
    };
  }

  private async tripBreaker(network: SponsorshipNetwork, reason: string): Promise<void> {
    const policy = await this.repository.tripGlobalBreaker(network, reason);
    logEvent("error", {
      event: "sdp_api_sponsorship_breaker_tripped",
      network,
      reason,
      already_tripped: policy === null,
      organization_id: this.scope.organizationId,
      project_id: this.scope.projectId,
    });
    if (policy) await this.budgetRedis.syncPolicy(policy);
  }

  private async durablyAdvanced(
    reservation: AdmissionResult,
    forwardStatuses: SponsorshipReservationStatus[]
  ): Promise<boolean> {
    let current: SponsorshipReservation | null;
    try {
      current = await this.repository.getReservation(reservation.id);
    } catch {
      return false;
    }
    return Boolean(
      current && current.attempt === reservation.attempt && forwardStatuses.includes(current.status)
    );
  }

  private async accountingUnavailable(
    network: SponsorshipNetwork,
    message: string,
    breakerReason: string,
    error?: unknown,
    // On post-broadcast paths, carry the one fact that makes the forced manual
    // reconciliation trivial: the broadcast signature (a public on-chain
    // identifier — redaction-safe) and the reservation it belongs to.
    submission?: { signature: string; reservationId: string }
  ): Promise<never> {
    logEvent("error", {
      event: "sdp_api_sponsorship_accounting_unavailable",
      network,
      reason: breakerReason,
      organization_id: this.scope.organizationId,
      project_id: this.scope.projectId,
      ...(submission === undefined
        ? {}
        : { signature: submission.signature, reservation_id: submission.reservationId }),
      ...(error === undefined ? {} : describeError(error)),
    });
    try {
      await this.tripBreaker(network, breakerReason);
    } catch {
      // The original accounting outage remains the primary failure. Admission
      // still fails closed even when the breaker cannot be synchronized.
    }
    throw new FeePaymentError(
      message,
      "PROVIDER_NOT_AVAILABLE",
      error instanceof Error ? error : undefined
    );
  }

  private async markAmbiguous(reservation: AdmissionResult, error: unknown): Promise<void> {
    const reason = error instanceof Error ? error.message : "Unknown Kora failure";
    try {
      const persisted = await this.repository.markChargedUnknown(
        reservation.id,
        reservation.attempt,
        reason
      );
      if (persisted) return;
    } catch (persistenceError) {
      return this.accountingUnavailable(
        resolveNetwork(this.env),
        "Ambiguous sponsorship outcome could not be persisted",
        "Failed to persist ambiguous Kora outcome",
        persistenceError
      );
    }
    return this.accountingUnavailable(
      resolveNetwork(this.env),
      "Ambiguous sponsorship outcome could not be persisted",
      "Ambiguous sponsorship state transition was lost"
    );
  }

  private async releaseDuplicateSignature(
    reservation: Awaited<ReturnType<BudgetedFeePayment["admit"]>>
  ): Promise<void> {
    await this.releaseDeterministic(
      reservation,
      new FeePaymentError("Transaction already sponsored under another reservation", "RATE_LIMITED")
    );
  }

  private async releaseDeterministic(
    reservation: Awaited<ReturnType<BudgetedFeePayment["admit"]>>,
    error: unknown,
    boundary: "before_submission" | "after_submission" = "before_submission"
  ): Promise<void> {
    const reason = error instanceof Error ? error.message : "Kora rejected sponsorship";
    let released: boolean;
    try {
      released =
        boundary === "after_submission"
          ? await this.repository.settleReservation(
              reservation.id,
              reservation.attempt,
              "released",
              0,
              reason
            )
          : await this.repository.markReleased(reservation.id, reservation.attempt, reason);
    } catch (releaseError) {
      return this.accountingUnavailable(
        resolveNetwork(this.env),
        "Sponsorship release state is unavailable",
        "Deterministic release persistence failed",
        releaseError
      );
    }
    if (!released || !reservation.settlement) {
      await this.tripBreaker(
        resolveNetwork(this.env),
        "Deterministic release lost its durable ownership transition"
      );
      throw new FeePaymentError(
        "Sponsorship release could not be persisted safely",
        "PROVIDER_NOT_AVAILABLE"
      );
    }
    try {
      await this.budgetRedis.settle({
        ...reservation.settlement,
        actualLamports: 0,
        detectMissingReservation: true,
      });
      const persisted = await this.repository.markRedisSettled(reservation.id, reservation.attempt);
      if (!persisted) throw new Error("Released reservation lost its Redis settlement ownership");
    } catch (compensationError) {
      return this.accountingUnavailable(
        resolveNetwork(this.env),
        "Sponsorship release accounting is unavailable",
        "Redis release invariant failed",
        compensationError
      );
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

function reservationHasResponse(
  reservation: SponsorshipReservation,
  operation: AdmissionOperation
): boolean {
  if (operation === "sign") {
    return (
      ["signed", "submitted", "committed"].includes(reservation.status) &&
      Boolean(reservation.signedTransaction)
    );
  }
  return ["submitted", "committed"].includes(reservation.status) && Boolean(reservation.signature);
}
