
const FILE_FIXED_SUBREQUESTS = 2;

const MAX_MODEL_ATTEMPTS_ESTIMATE = 4;

export function budgetAwareFileLimit(
  remainingSafeBudget: number,
  configuredChunkFileLimit: number,
  modelChainLength = 1,
) {
  const budgetLimit = Math.floor(remainingSafeBudget / estimatedSubrequestsPerFile(modelChainLength));
  return Math.min(configuredChunkFileLimit, budgetLimit);
}

export function estimatedSubrequestsPerFile(modelChainLength: number) {
  const modelAttempts = Math.max(1, Math.min(modelChainLength, MAX_MODEL_ATTEMPTS_ESTIMATE));
  return FILE_FIXED_SUBREQUESTS + modelAttempts;
}
