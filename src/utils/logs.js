const fs = require('fs-extra');
const path = require('path');

const LOG_PATH = path.join(process.cwd(), 'data', 'bot.log');

async function appendLog(userId, action, details = '') {
  await fs.ensureDir(path.dirname(LOG_PATH));
  const line = `[${new Date().toISOString()}] user=${userId} action=${action} details=${String(details).replace(/\s+/g, ' ').slice(0, 500)}\n`;
  await fs.appendFile(LOG_PATH, line, 'utf8');
}

async function tailLogs(lines = 50) {
  if (!(await fs.pathExists(LOG_PATH))) return 'No logs yet.';
  const content = await fs.readFile(LOG_PATH, 'utf8');
  return content.split('\n').filter(Boolean).slice(-lines).join('\n') || 'No logs yet.';
}

module.exports = { appendLog, tailLogs, LOG_PATH };
