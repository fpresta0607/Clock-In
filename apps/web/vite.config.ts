import { defineConfig } from "vite";

export default defineConfig({
  // A distinctive port so a stray Vite dev server on the default 5173 cannot
  // shadow this app.
  server: { port: 5180, strictPort: true },
  test: {
    environment: "jsdom",
    setupFiles: ["./src/test-setup.ts"],
  },
});
