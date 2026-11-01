import { ApiClientError, type GeneratedApiClient } from "@loomhelm/api-client";
import type { DeploymentCandidate, DeploymentEvent, DeploymentOperation, DeploymentStatus } from "@loomhelm/protocol";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Activity, Check, CheckCircle2, CircleAlert, Clock3, LoaderCircle, LockKeyhole, Play, RefreshCw, RotateCcw, ShieldCheck, TriangleAlert, XCircle } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { Button } from "@/components/ui/button";

type DeploymentAction = "preflight" | "stage" | "promote" | "rollback" | "drain" | "reconcile";

export interface DeploymentConsoleProps {
  client: GeneratedApiClient;
  principalId: string;
}

interface DeploymentDashboardProps {
  status?: DeploymentStatus;
  candidates: readonly DeploymentCandidate[];
  events: readonly DeploymentEvent[];
  operation?: DeploymentOperation;
  loading: boolean;
  error?: unknown;
  actionPending?: DeploymentAction;
  selectedCandidateId: string;
  onSelectedCandidate: (candidateId: string) => void;
  onRefresh: () => void;
  onAction: (action: DeploymentAction) => void;
  onCancelAction: () => void;
  confirmingAction?: DeploymentAction;
}

const actionLabels: Record<DeploymentAction, string> = {
  preflight: "预检",
  stage: "预置",
  promote: "切换",
  rollback: "回滚",
  drain: "排空",
  reconcile: "对账"
};

const statusLabels: Record<string, string> = {
  accepted: "已接收",
  running: "执行中",
  succeeded: "已完成",
  failed: "失败",
  degraded: "降级",
  unknown: "结果未知",
  reconciling: "对账中",
  blocked: "已阻断"
};

const slotLabels: Record<string, string> = { blue: "蓝槽", green: "绿槽" };

