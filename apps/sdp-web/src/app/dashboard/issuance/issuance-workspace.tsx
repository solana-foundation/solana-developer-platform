"use client";

import { ApiPlaygroundShellSkeleton } from "@/components/api-playground-shell-skeleton";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useDashboardWorkspace } from "@/contexts/dashboard-workspace-context";
import { getStoredApiKeySecret } from "@/lib/playground-api-keys";
import type { PaymentsDashboardWallet } from "@sdp/types";
import { AnimatePresence, motion } from "framer-motion";
import { Plus, Search } from "lucide-react";
import dynamic from "next/dynamic";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { CreateIssuanceTokenModal } from "./create-token-modal";
import { type IssuanceTemplateId, getTemplateCatalogEntry } from "./template-catalog";

const IssuancePlayground = dynamic(
  () => import("./issuance-playground").then((module) => module.IssuancePlayground),
  {
    loading: () => <ApiPlaygroundShellSkeleton />,
  }
);

interface IssuanceTokenView {
  id: string;
  name: string;
  symbol: string;
  status: string;
  template: IssuanceTemplateId | "rwa" | string;
  imageUrl: string | null;
  mintAddress: string | null;
  totalSupply: string;
  createdAt: string;
  deployedAt: string | null;
}

interface IssuanceApiKeyOption {
  id: string;
  name: string;
  keyPrefix: string;
  role: string;
  environment: string;
}

interface IssuanceTemplateOption {
  id: string;
  name: string;
  description?: string;
}

interface IssuanceWorkspaceProps {
  tokens: IssuanceTokenView[];
  templates: IssuanceTemplateOption[];
  apiKeys: IssuanceApiKeyOption[];
  signerWallets: PaymentsDashboardWallet[];
  apiBaseUrl: string | null;
  templatesError: string | null;
  tokensNotice: string | null;
  signerWalletsError: string | null;
}

function formatDate(value: string | null | undefined): string {
  if (!value) {
    return "—";
  }

  const isoDateMatch = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
  if (isoDateMatch) {
    const [, year, month, day] = isoDateMatch;
    return `${month}/${day}/${year}`;
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }

  return date.toLocaleDateString("en-US");
}

function formatSupply(value: string): string {
  const normalized = value.trim();
  if (!normalized) {
    return "0";
  }

  const parsed = Number.parseFloat(normalized);
  if (!Number.isFinite(parsed)) {
    return value;
  }

  const formatted = new Intl.NumberFormat("en-US", {
    notation: "compact",
    maximumFractionDigits: parsed >= 100 ? 0 : 1,
  }).format(parsed);

  return formatted.replace(/\.0([A-Za-z])$/, "$1");
}

function getTokenTypeLabel(template: IssuanceTokenView["template"]): string {
  const templateEntry = getTemplateCatalogEntry(template);
  if (templateEntry?.name) {
    return templateEntry.name;
  }

  return template;
}

