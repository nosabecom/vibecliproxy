export interface ReviewSettings {
  enabled: boolean;
  mode: 'observe' | 'enforce';
  dailyBudgetUsd: number;
  monthlyBudgetUsd: number;
  cacheSeconds: number;
}
export interface ReviewRule {
  id: string; name: string; description: string; exceptions: string;
  pauseExamples: string[]; allowExamples: string[]; memberIds: string[];
  action: 'review' | 'block' | 'record'; enabled: boolean; version: number; updatedAt: number;
}
export interface TaskEvidence {
  fingerprint: string;
  text: string;
  contextKnown: boolean;
  issue?: string;
  screenable?: boolean;
  objectivePreview: string;
  latestPreview: string;
}
export interface TaskReview {
  id: string; memberId: string; memberName: string; fingerprint: string;
  title: string; reason: string; ruleIds: string[]; ruleNames: string[];
  status: 'pending' | 'denied' | 'approved' | 'dismissed'; requestCount: number;
  createdAt: number; updatedAt: number; lastRequestId: string;
  objectivePreview: string; latestPreview: string; contextKnown: boolean; policyVersion: string;
  approvalExpiresAt: number | null; approvalRemaining: number | null; note?: string;
  generation?: number;
  hardBlocked?: boolean;
}
export interface ClassifierResult {
  probabilities: Record<string, number>;
  inputTokens: number;
  contextProbability: number;
}
export type TaskClassifier = ((text: string, rules: ReviewRule[], signal: AbortSignal) => Promise<ClassifierResult>) & {
  estimateInputTokens?: (text: string, rules: ReviewRule[], signal: AbortSignal) => Promise<number>;
};
export interface ScreeningResult {
  fingerprint: string;
  policyVersion: string;
  source: 'disabled' | 'observed' | 'classifier' | 'cache' | 'approval' | 'review';
  reviewId?: string;
  blocked: boolean;
  reason?: string;
  recordedRules?: string[];
  hardBlocked?: boolean;
}
