import type { Zone, ZoneKind } from "@sdp/helius-rings";
import type { RepositoryDbClient } from "./base";

export function generateHeliusRingsZoneId(): string {
  return `hrz_${crypto.randomUUID()}`;
}

export interface HeliusRingsZoneRow {
  id: string;
  wallet_id: string;
  name: string;
  kind: ZoneKind;
  created_at: string;
}

export interface CreateHeliusRingsZoneInput {
  walletId: string;
  name: string;
  kind: ZoneKind;
}

export interface HeliusRingsZoneRepositoryContext {
  db: RepositoryDbClient;
}

export interface HeliusRingsZoneRepository {
  /** Zone names are unique per wallet; a replay returns the existing zone. */
  createZone(input: CreateHeliusRingsZoneInput): Promise<HeliusRingsZoneRow | null>;
  getZoneById(input: { id: string; walletId: string }): Promise<HeliusRingsZoneRow | null>;
  listZonesByWallet(input: { walletId: string }): Promise<HeliusRingsZoneRow[]>;
}

export function mapHeliusRingsZoneRow(row: HeliusRingsZoneRow): Zone {
  return { id: row.id, name: row.name, kind: row.kind };
}