export function DeploymentConsole({ client, principalId }: DeploymentConsoleProps) {
  const queryClient = useQueryClient();
  const [selectedCandidateId, setSelectedCandidateId] = useState("");
  const [confirmingAction, setConfirmingAction] = useState<DeploymentAction>();
  const [operationId, setOperationId] = useState<string>();

  const statusQuery = useQuery({
    queryKey: ["loomhelm", principalId, "deployment-status"],
    queryFn: () => client.getDeploymentStatus(),
    enabled: Boolean(principalId),
    refetchInterval: 10_000
  });
  const candidatesQuery = useQuery({
    queryKey: ["loomhelm", principalId, "deployment-candidates"],
    queryFn: () => client.listDeploymentCandidates(),
    enabled: Boolean(principalId),
    refetchInterval: 30_000
  });
  const eventsQuery = useQuery({
    queryKey: ["loomhelm", principalId, "deployment-events"],
    queryFn: () => client.listDeploymentEvents({ limit: 40 }),
    enabled: Boolean(principalId),
    refetchInterval: 10_000
  });
  const operationQuery = useQuery({
    queryKey: ["loomhelm", principalId, "deployment-operation", operationId],
    queryFn: () => client.getDeploymentOperation({ operation_id: operationId ?? "" }),
    enabled: Boolean(operationId),
    refetchInterval: operationId ? 1_500 : false
  });
  const operation = operationQuery.data?.operation;
  const mutation = useMutation({
    mutationFn: async (action: DeploymentAction) => {
      const body = {
        candidate_id: selectedCandidateId || undefined,
        expected_current_fingerprint: statusQuery.data?.status.active_fingerprint || undefined,
        slot: action === "drain" ? statusQuery.data?.status.active_slot || undefined : undefined,
        confirm: action !== "preflight" && action !== "reconcile"
      };
      const request = { body, idempotency_key: `${principalId}-${action}-${Date.now()}` };
      switch (action) {
        case "preflight": return client.preflightDeployment(request);
        case "stage": return client.stageDeployment(request);
        case "promote": return client.promoteDeployment(request);
        case "rollback": return client.rollbackDeployment(request);
        case "drain": return client.drainDeployment(request);
        case "reconcile": return client.reconcileDeployment(request);
      }
    },
    onSuccess: (response) => {
      setConfirmingAction(undefined);
      setOperationId(response.operation.id);
      void queryClient.invalidateQueries({ queryKey: ["loomhelm", principalId, "deployment-events"] });
    }
  });

  useEffect(() => {
    if (!operation || !["succeeded", "failed", "unknown", "degraded", "blocked"].includes(operation.status)) return;
    void queryClient.invalidateQueries({ queryKey: ["loomhelm", principalId, "deployment-status"] });
    void queryClient.invalidateQueries({ queryKey: ["loomhelm", principalId, "deployment-candidates"] });
    void queryClient.invalidateQueries({ queryKey: ["loomhelm", principalId, "deployment-events"] });
  }, [operation, principalId, queryClient]);

  const candidates = candidatesQuery.data?.candidates ?? [];
  const selectedCandidate = candidates.find((candidate) => candidate.id === selectedCandidateId);
  const refresh = () => {
    void Promise.all([statusQuery.refetch(), candidatesQuery.refetch(), eventsQuery.refetch()]);
  };
  const startAction = (action: DeploymentAction) => {
    if (confirmingAction === action) {
      mutation.mutate(action);
      return;
    }
    if (action === "reconcile" || action === "preflight") {
      mutation.mutate(action);
      return;
    }
    setConfirmingAction(action);
  };

  return (
    <DeploymentDashboard
      status={statusQuery.data?.status}
      candidates={candidates}
      events={eventsQuery.data?.events ?? []}
      operation={operation ?? statusQuery.data?.status.latest_operation}
      loading={statusQuery.isLoading || candidatesQuery.isLoading || eventsQuery.isLoading}
      error={statusQuery.error ?? candidatesQuery.error ?? eventsQuery.error}
      actionPending={mutation.isPending ? mutation.variables : undefined}
      selectedCandidateId={selectedCandidateId}
      onSelectedCandidate={setSelectedCandidateId}
      onRefresh={refresh}
      onAction={startAction}
      onCancelAction={() => setConfirmingAction(undefined)}
      confirmingAction={confirmingAction}
    />
  );
}

