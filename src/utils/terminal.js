const path = require('path');
const fs = require('fs');
const exec = require('./executor');

const sessionCwd = new Map();

function getCwd(userId, defaultCwd) {
  return sessionCwd.get(userId) || defaultCwd;
}

function setCwd(userId, cwd) {
  sessionCwd.set(userId, cwd);
}

async function run(userId, command, defaultCwd) {
  const trimmed = String(command || '').trim();
  const cwd = getCwd(userId, defaultCwd);

  if (!trimmed) return { output: 'No command provided', cwd };

  if (trimmed === 'pwd') {
    return { output: cwd, cwd };
  }

  if (trimmed.startsWith('cd ')) {
    const target = trimmed.slice(3).trim();
    const resolved = path.resolve(cwd, target);
    if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
      return { output: `Directory not found: ${target}`, cwd };
    }
    setCwd(userId, resolved);
    return { output: `Changed directory to ${resolved}`, cwd: resolved };
  }

  const result = await exec(trimmed, { cwd });
  return { output: (result.stdout || result.stderr || 'Done').trim(), cwd };
}

module.exports = { run, getCwd, setCwd };
