const { Telegraf, Scenes, session } = require('telegraf');
const axios = require('axios');
const fs = require('fs-extra');
const path = require('path');
const archiver = require('archiver');
const { PassThrough } = require('stream');

require('dotenv').config();

const callClaudePro = require('./utils/claudePro');
const workspace = require('./utils/workspace');
const terminal = require('./utils/terminal');
const gitPushScene = require('./scenes/gitPush');
const { buildHelpText } = require('./commands/help');
const accessControl = require('./utils/accessControl');
const { appendLog, tailLogs } = require('./utils/logs');

if (!process.env.BOT_TOKEN) {
  throw new Error('Missing BOT_TOKEN in environment.');
}

const bot = new Telegraf(process.env.BOT_TOKEN);
const stage = new Scenes.Stage([gitPushScene]);

bot.use(session());
bot.use(stage.middleware());

bot.use(async (ctx, next) => {
  if (ctx.from?.id) {
    await workspace.create(ctx.from.id);
    await accessControl.registerUser(ctx.from);
  }
  return next();
});

bot.start(async (ctx) => {
  await ctx.reply('✅ Bot connected successfully.\nWorkspace ready.\nUse /help for commands.');
});

bot.command('help', async (ctx) => ctx.reply(buildHelpText('/')));
bot.command('gitpush', async (ctx) => ctx.scene.enter('gitPush'));

bot.command('run', async (ctx) => {
  const command = (ctx.message?.text || '').replace(/^\/run\s*/, '').trim();
  if (!command) return ctx.reply('Usage: /run <command>');
  return runTerminalCommand(ctx, command, workspace.getPath(ctx.from.id));
});


bot.command('play', async (ctx) => {
  const query = (ctx.message?.text || '').replace(/^\/play\s*/, '').trim();
  if (!query) return ctx.reply('Usage: /play <song name>');

  await appendLog(ctx.from.id, 'play_request', query);
  await ctx.reply(`🎵 Searching for: ${query}`);

  try {
    const { data } = await axios.get('https://apis.davidcyril.name.ng/play', {
      params: { query },
      timeout: 60000,
      headers: {
        Accept: 'application/json',
        'User-Agent': 'TelegramBot/1.0'
      }
    });

    const song = extractPlayableSong(data);
    if (!song.url) {
      await appendLog(ctx.from.id, 'play_failed', JSON.stringify(data).slice(0, 300));
      return ctx.reply('❌ I found a result, but the API did not return a playable audio URL. Try a different song name.');
    }

    const caption = [
      song.title ? `🎶 ${song.title}` : '🎶 Song ready',
      song.artist ? `👤 ${song.artist}` : '',
      song.duration ? `⏱️ ${song.duration}` : '',
      song.source ? `🔗 ${song.source}` : ''
    ].filter(Boolean).join('\n');

    try {
      return await ctx.replyWithAudio({ url: song.url, filename: `${sanitizeFilename(song.title || query)}.mp3` }, { caption });
    } catch (_audioError) {
      return ctx.reply(`${caption}\n\n${song.url}`);
    }
  } catch (error) {
    await appendLog(ctx.from.id, 'play_error', error.message);
    return ctx.reply(`❌ Song search failed: ${error.response?.data?.message || error.message}`);
  }
});

bot.command('logs', async (ctx) => {
  const output = await tailLogs(60);
  return ctx.reply(`🧾 Bot logs (latest):\n\n\`\`\`\n${output.slice(0, 3500)}\n\`\`\``);
});

bot.command('workspace', async (ctx) => {
  const { cwd, items } = await accessControl.getWorkspaceFiles(ctx.from.id);
  return ctx.reply(`📁 ${cwd}\n\n${items.length ? items.join('\n') : '(empty workspace)'}`);
});

bot.command('getfile', async (ctx) => {
  const rel = (ctx.message?.text || '').replace(/^\/getfile\s*/, '').trim();
  if (!rel) return ctx.reply('Usage: /getfile <relative-path>');
  const filePath = path.resolve(workspace.getPath(ctx.from.id), rel);
  if (!filePath.startsWith(workspace.getPath(ctx.from.id))) return ctx.reply('Invalid path.');
  if (!(await fs.pathExists(filePath))) return ctx.reply('File not found.');
  return ctx.replyWithDocument({ source: filePath });
});

bot.command('users', async (ctx) => {
  if (!(await accessControl.isAdmin(ctx.from.id))) return ctx.reply('Admin only command.');
  const users = await accessControl.listUsers();
  const lines = users.map((u) => `${u.id} | @${u.username || '-'} | banned=${u.banned} | pushes=${u.pushCount}/${accessControl.DAILY_LIMIT}`);
  return ctx.reply(lines.length ? lines.join('\n') : 'No users yet.');
});

bot.command('ban', async (ctx) => adminUserAction(ctx, 'ban'));
bot.command('unban', async (ctx) => adminUserAction(ctx, 'unban'));
bot.command('resetuser', async (ctx) => adminUserAction(ctx, 'reset'));

async function adminUserAction(ctx, action) {
  if (!(await accessControl.isAdmin(ctx.from.id))) return ctx.reply('Admin only command.');
  const target = (ctx.message?.text || '').split(/\s+/)[1];
  if (!target || !/^\d+$/.test(target)) return ctx.reply('Provide a numeric user id.');
  if (action === 'ban') {
    await accessControl.setBan(target, true);
    return ctx.reply(`User ${target} banned.`);
  }
  if (action === 'unban') {
    await accessControl.setBan(target, false);
    return ctx.reply(`User ${target} unbanned.`);
  }
  await accessControl.resetUser(target);
  return ctx.reply(`User ${target} reset.`);
}

