const fs = require('fs');
const path = require('path');
const axios = require('axios');
const { runShell } = require('../utils/helpers');

const ZIP_DIR = path.join(__dirname, '../../data/zips');
if (!fs.existsSync(ZIP_DIR)) fs.mkdirSync(ZIP_DIR, { recursive: true });

async function handleZip(bot, msg) {
  const chatId = msg.chat.id;
  const fileId = msg.document.file_id;
  const fileName = msg.document.file_name;

  const link = await bot.getFileLink(fileId);
  const response = await axios.get(link, { responseType: 'arraybuffer' });
  const filePath = path.join(ZIP_DIR, fileName);
  fs.writeFileSync(filePath, response.data);

  bot.sendMessage(chatId, `Saved zip as ${fileName}.`);
}

function listZips(bot, msg) {
  const files = fs.readdirSync(ZIP_DIR).filter((name) => name.endsWith('.zip'));
  bot.sendMessage(msg.chat.id, files.length ? `Available zips:\n${files.join('\n')}` : 'No zips saved yet.');
}

function pushZip(bot, msg, filename) {
  const filePath = path.join(ZIP_DIR, filename);
  if (!fs.existsSync(filePath)) {
    bot.sendMessage(msg.chat.id, 'Zip not found.');
    return;
  }

  const unzipDir = path.join(ZIP_DIR, filename.replace(/\.zip$/i, ''));
  runShell(`mkdir -p "${unzipDir}"`);
  const unzipOutput = runShell(`unzip -o "${filePath}" -d "${unzipDir}"`);
  const stageOutput = runShell('git add . && git commit -m "Zip import"', unzipDir);

  bot.sendMessage(
    msg.chat.id,
    `Unzipped ${filename}.\n${unzipOutput.slice(0, 1500)}\n${stageOutput.slice(0, 1500)}\nRun /gitpush when ready.`
  );
}

function deleteZip(bot, msg, filename) {
  const filePath = path.join(ZIP_DIR, filename);
  if (fs.existsSync(filePath)) {
    fs.rmSync(filePath);
    bot.sendMessage(msg.chat.id, `${filename} deleted.`);
  } else {
    bot.sendMessage(msg.chat.id, 'Zip not found.');
  }
}

module.exports = { handleZip, listZips, pushZip, deleteZip };
