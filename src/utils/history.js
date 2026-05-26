const history = new Map();

module.exports = {
  getHistory(userId) {
    if (!history.has(userId)) {
      history.set(userId, {
        sessionId: `OmegaTech_${Date.now()}_${userId}`,
        messages: []
      });
    }
    return history.get(userId);
  },

  addMessage(userId, role, content) {
    const userHistory = this.getHistory(userId);
    userHistory.messages.push({ role, content });

    if (userHistory.messages.length > 20) {
      userHistory.messages.shift();
    }
  },

  getSessionId(userId) {
    return this.getHistory(userId).sessionId;
  }
};
