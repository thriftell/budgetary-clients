export interface BudgetaryClientOptions {
  apiKey: string;
  baseUrl?: string; // default "https://api.budgetary.dev"
}

export class BudgetaryClient {
  constructor(private readonly opts: BudgetaryClientOptions) {}

  // Methods land in a later release. This file exists so the package is importable.
  async estimate(_query: string): Promise<never> {
    throw new Error("not implemented in this release");
  }
}
