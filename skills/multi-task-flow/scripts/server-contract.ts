import type { ConnectObserver } from "./conversation-output";
import type { ProfileCapabilities } from "./execution-profile";

export type DashboardOptions = {
  root: string;
  runId: string;
  port: number;
  token?: string;
  assetsDir: string;
  demoFrame?: boolean;
  connectObserver?: ConnectObserver;
  readOnly?: boolean;
  getProfileCapabilities?: () => Promise<ProfileCapabilities>;
};
export const contentTypes: Record<string, string> = {
  "index.html": "text/html; charset=utf-8",
  "app.js": "text/javascript; charset=utf-8",
  "app.css": "text/css; charset=utf-8",
};
export const maxPreferenceBodyBytes = 1024;
export const dashboardHeaders = {
  "Cache-Control": "no-store",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
  "Content-Security-Policy":
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
};
