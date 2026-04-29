# Contributing to Solana Developer Platform

## Repo Layout and Prerequisites

- [AGENTS.md](./AGENTS.md) — repo layout, public vs. internal API surfaces, generated-file rules, and the canonical `pnpm` check commands.
- [README.md](./README.md) — Node `>=20` and `pnpm@10.15.1` prerequisites (listed under [README "Prereqs"](./README.md#prereqs)), and the release/deploy model.
- [docs/ops/doppler-secrets.md](./docs/ops/doppler-secrets.md) — Doppler configuration and secrets setup required for local development.

## Pull Requests

- PR titles MUST follow [Conventional Commits](https://www.conventionalcommits.org/) (enforced by [`.github/workflows/pr-title.yml`](./.github/workflows/pr-title.yml)). Allowed types: `build`, `chore`, `ci`, `docs`, `feat`, `fix`, `perf`, `refactor`, `revert`, `style`, `test`.
- PR-title format is load-bearing for Release Please — a non-conforming title blocks CI and breaks the release pipeline.
- Keep PRs small and focused. Link to an issue when one exists.
- Run `pnpm check`, `pnpm test` and `pnpm test:integration` locally before pushing.

## Provider Contributions

SDP is designed to support provider integrations across custody, RPC, compliance, payments, ramps, and related infrastructure. Provider onboarding is self-service for the initial contribution: providers can prepare the integration, open the required access, and submit a PR for review. See the [Provider Onboarding docs](./apps/sdp-docs/content/docs/reference/provider-onboarding.mdx) for provider-type criteria covering RPC, custody, ramps, and compliance.

Before opening an SDP integration PR:

- Complete the [provider intake form](https://solanafoundation.typeform.com/to/gkJC0ZKq).
- Give the Solana Foundation team API access to your sandbox or playground environment so we can test and validate the integration.
- Share enough sandbox credentials, test accounts, supported networks, rate limits, and provider documentation for maintainers to reproduce the integration locally and in CI.
- Confirm that the provider service is suitable for devnet or sandbox testing, and document any mainnet-only behavior.
- Confirm support expectations for integration review, bug fixes, incidents, and breaking API changes.

Custody providers have one additional prerequisite: first make sure your provider is compatible with the Solana keychain repository. After keychain compatibility exists, integrate the provider into SDP by wiring the custody provider registry, dashboard setup flow, API routes, generated docs, and tests.

After intake is submitted, the SDP maintainers target a three to five business day evaluation period. Evaluation includes fit for SDP, sandbox access, API quality, Solana compatibility, security posture, operational readiness, and whether the contribution has enough tests and docs to support users.

## Security

For security vulnerabilities related to code on `main`, please do NOT open an issue — follow [SECURITY.md](./SECURITY.md).

## Reviewers

Reviews are routed via [`.github/CODEOWNERS`](./.github/CODEOWNERS).

## License

By contributing, you agree that your contributions are licensed under the project's [LICENSE](./LICENSE).
