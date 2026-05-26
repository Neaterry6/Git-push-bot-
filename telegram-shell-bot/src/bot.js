const TelegramBot = require('node-telegram-bot-api');
const { BOT_TOKEN } = require('./config');
const { isAdmin } = require('./utils/auth');
const { askGemini } = require('./utils/ai');
const shell = require('./commands/shell');
const { handleZip, listZips, pushZip, deleteZip } = require('./commands/zip');
const { gitClone, gitStatus, gitCommit, gitPush } = require('./commands/git');
const { showHelp } = require('./commands/help');

const bot = new TelegramBot(BOT_TOKEN, { polling: true });

bot.onText(/^\/ls$/, (msg) => bot.sendMessage(msg.chat.id, shell.ls(msg.from.id).slice(0, 4000)));
bot.onText(/^\/pwd$/, (msg) => bot.sendMessage(msg.chat.id, shell.pwd(msg.from.id)));
bot.onText(/^\/cd (.+)$/, (msg, match) => bot.sendMessage(msg.chat.id, shell.cd(msg.from.id, match[1])));
bot.onText(/^\/cat (.+)$/, (msg, match) => bot.sendMessage(msg.chat.id, shell.cat(msg.from.id, match[1])));
bot.onText(/^\/rm (.+)$/, (msg, match) => bot.sendMessage(msg.chat.id, shell.rm(msg.from.id, match[1])));

bot.onText(/^\/exec (.+)$/, (msg, match) => {
  if (!isAdmin(msg.from.id)) return bot.sendMessage(msg.chat.id, 'Unauthorized');
  return bot.sendMessage(msg.chat.id, shell.execCommand(msg.from.id, match[1]));
});

bot.onText(/^\/gitclone (.+)$/, (msg, match) => bot.sendMessage(msg.chat.id, gitClone(match[1], shell.pwd(msg.from.id)).slice(0, 4000)));
bot.onText(/^\/gitstatus$/, (msg) => bot.sendMessage(msg.chat.id, gitStatus(shell.pwd(msg.from.id)).slice(0, 4000)));
bot.onText(/^\/gitcommit (.+)$/, (msg, match) => bot.sendMessage(msg.chat.id, gitCommit(match[1], shell.pwd(msg.from.id)).slice(0, 4000)));

bot.onText(/^\/gitpush$/, (msg) => {
  if (!isAdmin(msg.from.id)) return bot.sendMessage(msg.chat.id, 'Unauthorized');
  return bot.sendMessage(msg.chat.id, gitPush(shell.pwd(msg.from.id)).slice(0, 4000));
});

bot.on('document', async (msg) => {
  if (msg.document?.mime_type === 'application/zip') {
    try {
      await handleZip(bot, msg);
    } catch (err) {
      bot.sendMessage(msg.chat.id, `Zip upload error: ${err.message}`);
    }
  }
});

bot.onText(/^\/listzips$/, (msg) => listZips(bot, msg));
bot.onText(/^\/pushzip (.+)$/, (msg, match) => {
  if (!isAdmin(msg.from.id)) return bot.sendMessage(msg.chat.id, 'Unauthorized');
  return pushZip(bot, msg, match[1]);
});
bot.onText(/^\/deletezip (.+)$/, (msg, match) => {
  if (!isAdmin(msg.from.id)) return bot.sendMessage(msg.chat.id, 'Unauthorized');
  return deleteZip(bot, msg, match[1]);
});

bot.onText(/^\/help$/, (msg) => showHelp(bot, msg));

bot.on('message', async (msg) => {
  if (msg.text && !msg.text.startsWith('/')) {
    try {
      const reply = await askGemini(msg.text);
      bot.sendMessage(msg.chat.id, reply);
    } catch (err) {
      bot.sendMessage(msg.chat.id, `AI error: ${err.message}`);
    }
  }
});

console.log('Bot is running...');