export function DeploymentDashboard({
  status,
  candidates,
  events,
  operation,
  loading,
  error,
  actionPending,
  selectedCandidateId,
  onSelectedCandidate,
  onRefresh,
  onAction,
  onCancelAction,
  confirmingAction
}: DeploymentDashboardProps) {
  const capabilities = new Set<string>(status?.capabilities ?? []);
  const permissionDenied = error instanceof ApiClientError && error.status === 403;
  const actionAvailable = (action: DeploymentAction) => capabilities.has(action === "drain" ? "emergency_drain" : action);

  if (permissionDenied) {
    return <section className="page-section deployment-page"><div className="deployment-empty-state"><LockKeyhole size={23} aria-hidden="true" /><div><span className="eyebrow">INSTALLATION ACCESS</span><h1>部署权限不足</h1><p>当前项目成员角色不会自动获得安装级部署权限。</p></div></div></section>;
  }

  return (
    <section className="page-section deployment-page" aria-busy={loading}>
      <div className="page-heading deployment-heading">
        <div><span className="eyebrow">INSTALLATION CONTROL</span><h1>部署控制</h1><p>当前安装的候选物、槽位和可恢复操作。</p></div>
        <Button type="button" variant="secondary" className="button button-secondary" onClick={onRefresh} disabled={loading}><RefreshCw size={15} aria-hidden="true" />刷新</Button>
      </div>

      {Boolean(error) && !permissionDenied && <div className="inline-state inline-state-warning" role="alert"><CircleAlert size={16} aria-hidden="true" />部署状态暂时不可用，请稍后重试。</div>}
      {loading && !status && <div className="deployment-loading"><LoaderCircle className="deployment-spin" size={20} aria-hidden="true" />正在读取安装状态</div>}

      {status && <>
        <div className="deployment-summary-grid">
          <SummaryMetric label="当前槽位" value={slotLabels[status.active_slot] ?? "未激活"} detail={status.active_candidate_id ? status.active_candidate_id.slice(0, 12) : "等待首个候选物"} tone={status.active_slot ? "success" : "neutral"} />
          <SummaryMetric label="Worker generation" value={String(status.next_worker_generation)} detail="下一次分配值" tone="accent" />
          <SummaryMetric label="控制器" value={status.controller_ready ? "可用" : "不可用"} detail={status.role ?? "无安装级角色"} tone={status.controller_ready ? "success" : "danger"} />
          <SummaryMetric label="最近操作" value={status.latest_operation ? (statusLabels[status.latest_operation.status] ?? status.latest_operation.status) : "暂无"} detail={status.latest_operation?.kind ? actionLabels[status.latest_operation.kind as DeploymentAction] ?? status.latest_operation.kind : ""} tone={operationTone(status.latest_operation?.status)} />
        </div>

        <div className="deployment-layout">
          <div className="deployment-main-column">
            <section className="deployment-section" aria-labelledby="deployment-candidates-heading">
              <div className="panel-heading"><div><span className="section-kicker">CANDIDATES</span><h2 id="deployment-candidates-heading">候选物</h2></div><span className="panel-count">{candidates.length}</span></div>
              {candidates.length ? <div className="deployment-candidate-list">
                {candidates.map((candidate) => <button type="button" className={`deployment-candidate-row ${candidate.id === selectedCandidateId ? "is-selected" : ""}`} key={candidate.id} onClick={() => onSelectedCandidate(candidate.id)}>
                  <span className={`deployment-state-dot deployment-state-${candidate.status}`} aria-hidden="true" />
                  <span className="deployment-candidate-copy"><strong>{candidate.id}</strong><small>{candidate.source_sha} · {candidate.migration_mode} · 可读 {candidate.read_min}–{candidate.read_max}</small></span>
                  <span className={`deployment-status deployment-status-${candidate.status}`}>{candidate.status}</span>
                </button>)}
              </div> : <p className="deployment-muted">还没有登记候选物。</p>}
            </section>

            <section className="deployment-section" aria-labelledby="deployment-operations-heading">
              <div className="panel-heading"><div><span className="section-kicker">OPERATIONS</span><h2 id="deployment-operations-heading">受控操作</h2></div><span className="panel-status">长操作会保留 operation ID</span></div>
              <label className="deployment-field"><span>候选物</span><select value={selectedCandidateId} onChange={(event) => onSelectedCandidate(event.target.value)}><option value="">选择候选物</option>{candidates.map((candidate) => <option key={candidate.id} value={candidate.id}>{candidate.id} · {candidate.status}</option>)}</select></label>
              <div className="deployment-action-grid">
                {(["preflight", "stage", "promote", "rollback", "drain", "reconcile"] as DeploymentAction[]).map((action) => <Button key={action} type="button" variant={action === "promote" ? "default" : "secondary"} className={`button ${action === "promote" ? "button-primary" : "button-secondary"}`} disabled={!actionAvailable(action) || Boolean(actionPending) || ((action === "stage" || action === "promote" || action === "preflight" || action === "rollback") && !selectedCandidateId)} onClick={() => onAction(action)}>
                  {actionIcon(action)}{actionLabels[action]}
                </Button>)}
              </div>
              {confirmingAction && <div className="deployment-confirmation" role="alert"><TriangleAlert size={17} aria-hidden="true" /><div><strong>确认{actionLabels[confirmingAction]}</strong><p>{selectedCandidateId || "当前安装"}</p></div><div className="deployment-confirmation-actions"><Button type="button" variant="default" className="button button-primary" onClick={() => onAction(confirmingAction)} disabled={Boolean(actionPending)}><Check size={15} aria-hidden="true" />确认</Button><Button type="button" variant="ghost" className="button" onClick={onCancelAction} disabled={Boolean(actionPending)}>取消</Button></div></div>}
              {operation && <OperationNotice operation={operation} />}
            </section>
          </div>

          <aside className="deployment-side-column">
            <section className="deployment-section" aria-labelledby="deployment-slots-heading"><div className="panel-heading"><div><span className="section-kicker">SLOTS</span><h2 id="deployment-slots-heading">槽位</h2></div></div><div className="deployment-slot-list">{status.slots.map((slot) => <div className={`deployment-slot-row ${slot.state === "active" ? "is-active" : ""}`} key={slot.slot}><span><strong>{slotLabels[slot.slot] ?? slot.slot}</strong><small>{slot.candidate_id ? slot.candidate_id.slice(0, 16) : "空"}</small></span><span className={`deployment-status deployment-status-${slot.state}`}>{slot.state}</span></div>)}</div></section>
            <section className="deployment-section" aria-labelledby="deployment-events-heading"><div className="panel-heading"><div><span className="section-kicker">AUDIT</span><h2 id="deployment-events-heading">操作时间线</h2></div><Activity size={17} aria-hidden="true" /></div>{events.length ? <ol className="deployment-timeline">{events.slice(0, 8).map((event) => <li key={event.id}><span className="deployment-timeline-marker" aria-hidden="true" /><div><strong>{event.type}</strong><small>{event.operation_id} · {formatTimestamp(event.created_at)}</small></div></li>)}</ol> : <p className="deployment-muted">暂无审计事件。</p>}</section>
          </aside>
        </div>
      </>}
    </section>
  );
}

