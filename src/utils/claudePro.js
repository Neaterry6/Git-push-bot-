const axios = require('axios');
const historyManager = require('./history');

async function callClaudePro(userId, prompt, clearSession = false) {
  const hist = historyManager.getHistory(userId);
  const sessionId = clearSession ? `OmegaTech_${Date.now()}_${userId}` : hist.sessionId;

  try {
    const url = `https://omegatech-api.dixonomega.tech/api/ai/Claude-pro?action=chat&prompt=${encodeURIComponent(prompt)}&model=claudeai_1&chatStyle=claudeai_0&tools=none&size=portrait&version=hd&clearSession=${clearSession}&sessionId=${sessionId}`;

    const { data } = await axios.get(url, { timeout: 60000 });

    if (data?.success) {
      historyManager.addMessage(userId, 'user', prompt);
      historyManager.addMessage(userId, 'assistant', data.response);
      return data.response;
    }

    return data?.response || 'No response';
  } catch (error) {
    return `Claude Pro Error: ${error.message}`;
  }
}

module.exports = callClaudePro;
