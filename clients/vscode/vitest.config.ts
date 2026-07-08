import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// The `vscode` module has no runtime package (only @types/vscode). Alias it to a
// tiny stub so command modules that import it can be exercised in unit tests.
// tsc (`build`) still type-checks `src/**` against the real @types/vscode.
export default defineConfig({
  test: {
    alias: {
      vscode: fileURLToPath(new URL("./test/vscode-stub.ts", import.meta.url)),
    },
  },
});
