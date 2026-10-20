export type ModelContextUsage = {
  usedTokens: number;
  maxTokens: number;
};

export interface ContextUsageProvider {
  getContextUsage(): ModelContextUsage | null;
}
