import { ChevronDown, Search, X } from "lucide-react";
import { useEffect, useId, useMemo, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { queueOwnedFocusRestore } from "@/lib/focus-ownership";

export interface TaskRelationCandidate {
  id: string;
  title: string;
  projectName?: string;
  disabled?: boolean;
  disabledReason?: string;
}

export interface TaskRelationPickerProps {
  label: string;
  candidates: readonly TaskRelationCandidate[];
  selectedIds: readonly string[];
  selectedCandidates?: readonly TaskRelationCandidate[];
  density?: "compact" | "form";
  onChange: (nextIds: string[]) => void;
  disabled?: boolean;
  disabledMessage?: string;
  emptyMessage?: string;
  noMatchMessage?: string;
  resultLimit?: number;
}

const DEFAULT_RESULT_LIMIT = 40;

function candidateText(candidate: TaskRelationCandidate): string {
  return [candidate.id, candidate.title, candidate.projectName].filter(Boolean).join(" · ");
}

function normalizeSearch(value: string): string {
  return value.trim().toLocaleLowerCase();
}

export function TaskRelationPicker({
  label,
  candidates,
  selectedIds,
  selectedCandidates = [],
  density = "compact",
  onChange,
  disabled = false,
  disabledMessage,
  emptyMessage = "当前范围没有可选任务。",
  noMatchMessage = "未找到匹配任务。",
  resultLimit = DEFAULT_RESULT_LIMIT
}: TaskRelationPickerProps) {
  const pickerId = useId();
  const pickerRef = useRef<HTMLDivElement>(null);
  const summaryRef = useRef<HTMLElement>(null);
  const detailsRef = useRef<HTMLDetailsElement>(null);
  const wasDisabledRef = useRef(disabled);
  const restoreFocusAfterDisableRef = useRef(false);
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [visibleLimit, setVisibleLimit] = useState(resultLimit);
  const selectedSet = useMemo(() => new Set(selectedIds), [selectedIds]);
  const candidateMap = useMemo(() => new Map(candidates.map((candidate) => [candidate.id, candidate])), [candidates]);
  const selectedCandidateMap = useMemo(() => new Map(selectedCandidates.map((candidate) => [candidate.id, candidate])), [selectedCandidates]);
  const selectedItems = useMemo(() => {
    const seen = new Set<string>();
    return selectedIds.flatMap((id) => {
      if (seen.has(id)) return [];
      seen.add(id);
      return [candidateMap.get(id) ?? selectedCandidateMap.get(id) ?? { id, title: "当前无权查看", disabled: true, disabledReason: "当前无权查看此任务" }];
    });
  }, [candidateMap, selectedCandidateMap, selectedIds]);
  const normalizedSearch = normalizeSearch(search);
  const searchLabel = `搜索${label} ID、标题或项目`;
  const filteredCandidates = useMemo(() => {
    if (!normalizedSearch) return candidates;
    return candidates.filter((candidate) => normalizeSearch(candidateText(candidate)).includes(normalizedSearch));
  }, [candidates, normalizedSearch]);
  const visibleCandidates = filteredCandidates.slice(0, visibleLimit);
  const remainingCount = Math.max(0, filteredCandidates.length - visibleCandidates.length);

  useEffect(() => {
    setVisibleLimit(resultLimit);
  }, [normalizedSearch, resultLimit]);

  useEffect(() => {
    const wasDisabled = wasDisabledRef.current;
    wasDisabledRef.current = disabled;
    if (!disabled) return;
    setOpen(false);
    if (wasDisabled || typeof document === "undefined") {
      restoreFocusAfterDisableRef.current = false;
      return;
    }
    const restoreAfterBrowserBlur = restoreFocusAfterDisableRef.current;
    restoreFocusAfterDisableRef.current = false;
    requestAnimationFrame(() => {
      const activeElement = document.activeElement;
      const focusStillOwned = Boolean(activeElement && detailsRef.current?.contains(activeElement));
      const focusWasDroppedByDisable = restoreAfterBrowserBlur && (!activeElement || activeElement === document.body);
      if (focusStillOwned || focusWasDroppedByDisable) summaryRef.current?.focus();
    });
  }, [disabled]);

  const closePicker = () => {
    queueOwnedFocusRestore(pickerRef.current, () => summaryRef.current, { restoreWhenFocusDropped: true });
    setOpen(false);
  };

  const toggleCandidate = (candidate: TaskRelationCandidate) => {
    if (disabled || candidate.disabled) return;
    const activeElement = typeof document === "undefined" ? null : document.activeElement;
    if (activeElement && detailsRef.current?.contains(activeElement)) restoreFocusAfterDisableRef.current = true;
    onChange(selectedSet.has(candidate.id) ? selectedIds.filter((id) => id !== candidate.id) : [...selectedIds, candidate.id]);
  };

  const removeCandidate = (candidate: TaskRelationCandidate) => {
    if (disabled || candidate.disabled) return;
    queueOwnedFocusRestore(pickerRef.current, () => summaryRef.current);
    onChange(selectedIds.filter((id) => id !== candidate.id));
  };

  return (
    <div ref={pickerRef} className="task-relation-picker" data-density={density}>
      <div className="task-relation-picker-heading">
        <span>{label}</span>
        <span className="task-relation-picker-count" aria-live="polite">{selectedItems.length ? `已选 ${selectedItems.length}` : "未选择"}</span>
      </div>
      {selectedItems.length > 0 && <ul className="task-relation-picker-selected" aria-label={`${label}已选任务`}>
        {selectedItems.map((candidate) => <li key={candidate.id} className="task-relation-picker-selected-item">
          <span className="task-relation-picker-copy">
            <strong>{candidateText(candidate)}</strong>
            {candidate.disabledReason && <small>{candidate.disabledReason}</small>}
          </span>
          <Button type="button" variant="ghost" size="icon-sm" className="task-relation-remove task-relation-picker-remove" onClick={() => removeCandidate(candidate)} disabled={disabled || candidate.disabled} aria-label={`移除${label} ${candidate.id}`} title={candidate.disabledReason ?? `移除${label}`}>
            <X size={14} aria-hidden="true" />
          </Button>
        </li>)}
      </ul>}
      {disabled && disabledMessage && <p className="task-relation-picker-state" role="status" aria-label={disabledMessage}>{disabledMessage}</p>}
      <details
        ref={detailsRef}
        className="task-relation-picker-disclosure"
        open={open}
        onToggle={(event) => setOpen(event.currentTarget.open)}
        onKeyDown={(event) => {
          if (event.key !== "Escape" || !open) return;
          event.preventDefault();
          closePicker();
        }}
      >
        <summary ref={summaryRef} className={`task-relation-picker-trigger${disabled ? " is-disabled" : ""}`} aria-controls={pickerId} aria-disabled={disabled} onClick={(event) => { if (disabled) event.preventDefault(); }}>
          <span>{open ? `收起${label}候选` : `添加${label}`}</span>
          <ChevronDown size={15} aria-hidden="true" />
        </summary>
        <div id={pickerId} className="task-relation-picker-panel">
          <label className="task-relation-picker-search">
            <Search size={14} aria-hidden="true" />
            <span className="sr-only">{searchLabel}</span>
            <input type="search" value={search} onInput={(event) => setSearch(event.currentTarget.value)} onChange={(event) => setSearch(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && !event.nativeEvent.isComposing) event.preventDefault(); }} placeholder="搜索任务 ID、标题或项目" aria-label={searchLabel} disabled={disabled} />
          </label>
          {!candidates.length ? <p className="task-relation-picker-state">{emptyMessage}</p> : !filteredCandidates.length ? <p className="task-relation-picker-state" role="status" aria-label={noMatchMessage}>{noMatchMessage}</p> : <>
            <fieldset className="task-relation-picker-results" disabled={disabled}>
              <legend className="sr-only">{label}候选任务</legend>
              {visibleCandidates.map((candidate) => <label key={candidate.id} className={`task-relation-picker-option${candidate.disabled ? " is-disabled" : ""}`} title={candidate.disabledReason}>
                <input type="checkbox" checked={selectedSet.has(candidate.id)} onChange={() => toggleCandidate(candidate)} disabled={disabled || candidate.disabled} />
                <span className="task-relation-picker-copy">
                  <strong>{candidateText(candidate)}</strong>
                  {candidate.disabledReason && <small>{candidate.disabledReason}</small>}
                </span>
              </label>)}
            </fieldset>
            <div className="task-relation-picker-footer">
              <span className="task-relation-picker-state">已显示 {visibleCandidates.length} / {filteredCandidates.length}</span>
              {remainingCount > 0 && <Button type="button" variant="ghost" size="sm" className="task-relation-picker-more" onClick={() => setVisibleLimit((current) => current + resultLimit)} disabled={disabled}>显示更多（还有 {remainingCount} 项）</Button>}
            </div>
          </>}
        </div>
      </details>
    </div>
  );
}
