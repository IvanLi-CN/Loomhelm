import {
  Check,
  Clipboard,
  FlaskConical,
  PanelLeftClose,
  PanelLeftOpen,
  PanelRight,
  PanelRightClose,
  RotateCcw,
  Settings2,
  Wifi,
  WifiOff,
  X
} from "lucide-react";
import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactElement } from "react";

import { Button } from "@/components/ui/button";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuLabel,
  ContextMenuRadioGroup,
  ContextMenuRadioItem,
  ContextMenuSeparator,
  ContextMenuTrigger
} from "@/components/ui/context-menu";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue
} from "@/components/ui/select";
import { useDemoRuntime, type InspectorMode, type InspectorPosition } from "@/demo/context";
import {
  demoDataModes,
  demoNetworks,
  demoPersonas,
  demoScenes,
  themeModes,
  type DemoDataMode,
  type DemoNetwork,
  type DemoPersona,
  type DemoScene,
  type ThemeMode
} from "@/demo/types";

const sceneLabels: Record<DemoScene, string> = {
  normal: "正常工作区",
  loading: "加载中",
  empty: "空状态",
  error: "加载失败",
  offline: "离线",
  "approval-expired": "审批已过期",
  readonly: "只读",
  unknown: "结果不确定",
  "permission-changed": "权限已变更",
  "update-available": "有可用更新"
};

const personaLabels: Record<DemoPersona, string> = {
  owner: "工作区主人",
  operator: "项目操作员",
  viewer: "只读访客"
};

const networkLabels: Record<DemoNetwork, string> = {
  online: "在线",
  recovering: "恢复中",
  offline: "离线"
};

const dataLabels: Record<DemoDataMode, string> = {
  full: "完整数据",
  sparse: "精简数据",
  empty: "空数据"
};

const themeLabels: Record<ThemeMode, string> = {
  system: "跟随系统",
  light: "亮色",
  dark: "暗色"
};

const INSPECTOR_GUTTER = 18;
const INSPECTOR_TOP_GUTTER = 74;
const INSPECTOR_SNAP_DISTANCE = 28;

type InspectorSize = Pick<DOMRect, "width" | "height">;

interface InspectorDragState {
  pointerId: number;
  offsetX: number;
  offsetY: number;
  size: InspectorSize;
  position: InspectorPosition;
}

function isCompactInspectorViewport(): boolean {
  return typeof window !== "undefined" && window.matchMedia("(max-width: 767px)").matches;
}

function clampValue(value: number, minimum: number, maximum: number): number {
  return Math.min(Math.max(value, minimum), maximum);
}

function clampInspectorPosition(position: InspectorPosition, size: InspectorSize): InspectorPosition {
  const maxLeft = Math.max(INSPECTOR_GUTTER, window.innerWidth - size.width - INSPECTOR_GUTTER);
  const maxTop = Math.max(INSPECTOR_TOP_GUTTER, window.innerHeight - size.height - INSPECTOR_GUTTER);
  return {
    left: clampValue(position.left, INSPECTOR_GUTTER, maxLeft),
    top: clampValue(position.top, INSPECTOR_TOP_GUTTER, maxTop)
  };
}

function snapInspectorPosition(position: InspectorPosition, size: InspectorSize): InspectorPosition {
  const clamped = clampInspectorPosition(position, size);
  const maxLeft = Math.max(INSPECTOR_GUTTER, window.innerWidth - size.width - INSPECTOR_GUTTER);
  const maxTop = Math.max(INSPECTOR_TOP_GUTTER, window.innerHeight - size.height - INSPECTOR_GUTTER);
  const rightGap = window.innerWidth - (clamped.left + size.width);
  const bottomGap = window.innerHeight - (clamped.top + size.height);

  return {
    left: clamped.left - INSPECTOR_GUTTER <= INSPECTOR_SNAP_DISTANCE
      ? INSPECTOR_GUTTER
      : rightGap - INSPECTOR_GUTTER <= INSPECTOR_SNAP_DISTANCE
        ? maxLeft
        : clamped.left,
    top: clamped.top - INSPECTOR_TOP_GUTTER <= INSPECTOR_SNAP_DISTANCE
      ? INSPECTOR_TOP_GUTTER
      : bottomGap - INSPECTOR_GUTTER <= INSPECTOR_SNAP_DISTANCE
        ? maxTop
        : clamped.top
  };
}

