const axios = require('axios');
const historyManager = require('./history');
const { requestWithRetry } = require('./httpRetry');

async function callClaudePro(userId, prompt, clearSession = false) {
  const hist = historyManager.getHistory(userId);
  const sessionId = clearSession ? `OmegaTech_${Date.now()}_${userId}` : hist.sessionId;
  const memoryContext = historyManager.formatMemoryContext(userId);
  const promptWithMemory = memoryContext ? `${memoryContext}\n\nCurrent request:\n${prompt}` : prompt;

  try {
    const url = `https://omegatech-api.dixonomega.tech/api/ai/Claude-pro?action=chat&prompt=${encodeURIComponent(promptWithMemory)}&model=claudeai_1&chatStyle=claudeai_0&tools=none&size=portrait&version=hd&clearSession=${clearSession}&sessionId=${sessionId}`;

    const { data } = await requestWithRetry(axios, { method: 'get', url, timeout: 60000 }, { retries: 2 });

    if (data?.success) {
      historyManager.addMessage(userId, 'user', prompt);
      historyManager.addMessage(userId, 'assistant', data.response);
      return data.response;
    }

    return data?.response || 'No response';
  } catch (error) {
    return `Claude Pro Error: ${error.response?.status || error.code || error.message}: ${error.message}`;
  }
}

module.exports = callClaudePro;
