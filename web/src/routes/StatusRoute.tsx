import { Link } from "@tanstack/react-router";

export function StatusRoute() {
  return (
    <section className="w-full max-w-3xl border border-slate-200 bg-white p-5 shadow-sm sm:p-7">
      <div className="flex flex-col gap-2 border-b border-slate-200 pb-5">
        <p className="text-xs font-semibold uppercase tracking-[0.14em] text-teal-700">Route status</p>
        <h1 className="text-2xl font-semibold tracking-tight text-slate-950">Status route</h1>
        <p className="text-sm leading-6 text-slate-600">
          This route verifies navigation and layout mounting only. It is not a backend health check.
        </p>
      </div>
      <dl className="grid gap-4 py-5 sm:grid-cols-2">
        <div>
          <dt className="text-xs font-semibold uppercase tracking-[0.12em] text-slate-500">Path</dt>
          <dd className="mt-1 font-mono text-sm text-slate-900">/status</dd>
        </div>
        <div>
          <dt className="text-xs font-semibold uppercase tracking-[0.12em] text-slate-500">Data source</dt>
          <dd className="mt-1 text-sm text-slate-900">None</dd>
        </div>
      </dl>
      <Link
        className="inline-flex rounded-md border border-slate-300 px-3 py-2 text-sm font-medium text-slate-700 hover:border-slate-400 hover:bg-slate-50 hover:text-slate-950"
        to="/"
      >
        Return to runtime
      </Link>
    </section>
  );
}
