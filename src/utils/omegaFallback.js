const axios = require('axios');
const historyManager = require('./history');
const { requestWithRetry } = require('./httpRetry');

const OMEGA_AI_BASE_URL = process.env.OMEGA_AI_BASE_URL || 'https://omegatech-api.dixonomega.tech/api/ai';

const PROVIDERS = [
  {
    key: 'omega-qwen',
    label: 'Omega Qwen',
    endpoint: 'Qwen-Claude-Haiku',
    params: { model: 'qwen' },
    messageParam: 'message',
    answerFields: ['answer', 'response', 'message']
  },
  {
    key: 'omega-claude-haiku',
    label: 'Omega Claude Haiku',
    endpoint: 'Qwen-Claude-Haiku',
    params: { model: 'claude' },
    messageParam: 'message',
    answerFields: ['answer', 'response', 'message']
  },
  {
    key: 'omega-gemini-premium',
    label: 'Omega Gemini Premium',
    endpoint: 'Gemini-premuim',
    params: { model: 'gemini-flash' },
    messageParam: 'message',
    answerFields: ['answer', 'response', 'message']
  },
  {
    key: 'omega-gpt-4-mini',
    label: 'Omega GPT-4 Mini',
    endpoint: 'Gpt-4-mini',
    params: {},
    messageParam: 'message',
    answerFields: ['answer', 'response', 'message'],
    supportsImage: true
  },
  {
    key: 'omega-deepseek',
    label: 'Omega DeepSeek',
    endpoint: 'Deepseek',
    params: { model: 'v32' },
    messageParam: 'message',
    answerFields: ['answer', 'response', 'message']
  }
];

function getOmegaProviders() {
  return PROVIDERS;
}

function getAnswer(data, answerFields) {
  for (const field of answerFields) {
    if (typeof data?.[field] === 'string' && data[field].trim()) return data[field].trim();
  }
  return '';
}

function buildPromptWithMemory(userId, prompt) {
  const memoryContext = historyManager.formatMemoryContext(userId);
  return memoryContext ? `${memoryContext}\n\nCurrent request:\n${prompt}` : prompt;
}

async function callOmegaProvider(provider, userId, prompt, options = {}) {
  const sessionId = options.sessionId || historyManager.getSessionId(userId);
  const url = `${OMEGA_AI_BASE_URL}/${provider.endpoint}`;
  const params = {
    ...provider.params,
    [provider.messageParam]: buildPromptWithMemory(userId, prompt),
    sessionId
  };

  if (provider.supportsImage && options.imageUrl) params.imageUrl = options.imageUrl;

  const response = await requestWithRetry(axios, {
    method: 'get',
    url,
    params,
    timeout: 120000,
    validateStatus: () => true
  }, { retries: 1 });

  const { data, status } = response;
  if (status >= 400 || data?.statusCode >= 400 || data?.success === false) {
    throw new Error(`${provider.label} failed (${status}): ${JSON.stringify(data).slice(0, 500)}`);
  }

  const answer = getAnswer(data, provider.answerFields);
  if (!answer) throw new Error(`${provider.label} did not return an answer`);

  return {
    answer,
    data,
    provider: provider.key,
    label: provider.label,
    sessionId: data.sessionId || sessionId,
    model: data.model || provider.params.model || ''
  };
}

module.exports = {
  callOmegaProvider,
  getOmegaProviders
};
