-- Install pg_trgm transactionally before the non-transactional concurrent
-- index migrations that depend on it. Cloud SQL for PostgreSQL supports this
-- trusted extension for users with CREATE privilege on the database.

CREATE EXTENSION IF NOT EXISTS pg_trgm;
