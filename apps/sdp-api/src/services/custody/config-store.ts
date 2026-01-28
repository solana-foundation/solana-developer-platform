/**
 * Custody Config Store
 *
 * Handles persistence for custody configuration records.
 */

import type { CustodyConfigRecord, CustodyConfiguration } from "./types";

export class CustodyConfigStore {
  constructor(private db: D1Database) {}

  async findActive(orgId: string, projectId?: string): Promise<CustodyConfigRecord | null> {
    if (projectId) {
      const projectConfig = await this.db
        .prepare(
          `SELECT * FROM custody_configs
           WHERE organization_id = ? AND project_id = ? AND status = 'active'`
        )
        .bind(orgId, projectId)
        .first<CustodyConfigRecord>();

      if (projectConfig) {
        return projectConfig;
      }
    }

    const orgConfig = await this.db
      .prepare(
        `SELECT * FROM custody_configs
         WHERE organization_id = ? AND project_id IS NULL AND status = 'active'`
      )
      .bind(orgId)
      .first<CustodyConfigRecord>();

    return orgConfig ?? null;
  }

  async getById(configId: string): Promise<CustodyConfigRecord | null> {
    return this.db
      .prepare("SELECT * FROM custody_configs WHERE id = ?")
      .bind(configId)
      .first<CustodyConfigRecord>();
  }

  async upsert(
    orgId: string,
    projectId: string | undefined,
    config: CustodyConfiguration
  ): Promise<string> {
    const existingConfig = await this.findActive(orgId, projectId);
    const now = new Date().toISOString();
    const encryptedConfig = JSON.stringify(config);

    if (existingConfig) {
      await this.db
        .prepare(
          `UPDATE custody_configs
           SET provider = ?, config = ?, default_wallet_id = ?, updated_at = ?
           WHERE id = ?`
        )
        .bind(
          config.provider,
          encryptedConfig,
          config.defaultWalletId ?? null,
          now,
          existingConfig.id
        )
        .run();

      return existingConfig.id;
    }

    const id = `cust_${crypto.randomUUID()}`;
    await this.db
      .prepare(
        `INSERT INTO custody_configs
         (id, organization_id, project_id, provider, config, default_wallet_id, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?)`
      )
      .bind(
        id,
        orgId,
        projectId ?? null,
        config.provider,
        encryptedConfig,
        config.defaultWalletId ?? null,
        now,
        now
      )
      .run();

    return id;
  }
}
