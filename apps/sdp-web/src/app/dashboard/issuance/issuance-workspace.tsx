"use client";

import { ApiEndpointPlayground } from "@/components/api-endpoint-playground";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useDashboardWorkspace } from "@/contexts/dashboard-workspace-context";
import { getStoredApiKeySecret } from "@/lib/playground-api-keys";
import { AnimatePresence, motion } from "framer-motion";
import { Search } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { type IssuanceTemplateId, getTemplateCatalogEntry } from "./template-catalog";

interface IssuanceTokenView {
  id: string;
  name: string;
  symbol: string;
  status: string;
  template: IssuanceTemplateId | "rwa" | string;
  mintAddress: string | null;
  totalSupply: string;
  createdAt: string;
  deployedAt: string | null;
}

interface IssuancePlaygroundEndpointConfig {
  title: string;
  description: string;
  method: "GET" | "POST";
  path: string;
  expectedResponse: unknown;
  requestBodyExample?: unknown;
}

const issuancePlaygroundEndpointConfigs: IssuancePlaygroundEndpointConfig[] = [
  {
    title: "List templates",
    description: "Fetch supported issuance templates and defaults.",
    method: "GET",
    path: "/v1/issuance/templates",
    expectedResponse: {
      data: {
        templates: [
          {
            id: "stablecoin",
            name: "Stablecoin",
            defaultDecimals: 6,
            requiredExtensions: ["transferFee"],
            optionalExtensions: ["pausable"],
          },
        ],
      },
    },
  },
  {
    title: "List tokens",
    description: "Page through tokens in the active organization or project scope.",
    method: "GET",
    path: "/v1/issuance/tokens",
    expectedResponse: {
      data: [
        {
          id: "tok_abc123",
          name: "Acme Dollar",
          symbol: "ACME",
          status: "active",
          mintAddress: "mint_acme_primary",
          totalSupply: "1250000",
        },
      ],
      meta: { page: 1, pageSize: 20, total: 1, totalPages: 1 },
    },
  },
  {
    title: "Create token",
    description: "Create a new token record from a template before deployment.",
    method: "POST",
    path: "/v1/issuance/tokens",
    requestBodyExample: {
      name: "Acme Dollar",
      symbol: "ACME",
      template: "stablecoin",
      decimals: 6,
      description: "USD-backed settlement asset",
      uri: "https://example.com/metadata/acme-usd.json",
    },
    expectedResponse: {
      data: {
        token: {
          id: "tok_abc123",
          name: "Acme Dollar",
          symbol: "ACME",
          status: "pending",
          deployedAt: null,
        },
      },
    },
  },
  {
    title: "Refresh total supply",
    description: "Force a read from chain and update cached total supply for a token.",
    method: "POST",
    path: "/v1/issuance/tokens/{tokenId}/supply/refresh",
    expectedResponse: {
      data: {
        token: {
          id: "tok_abc123",
          totalSupply: "1250000",
          totalSupplyUpdatedAt: "2026-02-17T12:00:00.000Z",
        },
      },
    },
  },
  {
    title: "List token transactions",
    description: "Retrieve issuance transaction audit history for one token.",
    method: "GET",
    path: "/v1/issuance/tokens/{tokenId}/transactions",
    expectedResponse: {
      data: {
        items: [
          {
            id: "tx_abc123",
            tokenId: "tok_abc123",
            type: "mint",
            status: "confirmed",
            signature: "5P7B...",
            createdAt: "2026-02-16T10:20:30.000Z",
          },
        ],
      },
      meta: { page: 1, pageSize: 20, total: 1, totalPages: 1 },
    },
  },
];

interface IssuanceApiKeyOption {
  id: string;
  name: string;
  keyPrefix: string;
  role: string;
  environment: string;
}

interface IssuanceWorkspaceProps {
  tokens: IssuanceTokenView[];
  apiKeys: IssuanceApiKeyOption[];
  apiBaseUrl: string | null;
  templatesError: string | null;
  tokensError: string | null;
}

