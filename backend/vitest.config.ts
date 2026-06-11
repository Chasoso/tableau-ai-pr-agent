import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    coverage: {
      provider: "v8",
      reporter: ["text", "html", "json-summary"],
      all: true,
      include: ["src/**/*.{ts,tsx}"],
      exclude: [
        "dist/**",
        "dist-lambda/**",
        "coverage/**",
        "node_modules/**",
        "src/localServer.ts",
        "src/**/*.d.ts",
        "src/types/**",
        "src/**/__fixtures__/**",
        "src/**/__mocks__/**",
      ],
      thresholds: {
        statements: 55,
        branches: 60,
        functions: 60,
        lines: 55,
        "src/services/chatAgent.ts": {
          statements: 80,
          branches: 55,
          functions: 85,
          lines: 80,
        },
        "src/tableau/tableauMcpContextProvider.ts": {
          statements: 60,
          branches: 60,
          functions: 80,
          lines: 60,
        },
      },
    },
  },
});