export function IssuanceWorkspace({
  tokens,
  templates,
  apiKeys,
  signerWallets,
  apiBaseUrl,
  templatesError,
  tokensNotice,
  signerWalletsError,
}: IssuanceWorkspaceProps) {
  const { issuanceTab, selectedPlaygroundApiKeyId, setPlaygroundApiKeys } = useDashboardWorkspace();
  const [search, setSearch] = useState("");
  const [isCreateTokenModalOpen, setIsCreateTokenModalOpen] = useState(false);
  const isPlaygroundTab = issuanceTab === "playground";

  useEffect(() => {
    setPlaygroundApiKeys(apiKeys);
  }, [apiKeys, setPlaygroundApiKeys]);

  useEffect(() => {
    if (isPlaygroundTab) {
      return;
    }

    const preloadPlayground = () => {
      void import("./issuance-playground");
    };

    // biome-ignore lint/nursery/noSecrets: requestIdleCallback is a browser API, not a secret.
    if (typeof window !== "undefined" && "requestIdleCallback" in window) {
      const idleId = window.requestIdleCallback(preloadPlayground);
      return () => window.cancelIdleCallback(idleId);
    }

    const timeoutId = globalThis.setTimeout(preloadPlayground, 600);
    return () => globalThis.clearTimeout(timeoutId);
  }, [isPlaygroundTab]);

  const selectedPlaygroundApiKey = useMemo(
    () => apiKeys.find((key) => key.id === selectedPlaygroundApiKeyId) ?? null,
    [apiKeys, selectedPlaygroundApiKeyId]
  );
  const selectedPlaygroundApiKeyPrefix = selectedPlaygroundApiKey?.keyPrefix ?? null;
  const playgroundApiKeyValue = useMemo(() => {
    if (!selectedPlaygroundApiKey) {
      return "";
    }

    const stored = getStoredApiKeySecret({
      apiKeyId: selectedPlaygroundApiKey.id,
      keyPrefix: selectedPlaygroundApiKeyPrefix,
    });

    return stored ?? "";
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
  const hasTokens = tokens.length > 0;

  return (
    <div className={isPlaygroundTab ? "flex h-full min-h-0 w-full flex-col" : "w-full space-y-6"}>
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
            {tokensNotice && tokens.length > 0 ? (
              <div className="rounded-xl border border-[rgba(28,28,29,0.12)] bg-[rgba(28,28,29,0.03)] px-4 py-3">
                <p className="text-sm font-medium text-[#1c1c1d]">Token list unavailable</p>
                <p className="mt-1 text-sm text-[rgba(28,28,29,0.72)]">{tokensNotice}</p>
              </div>
            ) : null}

            <div className="flex items-center gap-3">
              <div className="relative flex-1">
                <Search className="pointer-events-none absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-[rgba(28,28,29,0.52)]" />
                <Input
                  value={search}
                  onChange={(event) => {
                    const value = event.currentTarget.value;
                    setSearch(value);
                  }}
                  className="h-10 rounded-[10px] border-[rgba(28,28,29,0.16)] bg-white pl-9"
                  placeholder="Search"
                />
              </div>
              <Button
                type="button"
                className="h-10 rounded-[10px] bg-[#1c1c1d] px-4 text-white hover:bg-[rgba(28,28,29,0.92)]"
                onClick={() => setIsCreateTokenModalOpen(true)}
              >
                Create token
              </Button>
            </div>

            {hasTokens && filteredTokens.length === 0 ? (
              <p className="text-sm text-[rgba(28,28,29,0.64)]">
                No tokens match your current search.
              </p>
            ) : null}

            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
              {filteredTokens.map((token) => (
                <article
                  key={token.id}
                  className="flex min-h-[340px] flex-col rounded-2xl border border-[rgba(28,28,29,0.1)] bg-[#fcfcfa] p-5 shadow-[0_2px_10px_rgba(28,28,29,0.05)]"
                >
                  <div className="mb-4 h-14 w-14 overflow-hidden rounded-full border border-[rgba(28,28,29,0.1)] bg-white">
                    {token.imageUrl ? (
                      // Token logos are dynamic external assets from API data.
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        src={token.imageUrl}
                        alt={`${token.name} logo`}
                        className="h-full w-full object-cover"
                      />
                    ) : (
                      <div className="flex h-full w-full items-center justify-center text-lg font-semibold text-[rgba(28,28,29,0.58)]">
                        {token.symbol.slice(0, 1) || "?"}
                      </div>
                    )}
                  </div>

                  <p className="text-sm font-medium tracking-wide text-[rgba(28,28,29,0.58)] uppercase">
                    {token.symbol}
                  </p>
                  <h3 className="mt-1 text-[30px] leading-[1.1] font-medium text-[#1c1c1d]">
                    {token.name}
                  </h3>

                  <div className="mt-6 space-y-2 rounded-xl border border-[rgba(28,28,29,0.08)] bg-[rgba(28,28,29,0.03)] p-3">
                    <div className="flex items-center justify-between text-sm">
                      <span className="text-[rgba(28,28,29,0.58)]">Type</span>
                      <span className="font-medium text-[#1c1c1d]">
                        {getTokenTypeLabel(token.template)}
                      </span>
                    </div>
                    <div className="flex items-center justify-between text-sm">
                      <span className="text-[rgba(28,28,29,0.58)]">Supply</span>
                      <span className="font-medium text-[#1c1c1d]">
                        {formatSupply(token.totalSupply)}
                      </span>
                    </div>
                    <div className="flex items-center justify-between text-sm">
                      <span className="text-[rgba(28,28,29,0.58)]">Created</span>
                      <span className="font-medium text-[#1c1c1d]">
                        {formatDate(token.createdAt)}
                      </span>
                    </div>
                  </div>

                  <div className="mt-auto pt-3">
                    <Button
                      type="button"
                      variant="outline"
                      className="h-11 w-full rounded-[10px]"
                      asChild
                    >
                      <Link href={`/dashboard/issuance/${token.id}`}>Manage</Link>
                    </Button>
                  </div>
                </article>
              ))}

              <button
                type="button"
                onClick={() => setIsCreateTokenModalOpen(true)}
                className="flex min-h-[340px] items-center justify-center rounded-2xl border border-dashed border-[rgba(28,28,29,0.2)] bg-[#fcfcfa] text-[rgba(28,28,29,0.5)] transition-colors hover:border-[rgba(28,28,29,0.35)] hover:text-[rgba(28,28,29,0.75)]"
                aria-label="Add new token"
              >
                <Plus className="h-6 w-6" />
              </button>
            </div>

            <CreateIssuanceTokenModal
              open={isCreateTokenModalOpen}
              onOpenChange={setIsCreateTokenModalOpen}
              signerWallets={signerWallets}
              signerWalletsError={signerWalletsError}
              hideTrigger
            />
          </motion.div>
        ) : (
          <motion.div
            key="playground-tab"
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -8 }}
            transition={{ duration: 0.2, ease: "easeOut" }}
            className="h-full min-h-0 w-full"
          >
            <IssuancePlayground
              apiBaseUrl={apiBaseUrl}
              apiKeyValue={playgroundApiKeyValue}
              hasActiveApiKeys={apiKeys.length > 0}
              templates={templates}
              templatesError={templatesError}
              tokens={tokens}
            />
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