function sameInspectorPosition(first: InspectorPosition, second: InspectorPosition): boolean {
  return first.left === second.left && first.top === second.top;
}

function InspectorModeMenu({ children }: { children: ReactElement }) {
  const runtime = useDemoRuntime();

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
      <ContextMenuContent className="inspector-context-menu">
        <ContextMenuLabel>面板布局</ContextMenuLabel>
        <ContextMenuSeparator />
        <ContextMenuRadioGroup value={runtime.inspectorMode} onValueChange={(value) => runtime.setInspectorMode(value as InspectorMode)}>
          <ContextMenuRadioItem value="collapsed">
            <PanelRightClose size={15} aria-hidden="true" />
            <span>收起</span>
          </ContextMenuRadioItem>
          <ContextMenuRadioItem value="floating">
            <PanelRight size={15} aria-hidden="true" />
            <span>悬浮</span>
          </ContextMenuRadioItem>
          <ContextMenuRadioItem value="sidebar">
            <PanelLeftOpen size={15} aria-hidden="true" />
            <span>侧栏</span>
          </ContextMenuRadioItem>
        </ContextMenuRadioGroup>
      </ContextMenuContent>
    </ContextMenu>
  );
}

function Field<T extends string>({
  label,
  value,
  options,
  labels,
  onChange
}: {
  label: string;
  value: T;
  options: readonly T[];
  labels: Record<T, string>;
  onChange: (value: T) => void;
}) {
  return (
    <label className="inspector-field">
      <span>{label}</span>
      <Select value={value} onValueChange={(nextValue) => onChange(nextValue as T)}>
        <SelectTrigger size="dense" className="inspector-field-trigger">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectGroup>
            {options.map((option) => <SelectItem value={option} key={option}>{labels[option]}</SelectItem>)}
          </SelectGroup>
        </SelectContent>
      </Select>
    </label>
  );
}

