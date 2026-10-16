export const PROJECT_COOKIE_NAME = "sdp_selected_project_id";
export const PROJECT_HEADER_NAME = "x-project-id";

export const PROJECT_COOKIE_OPTIONS = {
  path: "/",
  maxAge: 31_536_000,
  sameSite: "lax" as const,
  secure: process.env.NODE_ENV === "production",
  httpOnly: true,
};
