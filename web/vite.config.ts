import path from "node:path";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig, loadEnv } from "vite";
import { VitePWA } from "vite-plugin-pwa";

const webRoot = path.dirname(fileURLToPath(import.meta.url));
const productBuild = { version: process.env.LOOMHELM_FIXTURE_BUILD_VERSION === "0.0.0-ci" ? "0.0.0-ci" : readFileSync(path.resolve(webRoot, "../VERSION"), "utf8").trim(), source_sha: execFileSync("git", ["rev-parse", "HEAD"], { cwd: webRoot, encoding: "utf8" }).trim(), policy: "loomhelm-manual-v1" };
const isStorybook = process.env.STORYBOOK === "true";

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  const isDemo = mode === "demo" || env.VITE_DEMO === "true" || env.VITE_DEMO === "1";

  return {
    base: "/",
    define: { __LOOMHELM_BUILD__: JSON.stringify(isStorybook || isDemo ? { ...productBuild, version: "dev" } : productBuild) },

    plugins: [
      react(),
      { name: "product-version-manifest", generateBundle() { this.emitFile({ type: "asset", fileName: "product-version.json", source: JSON.stringify(productBuild) + "\n" }); } },
      tailwindcss(),
      ...(isStorybook || isDemo
        ? []
        : [
            VitePWA({
              registerType: "prompt",
              injectRegister: null,
              includeAssets: ["icons/icon.svg"],
              manifest: {
                name: "Loomhelm Web",
                short_name: "Loomhelm",
                description: "Loomhelm web runtime verification surface",
                start_url: "/",
                scope: "/",
                display: "standalone",
                theme_color: "#0f766e",
                background_color: "#f8fafc",
                icons: [
                  {
                    src: "/icons/icon.svg",
                    sizes: "any",
                    type: "image/svg+xml",
                    purpose: "any maskable"
                  }
                ]
              },
              workbox: {
                navigateFallbackDenylist: [/^\/api(?:\/|\?|$)/]
              },
              devOptions: {
                enabled: false
              }
            })
          ])
    ],
    resolve: {
      alias: {
        "@": path.resolve(webRoot, "src"),
        ...(isDemo ? { "virtual:pwa-register": path.resolve(webRoot, "src/pwa/noopRegister.ts") } : {})
      }
    },
    build: {
      outDir: isDemo ? "dist-demo" : "dist",
      target: "es2022"
    }
  };
});
