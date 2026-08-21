import type { RuntimeHealth, RuntimeHealthComponent, RuntimeHealthStatus } from "@sdp/helius-rings";
import { RUNTIME_HEALTH_COMPONENTS } from "@sdp/helius-rings";
import type { RepositoryDbClient } from "./base";

/**
 * One row per (project, component). Overwritten in place rather than appended:
 * this is the status board the diagnostics page and the red-state action gate
 * read, not a history. Durable history lives in the event feed.
 */
export interface HeliusRingsRuntimeHealthRow {
  project_id: string;
  component: RuntimeHealthComponent;
  status: RuntimeHealthStatus;
  observed_at: string;
  detail: Record<string, string> | null;
}

export interface RecordHeliusRingsHealthInput {
  projectId: string;
  component: RuntimeHealthComponent;
  status: RuntimeHealthStatus;
  detail?: Record<string, string> | null;
}

export interface HeliusRingsHealthRepositoryContext {
  db: RepositoryDbClient;
}

export interface HeliusRingsHealthRepository {
  /** Upserts the latest observation for one component. */
  recordHealth(input: RecordHeliusRingsHealthInput): Promise<HeliusRingsRuntimeHealthRow>;
  listHealthByProject(input: { projectId: string }): Promise<HeliusRingsRuntimeHealthRow[]>;
}

/**
 * Collapses the stored rows into the domain's component-to-status map.
 *
 * A component with no row yet reads as `red`, not `green`: never having observed
 * an upstream is not evidence that it is healthy, and the action gate keys off
 * this value.
 */
export function mapHeliusRingsHealthRows(rows: HeliusRingsRuntimeHealthRow[]): RuntimeHealth {
  const byComponent = new Map(rows.map((row) => [row.component, row]));
  const detail: Record<string, string> = {};
  for (const row of rows) {
    for (const [key, value] of Object.entries(row.detail ?? {})) {
      detail[`${row.component}.${key}`] = value;
    }
  }

  const health = {} as Record<RuntimeHealthComponent, RuntimeHealthStatus>;
  for (const component of RUNTIME_HEALTH_COMPONENTS) {
    health[component] = byComponent.get(component)?.status ?? "red";
  }

  return Object.keys(detail).length > 0 ? { ...health, detail } : { ...health };
}
