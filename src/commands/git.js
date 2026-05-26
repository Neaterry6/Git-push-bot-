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

function gitPush(cwd) {
  return runShell('git push', cwd);
}

module.exports = { gitClone, gitStatus, gitCommit, gitPush };
