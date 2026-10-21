import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { RouterProvider } from "@tanstack/react-router";

import { AppProviders, PRODUCTION_AUTH_INVALIDATED_EVENT } from "@/app/providers";
import { router } from "@/app/router";
import { DemoBootstrapFailure } from "@/components/product/DemoBootstrapFailure";
import { bootstrapDemo, isDemoBuild } from "@/demo/bootstrap";
import { DemoProvider } from "@/demo/context";
import { createWebApiClient } from "@/lib/api/client";
import { PwaRegistration } from "@/pwa/PwaRegistration";

import "./index.css";

const rootElement = document.getElementById("root");

if (!rootElement) {
  throw new Error("The application root element is missing.");
}

const root = createRoot(rootElement);
const demoMode = isDemoBuild();
const productionClient = demoMode ? undefined : createWebApiClient({
  browserProtection: "same_origin",
  onUnauthorized: () => {
    window.dispatchEvent(new Event(PRODUCTION_AUTH_INVALIDATED_EVENT));
  }
});

async function start() {
  if (!demoMode) {
    root.render(
      <StrictMode>
        <AppProviders productionClient={productionClient}>
          <PwaRegistration />
          <RouterProvider router={router} />
        </AppProviders>
      </StrictMode>
    );
    return;
  }

  try {
    const runtime = await bootstrapDemo();
    root.render(
      <StrictMode>
        <AppProviders>
          <DemoProvider runtime={runtime}>
            <RouterProvider router={router} />
          </DemoProvider>
        </AppProviders>
      </StrictMode>
    );
  } catch (error) {
    root.render(
      <StrictMode>
        <DemoBootstrapFailure error={error} />
      </StrictMode>
    );
  }
}

void start();
