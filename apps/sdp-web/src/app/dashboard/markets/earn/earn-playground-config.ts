import type {
  ApiPlaygroundEndpointConfig,
  ApiPlaygroundFieldConfig,
} from "@/components/api-playground-shell";
import type { MessageKey, TranslationValues } from "@/i18n/messages";

/** One of the organization's own programs, so the id field can be a picker. */
export interface EarnPlaygroundProgramView {
  id: string;
  label: string;
}

type Translate = (key: MessageKey, values?: TranslationValues) => string;

const exampleProgramId = "earn_provider_wallet_abc123";
const exampleStrategyId = "earn_strategy_abc123";
const exampleWithdrawalRef = "wd_abc123";
const exampleDestination = "7M6bFdwsXQZX9MjoD4PDxQJb9FZbwdQh6VS8sK7F3WcQ";

// Braces are assembled rather than written inline so the label never looks like
// an i18n interpolation to a reader (or to a linter) scanning this file.
const programIdPathLabel = ["{", "programId", "}"].join("");
const strategyIdPathLabel = ["{", "strategyId", "}"].join("");
const withdrawalRefPathLabel = ["{", "withdrawalRef", "}"].join("");

/**
 * Endpoint catalogue for the Earn API playground.
 *
 * Curated rather than generated: the playground is a reference a partner reads
 * to understand the shape of the integration, so it leads with the two reads
 * that need no setup (`/strategies`) and only then the program surface. Every
 * path here exists — the removed quote/positions/movements routes are
 * deliberately absent, and adding one that 404s would teach a partner a call
 * that cannot work.
 *
 * `mergeOpenApiPlaygroundEndpoints` folds in whatever the committed OpenAPI
 * catalogue also documents, so a route that ships without an entry here still
 * appears rather than silently going missing.
 */
