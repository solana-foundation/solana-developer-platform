import { assertConsumersWithin, assertExactConsumers } from "./lib/dependency-boundary.mjs";

const VEDA_PACKAGE = "packages/sdp-veda/package.json";
const API_PACKAGE = "apps/sdp-api/package.json";

/**
 * `@vedatech/svm-sdk` is the ONLY private-registry dependency in this
 * workspace, and keeping it that way is what makes an absent `NPM_TOKEN` a
 * survivable state rather than a broken build.
 *
 * `.github/scripts/pnpm-install.sh` degrades a credential-less install by
 * deselecting exactly ONE workspace project — `@sdp/veda`. That is only sound
 * while `@sdp/veda` is the sole owner of the private package: a second owner
 * would make the fork-safe install fail on a tarball it cannot fetch, and every
 * external contribution would go red on a dependency it never touched.
 *
 * The kit-major boundary rides along. The SDK is built against `@solana/kit` 7
 * while this repo pins 6.8; `packages/sdp-veda/src/sdk.ts` is the only module
 * that may import it, and a second package owning the dependency would put a
 * fourth kit major in front of code that never asked for one.
 */
assertExactConsumers("@vedatech/svm-sdk", [VEDA_PACKAGE]);

/**
 * Only the API may ship `@sdp/veda`.
 *
 * A WITHIN check rather than an exact one: zero consumers is a legitimate state
 * while the integration is being wired up, and the property worth guarding is
 * that no NEW consumer appears — the dashboard or the docs site pulling this in
 * would drag the private SDK into a build whose image has no npm credential.
 */
assertConsumersWithin("@sdp/veda", [API_PACKAGE]);

console.log(
  "Veda dependency boundary OK: API -> @sdp/veda -> @vedatech/svm-sdk (private, single owner)"
);
