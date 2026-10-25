import type { CompletionRecord, Program } from '../types';
export interface DraftRecord { program: Program; updatedAt: number }
export type SyncedCompletion = CompletionRecord & { program?: Program };
export interface ProgressData { version: 1; drafts: Record<string, DraftRecord>; completed: Record<string, SyncedCompletion> }
export function emptyProgress(): ProgressData;
export function validateProgress(value: unknown, now?: number): value is ProgressData;
export function mergeProgress(a?: ProgressData | null, b?: ProgressData | null): ProgressData;
