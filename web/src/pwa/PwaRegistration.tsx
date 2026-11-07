import { useEffect, useState } from "react";
import { hasVersionMismatch, productVersionEvent } from "@/lib/api/version";
import { registerSW } from "virtual:pwa-register";

import { PwaStatusBanner } from "@/features/pwa/PwaStatusBanner";
import { usePwaRuntime, type PwaRegister } from "@/features/pwa/usePwaRuntime";

const registerPwa: PwaRegister = (options) => registerSW(options);

export function PwaRegistration() {
  const [versionMismatch, setVersionMismatch] = useState(hasVersionMismatch);
  useEffect(() => {
    const reject = () => setVersionMismatch(true);
    window.addEventListener(productVersionEvent, reject);
    return () => window.removeEventListener(productVersionEvent, reject);
  }, []);
  const runtime = usePwaRuntime(registerPwa, import.meta.env.PROD);

  return <PwaStatusBanner versionMismatch={versionMismatch} isOnline={runtime.isOnline} updateAvailable={runtime.updateAvailable} updateApplied={runtime.updateApplied} updating={runtime.updating} updateError={runtime.updateError} registrationError={runtime.registrationError} onApplyUpdate={() => void runtime.applyUpdate()} />;
}
