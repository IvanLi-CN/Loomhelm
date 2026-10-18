import { ArrowUpRight } from "lucide-react";
import {
  Link,
  Outlet,
  createRootRoute,
  createRoute,
  createRouter
} from "@tanstack/react-router";

import { StatusRoute } from "@/routes/StatusRoute";
import { VerificationRoute } from "@/routes/VerificationRoute";

function AppShell() {
  return (
    <div className="min-h-screen bg-slate-50 text-slate-950">
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto flex w-full max-w-5xl items-center justify-between gap-6 px-5 py-4 sm:px-8">
          <a className="text-sm font-semibold tracking-wide text-slate-950" href="/">
            Loomhelm / web foundation
          </a>
          <nav aria-label="Technical routes" className="flex items-center gap-1 text-sm">
            <Link
              activeOptions={{ exact: true }}
              activeProps={{ className: "bg-slate-100 text-slate-950" }}
              className="rounded-md px-3 py-2 text-slate-600 transition-colors hover:bg-slate-100 hover:text-slate-950"
              to="/"
            >
              Runtime
            </Link>
            <Link
              activeProps={{ className: "bg-slate-100 text-slate-950" }}
              className="rounded-md px-3 py-2 text-slate-600 transition-colors hover:bg-slate-100 hover:text-slate-950"
              to="/status"
            >
              Status
            </Link>
          </nav>
        </div>
      </header>
      <main className="mx-auto flex w-full max-w-5xl flex-1 px-5 py-12 sm:px-8 sm:py-16">
        <Outlet />
      </main>
      <footer className="border-t border-slate-200 bg-white">
        <div className="mx-auto flex w-full max-w-5xl items-center justify-between gap-4 px-5 py-4 text-xs text-slate-500 sm:px-8">
          <span>Technical verification surface</span>
          <a
            className="inline-flex items-center gap-1 hover:text-slate-950"
            href="https://github.com/IvanLi-CN/Loomhelm"
            rel="noreferrer"
            target="_blank"
          >
            Repository
            <ArrowUpRight aria-hidden="true" size={14} strokeWidth={1.8} />
          </a>
        </div>
      </footer>
    </div>
  );
}

const rootRoute = createRootRoute({ component: AppShell });

const runtimeRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  component: VerificationRoute
});

const statusRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/status",
  component: StatusRoute
});

const routeTree = rootRoute.addChildren([runtimeRoute, statusRoute]);

export const router = createRouter({
  routeTree,
  defaultPreload: "intent"
});

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
