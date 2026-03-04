export interface ReviewEvent {
  type: 'review' | 'followup' | 'fix';
  timestamp: string;
  durationMs: number;
  score: number | null;
  blocking: number;
  warnings: number;
  suggestions: number;
  threadsClosed: number;
  threadsOpened: number;
}
