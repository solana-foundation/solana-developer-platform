import type { VercelConfig } from "@vercel/config/v1";

export const config: VercelConfig = {
  // Ignored-build-step semantics are inverted from intuition: exit 0 SKIPS the
  // build, exit 1 BUILDS.
  //
  // Branches:
  //   1. Non-main refs always build — PR previews are unaffected.
  //   2. Main builds only when the commit author is sdp-release-bot[bot] (the
  //      release-please app). Squash merges carry the PR author's GitHub
  //      account, so only PRs opened by the release app produce bot-authored
  //      commits — this turns "push to main" into "deploy on release".
  //   3. Every other main push is skipped, so regular merges never reach
  //      production.
  //
  // Spoof resistance: VERCEL_GIT_COMMIT_AUTHOR_LOGIN is resolved by GitHub
  // from the merged PR's author account, not from forgeable git metadata, and
  // main is squash-merge-only with required signatures — a forged-author
  // commit cannot become the head of main.
  ignoreCommand:
    'sh -c \'[ "$VERCEL_GIT_COMMIT_REF" = main ] || exit 1; [ "$VERCEL_GIT_COMMIT_AUTHOR_LOGIN" = "sdp-release-bot[bot]" ] && exit 1; exit 0\'',
};
