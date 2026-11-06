export type HoverPreviewBridge = {
  bindTarget(target: HTMLElement, onEnter: (event: PointerEvent) => void, onLeave?: () => void): () => void;
  resetTargets(): void;
  cancelDismiss(): void;
  scheduleDismiss(): void;
  dispose(): void;
};

export function createHoverPreviewBridge(preview: HTMLElement, onDismiss: () => void, hideDelay = 180): HoverPreviewBridge {
  let dismissTimer: ReturnType<typeof setTimeout> | null = null;
  const targetDisposers: Array<() => void> = [];
  const cancelDismiss = (): void => {
    if (dismissTimer) clearTimeout(dismissTimer);
    dismissTimer = null;
  };
  const scheduleDismiss = (): void => {
    cancelDismiss();
    dismissTimer = setTimeout(() => { dismissTimer = null; onDismiss(); }, hideDelay);
  };
  const previewEnter = (): void => cancelDismiss();
  const previewLeave = (): void => scheduleDismiss();
  preview.addEventListener("pointerenter", previewEnter);
  preview.addEventListener("pointerleave", previewLeave);
  const resetTargets = (): void => {
    for (const disposeTarget of targetDisposers.splice(0)) disposeTarget();
  };
  return {
    bindTarget(target, onEnter, onLeave) {
      const targetEnter = (event: PointerEvent): void => { cancelDismiss(); onEnter(event); };
      const targetLeave = (): void => { onLeave?.(); scheduleDismiss(); };
      target.addEventListener("pointerenter", targetEnter);
      target.addEventListener("pointerleave", targetLeave);
      const disposeTarget = (): void => { target.removeEventListener("pointerenter", targetEnter); target.removeEventListener("pointerleave", targetLeave); };
      targetDisposers.push(disposeTarget);
      return disposeTarget;
    },
    resetTargets,
    cancelDismiss,
    scheduleDismiss,
    dispose() {
      cancelDismiss();
      preview.removeEventListener("pointerenter", previewEnter);
      preview.removeEventListener("pointerleave", previewLeave);
      resetTargets();
    },
  };
}
