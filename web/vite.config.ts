import path from "node:path";
import { fileURLToPath } from "node:url";

import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig, loadEnv } from "vite";
import { VitePWA } from "vite-plugin-pwa";

const webRoot = path.dirname(fileURLToPath(import.meta.url));
const isStorybook = process.env.STORYBOOK === "true";

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  const isDemo = mode === "demo" || env.VITE_DEMO === "true" || env.VITE_DEMO === "1";

  return {
    base: "/",
    plugins: [
      react(),
      tailwindcss(),
      ...(isStorybook || isDemo
        ? []
        : [
            VitePWA({
              registerType: "prompt",
              injectRegister: null,
              includeAssets: ["icons/icon.svg", "icons/icon-192.png", "icons/icon-512.png", "icons/icon-maskable-512.png", "icons/apple-touch-icon.png"],
              manifest: {
                name: "Loomhelm Web",
                short_name: "Loomhelm",
                description: "Loomhelm web runtime verification surface",
                id: "/",
                lang: "zh-CN",
                start_url: "/",
                scope: "/",
                display: "standalone",
                theme_color: "#0f766e",
                background_color: "#f8fafc",
                icons: [
                  {
                    src: "/icons/icon-192.png",
                    sizes: "192x192",
                    type: "image/png",
                    purpose: "any"
                  },
                  {
                    src: "/icons/icon-512.png",
                    sizes: "512x512",
                    type: "image/png",
                    purpose: "any"
                  },
                  {
                    src: "/icons/icon-maskable-512.png",
                    sizes: "512x512",
                    type: "image/png",
                    purpose: "maskable"
                  }
                ]
              },
              workbox: {
                cleanupOutdatedCaches: true,
                navigateFallbackDenylist: [/^\/api(?:\/|\?|$)/],
                runtimeCaching: []
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
