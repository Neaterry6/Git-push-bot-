const { Telegraf, Scenes, session } = require('telegraf');
const axios = require('axios');
const fs = require('fs-extra');
const path = require('path');
const archiver = require('archiver');

require('dotenv').config();

const callClaudePro = require('./utils/claudePro');
const workspace = require('./utils/workspace');
const terminal = require('./utils/terminal');
const agentTools = require('./tools');
const gitPushScene = require('./scenes/gitPush');
const { buildHelpText } = require('./commands/help');
const accessControl = require('./utils/accessControl');
const { appendLog, tailLogs } = require('./utils/logs');
const { isZipFileName, listWorkspaceZips, saveTelegramZip } = require('./utils/fileHandler');


const BRAIN = (process.env.BRAIN || 'groq').toLowerCase();
const GROQ_API_KEY = process.env.GROQ_API_KEY;
const GROQ_MODEL = process.env.GROQ_MODEL || 'llama-3.3-70b-versatile';
const ALLOWED_USER_ID = process.env.ALLOWED_USER_ID ? Number.parseInt(process.env.ALLOWED_USER_ID, 10) : null;

const SYSTEM_PROMPT = `You are an autonomous CLI agent controlling a server. You can:
- Run terminal commands with exec
- Create full project worktrees with createWorkTree
- Zip folders and upload to gofile.io with zipAndUpload
- Browse web, scrape sites, find APIs
Always give feedback before/after actions. If user asks to create a project, use createWorkTree with full file contents, then zipAndUpload it.`;

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


bot.on('document', async (ctx) => {
  const document = ctx.message?.document;
  const fileName = document?.file_name || '';

  if (!isZipFileName(fileName)) return ctx.reply('I can save .zip uploads only. Send a .zip file, then use /gitpush or reply to the zip with /gitpush.');

  const userId = ctx.from.id;
  const cwd = workspace.getPath(userId);

  try {
    const savedZip = await saveTelegramZip(ctx, cwd, document);
    await appendLog(userId, 'zip_saved', savedZip.name);
    const zipListing = await listWorkspaceZips(cwd);

    await ctx.reply(`✅ Saved zip: ${savedZip.name}

📦 Workspace zip files (ls):

\`\`\`
${zipListing.slice(0, 3200)}
\`\`\`

I will extract it now, then ask for the GitHub repo URL before asking for your token.`);
    return ctx.scene.enter('gitPush', { zipAlreadySaved: true });
  } catch (error) {
    await appendLog(userId, 'zip_save_failed', error.message);
    return ctx.reply(`❌ Failed to save zip: ${error.message}`);
  }
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
  if (ALLOWED_USER_ID && ctx.from.id !== ALLOWED_USER_ID) return ctx.reply('Unauthorized');

  const userId = ctx.from.id;

  await appendLog(userId, 'chat_message', userText);
  await ctx.sendChatAction('typing');

  const sendFeedback = async (msg) => {
    await ctx.reply(`⏳ ${String(msg).slice(0, 3500)}`);
  };

  try {
    const result = await runAgent(userText, [], sendFeedback, userId);

    if (result && typeof result === 'object' && result.type === 'url') {
      await ctx.reply(`✅ Done. Download: ${result.url}`);
    } else {
      await ctx.reply(`✅ ${String(result || 'Done').slice(0, 3500)}`);
    }
  } catch (error) {
    await appendLog(userId, 'agent_error', error.message);
    await ctx.reply(`❌ Error: ${error.message}`);
  }
});

async function executeToolCall(name, args, sendFeedback) {
  if (sendFeedback) await sendFeedback(`Calling tool: ${name}`);
  switch (name) {
    case 'exec': return agentTools.execTool(args.command, sendFeedback);
    case 'zipAndUpload': return agentTools.zipAndUpload(args.path, sendFeedback);
    case 'createWorkTree': return agentTools.createWorkTree(args.rootDir, args.files, sendFeedback);
    case 'webSearch': return agentTools.webSearch(args.query, sendFeedback);
    case 'fetchUrl': return agentTools.fetchUrl(args.url, sendFeedback);
    case 'scrapeSite': return agentTools.scrapeSite(args.url, args.maxDepth, sendFeedback);
    case 'findAPIs': return agentTools.findAPIs(args.url, sendFeedback);
    default: throw new Error(`Unknown tool: ${name}`);
  }
}

