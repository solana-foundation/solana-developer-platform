/**
 * The plain NOSUPERUSER/NOBYPASSRLS role tests connect through so the
 * tenant-isolation RLS policies (migration 0079) are actually evaluated —
 * the testcontainers bootstrap user is a superuser and would bypass them.
 * Created with its grants by node-global-setup.ts before the worker-database
 * clone. Shared as a module because the global setup runs in a separate
 * process from the workers.
 */
export const TEST_RUNTIME_ROLE = "sdp_runtime";
export const TEST_RUNTIME_PASSWORD = "sdp_runtime_test";
