const fs = require('fs-extra');
const path = require('path');

const HISTORY_DIR = path.join(process.cwd(), 'data', 'history');
const cache = new Map();

function getHistoryPath(userId) {
  return path.join(HISTORY_DIR, `${userId}.json`);
}

function createDefault(userId) {
  return {
    sessionId: `OmegaTech_${Date.now()}_${userId}`,
    messages: []
  };
}

function loadHistory(userId) {
  if (cache.has(userId)) return cache.get(userId);

  fs.ensureDirSync(HISTORY_DIR);
  const filePath = getHistoryPath(userId);

  let data = createDefault(userId);
  if (fs.existsSync(filePath)) {
    try {
      const parsed = fs.readJsonSync(filePath);
      if (parsed && Array.isArray(parsed.messages) && parsed.sessionId) {
        data = parsed;
      }
    } catch (_error) {
      data = createDefault(userId);
    }
  }

  cache.set(userId, data);
  return data;
}

function saveHistory(userId) {
  const data = cache.get(userId);
  if (!data) return;
  fs.writeJsonSync(getHistoryPath(userId), data, { spaces: 2 });
}

module.exports = {
  getHistory(userId) {
    return loadHistory(userId);
  },

  addMessage(userId, role, content) {
    const userHistory = loadHistory(userId);
    userHistory.messages.push({ role, content, at: new Date().toISOString() });

    if (userHistory.messages.length > 50) {
      userHistory.messages.splice(0, userHistory.messages.length - 50);
    }

    saveHistory(userId);
  },

  getSessionId(userId) {
    return loadHistory(userId).sessionId;
  }
};
