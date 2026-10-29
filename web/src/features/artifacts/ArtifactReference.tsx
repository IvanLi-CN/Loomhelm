import { AlertTriangle, Download, FileArchive, FileCode2, FileText, LoaderCircle, RefreshCw } from "lucide-react";
import { useState } from "react";

import type { Artifact } from "@loomhelm/protocol";

import type { ArtifactDownloader, ArtifactMetadataLoader } from "./api";
import { useArtifactMetadata } from "./useArtifactMetadata";

const kindLabels: Record<Artifact["kind"], string> = {
  file: "文件",
  diff: "差异",
  snapshot: "快照"
};

function artifactIcon(kind: Artifact["kind"]) {
  if (kind === "diff") return <FileCode2 size={18} aria-hidden="true" />;
  if (kind === "snapshot") return <FileArchive size={18} aria-hidden="true" />;
  return <FileText size={18} aria-hidden="true" />;
}

function formatBytes(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 ** 2) return `${(size / 1024).toFixed(1)} KiB`;
  if (size < 1024 ** 3) return `${(size / 1024 ** 2).toFixed(1)} MiB`;
  return `${(size / 1024 ** 3).toFixed(1)} GiB`;
}

function safeErrorMessage(): string {
  return "授权产物暂时无法读取。请检查连接或权限后重试。";
}

export function ArtifactReference({
  artifactId,
  loadMetadata,
  download,
  className = ""
}: {
  artifactId: string;
  loadMetadata: ArtifactMetadataLoader;
  download?: ArtifactDownloader;
  className?: string;
}) {
  const [retryKey, setRetryKey] = useState(0);
  const [downloadState, setDownloadState] = useState<"idle" | "pending" | "completed" | "error">("idle");
  const metadata = useArtifactMetadata(artifactId, loadMetadata, retryKey);

  if (metadata.status === "idle" || metadata.status === "loading") {
    return <div className={`grid gap-2 rounded-xl border border-[var(--line)] bg-[var(--surface)] p-4 text-sm text-[var(--muted)] ${className}`} aria-busy="true" aria-label="正在读取产物"><span className="inline-flex items-center gap-2"><LoaderCircle className="animate-spin" size={16} aria-hidden="true" />正在读取授权产物…</span><span className="text-xs">文件仍留在对话上下文中，读取不会扩大权限范围。</span></div>;
  }

  if (metadata.status === "error") {
    return <div className={`grid gap-3 rounded-xl border border-[var(--line)] bg-[var(--surface)] p-4 ${className}`} role="alert"><div className="flex items-center gap-2 text-sm font-semibold text-[var(--danger)]"><AlertTriangle size={17} aria-hidden="true" />产物暂不可用</div><p className="text-xs leading-6 text-[var(--muted)]">{safeErrorMessage()}</p><button type="button" className="inline-flex min-h-[44px] items-center justify-center gap-2 rounded-md border border-[var(--line)] px-3 text-sm font-semibold text-[var(--ink)] hover:bg-[var(--surface-soft)]" onClick={() => setRetryKey((value) => value + 1)}><RefreshCw size={15} aria-hidden="true" />重新读取</button></div>;
  }

  const artifact = metadata.artifact;
  const handleDownload = async () => {
    if (!download || downloadState === "pending") return;
    const controller = new AbortController();
    setDownloadState("pending");
    try {
      await download({ artifact, signal: controller.signal });
      setDownloadState("completed");
    } catch {
      setDownloadState("error");
    }
  };

  return (
    <article className={`grid gap-4 rounded-xl border border-[var(--line)] bg-[var(--surface)] p-4 text-[var(--ink)] shadow-[var(--shadow)] ${className}`} aria-label={`对话产物：${artifact.name}`}>
      <div className="flex min-w-0 items-start gap-3">
        <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-[var(--selected)] text-[var(--accent)]">{artifactIcon(artifact.kind)}</span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="break-all text-sm font-semibold">{artifact.name}</h3>
            <span className="rounded-full bg-[var(--surface-soft)] px-2 py-1 text-xs text-[var(--muted)]">{kindLabels[artifact.kind]}</span>
          </div>
          <p className="mt-1 break-all text-xs text-[var(--muted)]">{artifact.content_type} · {formatBytes(artifact.size)}</p>
        </div>
      </div>
      <dl className="grid gap-2 border-t border-[var(--line)] pt-3 text-xs sm:grid-cols-[auto_minmax(0,1fr)] sm:gap-x-3">
        <dt className="text-[var(--muted)]">SHA-256</dt><dd className="break-all font-mono text-[var(--ink)]">{artifact.sha256}</dd>
        <dt className="text-[var(--muted)]">产物身份</dt><dd className="break-all font-mono text-[var(--ink)]">{artifact.id}</dd>
      </dl>
      <div className="flex flex-wrap items-center gap-3">
        <button type="button" className="inline-flex min-h-[44px] items-center justify-center gap-2 rounded-md bg-[var(--accent)] px-4 text-sm font-semibold text-[var(--accent-ink)] disabled:cursor-not-allowed disabled:opacity-60" onClick={() => void handleDownload()} disabled={!download || downloadState === "pending"} title={!download ? "内容下载等待服务接线" : undefined}>
          {downloadState === "pending" ? <LoaderCircle className="animate-spin" size={16} aria-hidden="true" /> : <Download size={16} aria-hidden="true" />}
          {downloadState === "pending" ? "准备下载…" : downloadState === "completed" ? "已请求下载" : "下载文件"}
        </button>
        <span className="text-xs text-[var(--muted)]" aria-live="polite">
          {!download ? "内容下载等待授权端点接线。" : downloadState === "error" ? "下载失败，请重试。" : downloadState === "completed" ? "下载请求已完成。" : "仅在当前授权范围内读取。"}
        </span>
      </div>
    </article>
  );
}
