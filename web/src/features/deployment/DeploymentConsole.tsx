import { ApiClientError, type GeneratedApiClient } from "@loomhelm/api-client";
import type { DeploymentCandidate, DeploymentEvent, DeploymentObservation, DeploymentOperation, DeploymentSlotObservation, DeploymentStatus } from "@loomhelm/protocol";
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
  observation?: DeploymentObservation;
  observationLoading?: boolean;
  observationError?: unknown;
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
  const observationQuery = useQuery({
    queryKey: ["loomhelm", principalId, "deployment-observations"],
    queryFn: () => client.getDeploymentObservations(),
    enabled: Boolean(principalId),
    refetchInterval: 5_000
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
      void queryClient.invalidateQueries({ queryKey: ["loomhelm", principalId, "deployment-observations"] });
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
    void Promise.all([statusQuery.refetch(), candidatesQuery.refetch(), eventsQuery.refetch(), observationQuery.refetch()]);
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
      observation={observationQuery.data?.observation}
      observationLoading={observationQuery.isLoading || observationQuery.isFetching}
      observationError={observationQuery.error}
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
  observation,
  observationLoading,
  observationError,
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

        <DeploymentObservationPanel observation={observation} loading={observationLoading} error={observationError} />

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

function DeploymentObservationPanel({ observation, loading, error }: { observation?: DeploymentObservation; loading?: boolean; error?: unknown }) {
  if (!observation) {
    return <section className="deployment-section deployment-observation-section" aria-labelledby="deployment-observation-heading">
      <div className="panel-heading"><div><span className="section-kicker">RUNTIME OBSERVABILITY</span><h2 id="deployment-observation-heading">实际流量与负载</h2></div><span className="deployment-observation-status deployment-observation-status-unavailable">{loading ? "采样中" : "不可用"}</span></div>
      <div className="deployment-observation-empty"><CircleAlert size={17} aria-hidden="true" /><span>{error ? "运行时观测暂时不可用，控制器未用 0 值替代实际数据。" : "正在等待运行时观测数据。"}</span></div>
    </section>;
  }

  const migrationLabel = migrationStateLabels[observation.migration_state] ?? observation.migration_state;
  const observedRoute = observation.observed_active_slot ? slotLabels[observation.observed_active_slot] ?? observation.observed_active_slot : "未确认";
  const desiredRoute = slotLabels[observation.desired_active_slot] ?? observation.desired_active_slot;
  const aggregateRate = observation.total_request_rate === undefined ? observationNumber(undefined, observation.state, formatRate) : formatRate(observation.total_request_rate);
  const aggregateErrorRate = observation.total_error_rate === undefined ? observationNumber(undefined, observation.state, formatPercent) : formatPercent(observation.total_error_rate);

  return <section className="deployment-section deployment-observation-section" aria-labelledby="deployment-observation-heading">
    <div className="panel-heading">
      <div><span className="section-kicker">RUNTIME OBSERVABILITY</span><h2 id="deployment-observation-heading">实际流量与负载</h2></div>
      <div className="deployment-observation-heading-meta"><span className={`deployment-observation-status deployment-observation-status-${observationTone(observation.state)}`}>{observationStateLabels[observation.state] ?? observation.state}</span>{loading && <span className="deployment-observation-refresh"><LoaderCircle className="deployment-spin" size={13} aria-hidden="true" />更新中</span>}</div>
    </div>

    <div className="deployment-observation-route-grid">
      <ObservationMetric label="实际入口路由" value={observedRoute} detail={`期望 ${desiredRoute}`} tone={observation.observed_active_slot === observation.desired_active_slot ? "success" : "warning"} />
      <ObservationMetric label="迁移阶段" value={migrationLabel} detail={observation.reason || "由入口版本与槽位采样共同判断"} tone={observationTone(observation.migration_state)} />
      <ObservationMetric label="总请求速率" value={aggregateRate} detail={observation.sample_window_seconds > 0 ? `采样窗口 ${formatDuration(observation.sample_window_seconds)}` : "等待第二次计数采样"} tone="accent" />
      <ObservationMetric label="总错误率" value={aggregateErrorRate} detail={`观测时间 ${formatTimestamp(observation.observed_at)}`} tone={observation.total_error_rate !== undefined && observation.total_error_rate > 0 ? "danger" : "neutral"} />
      <ObservationMetric label="共享 Worker 队列" value={observationNumber(observation.shared_worker_queue_depth, observation.shared_worker_load_state, (value) => value.toLocaleString("zh-CN"))} detail={`运行中 ${observationCounter(observation.shared_worker_running_jobs, observation.shared_worker_load_state)} / 容量 ${observationCounter(observation.shared_worker_capacity, observation.shared_worker_load_state)}`} tone={observation.shared_worker_queue_depth !== undefined && observation.shared_worker_queue_depth > 0 ? "warning" : observationTone(observation.shared_worker_load_state)} />
    </div>

    <div className="deployment-traffic-distribution">
      <div className="deployment-observation-subheading"><strong>流量分布</strong><span>按两个连续计数采样计算</span></div>
      <div className={`deployment-traffic-bar ${observation.slots.some((slot) => slot.traffic.share !== undefined) ? "" : "is-unmeasured"}`} role="img" aria-label={observation.slots.some((slot) => slot.traffic.share !== undefined) ? "两个槽位的实际请求流量分布" : "流量分布尚未完成采样"}>
        {observation.slots.map((slot) => {
          const share = slot.traffic.share === undefined ? 0 : Math.max(0, Math.min(1, slot.traffic.share));
          return <span className={`deployment-traffic-bar-segment deployment-traffic-bar-${slot.slot}`} key={slot.slot} style={{ width: `${share * 100}%` }} />;
        })}
        {!observation.slots.some((slot) => slot.traffic.share !== undefined) && <span className="deployment-traffic-bar-label">采样中</span>}
      </div>
      <div className="deployment-traffic-legend">{observation.slots.map((slot) => <span key={slot.slot}><i className={`deployment-traffic-legend-dot deployment-traffic-legend-${slot.slot}`} aria-hidden="true" />{slotLabels[slot.slot] ?? slot.slot} {observationPercent(slot.traffic.share, observation.state)}</span>)}</div>
    </div>

    <div className="deployment-observation-subheading deployment-observation-slots-heading"><strong>槽位实时负载</strong><span>HTTP 活跃请求 + Worker generation</span></div>
    <div className="deployment-observation-slot-list">{observation.slots.map((slot) => <DeploymentSlotObservationRow key={slot.slot} slot={slot} observationState={observation.state} />)}</div>
  </section>;
}

function DeploymentSlotObservationRow({ slot, observationState }: { slot: DeploymentSlotObservation; observationState: string }) {
  const trafficState = slot.traffic.state;
  const loadState = slot.load.state;
  const workerState = loadState === "measured" ? slot.worker.load_state : loadState;
  const source = slot.server.candidate_source_sha || slot.worker.candidate_source_sha;
  return <article className={`deployment-observation-slot deployment-observation-slot-${slot.slot}`}>
    <div className="deployment-observation-slot-heading"><div><strong>{slotLabels[slot.slot] ?? slot.slot}</strong><small>{source ? `${source.slice(0, 12)} · generation ${slot.worker_generation ?? slot.worker.worker_generation ?? "--"}` : "候选物版本未确认"}</small></div><span className={`deployment-status deployment-status-${slot.desired_state}`}>{slot.desired_state}</span></div>
    <div className="deployment-observation-slot-grid">
      <ObservationMetric label="流量占比" value={observationPercent(slot.traffic.share, observationState)} detail={slot.traffic.request_rate === undefined ? "速率等待连续采样" : `${formatRate(slot.traffic.request_rate)} · 错误 ${observationNumber(slot.traffic.error_rate, trafficState, formatPercent)}`} tone={observationTone(trafficState)} />
      <ObservationMetric label="累计请求" value={observationCounter(slot.traffic.requests_total, trafficState)} detail={`当前活跃 ${observationCounter(slot.server.active_requests, slot.server.state)}`} tone="neutral" />
      <ObservationMetric label="HTTP 活跃" value={observationCounter(slot.load.http_active_requests, slot.server.state)} detail={`Server ${observationStateLabels[slot.server.state] ?? slot.server.state}`} tone="accent" />
      <ObservationMetric label="Worker 运行中" value={observationCounter(slot.load.worker_running_jobs, workerState)} detail={`容量 ${observationCounter(slot.load.worker_capacity, workerState)} · ${slot.worker.load_reason || `Worker ${observationStateLabels[workerState] ?? workerState}`}`} tone={slot.load.worker_running_jobs !== undefined && slot.load.worker_capacity !== undefined && slot.load.worker_running_jobs >= slot.load.worker_capacity ? "danger" : "neutral"} />
      <ObservationMetric label="Worker 利用率" value={slot.load.worker_utilization === undefined ? observationNumber(undefined, workerState, formatPercent) : formatPercent(slot.load.worker_utilization)} detail={slot.worker.load_reason || `Worker ${observationStateLabels[workerState] ?? workerState}`} tone={slot.load.worker_utilization !== undefined && slot.load.worker_utilization >= 1 ? "danger" : "neutral"} />
    </div>
  </article>;
}

function ObservationMetric({ label, value, detail, tone }: { label: string; value: string; detail: string; tone: string }) {
  return <div className={`deployment-observation-metric deployment-observation-metric-${tone}`}><span>{label}</span><strong>{value}</strong><small>{detail}</small></div>;
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

const observationStateLabels: Record<string, string> = {
  measured: "已测量",
  warming_up: "采样中",
  degraded: "部分降级",
  stale: "上次有效采样",
  unavailable: "不可用",
  unknown: "未知"
};

const migrationStateLabels: Record<string, string> = {
  stable: "路由稳定",
  draining: "旧槽排空中",
  route_mismatch: "路由与期望不一致",
  unknown: "路由未确认"
};

function observationTone(state?: string) {
  if (state === "measured" || state === "stable") return "success";
  if (state === "warming_up" || state === "draining" || state === "degraded") return "warning";
  if (state === "stale" || state === "unknown" || state === "route_mismatch" || state === "unavailable") return "danger";
  return "neutral";
}

function observationNumber(value: number | undefined, state: string | undefined, format: (value: number) => string) {
  if (value !== undefined && state !== "unavailable" && state !== "unknown") return format(value);
  if (state === "warming_up") return "采样中";
  if (state === "unavailable" || state === "unknown") return "不可用";
  return "--";
}

function observationCounter(value: number | undefined, state: string | undefined) {
  return observationNumber(value, state, (current) => current.toLocaleString("zh-CN"));
}

function observationPercent(value: number | undefined, state?: string) {
  return observationNumber(value, state, formatPercent);
}

function formatRate(value: number) {
  return `${value.toLocaleString("zh-CN", { maximumFractionDigits: 1 })} req/s`;
}

function formatPercent(value: number) {
  return `${(value * 100).toLocaleString("zh-CN", { maximumFractionDigits: 1 })}%`;
}

function formatDuration(value: number) {
  if (value < 60) return `${value.toLocaleString("zh-CN", { maximumFractionDigits: 1 })} 秒`;
  return `${(value / 60).toLocaleString("zh-CN", { maximumFractionDigits: 1 })} 分钟`;
}
