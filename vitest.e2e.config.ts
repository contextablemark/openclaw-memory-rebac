import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["**/e2e.test.ts", "**/*.e2e.test.ts", "**/e2e-*.test.ts"],
    testTimeout: 180000, // Allow sufficient time for graph operations
    hookTimeout: 180000,
    environment: "node",
    env: {
      // Load .env file for E2E tests
      DOTENV_CONFIG_PATH: ".env",
    },
    setupFiles: ["./vitest.e2e.setup.ts"],
  },
});
