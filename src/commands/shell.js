const fs = require('fs');
const path = require('path');
const { runShell } = require('../utils/helpers');

const userDirs = new Map();

function getCurrentDir(userId) {
  return userDirs.get(userId) || process.cwd();
}

function setCurrentDir(userId, dir) {
  userDirs.set(userId, dir);
}

function ls(userId) {
  return runShell('ls -la', getCurrentDir(userId));
}

function pwd(userId) {
  return getCurrentDir(userId);
}

function cd(userId, inputPath) {
  const current = getCurrentDir(userId);
  const target = path.resolve(current, inputPath);

  if (!fs.existsSync(target) || !fs.statSync(target).isDirectory()) {
    return 'Directory not found';
  }

  setCurrentDir(userId, target);
  return `Changed directory to ${target}`;
}

function cat(userId, inputPath) {
  const target = path.resolve(getCurrentDir(userId), inputPath);
  if (!fs.existsSync(target) || !fs.statSync(target).isFile()) return 'File not found';
  return fs.readFileSync(target, 'utf8').slice(0, 4000);
}

function rm(userId, inputPath) {
  const target = path.resolve(getCurrentDir(userId), inputPath);
  if (!fs.existsSync(target)) return 'File not found';
  fs.rmSync(target, { recursive: true, force: true });
  return 'Removed successfully';
}

function execCommand(userId, cmd) {
  return runShell(cmd, getCurrentDir(userId)).slice(0, 4000);
}

module.exports = { ls, pwd, cd, cat, rm, execCommand };