function SummaryMetric({ label, value, detail, tone }: { label: string; value: string; detail: string; tone: "success" | "accent" | "danger" | "neutral" }) {
  return <div className={`deployment-summary-metric deployment-summary-${tone}`}><span>{label}</span><strong>{value}</strong><small>{detail}</small></div>;
}

function OperationNotice({ operation }: { operation: DeploymentOperation }) {
  const tone = operationTone(operation.status);
  return <div className={`deployment-operation-notice deployment-operation-${tone}`} role={tone === "danger" ? "alert" : "status"}>{operationIcon(operation.status)}<div><strong>{actionLabels[operation.kind as DeploymentAction] ?? operation.kind} · {statusLabels[operation.status] ?? operation.status}</strong><small>{operation.id}{operation.error_message ? ` · ${operation.error_message}` : ""}</small></div></div>;
}

function actionIcon(action: DeploymentAction) {
  switch (action) {
    case "preflight": return <ShieldCheck size={15} aria-hidden="true" />;
    case "stage": return <Play size={15} aria-hidden="true" />;
    case "promote": return <CheckCircle2 size={15} aria-hidden="true" />;
    case "rollback": return <RotateCcw size={15} aria-hidden="true" />;
    case "drain": return <TriangleAlert size={15} aria-hidden="true" />;
    case "reconcile": return <RefreshCw size={15} aria-hidden="true" />;
  }
}

function operationIcon(status: string) {
  if (["failed", "unknown", "blocked"].includes(status)) return <XCircle size={18} aria-hidden="true" />;
  if (["accepted", "running", "reconciling"].includes(status)) return <Clock3 size={18} aria-hidden="true" />;
  return <CheckCircle2 size={18} aria-hidden="true" />;
}

function operationTone(status?: string): "success" | "accent" | "danger" | "neutral" {
  if (!status) return "neutral";
  if (status === "succeeded") return "success";
  if (["failed", "unknown", "blocked"].includes(status)) return "danger";
  if (["accepted", "running", "reconciling"].includes(status)) return "accent";
  return "neutral";
}

function formatTimestamp(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? value : date.toLocaleString("zh-CN", { dateStyle: "short", timeStyle: "short" });
}