bot.on('text', async (ctx) => {
  const userText = (ctx.message?.text || '').trim();
  if (userText.length < 2 || userText.startsWith('/')) return;

  const userId = ctx.from.id;
  const cwd = workspace.getPath(userId);

  await appendLog(userId, 'chat_message', userText);
  await ctx.reply('🧠 Thinking with Claude Pro...');

  const intentPrompt = `Classify this user message into ONE category. Return ONLY valid JSON.\nUser: "${userText}"\n\nCategories:\n- chat → normal conversation\n- terminal → run shell/git command\n- build_app → create app with LlamaCoder\n- git_push → push code to GitHub\n\nResponse format:\n{"intent": "chat|terminal|build_app|git_push", "command": "...", "app_prompt": "..."}`;

  let intent = { intent: 'chat' };
  const intentText = await callClaudePro(userId, intentPrompt);
  try {
    intent = JSON.parse(intentText);
  } catch (_error) {
    intent = { intent: 'chat' };
  }

  if (intent.intent === 'build_app') return handleLlamaCoder(ctx, intent.app_prompt || userText, cwd);
  if (intent.intent === 'git_push') return ctx.scene.enter('gitPush');
  if (intent.intent === 'terminal' && intent.command) return runTerminalCommand(ctx, intent.command, cwd);

  const response = await callClaudePro(userId, userText);
  return ctx.reply(response);
});

async function runTerminalCommand(ctx, command, cwd) {
  await appendLog(ctx.from.id, 'terminal_run', command);
  await ctx.reply(`🔄 Running: \`${command}\``);
  try {
    const { output, cwd: activeCwd } = await terminal.run(ctx.from.id, command, cwd);
    await appendLog(ctx.from.id, 'terminal_output', output.slice(0, 300));
    await ctx.reply(`✅ Output:\n\n\`\`\`\n${output.slice(0, 3500)}\n\`\`\``);
    await ctx.reply(`📁 CWD: ${activeCwd}`);
  } catch (error) {
    await appendLog(ctx.from.id, 'terminal_error', error.message);
    await ctx.reply(`❌ ${error.message}`);
  }
}

async function handleLlamaCoder(ctx, prompt, cwd) {
  await ctx.reply('🦙 Building full app with LlamaCoder...');
  try {
    const { data } = await axios.get(
      `https://omegatech-api.dixonomega.tech/api/ai/llamacoder?action=create&prompt=${encodeURIComponent(prompt)}&quality=low`,
      { timeout: 120000 }
    );

    if (!data?.success || !Array.isArray(data.files) || data.files.length === 0) {
      return ctx.reply(data?.rawOutput || 'No files generated.');
    }

    for (const file of data.files) {
      const filePath = path.join(cwd, file.path || 'src/index.tsx');
      await fs.ensureDir(path.dirname(filePath));
      await fs.writeFile(filePath, file.content || '');
    }

    await ctx.reply(`✅ App saved to workspace! ${data.files.length} files created.`);
    const zipBuffer = await createZipFromFiles(data.files);

    await ctx.replyWithDocument({ source: zipBuffer, filename: `app-${Date.now()}.zip` });
    return null;
  } catch (error) {
    return ctx.reply(`Build failed: ${error.message}`);
  }
}

function createZipFromFiles(files) {
  return new Promise((resolve, reject) => {
    const pass = new PassThrough();
    const chunks = [];

    pass.on('data', (chunk) => chunks.push(chunk));
    pass.on('end', () => resolve(Buffer.concat(chunks)));
    pass.on('error', reject);

    const archive = archiver('zip', { zlib: { level: 9 } });
    archive.on('error', reject);
    archive.pipe(pass);

    for (const file of files) {
      archive.append(file.content || '', { name: file.path || 'src/index.tsx' });
    }

    archive.finalize();
  });
}


function extractPlayableSong(payload) {
  const urls = [];
  collectUrls(payload, urls);

  const audioUrl = urls.find((url) => /\.(mp3|m4a|wav|ogg)(\?|$)/i.test(url)) ||
    urls.find((url) => /download|audio|play/i.test(url)) ||
    urls[0];

  const data = payload?.result || payload?.data || payload?.song || payload;
  return {
    url: audioUrl,
    title: findFirstString(data, ['title', 'name', 'song', 'track']),
    artist: findFirstString(data, ['artist', 'author', 'channel', 'uploader']),
    duration: findFirstString(data, ['duration', 'timestamp', 'time']),
    source: findFirstString(data, ['source', 'youtube', 'videoUrl', 'url', 'link', 'webpage_url'])
  };
}

function collectUrls(value, urls) {
  if (!value) return;
  if (typeof value === 'string') {
    if (/^https?:\/\//i.test(value)) urls.push(value);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((entry) => collectUrls(entry, urls));
    return;
  }
  if (typeof value === 'object') {
    for (const [key, nested] of Object.entries(value)) {
      if (/thumbnail|image|avatar|cover/i.test(key)) continue;
      collectUrls(nested, urls);
    }
  }
}

function findFirstString(value, keys) {
  if (!value || typeof value !== 'object') return '';
  for (const key of keys) {
    if (typeof value[key] === 'string' && value[key].trim()) return value[key].trim();
  }
  for (const nested of Object.values(value)) {
    if (nested && typeof nested === 'object') {
      const found = findFirstString(nested, keys);
      if (found) return found;
    }
  }
  return '';
}

function sanitizeFilename(name) {
  return String(name || 'song').replace(/[^a-z0-9._ -]/gi, '').slice(0, 80) || 'song';
}

console.log('Connecting to Telegram...');
bot
  .launch()
  .then(() => console.log(`🤖 Dirty Bot LIVE → Connected as @${bot.botInfo?.username || 'YourBot'}`))
  .catch((error) => console.error('Launch failed:', error));

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
