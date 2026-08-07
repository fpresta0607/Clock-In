import { defineConfig } from "vite";

export default defineConfig({
  // Tauri loads the dev server from a fixed port and shows Rust errors in the terminal.
  clearScreen: false,
  server: { port: 1420, strictPort: true },
  test: {
    environment: "jsdom",
    setupFiles: ["./src/test-setup.ts"],
  },
});
