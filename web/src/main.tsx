import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { RouterProvider } from "@tanstack/react-router";

import { AppProviders } from "@/app/providers";
import { router } from "@/app/router";
import { PwaRegistration } from "@/pwa/PwaRegistration";

import "./index.css";

const rootElement = document.getElementById("root");

if (!rootElement) {
  throw new Error("The application root element is missing.");
}

createRoot(rootElement).render(
  <StrictMode>
    <AppProviders>
      <PwaRegistration />
      <RouterProvider router={router} />
    </AppProviders>
  </StrictMode>
);
