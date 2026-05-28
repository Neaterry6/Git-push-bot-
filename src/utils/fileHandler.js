const fs = require('fs-extra');
const path = require('path');
const AdmZip = require('adm-zip');
const axios = require('axios');

function isZipFileName(name = '') {
  return String(name).toLowerCase().endsWith('.zip');
}

function sanitizeFilename(name) {
  const cleaned = path.basename(String(name || 'upload.zip')).replace(/[<>:"/\\|?*\x00-\x1F]/g, '_').trim();
  return cleaned || `upload-${Date.now()}.zip`;
}

function getZipDocumentFromContext(ctx) {
  const directDocument = ctx.message?.document;
  const repliedDocument = ctx.message?.reply_to_message?.document;
  const document = directDocument || repliedDocument;

  if (!document || !isZipFileName(document.file_name)) return null;
  return document;
}

async function saveTelegramZip(ctx, cwd, document = getZipDocumentFromContext(ctx)) {
  if (!document) return null;

  await fs.ensureDir(cwd);
  const fileName = sanitizeFilename(document.file_name);
  const filePath = path.join(cwd, fileName);
  const link = await ctx.telegram.getFileLink(document.file_id);
  const response = await axios.get(link.href || link.toString(), {
    responseType: 'arraybuffer',
    timeout: 120000
  });

  await fs.writeFile(filePath, response.data);
  const stat = await fs.stat(filePath);

  return {
    name: fileName,
    fullPath: filePath,
    size: stat.size,
    mtimeMs: stat.mtimeMs
  };
}

async function findZipFiles(cwd) {
  const files = await fs.readdir(cwd).catch(() => []);
  const zips = [];

  for (const name of files) {
    if (!isZipFileName(name)) continue;
    const fullPath = path.join(cwd, name);
    const stat = await fs.stat(fullPath);
    if (!stat.isFile()) continue;
    zips.push({ name, fullPath, size: stat.size, mtimeMs: stat.mtimeMs });
  }

  zips.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return zips;
}

async function findLatestZip(cwd) {
  const zips = await findZipFiles(cwd);
  return zips[0] || null;
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB'];
  let value = bytes / 1024;
  let unit = units.shift();

  while (value >= 1024 && units.length) {
    value /= 1024;
    unit = units.shift();
  }

  return `${value.toFixed(value >= 10 ? 1 : 2)} ${unit}`;
}

function formatZipListing(zips) {
  if (!zips.length) return '(no zip files found)';

  return zips
    .map((zip) => {
      const modified = new Date(zip.mtimeMs).toISOString().replace('T', ' ').replace(/\.\d+Z$/, ' UTC');
      return `${zip.name}\t${formatBytes(zip.size)}\t${modified}`;
    })
    .join('\n');
}

async function listWorkspaceZips(cwd) {
  return formatZipListing(await findZipFiles(cwd));
}

async function unzipFile(zipPath, destination) {
  const zip = new AdmZip(zipPath);
  zip.extractAllTo(destination, true);
}

module.exports = {
  findLatestZip,
  findZipFiles,
  formatZipListing,
  getZipDocumentFromContext,
  isZipFileName,
  listWorkspaceZips,
  saveTelegramZip,
  unzipFile
};
