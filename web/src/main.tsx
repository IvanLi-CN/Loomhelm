import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { RouterProvider } from "@tanstack/react-router";

import { AppProviders } from "@/app/providers";
import { router } from "@/app/router";
import { DemoBootstrapFailure } from "@/components/product/DemoBootstrapFailure";
import { bootstrapDemo, isDemoBuild } from "@/demo/bootstrap";
import { DemoProvider } from "@/demo/context";
import { PwaRegistration } from "@/pwa/PwaRegistration";

import "./index.css";

const rootElement = document.getElementById("root");

if (!rootElement) {
  throw new Error("The application root element is missing.");
}

const root = createRoot(rootElement);
const demoMode = isDemoBuild();

async function start() {
  if (!demoMode) {
    root.render(
      <StrictMode>
        <AppProviders>
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
