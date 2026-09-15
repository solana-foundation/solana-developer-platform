export const SPONSORSHIP_RESERVATION_STATUSES = [
  "reserved",
  "signed",
  "submitted",
  "committed",
  "released",
  "charged_unknown",
] as const;
export type SponsorshipReservationStatus = (typeof SPONSORSHIP_RESERVATION_STATUSES)[number];

/** Sponsorship reservations whose budget allocation remains held. */
export const BUDGET_HOLDING_SPONSORSHIP_RESERVATION_STATUSES = [
  "reserved",
  "signed",
  "submitted",
] as const satisfies readonly SponsorshipReservationStatus[];
/** Sponsorship reservations whose signed transaction can be replayed safely. */
export const REPLAYABLE_SPONSORSHIP_RESERVATION_STATUSES = [
  "signed",
  "submitted",
  "committed",
] as const satisfies readonly SponsorshipReservationStatus[];
/** Sponsorship reservations known to have been submitted. */
export const SUBMITTED_SPONSORSHIP_RESERVATION_STATUSES = [
  "submitted",
  "committed",
] as const satisfies readonly SponsorshipReservationStatus[];
/** Sponsorship reservations whose ledger accounting has settled. */
export const LEDGER_SETTLED_SPONSORSHIP_RESERVATION_STATUSES = [
  "committed",
  "released",
] as const satisfies readonly SponsorshipReservationStatus[];
/** Sponsorship reservations that can still accept a signature. */
export const SIGNABLE_SPONSORSHIP_RESERVATION_STATUSES = [
  "reserved",
  "signed",
] as const satisfies readonly SponsorshipReservationStatus[];
/** Sponsorship reservations awaiting a definitive chain outcome. */
export const RECONCILABLE_SPONSORSHIP_RESERVATION_STATUSES = [
  "signed",
  "submitted",
] as const satisfies readonly SponsorshipReservationStatus[];
/** Sponsorship reservations durably known to have advanced past signing. */
export const POST_SIGNING_SPONSORSHIP_RESERVATION_STATUSES = [
  "submitted",
  "committed",
  "charged_unknown",
] as const satisfies readonly SponsorshipReservationStatus[];

/** Sponsorship reservations whose durable outcome no longer needs reconciliation. */
export const DURABLY_RESOLVED_SPONSORSHIP_RESERVATION_STATUSES = [
  "charged_unknown",
  "committed",
  "released",
] as const satisfies readonly SponsorshipReservationStatus[];

/** Reports whether a sponsorship reservation's signed transaction can be replayed safely. */
export function isReplayableSponsorshipReservationStatus(
  status: SponsorshipReservationStatus
): boolean {
  return REPLAYABLE_SPONSORSHIP_RESERVATION_STATUSES.some((candidate) => candidate === status);
}

/** Reports whether a sponsorship reservation is known to have been submitted. */
export function isSubmittedSponsorshipReservationStatus(
  status: SponsorshipReservationStatus
): boolean {
  return SUBMITTED_SPONSORSHIP_RESERVATION_STATUSES.some((candidate) => candidate === status);
}
