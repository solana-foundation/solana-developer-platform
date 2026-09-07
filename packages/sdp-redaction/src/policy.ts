/**
 * The denylist. One definition, consumed by every observability and audit
 * serialization boundary in the platform.
 *
 * Two rule families live here because they answer different questions:
 *
 * - Credential rules protect *us*: leaked provider secrets are an incident
 *   regardless of which sink they landed in, so these also apply to
 *   client-facing error bodies.
 * - PII rules protect *counterparties*: the identity, contact, and bank fields
 *   the platform stores encrypted (see the PII cipher in the API's
 *   `services/pii-cipher`). These apply only where data is serialized for our
 *   own consumption — logs, Sentry, audit metadata — never to the API response
 *   that returned the data to its own tenant in the first place.
 *
 * Matching is key-based and explicit rather than entropy- or shape-based. A
 * generic "this looks secret" heuristic cannot survive on a blockchain
 * platform: base58 public keys are high-entropy, ubiquitous, public, and the
 * single most useful field in any log line. See NEVER_REDACTED_KEYS below for
 * the list of things a future rule must not start matching.
 */

export const REDACTED = "[REDACTED]";
export const REDACTED_EMAIL = "[REDACTED_EMAIL]";

/**
 * Keys are compared with separators and case removed, so `api_secret`,
 * `apiSecret`, `API-SECRET`, and `Api Secret` are one rule.
 */
export function normalizeKey(key: string): string {
  return key.replace(/[^a-z0-9]/gi, "").toLowerCase();
}

const CREDENTIAL_KEYS = new Set([
  "apikey",
  "authorization",
  "cookie",
  "cookies",
  "credential",
  "credentials",
  "password",
  "pem",
  "secret",
  "setcookie",
  "token",
]);

// `apikey` is a suffix rule, not just an exact one: normalization strips the
// separators from the `x-api-key` header to `xapikey`, which an exact match
// would miss — and that header is exactly what lands in a Sentry
// `request.headers` payload.
const CREDENTIAL_KEY_SUFFIXES = ["secret", "password", "token", "pem", "apikey"];

const CREDENTIAL_KEY_FRAGMENTS = ["privatekey", "secretpayload"];

/** Exact-match PII keys, grouped by the category they belong to. */
const PII_KEYS = new Set([
  // Contact
  "email",
  "emailaddress",
  "phone",
  "phonenumber",
  "mobile",
  "mobilenumber",
  "telephone",
  // Names. Bare `name` is deliberately absent — see NEVER_REDACTED_KEYS.
  "firstname",
  "middlename",
  "lastname",
  "secondlastname",
  "fullname",
  "givenname",
  "familyname",
  "surname",
  "maidenname",
  "legalname",
  "displayname",
  "holdername",
  "accountholdername",
  "beneficiaryname",
  // Date of birth
  "dateofbirth",
  "dob",
  "birthdate",
  "birthday",
  // Postal address components. The container key `address` is NOT matched
  // (it collides with Solana addresses), so a postal address is defused one
  // component at a time instead — which means every spelling a provider uses
  // for the street line has to be here by name. `address1`/`physicalAddress`
  // are Mural's (`MuralPhysicalAddress` in the Mural client),
  // `addressLine1`/`addressLine2` are BVNK's (`BvnkRuleEntityAddress`), and
  // `line1`/`line2` are SDP's own `CounterpartyAddress`.
  //
  // These are unambiguous postal keys, unlike the `*Address` suffix: BVNK's
  // `beneficiaryAddress` holds `destinationWalletAddress`, a crypto address,
  // which is exactly why no blanket suffix rule can exist here.
  "line1",
  "line2",
  "address1",
  "address2",
  "addressline1",
  "addressline2",
  "physicaladdress",
  "residentialaddress",
  "homeaddress",
  "street",
  "streetaddress",
  "mailingaddress",
  "city",
  "locality",
  "postalcode",
  "postcode",
  "zip",
  "zipcode",
  // Government identifiers
  "taxid",
  "taxidentificationnumber",
  "ssn",
  "socialsecuritynumber",
  "nationalid",
  "nationalidnumber",
  "idnumber",
  "passportnumber",
  "documentnumber",
  "licensenumber",
  "driverslicense",
  // Bank and card instruments. `swiftCode`/`bic` identify a bank, not a
  // person, and stay readable for corridor debugging.
  "accountnumber",
  "bankaccountnumber",
  "iban",
  "routingnumber",
  "sortcode",
  "cardnumber",
  "pannumber",
  "cvv",
  "cvc",
  // Whole-blob containers. Their contents are provider-shaped and unbounded,
  // so nothing inside can be vouched for by key.
  "identity",
  "identitydata",
  "providerdata",
  "provideraccountdata",
  "accountdata",
  "piidata",
  "personaldata",
  "personalinfo",
  "kycdata",
  // Network identity. `userAgent` is deliberately absent: it is not
  // identifying on its own and it is how provider-specific client bugs get
  // diagnosed. The audit table stores it in a dedicated column by design.
  "ip",
  "ipaddress",
  "clientip",
  "remoteip",
  "remoteaddr",
  "xforwardedfor",
]);

/**
 * Suffix rules, so `counterpartyEmail` and `invitee_email_address` are covered
 * without enumerating every prefix a caller might invent. Deliberately narrow:
 * there is no `address` suffix rule, because `walletAddress`,
 * `destinationAddress`, and `mintAddress` must survive.
 */
const PII_KEY_SUFFIXES = [
  "email",
  "emailaddress",
  "phone",
  "phonenumber",
  "dateofbirth",
  "postalcode",
  "zipcode",
  "accountnumber",
  "routingnumber",
  "iban",
  "taxid",
  "firstname",
  "lastname",
  "fullname",
];

/**
 * Keys a rule must never start matching. Each one is load-bearing somewhere:
 * losing it would either blind an on-call engineer or break a test that proves
 * scrubbing did not overreach.
 *
 * - `name`: provider names, wallet labels, rule names, token names.
 * - `address` and every `*Address`: Solana public keys. Public on-chain,
 *   pseudonymous, and the primary handle for tracing a payment.
 * - `countryCode` / `subdivisionCode`: needed to debug ramp corridors, and not
 *   identifying once the name, phone, DOB, and street are gone.
 * - `details`: `AppError.details` carries validation output. Its PII-bearing
 *   children (`accountNumber`, `line1`, …) are matched individually.
 * - Any `*Id`: resource ids are the join key between a log line, an audit row,
 *   and a Sentry issue.
 */
export const NEVER_REDACTED_KEYS = [
  "name",
  "address",
  "walletAddress",
  "destinationAddress",
  "mintAddress",
  "countryCode",
  "subdivisionCode",
  "details",
  "userAgent",
  "counterpartyId",
  "organizationId",
  "projectId",
  "requestId",
  "traceId",
] as const;

export function isCredentialKey(key: string): boolean {
  const normalized = normalizeKey(key);
  return (
    CREDENTIAL_KEYS.has(normalized) ||
    CREDENTIAL_KEY_SUFFIXES.some((suffix) => normalized.endsWith(suffix)) ||
    CREDENTIAL_KEY_FRAGMENTS.some((fragment) => normalized.includes(fragment))
  );
}

export function isPiiKey(key: string): boolean {
  const normalized = normalizeKey(key);
  return PII_KEYS.has(normalized) || PII_KEY_SUFFIXES.some((suffix) => normalized.endsWith(suffix));
}

/** The full denylist: what must never be serialized to a telemetry sink. */
export function isSensitiveKey(key: string): boolean {
  return isCredentialKey(key) || isPiiKey(key);
}
