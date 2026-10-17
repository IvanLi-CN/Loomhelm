import { Check, CircleDashed, Code2, Database, Route, ServerCog } from "lucide-react";

import { cn } from "@/lib/utils";

type CheckState = "configured" | "boundary";

interface CheckItem {
  description: string;
  icon: typeof Code2;
  label: string;
  state: CheckState;
}

const checks: CheckItem[] = [
  {
    description: "Vite entry and React runtime",
    icon: Code2,
    label: "React + Vite",
    state: "configured"
  },
  {
    description: "Typed code-based route tree",
    icon: Route,
    label: "TanStack Router",
    state: "configured"
  },
  {
    description: "QueryClientProvider mounted at the app boundary",
    icon: Database,
    label: "TanStack Query",
    state: "configured"
  },
  {
    description: "Reserved import boundary for generated API code",
    icon: ServerCog,
    label: "Generated client",
    state: "boundary"
  },
  {
    description: "Manifest and service-worker registration path",
    icon: CircleDashed,
    label: "PWA wiring",
    state: "boundary"
  }
];

interface VerificationPanelProps {
  compact?: boolean;
  className?: string;
}

export function VerificationPanel({ compact = false, className }: VerificationPanelProps) {
  return (
    <section
      aria-labelledby="verification-panel-title"
      className={cn(
        "w-full border border-slate-200 bg-white p-5 shadow-sm sm:p-7",
        compact ? "rounded-md" : "rounded-lg",
        className
      )}
    >
      <div className="flex flex-col gap-2 border-b border-slate-200 pb-5">
        <p className="text-xs font-semibold uppercase tracking-[0.14em] text-teal-700">
          Technical verification
        </p>
        <h1 id="verification-panel-title" className="text-2xl font-semibold tracking-tight text-slate-950">
          Web foundation
        </h1>
        <p className="max-w-2xl text-sm leading-6 text-slate-600">
          A login-free route for checking the frontend runtime. Product workflows and backend data are
          intentionally not included in this foundation surface.
        </p>
      </div>

      <div className="divide-y divide-slate-200">
        {checks.map(({ description, icon: Icon, label, state }) => (
          <div className="flex items-start justify-between gap-4 py-4 first:pt-5 last:pb-0" key={label}>
            <div className="flex min-w-0 items-start gap-3">
              <span className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-md bg-slate-100 text-slate-700">
                <Icon aria-hidden="true" size={16} strokeWidth={1.8} />
              </span>
              <div className="min-w-0">
                <p className="text-sm font-medium text-slate-900">{label}</p>
                <p className="mt-1 text-sm leading-5 text-slate-500">{description}</p>
              </div>
            </div>
            <span
              className={cn(
                "inline-flex shrink-0 items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium",
                state === "configured"
                  ? "bg-emerald-50 text-emerald-700"
                  : "bg-amber-50 text-amber-700"
              )}
            >
              {state === "configured" ? (
                <Check aria-hidden="true" size={13} strokeWidth={2.2} />
              ) : (
                <CircleDashed aria-hidden="true" size={13} strokeWidth={1.8} />
              )}
              {state === "configured" ? "Configured" : "Integration slot"}
            </span>
          </div>
        ))}
      </div>
    </section>
  );
}
