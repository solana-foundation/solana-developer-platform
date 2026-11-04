"use client";

// Catches what no deeper boundary can: a throw in a layout below the root
// (the session or dashboard layouts) and pages outside the dashboard, such as
// the public pay page. Only a throw in the root layout reaches global-error.
export { RouteError as default } from "@/components/route-error";
