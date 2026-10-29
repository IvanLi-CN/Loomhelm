import { registerSW } from "virtual:pwa-register";

import { PwaStatusBanner } from "@/features/pwa/PwaStatusBanner";
import { usePwaRuntime, type PwaRegister } from "@/features/pwa/usePwaRuntime";

const registerPwa: PwaRegister = (options) => registerSW(options);

export function PwaRegistration() {
  const runtime = usePwaRuntime(registerPwa, import.meta.env.PROD);

  return <PwaStatusBanner isOnline={runtime.isOnline} updateAvailable={runtime.updateAvailable} updateApplied={runtime.updateApplied} updating={runtime.updating} registrationError={runtime.registrationError} onApplyUpdate={() => void runtime.applyUpdate()} />;
}
