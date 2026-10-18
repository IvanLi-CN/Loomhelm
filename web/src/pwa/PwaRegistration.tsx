import { useEffect } from "react";
import { registerSW } from "virtual:pwa-register";

function reportRegistrationError(error: unknown) {
  console.error("Loomhelm PWA registration failed", error);
}

export function PwaRegistration() {
  useEffect(() => {
    if (import.meta.env.PROD) {
      registerSW({ immediate: true, onRegisterError: reportRegistrationError });
    }
  }, []);

  return null;
}
