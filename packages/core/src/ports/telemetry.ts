/**
 * One completed review's anonymous metrics. Shaped entirely by the engine; the version and instance
 * id are the sink's business, since neither is knowable from inside a review.
 */
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

/**
 * Where finished-review metrics go.
 *
 * A correct implementation MUST NOT THROW, for any input or any transport failure -- it is called on
 * the last step of a successful review, and an exception there would fail a job that has already
 * posted its review. It must also not block: a slow or unreachable endpoint has to degrade to
 * dropping the event, not to holding the phase open until the invocation times out.
 *
 * It may drop, batch, sample or refuse events entirely (a host with telemetry disabled implements
 * this as a no-op), so the engine treats a resolved promise as no evidence that anything was sent.
 * Delivery is at-most-once and unordered.
 */
export interface TelemetrySink {
  send(event: ReviewTelemetryEvent): Promise<void>;
}