function formatDate(value: string | null | undefined): string {
  if (!value) {
    return "—";
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  return date.toLocaleDateString();
}

function normalizeStatus(status: string): string {
  return status.replaceAll("_", " ");
}

function truncateAddress(value: string | null): string {
  if (!value) {
    return "Not deployed";
  }
  if (value.length <= 12) {
    return value;
  }
  return `${value.slice(0, 4)}...${value.slice(-4)}`;
}

export function IssuanceWorkspace({
  tokens,
  apiKeys,
  apiBaseUrl,
  templatesError,
  tokensError,
}: IssuanceWorkspaceProps) {
  const { issuanceTab, setIssuanceTab, selectedIssuanceApiKeyId, setIssuanceApiKeys } =
    useDashboardWorkspace();
  const [search, setSearch] = useState("");
  const [playgroundApiKeyValue, setPlaygroundApiKeyValue] = useState("");

  useEffect(() => {
    setIssuanceApiKeys(apiKeys);
  }, [apiKeys, setIssuanceApiKeys]);

  const selectedPlaygroundApiKey = useMemo(
    () => apiKeys.find((key) => key.id === selectedIssuanceApiKeyId) ?? null,
    [apiKeys, selectedIssuanceApiKeyId]
  );
  const selectedPlaygroundApiKeyPrefix = selectedPlaygroundApiKey?.keyPrefix ?? null;

  useEffect(() => {
    if (!selectedPlaygroundApiKey) {
      setPlaygroundApiKeyValue("");
      return;
    }

    const stored = getStoredApiKeySecret({
      apiKeyId: selectedPlaygroundApiKey.id,
      keyPrefix: selectedPlaygroundApiKeyPrefix,
    });

    setPlaygroundApiKeyValue(stored ?? "");
  }, [selectedPlaygroundApiKey, selectedPlaygroundApiKeyPrefix]);

  const filteredTokens = useMemo(() => {
    const needle = search.trim().toLowerCase();
    if (!needle) {
      return tokens;
    }

    return tokens.filter((token) => {
      return (
        token.name.toLowerCase().includes(needle) ||
        token.symbol.toLowerCase().includes(needle) ||
        token.id.toLowerCase().includes(needle) ||
        (token.mintAddress ? token.mintAddress.toLowerCase().includes(needle) : false)
      );
    });
  }, [tokens, search]);

  const stats = useMemo(() => {
    const total = tokens.length;
    const active = tokens.filter((token) => token.status === "active").length;
    const pending = tokens.filter((token) => token.status === "pending").length;
    const deployed = tokens.filter((token) => token.mintAddress).length;
    return { total, active, pending, deployed };
  }, [tokens]);

  return (
    <div className="w-full space-y-6">
      <AnimatePresence mode="wait">
        {issuanceTab === "tokens" ? (
          <motion.div
            key="tokens-tab"
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -8 }}
            transition={{ duration: 0.2, ease: "easeOut" }}
            className="space-y-6"
          >
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <Card className="gap-2 py-4">
                <CardHeader className="px-4">
                  <CardDescription>Total tokens</CardDescription>
                  <CardTitle>{stats.total}</CardTitle>
                </CardHeader>
              </Card>
              <Card className="gap-2 py-4">
                <CardHeader className="px-4">
                  <CardDescription>Active</CardDescription>
                  <CardTitle>{stats.active}</CardTitle>
                </CardHeader>
              </Card>
              <Card className="gap-2 py-4">
                <CardHeader className="px-4">
                  <CardDescription>Pending</CardDescription>
                  <CardTitle>{stats.pending}</CardTitle>
                </CardHeader>
              </Card>
              <Card className="gap-2 py-4">
                <CardHeader className="px-4">
                  <CardDescription>Deployed mints</CardDescription>
                  <CardTitle>{stats.deployed}</CardTitle>
                </CardHeader>
              </Card>
            </div>

            {tokensError ? (
              <Card className="border-[#c71f37]/20 bg-[#c71f37]/[0.03]">
                <CardHeader>
                  <CardTitle>Unable to load tokens</CardTitle>
                  <CardDescription>{tokensError}</CardDescription>
                </CardHeader>
              </Card>
            ) : null}

            <Card>
              <CardHeader className="gap-3">
                <CardTitle>Token inventory</CardTitle>
                <CardDescription>
                  Search and inspect issued tokens tracked in this organization workspace.
                </CardDescription>
                <div className="relative w-full sm:max-w-[320px]">
                  <Search className="pointer-events-none absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-[rgba(28,28,29,0.52)]" />
                  <Input
                    value={search}
                    onChange={(event) => {
                      const value = event.currentTarget.value;
                      setSearch(value);
                    }}
                    className="pl-9"
                    placeholder="Find by token, symbol, mint or id"
                  />
                </div>
              </CardHeader>
              <CardContent>
                {filteredTokens.length === 0 ? (
                  <p className="text-sm text-[rgba(28,28,29,0.72)]">
                    {tokens.length === 0
                      ? "No tokens found yet. Use Create token in quick actions to start."
                      : "No tokens match your current search."}
                  </p>
                ) : (
                  <div className="overflow-x-auto">
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>Token</TableHead>
                          <TableHead>Template</TableHead>
                          <TableHead>Status</TableHead>
                          <TableHead>Total supply</TableHead>
                          <TableHead>Mint</TableHead>
                          <TableHead>Created</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {filteredTokens.map((token) => {
                          const template = getTemplateCatalogEntry(token.template) ?? null;
                          return (
                            <TableRow key={token.id}>
                              <TableCell>
                                <div>
                                  <p className="font-medium text-[#1c1c1d]">{token.name}</p>
                                  <p className="text-xs text-[rgba(28,28,29,0.62)]">
                                    {token.symbol}
                                  </p>
                                </div>
                              </TableCell>
                              <TableCell>{template?.name ?? token.template}</TableCell>
                              <TableCell>
                                <span className="rounded-full bg-[rgba(28,28,29,0.08)] px-2 py-0.5 text-xs capitalize">
                                  {normalizeStatus(token.status)}
                                </span>
                              </TableCell>
                              <TableCell className="font-mono text-xs">
                                {token.totalSupply}
                              </TableCell>
                              <TableCell className="font-mono text-xs">
                                {truncateAddress(token.mintAddress)}
                              </TableCell>
                              <TableCell className="text-xs text-[rgba(28,28,29,0.66)]">
                                {formatDate(token.createdAt)}
                              </TableCell>
                            </TableRow>
                          );
                        })}
                      </TableBody>
                    </Table>
                  </div>
                )}
              </CardContent>
            </Card>
          </motion.div>
        ) : (
          <motion.div
            key="playground-tab"
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -8 }}
            transition={{ duration: 0.2, ease: "easeOut" }}
            className="space-y-6"
          >
            <Card>
              <CardHeader>
                <CardTitle>Issuance API playground</CardTitle>
                <CardDescription>
                  Reusable per-endpoint playground cards with expected responses, fetch snippet
                  copy, API key selector, and live execution.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="rounded-xl border border-[rgba(28,28,29,0.12)] bg-[rgba(28,28,29,0.02)] p-3 text-xs text-[rgba(28,28,29,0.64)]">
                  Endpoints with <code>{"{tokenId}"}</code> require a real token id in their
                  configured path before execution.
                </div>
                {templatesError ? (
                  <div className="rounded-xl border border-[#c71f37]/20 bg-[#c71f37]/[0.03] p-3 text-sm text-[#8a1f2a]">
                    Templates status: {templatesError}
                  </div>
                ) : null}
                {apiKeys.length === 0 ? (
                  <div className="rounded-xl border border-[#c71f37]/20 bg-[#c71f37]/[0.03] p-3 text-sm text-[#8a1f2a]">
                    No active API keys found. Create one in API keys before running mutable issuance
                    endpoints.
                  </div>
                ) : null}
              </CardContent>
            </Card>

            <div className="space-y-4">
              {issuancePlaygroundEndpointConfigs.map((endpointConfig) => (
                <ApiEndpointPlayground
                  key={`${endpointConfig.method}-${endpointConfig.path}`}
                  title={endpointConfig.title}
                  description={endpointConfig.description}
                  method={endpointConfig.method}
                  path={endpointConfig.path}
                  expectedResponse={endpointConfig.expectedResponse}
                  requestBodyExample={endpointConfig.requestBodyExample}
                  apiKeyValue={playgroundApiKeyValue}
                  apiBaseUrl={apiBaseUrl}
                  defaultOpen={endpointConfig.path === "/v1/issuance/templates"}
                />
              ))}
            </div>

            <div className="flex justify-end">
              <Button type="button" variant="secondary" onClick={() => setIssuanceTab("tokens")}>
                Back to tokens
              </Button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
