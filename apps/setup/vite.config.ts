import { fileURLToPath, URL } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
      // Nyu is shared with the app.
      "@nyu": fileURLToPath(new URL("../desktop/src/components/nyu", import.meta.url)),
    },
    dedupe: ["react", "react-dom", "clsx"],
  },
  clearScreen: false,
  server: {
    port: 1430,
    strictPort: true,
    fs: { allow: [".."] },
    watch: { ignored: ["**/src-tauri/**"] },
  },
  build: {
    target: "es2022",
  },
});
