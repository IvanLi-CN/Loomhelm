import { useCallback, useEffect, useRef, useState } from "react";

export interface PwaRegisterOptions {
  immediate?: boolean;
  onNeedRefresh?: () => void;
  onOfflineReady?: () => void;
  onRegisterError?: (error: unknown) => void;
}

export type PwaUpdate = (reloadPage?: boolean) => void | Promise<void>;
export type PwaRegister = (options: PwaRegisterOptions) => PwaUpdate;

export interface PwaRuntimeState {
  isOnline: boolean;
  updateAvailable: boolean;
  updating: boolean;
  offlineReady: boolean;
  registrationError: boolean;
  applyUpdate: () => Promise<void>;
}

export function usePwaRuntime(register: PwaRegister, enabled = true): PwaRuntimeState {
  const [isOnline, setIsOnline] = useState(() => typeof navigator === "undefined" || navigator.onLine);
  const [updateAvailable, setUpdateAvailable] = useState(false);
  const [updating, setUpdating] = useState(false);
  const [offlineReady, setOfflineReady] = useState(false);
  const [registrationError, setRegistrationError] = useState(false);
  const updateRef = useRef<PwaUpdate | null>(null);

  useEffect(() => {
    if (!enabled || typeof window === "undefined") return;
    const handleOnline = () => setIsOnline(true);
    const handleOffline = () => setIsOnline(false);
    window.addEventListener("online", handleOnline);
    window.addEventListener("offline", handleOffline);
    updateRef.current = register({
      immediate: true,
      onNeedRefresh: () => setUpdateAvailable(true),
      onOfflineReady: () => setOfflineReady(true),
      onRegisterError: () => setRegistrationError(true)
    });
    return () => {
      window.removeEventListener("online", handleOnline);
      window.removeEventListener("offline", handleOffline);
      updateRef.current = null;
    };
  }, [enabled, register]);

  const applyUpdate = useCallback(async () => {
    const update = updateRef.current;
    if (!update || updating) return;
    setUpdating(true);
    try {
      await update(true);
    } catch {
      setUpdating(false);
      setRegistrationError(true);
    }
  }, [updating]);

  return { isOnline, updateAvailable, updating, offlineReady, registrationError, applyUpdate };
}
