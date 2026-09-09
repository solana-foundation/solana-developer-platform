# Branch controls

How branch protection for this repository is owned, enforced, and changed
(SDLC §§3.2.5, 3.4.1–3.4.2, 4).

## What is enforced on `main`

Rules come from the organization-level ruleset and are snapshotted in
`.github/branch-rules-baseline.json`:

- no direct pushes: every change lands through a pull request with at least one
  approving review, re-approval after the last push, and an extra approval for
  unattributed changes;
- no force pushes, no branch deletion;
- verified commit signatures;
- squash or rebase merges only.

Required status checks and code-owner review are configured in the same ruleset;
the baseline file is the reviewed record of the full rule set.

## Control owner

The SDP security owner holds this control. Ruleset changes are made by an
organization administrator at the security owner's request — never ad hoc.

## Changing the rules

1. Open a pull request updating `.github/branch-rules-baseline.json` to the
   intended state and describing why.
2. After that PR is approved, an organization administrator applies the matching
   ruleset change.
3. The `branch-rules-drift` workflow verifies live rules against the baseline
   every six hours and on baseline PRs; a mismatch pages the alerts channel and
   fails until the ruleset and the baseline agree again.

An unannounced ruleset change therefore surfaces within six hours as a drift
alert, and the git history of the baseline file is the control's audit evidence.

## Security-relevant checks

`workflow-security.yml` (actionlint, full-SHA action pins, the changed-packages
injection fixture) runs on every pull request so it can be a required check —
path filtering was removed deliberately; a check that does not run cannot be
required.
