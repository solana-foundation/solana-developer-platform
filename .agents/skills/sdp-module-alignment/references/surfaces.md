# Public surface, docs and infra checks (D1-D4, E1-E3)

What a module exposes beyond its code, and where it runs. `api/` =
`apps/sdp-api/src/`.

## D1 Public OpenAPI and AI resources

- **Condition:** the public document comes from
  `createPublicOpenApiDocument({ releaseChannel })` (`api/openapi/spec.ts`),
  which drops routes of modules outside the channel; shared schemas drop their
  enum values and `oneOf` branches in `api/openapi/release-channel-values.ts`.
  Never hand-maintain a list of the module's routes anywhere else. A family is
  held out of the public document in one of two ways: a flag
  (`EARN_PUBLIC_SURFACE_PUBLISHED = false`), or omission of its tag from
  `PUBLIC_OPENAPI_TAGS` in the same file (DvP, Private Channels). Lifting either
  hold, or promoting any route into the public document, is a
  security-relevant scope change that needs a named sign-off.
- **Verify:** scanner D1 prints the internal paths file and whether the tag is
  public. In the fix PR (these write files), regenerate and diff:
  `pnpm -C apps/sdp-api openapi:generate`, `pnpm -C apps/sdp-api
  route-actions:generate`, `pnpm generate:api-playground` then `pnpm
  check:api-playground`, `pnpm -C apps/sdp-docs generate:api`, `pnpm -C
  apps/sdp-docs generate:ai`. Never hand-edit the generated files. The
  committed AI files are built at `experimental`, so check what they list
  (grantable actions included) against what `stable` publishes.
- **Done:** no drift after regeneration; internal OpenAPI descriptions match
  behavior (Earn's still say an expired build is refused with 409
  `TRANSACTION_EXPIRED`, which nothing has thrown since #2178).

## D2 Docs site

- **Condition:** a page about one module takes `module: <module>` frontmatter
  (or `rampProvider:`); shared pages never name a module and use the generated
  blocks (`<ModuleTable />`, `<ModuleCapabilities />`, ...) for lists. An
  unpublished guide lives outside `content/docs` (Earn's is in
  `apps/sdp-docs/content/unpublished/`). Rules: `apps/sdp-docs/CLAUDE.md`
  "Release Channels".
- **Verify:** scanner D1 counts the module's pages; `pnpm --filter sdp-docs
  check:links` on both `experimental` and `stable`; `pnpm --filter sdp-docs
  build`.
- **Done:** links clean on both channels; no page states a fixed host for the
  module ("the project's environment decides", never "api-preview is devnet").

## D3 Partner material, examples and skills

- **Condition:** example apps, integration snippets, partner PDFs and
  repo-local skills match the current contract: base URL (a host that serves
  the module, see E3), auth (action grants, `sf_` keys), routes, defaults.
- **Verify:** scanner D3 flags fixed API hosts in the module's code; grep the
  example app and docs for the module's old scopes and route names.
- **Earn:** the 09-10 partner PDFs pointed at `api.solana.com` (403 for Earn),
  used retired scopes, claimed public OpenAPI routes that are held, and missed
  14 queued-withdrawal routes; the unpublished guide still defaults
  `SDP_API_URL` to `https://api.solana.com`.

## D4 Repo docs

- **Condition:** the module's `CLAUDE.md` files, root `AGENTS.md`, the relevant
  ADR consequences and `docs/architecture/module-map.md` (regenerate with
  `pnpm generate:module-map`, never by hand) describe the module as it is after
  the change. Kit versions and other pins in package `CLAUDE.md` files match
  the catalog.
- **Earn:** `packages/sdp-kamino/CLAUDE.md` still says the repo pins kit 6.8.0
  while the catalog pins 7.1.1.

## E1 Where it runs

- **Condition:** know each deployment's channel and the module's flags before
  testing or writing docs. Read sdp-infra from `origin/main` after a fetch,
  never a local branch: `terraform/envs/{dev,stage,prod}/terraform.tfvars`
  (`sdp_api_release_channel`, `sdp_api_<module>_enabled`). Stage Terraform has
  no CI apply, so merged and applied are separate facts.
- **Verify:** scanner E1 prints the tfvars lines; then probe each host (A1).

## E2 Alerts, runbooks and dashboards

- **Condition:** the module's crons and money paths have alert rules that group
  by `environment` (after A5's flip), runbooks describe current behavior, the
  signal inventory lists the module's events, and nothing describes a removed
  path. A cron with no rule at all is a gap to raise, not a pass.
- **Verify:** scanner E2 lists sdp-infra rules and runbooks naming the module
  (DvP and Rings have none today).
- **Earn:** sdp-infra #286 regrouped 20 Earn rules per environment before the
  cron flip; #295 rewrote the anonymous-traffic runbook after keyless Earn was
  removed.

## E3 Live behavior

- **Condition:** every claim about where the module runs is a live probe from
  today, not a note: `curl -s -o /dev/null -w '%{http_code}'
  https://api-dev.solana.com/v1/<module>/<list-route>` and the same on
  `api-preview` and `api`. Loki (`sdp_cron_run`, vendor-call events) confirms
  crons tick per environment after a flip.
