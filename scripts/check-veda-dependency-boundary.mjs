import { assertConsumersWithin, assertExactConsumers } from "./lib/dependency-boundary.mjs";

const VEDA_PACKAGE = "packages/sdp-veda/package.json";
const API_PACKAGE = "apps/sdp-api/package.json";

/**
 * `packages/sdp-veda` is the ONLY owner of `@vedatech/svm-sdk`.
 *
 * The SDK is a vendor chain client built against `@solana/kit` 7 while this
 * repo pins 6.8; `packages/sdp-veda/src/sdk.ts` is the only module that may
 * import it, and a second package owning the dependency would put another
 * nested kit major in front of code that never asked for one — and a second
 * copy of the IDL/ABI assumptions `idl-layout.test.ts` pins to exactly one
 * place.
 */
assertExactConsumers("@vedatech/svm-sdk", [VEDA_PACKAGE]);

/**
 * Only the API may ship `@sdp/veda`.
 *
 * A WITHIN check rather than an exact one: zero consumers is a legitimate state
 * while the integration is being wired up, and the property worth guarding is
 * that no NEW consumer appears — the dashboard or the docs site pulling this in
 * would drag a chain SDK into bundles that never touch a vault.
 */
assertConsumersWithin("@sdp/veda", [API_PACKAGE]);

console.log("Veda dependency boundary OK: API -> @sdp/veda -> @vedatech/svm-sdk (single owner)");
