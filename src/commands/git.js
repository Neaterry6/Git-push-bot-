const { runShell } = require('../utils/helpers');

function gitClone(url, cwd) {
  return runShell(`git clone ${url}`, cwd);
}

function gitStatus(cwd) {
  return runShell('git status', cwd);
}

function gitCommit(message, cwd) {
  return runShell(`git add . && git commit -m "${message.replace(/"/g, '\\"')}"`, cwd);
}

function getCurrentBranch(cwd) {
  return runShell('git rev-parse --abbrev-ref HEAD', cwd).trim();
}

function gitPush(cwd, remote = 'origin') {
  const isGitRepo = runShell('git rev-parse --is-inside-work-tree', cwd).trim();
  if (isGitRepo !== 'true') {
    return 'Not a git repository. Run this command from your project folder, or initialize one with: git init';
  }

  const remotesRaw = runShell('git remote', cwd).trim();
  const remotes = remotesRaw ? remotesRaw.split('\n').map((entry) => entry.trim()).filter(Boolean) : [];

  if (!remotes.length) {
    return 'No git remote configured. Add one first, for example: git remote add origin https://github.com/<user>/<repo>.git';
  }

  const targetRemote = remotes.includes(remote) ? remote : remotes[0];
  const branch = getCurrentBranch(cwd);

  return runShell(`git push --set-upstream ${targetRemote} ${branch}`, cwd);
}

module.exports = { gitClone, gitStatus, gitCommit, gitPush };
