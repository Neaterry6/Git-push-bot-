const path = require('path');
const fs = require('fs-extra');

const ROOT = path.join(process.cwd(), 'workspaces');

function getPath(userId) {
  return path.join(ROOT, String(userId));
}

async function create(userId) {
  const userPath = getPath(userId);
  await fs.ensureDir(userPath);
  return userPath;
}

module.exports = {
  ROOT,
  getPath,
  create
};
