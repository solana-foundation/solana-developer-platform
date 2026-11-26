// The browser posts Sentry events to this same-origin path without cookies, so
// the proxy must treat it as public or every event is turned away as signed out.
export const SENTRY_TUNNEL_PATH = "/monitoring";
