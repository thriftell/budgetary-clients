// Runtime stub for the `vscode` module, used only by unit tests (see
// vitest.config.ts). It exposes just the surface the command modules touch at
// runtime; tests reassign `window.createWebviewPanel` to return a fake panel.
export const ViewColumn = { Active: 1 } as const;

export const window: {
  createWebviewPanel: (...args: unknown[]) => unknown;
} = {
  createWebviewPanel: () => {
    throw new Error(
      "vscode.window.createWebviewPanel was not stubbed for this test",
    );
  },
};