export function DemoInspector() {
  const runtime = useDemoRuntime();
  const [copied, setCopied] = useState(false);
  const [isCompactViewport, setIsCompactViewport] = useState(isCompactInspectorViewport);
  const [isDragging, setIsDragging] = useState(false);
  const [livePosition, setLivePosition] = useState<InspectorPosition | null>(runtime.inspectorPosition);
  const panelRef = useRef<HTMLElement | null>(null);
  const dragRef = useRef<InspectorDragState | null>(null);

  useEffect(() => {
    const viewport = window.matchMedia("(max-width: 767px)");
    const updateViewport = () => setIsCompactViewport(viewport.matches);
    updateViewport();
    viewport.addEventListener("change", updateViewport);
    return () => viewport.removeEventListener("change", updateViewport);
  }, []);

  useEffect(() => {
    if (!isDragging) setLivePosition(runtime.inspectorPosition);
  }, [isDragging, runtime.inspectorPosition]);

  useEffect(() => {
    if (runtime.inspectorMode !== "floating" || !runtime.inspectorPosition || isCompactViewport) return;

    const keepPositionInViewport = () => {
      const panel = panelRef.current;
      if (!panel) return;
      const rect = panel.getBoundingClientRect();
      const next = clampInspectorPosition(runtime.inspectorPosition!, rect);
      if (!sameInspectorPosition(next, runtime.inspectorPosition!)) runtime.setInspectorPosition(next);
    };

    keepPositionInViewport();
    window.addEventListener("resize", keepPositionInViewport);
    return () => window.removeEventListener("resize", keepPositionInViewport);
  }, [isCompactViewport, runtime.inspectorMode, runtime.inspectorPosition, runtime.setInspectorPosition]);

  useEffect(() => {
    if (runtime.inspectorMode === "floating") return;
    dragRef.current = null;
    setIsDragging(false);
  }, [runtime.inspectorMode]);

  const startDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (runtime.inspectorMode !== "floating" || isCompactViewport || event.button !== 0) return;
    const panel = panelRef.current;
    if (!panel) return;
    const rect = panel.getBoundingClientRect();
    dragRef.current = {
      pointerId: event.pointerId,
      offsetX: event.clientX - rect.left,
      offsetY: event.clientY - rect.top,
      size: { width: rect.width, height: rect.height },
      position: { left: rect.left, top: rect.top }
    };
    setLivePosition({ left: rect.left, top: rect.top });
    setIsDragging(true);
    event.currentTarget.setPointerCapture(event.pointerId);
    event.preventDefault();
  };

  const moveDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const next = clampInspectorPosition({
      left: event.clientX - drag.offsetX,
      top: event.clientY - drag.offsetY
    }, drag.size);
    drag.position = next;
    setLivePosition(next);
  };

  const finishDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const next = snapInspectorPosition(drag.position, drag.size);
    dragRef.current = null;
    setLivePosition(next);
    runtime.setInspectorPosition(next);
    setIsDragging(false);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  };

  const moveWithKeyboard = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (runtime.inspectorMode !== "floating" || isCompactViewport) return;
    const movement: Record<string, InspectorPosition> = {
      ArrowLeft: { left: -16, top: 0 },
      ArrowRight: { left: 16, top: 0 },
      ArrowUp: { left: 0, top: -16 },
      ArrowDown: { left: 0, top: 16 }
    };
    const delta = movement[event.key];
    if (!delta) return;
    const panel = panelRef.current;
    if (!panel) return;
    const rect = panel.getBoundingClientRect();
    const current = livePosition ?? runtime.inspectorPosition ?? { left: rect.left, top: rect.top };
    const step = event.shiftKey ? 4 : 1;
    const next = clampInspectorPosition({
      left: current.left + delta.left * step,
      top: current.top + delta.top * step
    }, rect);
    setLivePosition(next);
    runtime.setInspectorPosition(next);
    event.preventDefault();
  };

  const activePosition = isDragging ? livePosition : runtime.inspectorPosition;
  const floatingPositionStyle = runtime.inspectorMode === "floating" && activePosition && !isCompactViewport
    ? {
        left: `${activePosition.left}px`,
        top: `${activePosition.top}px`,
        right: "auto",
        bottom: "auto"
      }
    : undefined;

  if (runtime.inspectorMode === "collapsed") {
    return (
      <InspectorModeMenu>
        <Button
          type="button"
          variant="outline"
          size="icon"
          className="inspector-bubble"
          aria-label="打开 Demo 控制面板"
          title="打开 Demo 控制面板；右键选择面板布局"
          onClick={() => runtime.setInspectorOpen(true)}
        >
          <PanelLeftOpen size={18} aria-hidden="true" />
        </Button>
      </InspectorModeMenu>
    );
  }

  const copyShareUrl = async () => {
    const url = runtime.shareUrl();
    try {
      await navigator.clipboard?.writeText(url);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      setCopied(false);
      window.prompt("复制这个 Demo 链接", url);
    }
  };

  return (
    <aside ref={panelRef} className={`demo-inspector${isDragging ? " is-dragging" : ""}`} style={floatingPositionStyle} aria-label="Demo 控制面板">
      <div className="inspector-header">
        <div
          className="inspector-title inspector-drag-handle"
          role="group"
          aria-label="拖动 Demo 控制面板"
          tabIndex={runtime.inspectorMode === "floating" && !isCompactViewport ? 0 : -1}
          title="拖动 Demo 控制面板；方向键可微调位置"
          onKeyDown={moveWithKeyboard}
          onPointerDown={startDrag}
          onPointerMove={moveDrag}
          onPointerUp={finishDrag}
          onPointerCancel={finishDrag}
          onLostPointerCapture={finishDrag}
        >
          <span className="inspector-icon" aria-hidden="true">
            <FlaskConical size={16} />
          </span>
          <div>
            <strong>Demo controls</strong>
            <span>mock-only / memory state</span>
          </div>
        </div>
        <div className="inspector-actions">
          <InspectorModeMenu>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="icon-button icon-button-subtle"
              aria-label="收起 Demo 控制面板"
              title="左键收起；右键选择面板布局"
              onClick={() => runtime.setInspectorOpen(false)}
            >
              <PanelLeftClose size={16} aria-hidden="true" />
            </Button>
          </InspectorModeMenu>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="icon-button icon-button-subtle"
            aria-label="重置 Demo"
            title="重置 Demo"
            onClick={runtime.reset}
          >
            <RotateCcw size={16} aria-hidden="true" />
          </Button>
        </div>
      </div>

      <div className="inspector-status" data-network={runtime.network}>
        {runtime.network === "online" ? <Wifi size={15} aria-hidden="true" /> : <WifiOff size={15} aria-hidden="true" />}
        <span>{networkLabels[runtime.network]} · {runtime.canWrite ? "模拟动作可用" : "控制入口已保护"}</span>
      </div>

      <div className="inspector-fields">
        <Field label="场景" value={runtime.scene} options={demoScenes} labels={sceneLabels} onChange={runtime.setScene} />
        <Field label="身份" value={runtime.persona} options={demoPersonas} labels={personaLabels} onChange={runtime.setPersona} />
        <Field label="网络" value={runtime.network} options={demoNetworks} labels={networkLabels} onChange={runtime.setNetwork} />
        <Field label="数据" value={runtime.dataMode} options={demoDataModes} labels={dataLabels} onChange={runtime.setDataMode} />
        <Field label="主题" value={runtime.theme} options={themeModes} labels={themeLabels} onChange={runtime.setTheme} />
      </div>

      <div className="inspector-share">
        <Button type="button" variant="secondary" className="button button-secondary inspector-share-button" onClick={copyShareUrl}>
          {copied ? <Check size={15} aria-hidden="true" /> : <Clipboard size={15} aria-hidden="true" />}
          {copied ? "已复制分享链接" : "复制分享链接"}
        </Button>
        <p>场景、身份、网络与数据会写入 URL；主题和草稿保持在当前 Demo 存储范围。</p>
      </div>

      <div className="inspector-log">
        <div className="inspector-log-heading">
          <span>最近模拟操作</span>
          <Settings2 size={14} aria-hidden="true" />
        </div>
        {runtime.mutations.length ? (
          <ul>
            {runtime.mutations.map((mutation) => (
              <li key={mutation.id}>
                <strong>{mutation.label}</strong>
                <span>{mutation.detail}</span>
              </li>
            ))}
          </ul>
        ) : (
          <p>还没有模拟写入。页面中的操作会在这里留下可见记录。</p>
        )}
      </div>

    </aside>
  );
}

