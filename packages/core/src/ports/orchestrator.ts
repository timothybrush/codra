import type { ReviewJobMessage } from '@codra/schema';

export interface JobOrchestrator {
  startReviewJob(id: string, params: ReviewJobMessage): Promise<void>;
}
