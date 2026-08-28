/**
 * GitHub freezes the commit headline an auto-merge request was armed with.
 * `enablePullRequestAutoMerge` refuses a second call on an already-armed pull
 * request, so a headline armed at one version survives every later update to
 * the pull request itself, including its title.
 *
 * That matters here because release-please recreates the release pull request
 * on every push to `main`. A pull request armed while it was `0.67.2` still
 * squash-merges as `chore(main): release 0.67.2` after it has been recreated as
 * `0.68.0`, and `release-flow.mjs publish` reads the version out of the release
 * commit subject and refuses a mismatch against `package.json`. The refusal is
 * correct, but it costs the release: `publish-release` fails and
 * `deploy-api-production`, which needs it, is skipped.
 *
 * @param {string | null | undefined} armedHeadline Headline currently armed on
 *   the pull request, or null when auto-merge is not armed.
 * @param {string} desiredHeadline Headline the current release version needs.
 * @returns {boolean} True when auto-merge must be disarmed and re-armed.
 */
export function autoMergeNeedsRearm(armedHeadline, desiredHeadline) {
  if (!desiredHeadline) {
    throw new Error("desiredHeadline is required to evaluate auto-merge drift");
  }
  if (!armedHeadline) {
    return false;
  }
  return armedHeadline !== desiredHeadline;
}
