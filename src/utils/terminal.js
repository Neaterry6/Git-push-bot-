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

function isInsideGitRepo(cwd) {
  return fs.existsSync(path.join(cwd, '.git'));
}

function findGitRepo(startDir, maxDepth = 3) {
  if (!startDir || !fs.existsSync(startDir)) return null;

  const queue = [{ dir: startDir, depth: 0 }];
  while (queue.length) {
    const { dir, depth } = queue.shift();
    if (isInsideGitRepo(dir)) return dir;
    if (depth >= maxDepth) continue;

    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (_error) {
      continue;
    }

    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name === 'node_modules' || entry.name === '.git') continue;
      queue.push({ dir: path.join(dir, entry.name), depth: depth + 1 });
    }
  }

  return null;
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

  let commandCwd = cwd;
  if (/^git(?:\s|$)/.test(trimmed) && !findGitRepo(cwd, 0)) {
    const repoCwd = findGitRepo(defaultCwd);
    if (!repoCwd) {
      return {
        output: `Not a git repository: ${cwd}\nNo .git directory was found under your workspace. Run /gitpush first, upload a repository, or cd into a folder that contains .git.`,
        cwd
      };
    }

    commandCwd = repoCwd;
    setCwd(userId, repoCwd);
  }

  const result = await exec(trimmed, { cwd: commandCwd });
  return { output: (result.stdout || result.stderr || 'Done').trim(), cwd: commandCwd };
}

module.exports = { run, getCwd, setCwd, findGitRepo };
