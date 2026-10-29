import { useCallback, useEffect, useReducer, useRef, useState } from "react";

export interface PwaRegisterOptions {
  immediate?: boolean;
  onNeedReload?: () => void;
  onNeedRefresh?: () => void;
  onOfflineReady?: () => void;
  onRegisterError?: (error: unknown) => void;
}

export type PwaUpdate = (reloadPage?: boolean) => void | Promise<void>;
export type PwaRegister = (options: PwaRegisterOptions) => PwaUpdate;

export interface PwaUpdateState {
  available: boolean;
  applied: boolean;
  updating: boolean;
  error: boolean;
}

export type PwaUpdateAction =
  | { type: "available" }
  | { type: "request" }
  | { type: "activated" }
  | { type: "failed" };

export const initialPwaUpdateState: PwaUpdateState = {
  available: false,
  applied: false,
  updating: false,
  error: false
};

export function reducePwaUpdateState(state: PwaUpdateState, action: PwaUpdateAction): PwaUpdateState {
  switch (action.type) {
    case "available":
      return { available: true, applied: false, updating: false, error: false };
    case "request":
      return { ...state, available: true, applied: false, updating: true, error: false };
    case "activated":
      return { available: false, applied: true, updating: false, error: false };
    case "failed":
      return { available: true, applied: false, updating: false, error: true };
  }
}

export interface PwaRuntimeState {
  isOnline: boolean;
  updateAvailable: boolean;
  updateApplied: boolean;
  updating: boolean;
  updateError: boolean;
  offlineReady: boolean;
  registrationError: boolean;
  applyUpdate: () => Promise<void>;
}

export function usePwaRuntime(register: PwaRegister, enabled = true): PwaRuntimeState {
  const [isOnline, setIsOnline] = useState(() => typeof navigator === "undefined" || navigator.onLine);
  const [updateState, dispatchUpdate] = useReducer(reducePwaUpdateState, initialPwaUpdateState);
  const [offlineReady, setOfflineReady] = useState(false);
  const [registrationError, setRegistrationError] = useState(false);
  const updateRef = useRef<PwaUpdate | null>(null);
  const mountedRef = useRef(false);

  useEffect(() => {
    if (!enabled || typeof window === "undefined") return;
    mountedRef.current = true;
    const handleOnline = () => setIsOnline(true);
    const handleOffline = () => setIsOnline(false);
    const dispatchIfMounted = (action: PwaUpdateAction) => {
      if (mountedRef.current) dispatchUpdate(action);
    };
    window.addEventListener("online", handleOnline);
    window.addEventListener("offline", handleOffline);
    try {
      updateRef.current = register({
        immediate: true,
        onNeedReload: () => dispatchIfMounted({ type: "activated" }),
        onNeedRefresh: () => dispatchIfMounted({ type: "available" }),
        onOfflineReady: () => {
          if (mountedRef.current) setOfflineReady(true);
        },
        onRegisterError: () => {
          if (mountedRef.current) setRegistrationError(true);
        }
      });
    } catch {
      setRegistrationError(true);
      updateRef.current = null;
    }
    return () => {
      mountedRef.current = false;
      window.removeEventListener("online", handleOnline);
      window.removeEventListener("offline", handleOffline);
      updateRef.current = null;
    };
  }, [enabled, register]);

  const applyUpdate = useCallback(async () => {
    const update = updateRef.current;
    if (!update || updateState.updating) return;
    dispatchUpdate({ type: "request" });
    try {
      await update(false);
    } catch {
      if (mountedRef.current) dispatchUpdate({ type: "failed" });
    }
  }, [updateState.updating]);

  return {
    isOnline,
    updateAvailable: updateState.available,
    updateApplied: updateState.applied,
    updating: updateState.updating,
    updateError: updateState.error,
    offlineReady,
    registrationError,
    applyUpdate
  };
}
