const fs = require('fs-extra');
const path = require('path');
const AdmZip = require('adm-zip');

async function findLatestZip(cwd) {
  const files = await fs.readdir(cwd);
  const zips = [];

  for (const name of files) {
    if (!name.endsWith('.zip')) continue;
    const fullPath = path.join(cwd, name);
    const stat = await fs.stat(fullPath);
    zips.push({ name, fullPath, mtimeMs: stat.mtimeMs });
  }

  zips.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return zips[0] || null;
}

async function unzipFile(zipPath, destination) {
  const zip = new AdmZip(zipPath);
  zip.extractAllTo(destination, true);
}

module.exports = {
  findLatestZip,
  unzipFile
};
