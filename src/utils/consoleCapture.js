const fs = require('fs-extra');
const path = require('path');
const os = require('os');

const MAX_LINES = 240;
const buffers = new Map();

function append(userId, text) {
  if (!userId || text === undefined || text === null) return;
  const key = String(userId);
  const existing = buffers.get(key) || [];
  const timestamp = new Date().toISOString().replace('T', ' ').replace(/\.\d+Z$/, ' UTC');
  const lines = String(text).split(/\r?\n/).map((line) => `[${timestamp}] ${line}`);
  buffers.set(key, existing.concat(lines).slice(-MAX_LINES));
}

function getTranscript(userId) {
  const lines = buffers.get(String(userId)) || [];
  return lines.length ? lines.join('\n') : 'No console output captured yet for this chat.';
}

function escapeXml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function wrapLine(line, width = 110) {
  const chunks = [];
  let remaining = String(line);
  while (remaining.length > width) {
    chunks.push(remaining.slice(0, width));
    remaining = remaining.slice(width);
  }
  chunks.push(remaining);
  return chunks;
}

async function saveScreenshot(userId, outputPath) {
  const transcript = getTranscript(userId);
  const visibleLines = transcript.split(/\r?\n/).flatMap((line) => wrapLine(line)).slice(-90);
  const lineHeight = 18;
  const padding = 24;
  const width = 1320;
  const height = Math.max(260, padding * 2 + visibleLines.length * lineHeight + 44);
  const filePath = path.resolve(outputPath || path.join(os.tmpdir(), `bot-console-${userId}-${Date.now()}.svg`));

  await fs.ensureDir(path.dirname(filePath));

  const text = visibleLines.map((line, index) => (
    `<text x="${padding}" y="${padding + 48 + index * lineHeight}" class="line">${escapeXml(line)}</text>`
  )).join('\n');

  const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <rect width="100%" height="100%" fill="#0d1117"/>
  <rect x="12" y="12" width="${width - 24}" height="${height - 24}" rx="12" fill="#010409" stroke="#30363d"/>
  <circle cx="38" cy="36" r="7" fill="#ff5f56"/>
  <circle cx="62" cy="36" r="7" fill="#ffbd2e"/>
  <circle cx="86" cy="36" r="7" fill="#27c93f"/>
  <text x="112" y="42" class="title">Git Push Bot console — chat ${escapeXml(userId)}</text>
  <style>
    .title { fill: #c9d1d9; font: 600 16px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
    .line { fill: #d1d5db; font: 14px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; white-space: pre; }
  </style>
  ${text}
</svg>`;

  await fs.writeFile(filePath, svg, 'utf8');
  return {
    path: filePath,
    mimetype: 'image/svg+xml',
    caption: '🖥️ Screenshot of this bot chat console/output transcript'
  };
}

module.exports = { append, getTranscript, saveScreenshot };
