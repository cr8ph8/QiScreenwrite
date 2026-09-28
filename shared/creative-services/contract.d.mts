/** Portable advisory contracts. Runtime validators enforce bounds and evidence. */
export type ServiceKind = 'coverage' | 'screenplay_profile' | 'character_profile';
export const SERVICE_KINDS: ServiceKind[];
export const RUBRIC: Readonly<{
  concept: 15; story: 20; characters: 20; dialogue: 10; theme: 10;
  market: 15; cinematic: 10; climax: 10; technicalities: 10;
}>;
export const MAX_EXCERPT: 12000;
export class AnalysisError extends Error {
  code: string;
  constructor(code: string);
}

export interface AnalysisInput {
  schemaVersion: 1;
  kind: ServiceKind;
  source: {
    draftId: string;
    title: string;
    /** SHA-256 of the full saved body, including when scope is excerpt. */
    bodySha256: string;
    excerpt: string;
    scope: 'full' | 'excerpt';
  };
  /** Nonblank for character_profile; exactly empty for other services. */
  characterName: string;
}
export interface AnalysisOutput {
  summary: string;
  strengths: string[];
  concerns: string[];
  nextSteps: string[];
  sections: { heading: string; body: string; evidence: string }[];
  /** Exactly nine rubric keys for coverage; empty for profiles. */
  scores: { key: keyof typeof RUBRIC; score: number; evidence: string }[];
}
export interface AnalysisReport {
  schemaVersion: 1;
  id: string;
  createdAt: string;
  input: AnalysisInput;
  provider: 'ollama' | 'hosted';
  model: string;
  /** Ollama reports require zero; these are not model token counts. */
  platformCredits: number;
  output: AnalysisOutput;
  usage: { inputTokens: number | null; outputTokens: number | null };
}

/** JSON Schema subset emitted by outputSchema; semantic checks remain runtime. */
export interface AnalysisJSONSchema {
  type: 'object' | 'array' | 'string' | 'number';
  additionalProperties?: boolean;
  required?: string[];
  properties?: Record<string, AnalysisJSONSchema>;
  items?: AnalysisJSONSchema;
  enum?: string[];
  maxLength?: number;
  minItems?: number;
  maxItems?: number;
  minimum?: number;
  maximum?: number;
}
export function validateInput(value: unknown): AnalysisInput;
export function validateOutput(value: unknown, input: AnalysisInput): AnalysisOutput;
export function validateReport(value: unknown): AnalysisReport;
/** Recomputes a total; callers must validate output first. */
export function scoreTotal(output: AnalysisOutput): number;
export function outputSchema(kind: ServiceKind): AnalysisJSONSchema;
export function analysisMessages(input: AnalysisInput): { role: 'system' | 'user'; content: string }[];