async function runAgent(userMsg, history = [], sendFeedback, userId, depth = 0) {
  if (depth > 8) throw new Error('Tool recursion limit reached');
  const messages = [
    { role: 'system', content: SYSTEM_PROMPT },
    ...history.map((h) => ({ role: h.role, content: h.parts?.[0]?.text || h.content })),
    { role: 'user', content: userMsg }
  ];

  if (BRAIN === 'groq' && GROQ_API_KEY) {
    try {
      const resp = await axios.post(
        'https://api.groq.com/openai/v1/chat/completions',
        {
          model: GROQ_MODEL,
          messages,
          tools: agentTools.tools.map((t) => ({
            type: 'function',
            function: { name: t.name, description: t.description, parameters: t.parameters }
          })),
          tool_choice: 'auto'
        },
        {
          timeout: 120000,
          headers: {
            Authorization: `Bearer ${GROQ_API_KEY}`,
            'Content-Type': 'application/json'
          }
        }
      );

      const msg = resp.data?.choices?.[0]?.message;
      if (msg?.tool_calls?.length) {
        let lastResult;
        for (const call of msg.tool_calls) {
          const parsedArgs = JSON.parse(call.function.arguments || '{}');
          lastResult = await executeToolCall(call.function.name, parsedArgs, sendFeedback);
        }
        return runAgent(`Tool result: ${JSON.stringify(lastResult)}`, [...history, { role: 'user', content: userMsg }], sendFeedback, userId, depth + 1);
      }
      return msg?.content || 'Done';
    } catch (error) {
      const status = error.response?.status;
      if (sendFeedback) await sendFeedback(`Groq unavailable${status ? ` (${status})` : ''}; falling back to Claude Pro...`);
      return runClaudeFallbackAgent(userMsg, history, sendFeedback, userId, depth);
    }
  }

  return runClaudeFallbackAgent(userMsg, history, sendFeedback, userId, depth);
}

async function runClaudeFallbackAgent(userMsg, history = [], sendFeedback, userId, depth = 0) {
  if (depth > 8) throw new Error('Tool recursion limit reached');
  const toolNames = agentTools.tools.map((t) => t.name).join(', ');
  const prompt = `${SYSTEM_PROMPT}

You are in fallback mode. Available tools: ${toolNames}.
Return ONLY JSON. To call a tool return {"tool":"toolName","args":{...}}. To answer return {"final":"message"}.
User/task: ${userMsg}`;
  const raw = await callClaudePro(userId, prompt);
  let parsed;
  try {
    parsed = JSON.parse(raw.replace(/^```json\s*/i, '').replace(/```$/i, '').trim());
  } catch (_error) {
    return raw;
  }

  if (parsed.tool) {
    const result = await executeToolCall(parsed.tool, parsed.args || {}, sendFeedback);
    return runClaudeFallbackAgent(`Tool result: ${JSON.stringify(result)}`, [...history, { role: 'user', content: userMsg }], sendFeedback, userId, depth + 1);
  }

  return parsed.final || raw;
}

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

    const rootDir = path.join(cwd, `app-${Date.now()}`);
    const sendFeedback = async (msg) => ctx.reply(`⏳ ${msg}`);
    await agentTools.createWorkTree(rootDir, data.files, sendFeedback);
    const upload = await agentTools.zipAndUpload(rootDir, sendFeedback);

    return ctx.reply(`✅ App saved and uploaded: ${upload.url}`);
  } catch (error) {
    return ctx.reply(`Build failed: ${error.message}`);
  }
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
