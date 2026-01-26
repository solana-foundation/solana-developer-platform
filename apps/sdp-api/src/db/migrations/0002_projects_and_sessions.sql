-- SDP API Projects and Sessions Schema
-- Migration: 0002_projects_and_sessions.sql

-- Projects for grouping API keys by team/environment
CREATE TABLE projects (
    id TEXT PRIMARY KEY,                              -- prj_xxxxxxxxxxxx
    organization_id TEXT NOT NULL,
    name TEXT NOT NULL,
    slug TEXT NOT NULL,
    description TEXT,
    environment TEXT NOT NULL DEFAULT 'sandbox',      -- sandbox, beta, production
    settings TEXT,                                    -- JSON blob for project-specific config
    status TEXT NOT NULL DEFAULT 'active',            -- active, archived
    created_by TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE,
    FOREIGN KEY (created_by) REFERENCES users(id),
    UNIQUE(organization_id, slug)
);

CREATE INDEX idx_projects_org ON projects(organization_id);
CREATE INDEX idx_projects_status ON projects(status);
CREATE INDEX idx_projects_slug ON projects(organization_id, slug);

-- Project members (many-to-many with project-level roles)
CREATE TABLE project_members (
    id TEXT PRIMARY KEY,                              -- pm_xxxxxxxxxxxx
    project_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'developer',           -- admin, developer, viewer
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    UNIQUE(project_id, user_id)
);

CREATE INDEX idx_project_members_project ON project_members(project_id);
CREATE INDEX idx_project_members_user ON project_members(user_id);

-- Sessions for UI authentication (cookie-based)
CREATE TABLE sessions (
    id TEXT PRIMARY KEY,                              -- ses_xxxxxxxxxxxx
    user_id TEXT NOT NULL,
    organization_id TEXT NOT NULL,
    auth_method TEXT NOT NULL,                        -- magic_link
    ip_address TEXT,
    user_agent TEXT,
    expires_at TEXT NOT NULL,
    revoked_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    last_activity_at TEXT,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE
);

CREATE INDEX idx_sessions_user ON sessions(user_id);
CREATE INDEX idx_sessions_org ON sessions(organization_id);
CREATE INDEX idx_sessions_expires ON sessions(expires_at);

-- Magic link tokens for passwordless authentication
CREATE TABLE magic_links (
    id TEXT PRIMARY KEY,                              -- ml_xxxxxxxxxxxx
    email TEXT NOT NULL,
    token_hash TEXT NOT NULL UNIQUE,                  -- SHA-256 of token
    organization_id TEXT,                             -- Optional: direct to specific org
    expires_at TEXT NOT NULL,
    used_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE SET NULL
);

CREATE INDEX idx_magic_links_email ON magic_links(email);
CREATE INDEX idx_magic_links_token ON magic_links(token_hash);
CREATE INDEX idx_magic_links_expires ON magic_links(expires_at);
