import path from "node:path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import svgr from "vite-plugin-svgr";

const root = path.resolve(import.meta.dirname, "..");
const packages = [
  "common",
  "element",
  "math",
  "utils",
  "fractional-indexing",
  "laser-pointer",
];
export default defineConfig({
  root: import.meta.dirname,
  plugins: [react(), svgr()],
  resolve: {
    alias: [
      {
        find: /^@excalidraw\/excalidraw$/,
        replacement: `${root}/packages/excalidraw/index.tsx`,
      },
      {
        find: /^@excalidraw\/excalidraw\/(.*)/,
        replacement: `${root}/packages/excalidraw/$1`,
      },
      ...packages.flatMap((name) => [
        {
          find: new RegExp(`^@excalidraw/${name}$`),
          replacement: `${root}/packages/${name}/src/index.ts`,
        },
        {
          find: new RegExp(`^@excalidraw/${name}/(.*)`),
          replacement: `${root}/packages/${name}/src/$1`,
        },
      ]),
    ],
  },
  define: { "process.env.IS_PREACT": "false" },
  build: { outDir: "dist", assetsInlineLimit: 0, sourcemap: false },
  server: {
    host: "127.0.0.1",
    port: 3101,
    proxy: { "/api": "http://127.0.0.1:3100" },
  },
});
