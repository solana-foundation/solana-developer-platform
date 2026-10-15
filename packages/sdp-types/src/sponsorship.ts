export const SPONSORSHIP_RESERVATION_STATUSES = [
  "reserved",
  "signed",
  "submitted",
  "committed",
  "released",
  "charged_unknown",
] as const;

export type SponsorshipReservationStatus = (typeof SPONSORSHIP_RESERVATION_STATUSES)[number];

/** An in-progress or ambiguous reservation cannot adopt another accounting actor. */
export const SPONSORSHIP_RESERVATION_CONTINUITY_BLOCKED_STATUSES = [
  "reserved",
  "charged_unknown",
] as const satisfies readonly SponsorshipReservationStatus[];

/** A retained signed transaction can be replayed in these states. */
export const SPONSORSHIP_RESERVATION_SIGNED_RESPONSE_STATUSES = [
  "signed",
  "submitted",
  "committed",
] as const satisfies readonly SponsorshipReservationStatus[];

/** A retained submission signature can be replayed in these states. */
export const SPONSORSHIP_RESERVATION_SUBMITTED_RESPONSE_STATUSES = [
  "submitted",
  "committed",
] as const satisfies readonly SponsorshipReservationStatus[];

/** Durable accounting can already have advanced beyond a sign-only state write. */
export const SPONSORSHIP_RESERVATION_SIGNING_ACCOUNTED_STATUSES = [
  ...SPONSORSHIP_RESERVATION_SIGNED_RESPONSE_STATUSES,
  "charged_unknown",
] as const satisfies readonly SponsorshipReservationStatus[];

/** Durable accounting can already have advanced beyond a submission state write. */
export const SPONSORSHIP_RESERVATION_SUBMISSION_ACCOUNTED_STATUSES = [
  ...SPONSORSHIP_RESERVATION_SUBMITTED_RESPONSE_STATUSES,
  "charged_unknown",
] as const satisfies readonly SponsorshipReservationStatus[];
