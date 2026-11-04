"use client";

// Without a boundary here, a throw in any dashboard page would be caught at the
// app root, outside the shell, taking the sidebar and every client effect
// mounted inside it with it.
//
// Sitting under the [projectId] layout means the chrome survives and only the
// content slot is replaced, so the rest of the dashboard stays navigable. An
// error in that layout itself (the Project list failing to load) is caught one
// level up by app/(session)/dashboard/error.tsx, and one in the dashboard
// layout (the admission check failing) by app/error.tsx.
//
// Project selection is not a reason to land here: the `[projectId]` layout
// redirects a Project the user cannot list to the Sandbox before any page
// renders. What still arrives is a genuine failure, such as the API being down.
export { RouteError as default } from "@/components/route-error";
