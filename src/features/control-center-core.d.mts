import type { AccountRecord, ManagerSnapshot } from "../types";

export type RouterAssessmentStatus = "ready" | "busy" | "blocked" | "needs-auth" | "attention";

export interface RouterAssessment {
  status: RouterAssessmentStatus;
  eligible: boolean;
  busy: boolean;
  reasons: string[];
  reasonText: string;
}

export interface RouterSummary {
  total: number;
  ready: number;
  busy: number;
  blocked: number;
  needsAuth: number;
  attention: number;
}

export interface AgentCenterSummary {
  externalAgents: number;
  webAccounts: number;
  workspaces: number;
  runningTurns: number;
  completedTurns: number;
  failedTurns: number;
}

export function assessAccount(
  snapshot: ManagerSnapshot,
  account: AccountRecord,
  now?: number
): RouterAssessment;
export function summarizeRouter(assessments: RouterAssessment[]): RouterSummary;
export function summarizeAgentCenter(snapshot: ManagerSnapshot): AgentCenterSummary;
