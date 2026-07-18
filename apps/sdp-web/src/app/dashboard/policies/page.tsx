import { auth } from "@clerk/nextjs/server";
import type {
  PolicyControlInventoryResponse,
  PolicyControlInventoryStatus,
  PolicyControlInventoryTarget,
} from "@sdp/types";
import { redirect } from "next/navigation";
import { getAuthEntryPath } from "@/lib/auth-entry";
import { createTimedTrace } from "@/lib/request-tracing";
import { createSdpApiClient } from "@/lib/sdp-api";
import { PoliciesOverview, type PoliciesTab, type PoliciesUrlState } from "./policies-overview";

export const dynamic = "force-dynamic";

type RawSearchParams = Record<string, string | string[] | undefined>;

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function parsePositiveInteger(value: string | undefined, fallback: number, maximum = Infinity) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 && parsed <= maximum ? parsed : fallback;
}

function parseState(params: RawSearchParams): PoliciesUrlState {
  const tabParam = first(params.tab);
  const tab: PoliciesTab = tabParam === "wallets" || tabParam === "api_keys" ? tabParam : "all";
  const statusParam = first(params.status);
  const status: PolicyControlInventoryStatus | "" =
    statusParam === "default_allow" ||
    statusParam === "draft" ||
    statusParam === "active" ||
    statusParam === "disabled"
      ? statusParam
      : "";
  return {
    tab,
    query: first(params.query)?.trim() ?? "",
    status,
    page: parsePositiveInteger(first(params.page), 1),
    pageSize: parsePositiveInteger(first(params.pageSize), 25, 100),
  };
}

function inventoryTarget(tab: PoliciesTab): PolicyControlInventoryTarget {
  if (tab === "wallets") return "wallet";
  if (tab === "api_keys") return "api_key";
  return "all";
}

export default async function PoliciesPage({
  searchParams,
}: {
  searchParams?: Promise<RawSearchParams>;
}) {
  const { userId, orgId } = await auth();
  if (!userId) redirect(await getAuthEntryPath());
  if (!orgId) redirect("/dashboard");

  const state = parseState((await searchParams) ?? {});
  const query = new URLSearchParams({
    target: inventoryTarget(state.tab),
    page: String(state.page),
    pageSize: String(state.pageSize),
  });
  if (state.query) query.set("query", state.query);
  if (state.status) query.set("status", state.status);

  const trace = createTimedTrace("dashboard.policies.page");
  let inventory: PolicyControlInventoryResponse | null = null;
  let error = false;
  try {
    const client = await trace.step("create_sdp_api_client", () =>
      createSdpApiClient(trace.childContext("dashboard.policies.api"))
    );
    inventory = await trace.step("fetch_policy_controls", () =>
      client.fetch<PolicyControlInventoryResponse>(`/v1/policies?${query.toString()}`)
    );
    trace.log({ ok: true, resultCount: inventory.controls.length, total: inventory.total });
  } catch (cause) {
    error = true;
    trace.log({
      ok: false,
      error: cause instanceof Error ? cause.message : "Unknown error",
    });
  }

  return <PoliciesOverview inventory={inventory} error={error} state={state} />;
}
