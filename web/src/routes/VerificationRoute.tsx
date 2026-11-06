import { Link } from "@tanstack/react-router";

import { VerificationPanel } from "@/components/VerificationPanel";

export function VerificationRoute() {
  return (
    <div className="flex w-full flex-col gap-6">
      <VerificationPanel />
      <div className="flex flex-wrap items-center justify-between gap-3 text-sm text-slate-600">
        <span>Route: /</span>
        <Link
          className="font-medium text-teal-700 underline decoration-teal-200 underline-offset-4 hover:text-teal-900"
          to="/status"
        >
          View route status
        </Link>
      </div>
    </div>
  );
}
