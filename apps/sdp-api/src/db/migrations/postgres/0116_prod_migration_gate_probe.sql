-- CI probe for the prod merge-deploy migration gate. Deliberately a no-op:
-- stage applies it and records the filename in schema_migrations; the prod
-- merge deploy must fail at "Gate merge deploys on pending migrations" until
-- a release is cut. Revert this file after the probe; the runner ignores
-- applied rows whose file is gone.
SELECT 1;
