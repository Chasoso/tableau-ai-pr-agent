import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    setupFiles: "./src/test/setup.ts",
    include: ["src/**/*.test.{ts,tsx}"],
    css: true,
    coverage: {
      provider: "v8",
      reporter: ["text", "html", "json-summary"],
      all: true,
      include: ["src/**/*.{ts,tsx}"],
      exclude: [
        "coverage/**",
        "dist/**",
        "node_modules/**",
        "playwright-report/**",
        "test-results/**",
        "src/main.tsx",
        "src/vite-env.d.ts",
        "src/**/*.d.ts",
        "src/types/**",
        "src/**/__fixtures__/**",
        "src/**/__mocks__/**",
      ],
      thresholds: {
        statements: 20,
        branches: 50,
        functions: 50,
        lines: 20,
        "src/components/AuthGate.tsx": {
          statements: 75,
          branches: 50,
          functions: 100,
          lines: 75,
        },
      },
    },
  },
});
