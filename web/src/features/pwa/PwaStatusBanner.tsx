import { AlertTriangle, CloudOff, Download, LoaderCircle } from "lucide-react";

export function PwaStatusBanner({
  isOnline,
  updateAvailable,
  updateApplied = false,
  updating,
  registrationError,
  onApplyUpdate,
  placement = "fixed"
}: {
  isOnline: boolean;
  updateAvailable: boolean;
  updateApplied?: boolean;
  updating: boolean;
  registrationError: boolean;
  onApplyUpdate: () => void;
  placement?: "fixed" | "inline";
}) {
  const positionClass = placement === "inline" ? "relative w-full" : "fixed inset-x-4 bottom-4 z-50 mx-auto max-w-xl";

  if (!isOnline) {
    return <div className={`${positionClass} flex items-start gap-3 rounded-xl border border-[var(--line)] bg-[var(--surface)] p-4 text-[var(--ink)] shadow-[var(--shadow)]`} role="status" aria-live="polite"><CloudOff className="mt-0.5 shrink-0 text-[var(--warning)]" size={18} aria-hidden="true" /><div className="grid gap-1"><strong className="text-sm">当前处于离线状态</strong><span className="text-xs leading-5 text-[var(--muted)]">当前页面中的已加载内容仍可查看；发送、审批与控制命令不会离线排队或自动补发。</span></div></div>;
  }

  if (registrationError) {
    return <div className={`${positionClass} flex items-start gap-3 rounded-xl border border-[var(--line)] bg-[var(--surface)] p-4 text-[var(--ink)] shadow-[var(--shadow)]`} role="status" aria-live="polite"><AlertTriangle className="mt-0.5 shrink-0 text-[var(--warning)]" size={18} aria-hidden="true" /><div className="grid gap-1"><strong className="text-sm">离线更新服务暂不可用</strong><span className="text-xs leading-5 text-[var(--muted)]">当前页面继续使用；不会因此发送或重放任何控制命令。</span></div></div>;
  }

  if (updateApplied) {
    return <div className={`${positionClass} flex items-start gap-3 rounded-xl border border-[var(--line)] bg-[var(--surface)] p-4 text-[var(--ink)] shadow-[var(--shadow)]`} role="status" aria-live="polite"><Download className="mt-0.5 shrink-0 text-[var(--accent)]" size={18} aria-hidden="true" /><div className="grid gap-1"><strong className="text-sm">更新已准备</strong><span className="text-xs leading-5 text-[var(--muted)]">最新资源会在下次导航加载；当前页面不会被强制重载，未提交草稿不会被主动清空。</span></div></div>;
  }

  if (updateAvailable) {
    return <div className={`${positionClass} flex items-center gap-3 rounded-xl border border-[var(--line)] bg-[var(--surface)] p-4 text-[var(--ink)] shadow-[var(--shadow)]`} role="status" aria-live="polite"><Download className="shrink-0 text-[var(--accent)]" size={18} aria-hidden="true" /><div className="grid min-w-0 flex-1 gap-1"><strong className="text-sm">有可用更新</strong><span className="text-xs leading-5 text-[var(--muted)]">应用更新不会强制重载当前页面；最新资源会在下次导航加载，未提交草稿不会被主动清空。</span></div><button type="button" className="inline-flex min-h-[44px] shrink-0 items-center justify-center gap-2 rounded-md bg-[var(--accent)] px-3 text-sm font-semibold text-[var(--accent-ink)] disabled:cursor-wait disabled:opacity-70" onClick={onApplyUpdate} disabled={updating}>{updating && <LoaderCircle className="animate-spin" size={15} aria-hidden="true" />}{updating ? "更新中…" : "应用更新"}</button></div>;
  }

  return null;
}
