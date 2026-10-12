// Retired docs URLs, served by next.config.mjs. Add an entry whenever a page
// under content/docs is deleted or renamed so inbound links keep resolving.
// guides/embedded-yield is deliberately absent: Earn stays unpublished until
// PRO-2038, so that URL should 404 rather than point anywhere.
export const DOCS_REDIRECTS = [
  // d9e0c9127: docs redesign.
  {
    source: "/docs/what-is-solana-developer-platform",
    destination: "/docs/introduction",
    permanent: true,
  },
  {
    source: "/docs/getting-started",
    destination: "/docs/guides/setup-organization",
    permanent: true,
  },
  {
    source: "/docs/guides/transfer-tokens",
    destination: "/docs/payments/send-basic-payment",
    permanent: true,
  },
  // f8ea8490f: wallet operations got its own section. HOO-1889 then removed
  // wallet and API-key policies in favor of allowed operations on API keys.
  {
    source: "/docs/payments/wallet-policies",
    destination: "/docs/developing-with-sdp/manage-api-keys",
    permanent: true,
  },
  {
    source: "/docs/wallet-operations/policies",
    destination: "/docs/developing-with-sdp/manage-api-keys",
    permanent: true,
  },
  {
    source: "/docs/reference/api/policies",
    destination: "/docs/developing-with-sdp/manage-api-keys",
    permanent: true,
  },
  {
    source: "/docs/reference/api/policies/:path*",
    destination: "/docs/developing-with-sdp/manage-api-keys",
    permanent: true,
  },
  {
    source: "/docs/payments/wallet-balances",
    destination: "/docs/wallet-operations/balances",
    permanent: true,
  },
  // 9628cfc04: token guides moved under tokens/, API keys under developing-with-sdp/.
  { source: "/docs/home", destination: "/docs", permanent: true },
  {
    source: "/docs/guides/tokenize-an-asset",
    destination: "/docs/tokens/tokenize-an-asset",
    permanent: true,
  },
  {
    source: "/docs/guides/create-a-token",
    destination: "/docs/tokens/create-a-token",
    permanent: true,
  },
  {
    source: "/docs/guides/deploy-a-token",
    destination: "/docs/tokens/deploy-a-token",
    permanent: true,
  },
  {
    source: "/docs/guides/mint-and-burn",
    destination: "/docs/tokens/mint-and-burn",
    permanent: true,
  },
  {
    source: "/docs/guides/manage-allowlists",
    destination: "/docs/tokens/allowlists",
    permanent: true,
  },
  {
    source: "/docs/guides/freeze-and-compliance",
    destination: "/docs/tokens/freeze-and-compliance",
    permanent: true,
  },
  {
    source: "/docs/guides/manage-api-keys",
    destination: "/docs/developing-with-sdp/manage-api-keys",
    permanent: true,
  },
  {
    source: "/docs/reference/ai-consumption",
    destination: "/docs/reference/docs-for-ai",
    permanent: true,
  },
  {
    source: "/docs/tutorials/tokenize-a-treasury-fund",
    destination: "/docs/tokens/tokenize-an-asset",
    permanent: true,
  },
  // The prepare-vs-execute guides were replaced by the signing-modes page.
  {
    source: "/docs/guides/prepare-vs-execute",
    destination: "/docs/developing-with-sdp/signing-modes",
    permanent: true,
  },
  {
    source: "/docs/tokens/prepare-vs-execute",
    destination: "/docs/developing-with-sdp/signing-modes",
    permanent: true,
  },
];
