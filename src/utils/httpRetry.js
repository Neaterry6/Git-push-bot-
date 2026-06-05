const DEFAULT_RETRIES = 2;
const DEFAULT_BASE_DELAY_MS = 1500;
const MAX_RETRY_AFTER_MS = 15000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseRetryAfter(value) {
  if (!value) return 0;
  const seconds = Number.parseFloat(value);
  if (Number.isFinite(seconds)) return Math.min(seconds * 1000, MAX_RETRY_AFTER_MS);
  const timestamp = Date.parse(value);
  if (!Number.isNaN(timestamp)) return Math.min(Math.max(timestamp - Date.now(), 0), MAX_RETRY_AFTER_MS);
  return 0;
}

function shouldRetry(error) {
  const status = error?.response?.status;
  return status === 429 || status === 408 || (status >= 500 && status <= 599) || ['ETIMEDOUT', 'ECONNRESET', 'EAI_AGAIN'].includes(error?.code);
}

function getRetryDelay(error, attempt, baseDelayMs) {
  const retryAfter = parseRetryAfter(error?.response?.headers?.['retry-after']);
  if (retryAfter) return retryAfter;
  return Math.min(baseDelayMs * (2 ** attempt), MAX_RETRY_AFTER_MS);
}

async function requestWithRetry(axiosInstance, config, options = {}) {
  const retries = Number.isInteger(options.retries) ? options.retries : DEFAULT_RETRIES;
  const baseDelayMs = options.baseDelayMs || DEFAULT_BASE_DELAY_MS;
  const onRetry = options.onRetry;

  let lastError;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      return await axiosInstance(config);
    } catch (error) {
      lastError = error;
      if (attempt >= retries || !shouldRetry(error)) throw error;
      const delayMs = getRetryDelay(error, attempt, baseDelayMs);
      if (onRetry) await onRetry(error, attempt + 1, delayMs);
      await sleep(delayMs);
    }
  }

  throw lastError;
}

module.exports = { requestWithRetry, shouldRetry };
