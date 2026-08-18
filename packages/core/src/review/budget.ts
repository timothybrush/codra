
import { FILE_FIXED_SUBREQUESTS, MAX_MODEL_ATTEMPTS_ESTIMATE } from '../constants';

export function budgetAwareFileLimit(
  remainingSafeBudget: number,
  configuredChunkFileLimit: number,
  modelChainLength = 1,
  fetchesFileContent = false,
) {
  const budgetLimit = Math.floor(
    remainingSafeBudget / estimatedSubrequestsPerFile(modelChainLength, fetchesFileContent),
  );
  return Math.min(configuredChunkFileLimit, budgetLimit);
}

export function estimatedSubrequestsPerFile(modelChainLength: number, fetchesFileContent = false) {
  const modelAttempts = Math.max(1, Math.min(modelChainLength, MAX_MODEL_ATTEMPTS_ESTIMATE));
  return FILE_FIXED_SUBREQUESTS + modelAttempts + (fetchesFileContent ? 1 : 0);
}
