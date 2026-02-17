"use client";

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
import { AnimatePresence, motion } from "framer-motion";
import { Braces, Coins, Search } from "lucide-react";
import { useMemo, useState } from "react";
import { type IssuanceTemplateId, getTemplateCatalogEntry } from "./template-catalog";

interface IssuanceTemplateView {
  id: string;
  name: string;
  description?: string;
}

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

interface IssuanceWorkspaceProps {
  templates: IssuanceTemplateView[];
  tokens: IssuanceTokenView[];
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
  templates,
  tokens,
  templatesError,
  tokensError,
}: IssuanceWorkspaceProps) {
  const { issuanceTab, setIssuanceTab } = useDashboardWorkspace();
  const [search, setSearch] = useState("");

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
                  Reference requests for templates and token operations. Use project-scoped API keys
                  for mutable token endpoints.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="rounded-xl border border-[rgba(28,28,29,0.12)] bg-[rgba(28,28,29,0.03)] p-4">
                  <div className="mb-2 flex items-center gap-2">
                    <Coins className="h-4 w-4 text-[rgba(28,28,29,0.72)]" />
                    <p className="text-sm font-medium text-[#1c1c1d]">Create token from template</p>
                  </div>
                  <pre className="overflow-x-auto text-xs leading-5 text-[rgba(28,28,29,0.78)]">
                    <code>{`POST /v1/issuance/tokens
{
  "name": "Acme Dollar",
  "symbol": "ACME",
  "template": "stablecoin",
  "decimals": 6
}`}</code>
                  </pre>
                </div>

                <div className="rounded-xl border border-[rgba(28,28,29,0.12)] bg-[rgba(28,28,29,0.03)] p-4">
                  <div className="mb-2 flex items-center gap-2">
                    <Braces className="h-4 w-4 text-[rgba(28,28,29,0.72)]" />
                    <p className="text-sm font-medium text-[#1c1c1d]">List tokens</p>
                  </div>
                  <pre className="overflow-x-auto text-xs leading-5 text-[rgba(28,28,29,0.78)]">
                    <code>{"GET /v1/issuance/tokens?page=1&" + "pageSize=50"}</code>
                  </pre>
                </div>

                {templatesError ? (
                  <div className="rounded-xl border border-[#c71f37]/20 bg-[#c71f37]/[0.03] p-3 text-sm text-[#8a1f2a]">
                    Templates status: {templatesError}
                  </div>
                ) : (
                  <div className="rounded-xl border border-[rgba(28,28,29,0.12)] bg-[rgba(28,28,29,0.02)] p-3 text-sm text-[rgba(28,28,29,0.72)]">
                    Available templates:{" "}
                    {templates.map((template) => template.name).join(", ") || "None"}
                  </div>
                )}
              </CardContent>
            </Card>

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
