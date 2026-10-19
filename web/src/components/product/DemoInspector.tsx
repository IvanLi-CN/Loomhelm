import {
  Check,
  ChevronDown,
  ChevronUp,
  Clipboard,
  FlaskConical,
  PanelLeftClose,
  PanelLeftOpen,
  RotateCcw,
  Settings2,
  Wifi,
  WifiOff,
  X
} from "lucide-react";
import { useState } from "react";

import { useDemoRuntime } from "@/demo/context";
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
  reviewer: "项目审阅者",
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
      <select value={value} onChange={(event) => onChange(event.target.value as T)}>
        {options.map((option) => (
          <option value={option} key={option}>
            {labels[option]}
          </option>
        ))}
      </select>
    </label>
  );
}

export function DemoInspector() {
  const runtime = useDemoRuntime();
  const [copied, setCopied] = useState(false);

  if (!runtime.inspectorOpen) {
    return (
      <button
        type="button"
        className="inspector-bubble"
        aria-label="打开 Demo 控制面板"
        title="打开 Demo 控制面板"
        onClick={() => runtime.setInspectorOpen(true)}
      >
        <PanelLeftOpen size={18} aria-hidden="true" />
      </button>
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
    <aside className="demo-inspector" aria-label="Demo 控制面板">
      <div className="inspector-header">
        <div className="inspector-title">
          <span className="inspector-icon" aria-hidden="true">
            <FlaskConical size={16} />
          </span>
          <div>
            <strong>Demo controls</strong>
            <span>mock-only / memory state</span>
          </div>
        </div>
        <div className="inspector-actions">
          <button
            type="button"
            className="icon-button icon-button-subtle"
            aria-label="收起 Demo 控制面板"
            title="收起 Demo 控制面板"
            onClick={() => runtime.setInspectorOpen(false)}
          >
            <PanelLeftClose size={16} aria-hidden="true" />
          </button>
          <button
            type="button"
            className="icon-button icon-button-subtle"
            aria-label="重置 Demo"
            title="重置 Demo"
            onClick={runtime.reset}
          >
            <RotateCcw size={16} aria-hidden="true" />
          </button>
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
        <button type="button" className="button button-secondary inspector-share-button" onClick={copyShareUrl}>
          {copied ? <Check size={15} aria-hidden="true" /> : <Clipboard size={15} aria-hidden="true" />}
          {copied ? "已复制分享链接" : "复制分享链接"}
        </button>
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

      <button type="button" className="inspector-close" onClick={() => runtime.setInspectorOpen(false)}>
        <X size={14} aria-hidden="true" />
        收起为浮标
      </button>
    </aside>
  );
}

export function DemoNotice() {
  const runtime = useDemoRuntime();
  if (!runtime.notice) return null;
  return (
    <div className="demo-notice" role="status">
      <span>{runtime.notice}</span>
      <button type="button" className="icon-button icon-button-subtle" aria-label="关闭提示" title="关闭提示" onClick={runtime.dismissNotice}>
        <X size={15} aria-hidden="true" />
      </button>
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
        <button type="button" className="button button-secondary scene-banner-action" onClick={runtime.recover}>
          {runtime.scene === "loading" ? "重新加载" : "恢复演示"}
        </button>
      )}
    </div>
  );
}
