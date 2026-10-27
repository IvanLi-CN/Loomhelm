interface OwnedFocusRestoreOptions {
  restoreWhenFocusDropped?: boolean;
}

export function queueOwnedFocusRestore(
  owner: HTMLElement | null,
  target: () => HTMLElement | null,
  options: OwnedFocusRestoreOptions = {}
): void {
  if (typeof document === "undefined" || !owner) return;
  const originallyFocused = document.activeElement;
  const focusWasOwned = Boolean(originallyFocused && owner.contains(originallyFocused));
  if (!focusWasOwned && !options.restoreWhenFocusDropped) return;

  requestAnimationFrame(() => {
    const activeElement = document.activeElement;
    const focusStillOwned = Boolean(activeElement && owner.contains(activeElement));
    const focusWasDropped = !activeElement || activeElement === document.body;
    const focusedControlWasRemoved = focusWasDropped && !originallyFocused?.isConnected;
    if (!focusStillOwned && !focusedControlWasRemoved && !(options.restoreWhenFocusDropped && focusWasDropped)) return;
    target()?.focus({ preventScroll: true });
  });
}
