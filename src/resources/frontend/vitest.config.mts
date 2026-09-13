import { defineConfig } from "vitest/config";

export default defineConfig({
  css: {
    postcss: {
      plugins: [],
    },
  },
  test: {
    environment: "node",
    include: ["lib/**/*.test.ts", "tests/**/*.test.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "html"],
      reportsDirectory: "coverage",
      include: ["lib/**/*.ts"],
      exclude: ["**/*.d.ts"],
      thresholds: {
        lines: 98,
        functions: 100,
        statements: 98,
        branches: 85,
      },
    },
  },
});