export function buildEarnPlaygroundEndpointConfigs(
  programs: EarnPlaygroundProgramView[],
  t: Translate
): ApiPlaygroundEndpointConfig[] {
  const programOptions = programs.map((program) => ({
    value: program.id,
    label: program.label,
  }));

  // A picker once the organization holds programs, a free-text field before
  // then — the same shape the counterparty playground uses, and the reason a
  // brand-new organization still gets a usable request line.
  const programIdField: ApiPlaygroundFieldConfig =
    programOptions.length > 0
      ? {
          key: "programId",
          label: programIdPathLabel,
          placeholder: exampleProgramId,
          kind: "select",
          options: programOptions,
          defaultValue: programOptions[0]?.value ?? "",
          required: true,
        }
      : {
          key: "programId",
          label: programIdPathLabel,
          placeholder: exampleProgramId,
          required: true,
        };

  const firstProgramId = programs[0]?.id ?? exampleProgramId;

  const curatedEndpoints: ApiPlaygroundEndpointConfig[] = [
    {
      id: "list-earn-strategies",
      title: t("DashboardEarn.playground.listStrategies"),
      method: "GET",
      path: "/v1/earn/strategies",
      pathFields: [],
      bodyFields: [],
      expectedResponse: {
        strategies: [
          {
            id: exampleStrategyId,
            provider: "kamino",
            providerReference: "8F2mL…",
            name: "Kamino Allez USDC",
            sourceKind: "defi",
            depositMints: ["EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"],
            apyType: "variable",
            currentApy: "0.051",
            liquidityTerm: "instant",
            // The two fields a partner most needs to branch on. Kamino
            // catalogues per cluster, so both are environment-dependent: a
            // sandbox caller sees `devnet`/`true`, a production caller
            // `mainnet-beta`/`true`. `fundable` still answers the CLUSTER
            // question only — it does not promise a deposit will succeed.
            hostCluster: "mainnet-beta",
            fundable: true,
            status: "active",
          },
        ],
        total: 21,
        page: 1,
        pageSize: 20,
      },
    },
    {
      id: "get-earn-strategy",
      title: t("DashboardEarn.playground.getStrategy"),
      method: "GET",
      path: `/v1/earn/strategies/${strategyIdPathLabel}`,
      pathFields: [
        {
          key: "strategyId",
          label: strategyIdPathLabel,
          placeholder: exampleStrategyId,
          required: true,
        },
      ],
      bodyFields: [],
      expectedResponse: {
        strategy: {
          id: exampleStrategyId,
          provider: "kamino",
          name: "Kamino Allez USDC",
          currentApy: "0.051",
          hostCluster: "mainnet-beta",
          fundable: true,
        },
      },
    },
    {
      id: "list-earn-programs",
      title: t("DashboardEarn.playground.listPrograms"),
      method: "GET",
      path: "/v1/earn/programs",
      pathFields: [],
      bodyFields: [],
      expectedResponse: {
        programs: [
          {
            id: firstProgramId,
            provider: "ground",
            label: null,
            wallet: {
              status: "ready",
              depositAddress: exampleDestination,
              balance: { totalUsd: "15.00", earnedUsd: "0.00", withdrawableUsd: "15.00" },
            },
          },
        ],
        total: 1,
        page: 1,
        pageSize: 20,
      },
    },
    {
      id: "get-earn-program",
      title: t("DashboardEarn.playground.getProgram"),
      method: "GET",
      path: `/v1/earn/programs/${programIdPathLabel}`,
      pathFields: [programIdField],
      bodyFields: [],
      expectedResponse: {
        program: {
          id: firstProgramId,
          provider: "ground",
          wallet: {
            status: "ready",
            depositAddress: exampleDestination,
            balance: { totalUsd: "15.00", earnedUsd: "0.00", withdrawableUsd: "15.00" },
          },
        },
      },
    },
    {
      id: "list-earn-program-deposits",
      title: t("DashboardEarn.playground.listDeposits"),
      method: "GET",
      path: `/v1/earn/programs/${programIdPathLabel}/deposits`,
      pathFields: [programIdField],
      bodyFields: [],
      expectedResponse: {
        deposits: [
          {
            id: "dep_abc123",
            amountUsd: "15.00",
            token: "usdc",
            status: "completed",
            fromAddress: exampleDestination,
          },
        ],
      },
    },
    {
      id: "preview-earn-withdrawal",
      title: t("DashboardEarn.playground.previewWithdrawal"),
      method: "POST",
      path: `/v1/earn/programs/${programIdPathLabel}/withdrawal-preview`,
      pathFields: [programIdField],
      bodyFields: [
        {
          key: "token",
          label: "token",
          placeholder: "usdc",
          kind: "select",
          options: [
            { label: "usdc", value: "usdc" },
            { label: "usdt", value: "usdt" },
          ],
          defaultValue: "usdc",
          required: true,
        },
        // Optional since PRO-1675: omitted, this is the LIQUIDITY read — what
        // the lane can pay right now — rather than a validation of an amount.
        {
          key: "amountUsd",
          label: "amountUsd",
          placeholder: "25.50",
          description: t("DashboardEarn.playground.amountOptional"),
        },
      ],
      expectedResponse: {
        preview: {
          withdrawableUsd: "15.00",
          amountRequestedUsd: "10.00",
          feeUsd: "0.00",
          totalUsdAfterWithdrawal: "5.00",
        },
      },
    },
    {
      id: "create-earn-withdrawal",
      title: t("DashboardEarn.playground.createWithdrawal"),
      method: "POST",
      path: `/v1/earn/programs/${programIdPathLabel}/withdrawals`,
      pathFields: [programIdField],
      bodyFields: [
        {
          key: "requestId",
          label: "requestId",
          placeholder: "0a1f4c2e-9b6d-4e83-8a11-5c7d2e9f4b60",
          description: t("DashboardEarn.playground.requestIdRequired"),
          required: true,
        },
        { key: "amountUsd", label: "amountUsd", placeholder: "10.00", required: true },
        {
          key: "token",
          label: "token",
          placeholder: "usdc",
          kind: "select",
          options: [
            { label: "usdc", value: "usdc" },
            { label: "usdt", value: "usdt" },
          ],
          defaultValue: "usdc",
          required: true,
        },
        {
          key: "destinationAddress",
          label: "destinationAddress",
          placeholder: exampleDestination,
          required: true,
        },
      ],
      expectedResponse: {
        withdrawal: {
          withdrawalRef: exampleWithdrawalRef,
          status: "processing",
          amountUsd: "10.00",
          token: "usdc",
        },
      },
    },
    {
      id: "list-earn-withdrawals",
      title: t("DashboardEarn.playground.listWithdrawals"),
      method: "GET",
      path: `/v1/earn/programs/${programIdPathLabel}/withdrawals`,
      pathFields: [programIdField],
      bodyFields: [],
      expectedResponse: {
        withdrawals: [
          { withdrawalRef: exampleWithdrawalRef, status: "completed", amountUsd: "10.00" },
        ],
        total: 1,
        page: 1,
        pageSize: 20,
      },
    },
    {
      id: "get-earn-withdrawal",
      title: t("DashboardEarn.playground.getWithdrawal"),
      method: "GET",
      path: `/v1/earn/programs/${programIdPathLabel}/withdrawals/${withdrawalRefPathLabel}`,
      pathFields: [
        programIdField,
        {
          key: "withdrawalRef",
          label: withdrawalRefPathLabel,
          placeholder: exampleWithdrawalRef,
          required: true,
        },
      ],
      bodyFields: [],
      expectedResponse: {
        withdrawal: { withdrawalRef: exampleWithdrawalRef, status: "completed" },
      },
    },
  ];

  return curatedEndpoints;
}
