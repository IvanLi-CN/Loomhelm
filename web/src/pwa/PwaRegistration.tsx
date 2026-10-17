import { useEffect } from "react";
import { registerSW } from "virtual:pwa-register";

export function PwaRegistration() {
  useEffect(() => {
    if (import.meta.env.PROD) {
      registerSW({ immediate: true });
    }
  }, []);

  return null;
}
