import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
export default defineConfig({
  plugins: [react()],
  base: "./",
  server: { strictPort: true, proxy: { "/api": "http://127.0.0.1:3210" } },
  build: { outDir: "dist" },
});
