const fs = require('fs-extra');
const path = require('path');

const HISTORY_DIR = path.join(process.cwd(), 'data', 'history');
const cache = new Map();
const MAX_MESSAGES = 80;
const MAX_MEMORIES = 80;

function getHistoryPath(userId) {
  return path.join(HISTORY_DIR, `${userId}.json`);
}

function createDefault(userId) {
  return {
    sessionId: `OmegaTech_${Date.now()}_${userId}`,
    messages: [],
    memories: [],
    profile: {
      userId: String(userId),
      firstSeenAt: new Date().toISOString(),
      lastSeenAt: new Date().toISOString()
    }
  };
}

function normalizeHistory(data, userId) {
  const fallback = createDefault(userId);
  if (!data || typeof data !== 'object') return fallback;

  return {
    sessionId: data.sessionId || fallback.sessionId,
    messages: Array.isArray(data.messages) ? data.messages : [],
    memories: Array.isArray(data.memories) ? data.memories : [],
    profile: { ...fallback.profile, ...(data.profile || {}) }
  };
}

function loadHistory(userId) {
  if (cache.has(userId)) return cache.get(userId);

  fs.ensureDirSync(HISTORY_DIR);
  const filePath = getHistoryPath(userId);

  let data = createDefault(userId);
  if (fs.existsSync(filePath)) {
    try {
      data = normalizeHistory(fs.readJsonSync(filePath), userId);
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
  fs.ensureDirSync(HISTORY_DIR);
  fs.writeJsonSync(getHistoryPath(userId), data, { spaces: 2 });
}

function trimMessages(userHistory) {
  if (userHistory.messages.length > MAX_MESSAGES) {
    userHistory.messages.splice(0, userHistory.messages.length - MAX_MESSAGES);
  }
}

function trimMemories(userHistory) {
  if (userHistory.memories.length > MAX_MEMORIES) {
    userHistory.memories.splice(0, userHistory.memories.length - MAX_MEMORIES);
  }
}

function formatMemoryContext(userId, limit = 20) {
  const hist = loadHistory(userId);
  const memories = hist.memories.slice(-limit).map((m, index) => `${index + 1}. ${m.content}`).join('\n');
  const recent = hist.messages.slice(-12).map((m) => `${m.role}: ${m.content}`).join('\n');
  return [
    memories ? `Saved memories about this user/session:\n${memories}` : '',
    recent ? `Recent chat history:\n${recent}` : ''
  ].filter(Boolean).join('\n\n');
}

module.exports = {
  getHistory(userId) {
    const hist = loadHistory(userId);
    hist.profile.lastSeenAt = new Date().toISOString();
    saveHistory(userId);
    return hist;
  },

  getMessages(userId, limit = 20) {
    return loadHistory(userId).messages.slice(-limit);
  },

  addMessage(userId, role, content) {
    const userHistory = loadHistory(userId);
    const text = String(content || '').slice(0, 8000);
    userHistory.messages.push({ role, content: text, at: new Date().toISOString() });
    userHistory.profile.lastSeenAt = new Date().toISOString();
    trimMessages(userHistory);
    saveHistory(userId);
  },

  addMemory(userId, content, source = 'agent') {
    const userHistory = loadHistory(userId);
    const text = String(content || '').trim();
    if (!text) return;
    const duplicate = userHistory.memories.some((m) => m.content.toLowerCase() === text.toLowerCase());
    if (!duplicate) {
      userHistory.memories.push({ content: text.slice(0, 1200), source, at: new Date().toISOString() });
      trimMemories(userHistory);
      saveHistory(userId);
    }
  },

  updateProfile(userId, patch) {
    const userHistory = loadHistory(userId);
    userHistory.profile = { ...userHistory.profile, ...patch, lastSeenAt: new Date().toISOString() };
    saveHistory(userId);
  },

  formatMemoryContext,

  getSessionId(userId) {
    return loadHistory(userId).sessionId;
  }
};
