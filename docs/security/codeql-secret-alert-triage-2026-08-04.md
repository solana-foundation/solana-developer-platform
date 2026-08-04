# CodeQL and secret-scanning triage — 2026-08-04

Owner: `@solana-foundation/sdp-maintainers`

Scope: GitHub security alerts open on `main` at `21b0253b`. This record deliberately excludes secret values.

## CodeQL

| Alert | Severity | Surface | Disposition and evidence |
| --- | --- | --- | --- |
| [#35](https://github.com/solana-foundation/solana-developer-platform/security/code-scanning/35) | High | Generated API docs | Fix in HOO-989. Markdown table content now escapes existing backslashes before delimiters and collapses line breaks; regression tests cover both bypasses. |
| [#39](https://github.com/solana-foundation/solana-developer-platform/security/code-scanning/39) | High | Dashboard API playground | Fix in HOO-989. Generated API-key secrets are memory-only and are never written to Web Storage; regression tests spy on both Web Storage methods. |
| [#44](https://github.com/solana-foundation/solana-developer-platform/security/code-scanning/44), [#45](https://github.com/solana-foundation/solana-developer-platform/security/code-scanning/45) | Medium | Clerk organization service | Dismiss as false positive. The reported source is an operator-owned local environment file and the outbound request intentionally sends the configured Clerk credential to the operator-configured Clerk API. No request-controlled value selects the credential or destination. |
| [#46](https://github.com/solana-foundation/solana-developer-platform/security/code-scanning/46) | Medium | Playwright Clerk setup | Dismiss as test-only false positive. The helper sends the E2E Clerk credential only to the constant `https://api.clerk.com/v1` origin. |
| [#47](https://github.com/solana-foundation/solana-developer-platform/security/code-scanning/47) | Medium | Local dashboard bootstrap | Dismiss as test-only false positive. The test runner intentionally reads its RPC target from operator-controlled local or CI configuration; no product request can select it. |
| [#48](https://github.com/solana-foundation/solana-developer-platform/security/code-scanning/48) | Medium | Solana RPC health probe | Dismiss as false positive. The test harness intentionally probes provider URLs from operator-controlled test configuration; the values do not originate from an HTTP request. |
| [#73](https://github.com/solana-foundation/solana-developer-platform/security/code-scanning/73) | Medium | Issuance E2E fixtures | Dismiss as test-only false positive. API response data is intentionally serialized to a constant repository fixture path; response data cannot influence the path. |
| [#106](https://github.com/solana-foundation/solana-developer-platform/security/code-scanning/106), [#107](https://github.com/solana-foundation/solana-developer-platform/security/code-scanning/107) | Medium | Release workflow | Dismiss as false positive. The protected release job intentionally reads the repository manifest and calls the fixed GitHub API with its workflow token; no product request reaches this path. |
| [#119](https://github.com/solana-foundation/solana-developer-platform/security/code-scanning/119) | Medium | Local API Playwright client | Dismiss as test-only false positive. The E2E API target is supplied by trusted local or CI configuration and is not reachable from product input. |

## Secret scanning

| Alerts | Provider validity | Disposition and evidence |
| --- | --- | --- |
| [#1](https://github.com/solana-foundation/solana-developer-platform/security/secret-scanning/1), [#2](https://github.com/solana-foundation/solana-developer-platform/security/secret-scanning/2), [#3](https://github.com/solana-foundation/solana-developer-platform/security/secret-scanning/3), [#4](https://github.com/solana-foundation/solana-developer-platform/security/secret-scanning/4) | Inactive | Resolve as revoked. GitHub provider checks report every historical credential inactive; none exists on the current tree. |
| [#5](https://github.com/solana-foundation/solana-developer-platform/security/secret-scanning/5) | Not provider-verifiable | Resolve as a non-production example. The only location is an OpenAPI webhook example in a retired source file; it is not a deployed credential and is absent from the current tree. |

## Follow-up rule

New High alerts block release. Medium alerts require an owner and evidence-backed fix or dismissal; test and automation findings must be re-opened if their inputs become reachable from product requests or an untrusted repository context.
