export type ReviewTelemetryEvent = {
  linesReviewed: number;
  findingsReported: number;
  inputTokens: number;
  outputTokens: number;
  modelsUsed: string[];
  fileExtensions: string[];
  triggerType: string;
  reviewDurationMs: number;
  filesReviewed: number;
  verdict?: string;
  severityDistribution: Record<string, number>;
  concurrencyLevel: string;
  prTotalLinesChanged: number;
  retryCount: number;
};

export interface TelemetrySink {
  send(event: ReviewTelemetryEvent): Promise<void>;
}