export function DemoNotice() {
  const runtime = useDemoRuntime();
  if (!runtime.notice) return null;
  return (
    <div className="demo-notice" role="status">
      <span>{runtime.notice}</span>
      <Button type="button" variant="ghost" size="icon" className="icon-button icon-button-subtle" aria-label="关闭提示" title="关闭提示" onClick={runtime.dismissNotice}>
        <X size={15} aria-hidden="true" />
      </Button>
    </div>
  );
}

export function DemoSceneBanner() {
  const runtime = useDemoRuntime();
  const isTransient = ["loading", "error", "offline", "approval-expired", "readonly", "unknown", "permission-changed", "update-available"].includes(runtime.scene);
  if (!isTransient) return null;

  const content: Record<string, { title: string; description: string; tone: string }> = {
    loading: { title: "正在读取工作区", description: "任务和对话准备好后会出现在这里。", tone: "info" },
    error: { title: "暂时无法读取工作区", description: "连接未完成，已有输入不会自动发送。", tone: "danger" },
    offline: { title: "当前处于离线状态", description: "草稿可以继续编辑，但发送和控制命令会保持禁用。", tone: "warning" },
    "approval-expired": { title: "审批请求已过期", description: "请求事实仍保留，批准和拒绝动作已经失效。", tone: "warning" },
    readonly: { title: "此视图为只读", description: "当前身份可以查看上下文，但不会改变任务或对话。", tone: "info" },
    unknown: { title: "结果需要人工对账", description: "没有把 ACK 丢失推断为成功或失败，也不会安全重放。", tone: "warning" },
    "permission-changed": { title: "项目权限已变更", description: "受保护项目和关系已从当前夹具中移除。", tone: "danger" },
    "update-available": { title: "有可用更新", description: "更新提示不会发送草稿，也不会接管另一端的阅读位置。", tone: "info" }
  };
  const state = content[runtime.scene];
  if (!state) return null;

  return (
    <div className={`scene-banner scene-banner-${state.tone}`} role="status" aria-busy={runtime.scene === "loading"}>
      <span className="scene-banner-dot" aria-hidden="true" />
      <div>
        <strong>{state.title}</strong>
        <span>{state.description}</span>
      </div>
      {(runtime.scene === "loading" || runtime.scene === "error" || runtime.scene === "offline" || runtime.scene === "permission-changed") && (
        <Button type="button" variant="secondary" className="button button-secondary scene-banner-action" onClick={runtime.recover}>
          {runtime.scene === "loading" ? "重新加载" : "恢复演示"}
        </Button>
      )}
    </div>
  );
}
