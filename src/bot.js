const { Telegraf, Scenes, session } = require('telegraf');
const axios = require('axios');
const fs = require('fs-extra');
const path = require('path');
const archiver = require('archiver');

require('dotenv').config();

const callClaudePro = require('./utils/claudePro');
const { askGemini } = require('./utils/ai');
const historyManager = require('./utils/history');
const workspace = require('./utils/workspace');
const terminal = require('./utils/terminal');
const agentTools = require('./tools');
const gitPushScene = require('./scenes/gitPush');
const { buildHelpText } = require('./commands/help');
const accessControl = require('./utils/accessControl');
const { appendLog, tailLogs } = require('./utils/logs');
const { requestWithRetry } = require('./utils/httpRetry');
const { callOmegaProvider, getOmegaProviders } = require('./utils/omegaFallback');
const consoleCapture = require('./utils/consoleCapture');
const { isZipFileName, listWorkspaceZips, saveTelegramZip, unzipFile } = require('./utils/fileHandler');


const DEFAULT_BRAIN = (process.env.BRAIN || 'groq').toLowerCase();
const GROQ_API_KEY = process.env.GROQ_API_KEY;
const GROQ_MODEL = process.env.GROQ_MODEL || 'llama-3.3-70b-versatile';
const ALLOWED_USER_ID = process.env.ALLOWED_USER_ID ? Number.parseInt(process.env.ALLOWED_USER_ID, 10) : null;
const OWNER_ONLY = process.env.OWNER_ONLY === '1';
const creationSessions = new Map();
const TELEGRAM_DOCUMENT_LIMIT_BYTES = Number(process.env.TELEGRAM_DOCUMENT_LIMIT_BYTES || 50 * 1024 * 1024);

const SYSTEM_PROMPT = `You are an autonomous CLI agent controlling a server. You can:
- Run terminal commands with exec, including installing missing tools/modules when needed
- Create full project worktrees with createWorkTree
- Zip completed files/folders and send them directly in Telegram; if Telegram upload fails or the zip is too large, upload to gofile.io with zipAndUpload
- Send existing files directly to chat with sendFile
- Browse web, scrape sites, find and validate API endpoints before sending endpoint scripts
- Generate images with generateImage when the user asks for AI art, text-to-image, pictures, or visual concepts
- Analyze uploaded photos with GPT-4 Mini's image-capable Omega fallback while using the same memory
- Take full-page website screenshots with screenshot and send the image to chat
- Send a screenshot of this bot's own console/output transcript with consoleScreenshot
- Extract zip files with unzipFile without asking for GitHub details
When the user asks you to create, build, scaffold, generate, or code a project/app/site/bot, first draft a clean work tree with sensible folders, then write complete code/config files for every needed directory using createWorkTree. Do not leave empty placeholder directories. After creating it, the bot will ask whether the user wants updates before packaging.
Only push to GitHub when the user explicitly runs /gitpush or clearly asks to push/upload to GitHub. If the user only asks to unzip, extract, inspect, edit, build, or send files, do not ask for a GitHub repo URL/token and do not run git push.
Always create missing output directories before redirecting command output into files. Always give feedback before/after actions. If user asks you to scrape, generate code, install dependencies, or build a project, you must run the code/command and report the console output. If a command fails, diagnose it, install missing dependencies/tools if safe, retry with another approach, and only stop after every reasonable method fails. If the user asks you to scrape a site for endpoints/APIs, use deepScrape or scrapeSite, then findAPIs, and only present endpoint scripts after the endpoint has been validated with a live request. If a scrape succeeds, include a screenshot when available. If output is a single short script, you may paste it in chat; if the user asks to send/download a file in chat, call sendFile with the file path; if there are many files, create them as a worktree and let the bot package them after user approval. Remember and use the saved chat history, user profile, and memories provided in the prompt.`;

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
bot.command('model', async (ctx) => {
  const selected = await accessControl.getModel(ctx.from.id, DEFAULT_BRAIN);
  return ctx.reply(`Current AI model: ${selected}
Choose a model. All choices share the bot's saved memory/session context.`, {
    reply_markup: {
      inline_keyboard: [
        [
          { text: '⚡ Groq', callback_data: 'model:groq' },
          { text: '✨ Gemini', callback_data: 'model:gemini' }
        ],
        [
          { text: '🧠 Qwen', callback_data: 'model:qwen' },
          { text: '🌿 Claude Haiku', callback_data: 'model:claude-haiku' }
        ],
        [
          { text: '🤖 GPT-4 Mini', callback_data: 'model:gpt-4-mini' },
          { text: '🔎 DeepSeek', callback_data: 'model:deepseek' }
        ]
      ]
    }
  });
});

bot.command('gemini', async (ctx) => switchModel(ctx, 'gemini'));
bot.command('groq', async (ctx) => switchModel(ctx, 'groq'));
bot.command('qwen', async (ctx) => switchModel(ctx, 'qwen'));
bot.command('claudehaiku', async (ctx) => switchModel(ctx, 'claude-haiku'));
bot.command('gpt4mini', async (ctx) => switchModel(ctx, 'gpt-4-mini'));
bot.command('deepseek', async (ctx) => switchModel(ctx, 'deepseek'));
bot.action(/^model:(gemini|groq|qwen|claude-haiku|gpt-4-mini|deepseek)$/, async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  return switchModel(ctx, ctx.match[1]);
});


bot.command('run', async (ctx) => {
  const access = await consumeUsageOrReply(ctx, 'run');
  if (!access) return;
  const command = (ctx.message?.text || '').replace(/^\/run\s*/, '').trim();
  if (!command) return ctx.reply('Usage: /run <command>');
  return runTerminalCommand(ctx, command, workspace.getPath(ctx.from.id));
});


bot.command('play', async (ctx) => {
  const access = await consumeUsageOrReply(ctx, 'play');
  if (!access) return;
  const query = (ctx.message?.text || '').replace(/^\/play\s*/, '').trim();
  if (!query) return ctx.reply('Usage: /play <song name>');

  await appendLog(ctx.from.id, 'play_request', query);
  await ctx.reply(`🎵 Searching for: ${query}`);

  try {
    const { data } = await requestWithRetry(axios, {
      method: 'get',
      url: 'https://apis.davidcyril.name.ng/play',
      params: { query },
      timeout: 60000,
      headers: {
        Accept: 'application/json',
        'User-Agent': 'TelegramBot/1.0'
      }
    }, {
      retries: 2,
      onRetry: async (error, attempt, delayMs) => appendLog(ctx.from.id, 'play_retry', `${error.response?.status || error.code || error.message}; attempt=${attempt}; delay=${delayMs}`)
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
  return sendDocumentOrGofile(ctx, filePath, `📄 ${path.basename(filePath)}`);
});


bot.on('photo', async (ctx) => {
  const access = await consumeUsageOrReply(ctx, 'image-chat');
  if (!access) return;

  const userId = ctx.from.id;
  const photos = ctx.message?.photo || [];
  const bestPhoto = photos[photos.length - 1];
  if (!bestPhoto) return ctx.reply('No image found.');

  try {
    const imageUrl = await ctx.telegram.getFileLink(bestPhoto.file_id);
    const prompt = ctx.message?.caption || 'Describe this image and answer any question about it.';
    const provider = getOmegaProviders().find((item) => item.key === 'omega-gpt-4-mini');
    await ctx.reply('🖼️ Analyzing image with GPT-4 Mini fallback memory...');
    const result = await callOmegaProvider(provider, userId, prompt, { imageUrl: imageUrl.href || imageUrl.toString() });
    historyManager.addMessage(userId, 'user', `[image] ${prompt}`);
    historyManager.addMessage(userId, 'assistant', result.answer);
    return ctx.reply(`✅ ${result.answer.slice(0, 3500)}`);
  } catch (error) {
    await appendLog(userId, 'image_chat_error', error.message);
    return ctx.reply(`❌ Image analysis failed: ${error.message}`);
  }
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

    const extractedDir = path.join(cwd, 'extracted');
    const unzipResult = await unzipFile(savedZip.fullPath, extractedDir);
    const { output: listing } = await terminal.run(userId, 'find extracted -maxdepth 2 -type f | sort | head -80', cwd);
    const strippedNote = unzipResult.strippedRoot ? `
📂 Removed zip wrapper folder: ${unzipResult.strippedRoot}` : '';

    await ctx.reply(`✅ Saved and extracted zip: ${savedZip.name}${strippedNote}

📦 Workspace zip files (ls):

\`\`\`
${zipListing.slice(0, 1800)}
\`\`\`

📂 Extracted files:

\`\`\`
${listing.slice(0, 2200)}
\`\`\`

I did not start a GitHub push. I will only ask for a GitHub repo URL/token if you explicitly run /gitpush or ask me to push to GitHub.`);
    return;
  } catch (error) {
    await appendLog(userId, 'zip_save_failed', error.message);
    return ctx.reply(`❌ Failed to save zip: ${error.message}`);
  }
});

bot.command('users', async (ctx) => {
  if (!(await accessControl.isAdmin(ctx.from.id))) return ctx.reply('Admin only command.');
  const users = await accessControl.listUsers();
  const lines = users.map((u) => `${u.id} | @${u.username || '-'} | banned=${u.banned} | usage=${u.usageCount || 0}/${accessControl.DAILY_LIMIT} | pushes=${u.pushCount}/${accessControl.DAILY_LIMIT} | model=${u.selectedModel || 'default'}`);
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
  if (OWNER_ONLY && ALLOWED_USER_ID && ctx.from.id !== ALLOWED_USER_ID) return ctx.reply('Unauthorized');

  if (creationSessions.has(ctx.from.id)) {
    return handleCreationFollowup(ctx, userText);
  }

  const access = await consumeUsageOrReply(ctx, 'ai');
  if (!access) return;

  const userId = ctx.from.id;

  await appendLog(userId, 'chat_message', userText);
  historyManager.addMessage(userId, 'user', userText);
  historyManager.updateProfile(userId, {
    username: ctx.from.username || '',
    firstName: ctx.from.first_name || '',
    lastName: ctx.from.last_name || ''
  });
  if (/\bremember\b|\bmy\s+name\b|\bcall me\b|\bi like\b|\bi prefer\b/i.test(userText)) {
    historyManager.addMemory(userId, userText, 'user');
  }
  await ctx.sendChatAction('typing');

  const sendFeedback = async (msg) => {
    consoleCapture.append(userId, msg);
    await ctx.reply(`⏳ ${String(msg).slice(0, 3500)}`);
  };

  try {
    const result = await runAgent(userText, [], sendFeedback, userId);

    await deliverAgentResult(ctx, result);
    historyManager.addMessage(userId, 'assistant', typeof result === 'string' ? result : JSON.stringify(result).slice(0, 8000));
    await promptForCreationUpdates(ctx);
  } catch (error) {
    await appendLog(userId, 'agent_error', error.message);
    await ctx.reply(`❌ Error: ${error.message}`);
  }
});

async function executeToolCall(name, args, sendFeedback, userId) {
  if (sendFeedback) await sendFeedback(`Calling tool: ${name}`);
  switch (name) {
    case 'exec': return agentTools.execTool(args.command, sendFeedback);
    case 'zipAndUpload': return agentTools.zipAndUpload(args.path, sendFeedback);
    case 'sendFile': return agentTools.sendFile(args.path, sendFeedback);
    case 'createWorkTree': {
      const result = await agentTools.createWorkTree(args.rootDir, args.files, sendFeedback);
      creationSessions.set(userId, { ...result, stage: 'await_update', createdAt: Date.now() });
      return result;
    }
    case 'unzipFile': return agentTools.unzipFileTool(args.zipPath, args.destination, sendFeedback);
    case 'consoleScreenshot': return consoleCapture.saveScreenshot(userId, args.path);
    case 'webSearch': return agentTools.webSearch(args.query, sendFeedback);
    case 'fetchUrl': return agentTools.fetchUrl(args.url, sendFeedback);
    case 'scrapeSite': return agentTools.scrapeSite(args.url, args.maxDepth, sendFeedback);
    case 'deepScrape': return agentTools.deepScrape(args.url, args, sendFeedback);
    case 'screenshot': return agentTools.screenshot(args.url, args.path, args.fullPage, sendFeedback);
    case 'findAPIs': return agentTools.findAPIs(args.url, sendFeedback);
    case 'generateImage': return agentTools.generateImage(args, sendFeedback);
    default: throw new Error(`Unknown tool: ${name}`);
  }
}

function shouldDeliverToolResult(toolName, result) {
  return ['screenshot', 'consoleScreenshot', 'scrapeSite', 'deepScrape', 'zipAndUpload', 'sendFile', 'unzipFile', 'createWorkTree', 'generateImage'].includes(toolName) || Boolean(result?.path || result?.savedPath || result?.type === 'url');
}

function buildMessages(userMsg, history, userId) {
  const memoryContext = historyManager.formatMemoryContext(userId);
  const contextBlock = memoryContext ? `\n\n${memoryContext}` : '';
  const persistedHistory = historyManager.getMessages(userId, 18);
  return [
    { role: 'system', content: `${SYSTEM_PROMPT}${contextBlock}` },
    ...persistedHistory.map((h) => ({ role: h.role === 'assistant' ? 'assistant' : 'user', content: h.content })),
    ...history.map((h) => ({ role: h.role, content: h.parts?.[0]?.text || h.content })),
    { role: 'user', content: userMsg }
  ];
}

function stripJsonFence(raw) {
  return String(raw || '').replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```$/i, '').trim();
}

function parseToolJson(raw) {
  try {
    return JSON.parse(stripJsonFence(raw));
  } catch (_error) {
    const match = stripJsonFence(raw).match(/\{[\s\S]*\}/);
    if (!match) return null;
    try {
      return JSON.parse(match[0]);
    } catch (__error) {
      return null;
    }
  }
}

async function deliverAgentResult(ctx, result) {
  if (result && typeof result === 'object') {
    if (result.type === 'url') return ctx.reply(`✅ Done. Download: ${result.url}`);
    if (result.type === 'images' && Array.isArray(result.images)) {
      await ctx.reply(`✅ Generated ${result.images.length} image(s) for: ${result.prompt || 'your prompt'}`);
      for (const image of result.images.slice(0, 10)) {
        const imageUrl = image.url || image;
        try {
          await ctx.replyWithPhoto(imageUrl, { caption: `🖼️ ${result.prompt || 'Generated image'}${image.seed ? `\nSeed: ${image.seed}` : ''}` });
        } catch (_error) {
          await ctx.reply(`🖼️ ${imageUrl}`);
        }
      }
      return;
    }

    if (result.savedPath && await fs.pathExists(result.savedPath)) {
      await ctx.reply(`✅ Done. Scrape saved: ${result.savedPath}\n\nConsole output:\n\`\`\`\n${String(result.consoleOutput || '').slice(0, 2500)}\n\`\`\``);
      if (result.screenshotPath && await fs.pathExists(result.screenshotPath)) {
        await ctx.replyWithPhoto({ source: result.screenshotPath }, { caption: result.screenshotCaption || '🖼️ Scrape screenshot' });
      }
      return sendDocumentOrGofile(ctx, result.savedPath, '📄 Scrape JSON');
    }

    if (result.path && await fs.pathExists(result.path)) {
      const isImage = (/^image\//i.test(result.mimetype || '') || /\.(png|jpe?g|webp)$/i.test(result.path)) && !/svg\+xml/i.test(result.mimetype || '') && !/\.svg$/i.test(result.path);
      await ctx.reply(`✅ Done. File created: ${result.path}`);
      if (isImage) {
        return ctx.replyWithPhoto({ source: result.path }, { caption: result.caption || '🖼️ Screenshot' });
      }
      return sendDocumentOrGofile(ctx, result.path, result.caption || `📄 ${path.basename(result.path)}`);
    }
    return ctx.reply(`✅ ${JSON.stringify(result, null, 2).slice(0, 3500)}`);
  }
  return ctx.reply(`✅ ${String(result || 'Done').slice(0, 3500)}`);
}

async function sendDocumentOrGofile(ctx, filePath, caption = '') {
  const stat = await fs.stat(filePath);
  const filename = path.basename(filePath);

  if (stat.size > TELEGRAM_DOCUMENT_LIMIT_BYTES) {
    await ctx.reply(`⚠️ ${filename} is ${formatBytes(stat.size)}, which is over Telegram's bot upload limit. Uploading to Gofile instead...`);
    const upload = await agentTools.uploadFileToGofile(filePath, async (msg) => consoleCapture.append(ctx.from.id, msg));
    return ctx.reply(`✅ Download: ${upload.url}`);
  }

  try {
    return await ctx.replyWithDocument({ source: filePath, filename }, caption ? { caption } : undefined);
  } catch (error) {
    await ctx.reply(`⚠️ Telegram could not send ${filename} (${error.message.slice(0, 500)}). Uploading to Gofile instead...`);
    const upload = await agentTools.uploadFileToGofile(filePath, async (msg) => consoleCapture.append(ctx.from.id, msg));
    return ctx.reply(`✅ Download: ${upload.url}`);
  }
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


function isYes(text) {
  return /^(yes|yeah|yep|sure|ok|okay|add|update|change|edit|y)\b/i.test(String(text || '').trim());
}

function isNoOrPackage(text) {
  return /^(no|nah|nope|done|finish|finished|zip|package|upload|send|ship|n)\b/i.test(String(text || '').trim());
}

function wantsGofile(text) {
  return /gofile|download link|upload|host/i.test(String(text || ''));
}

async function promptForCreationUpdates(ctx) {
  const pending = creationSessions.get(ctx.from.id);
  if (!pending || pending.stage !== 'await_update') return;

  const files = (pending.files || []).slice(0, 40).join('\n');
  await ctx.reply(`✅ Project worktree is ready at:\n${pending.rootDir}\n\nFiles created (${pending.fileCount || pending.files?.length || 0}):\n\n\`\`\`\n${files.slice(0, 2200)}\n\`\`\`\n\nDo you want any updates before I package it? Reply **yes** to add/change something, or **no** to zip it and send it here in chat. You can also say "upload to Gofile" if you want a download link instead.`);
}

async function finalizeCreation(ctx, pending, options = {}) {
  const userId = ctx.from.id;
  const sendFeedback = async (msg) => {
    consoleCapture.append(userId, msg);
    await ctx.reply(`⏳ ${String(msg).slice(0, 3500)}`);
  };

  creationSessions.delete(userId);

  const zipResult = await agentTools.createZipArchive(pending.rootDir, null, sendFeedback);
  try {
    if (options.gofile) {
      const upload = await agentTools.uploadFileToGofile(zipResult.path, sendFeedback);
      return ctx.reply(`✅ Project zipped and uploaded to Gofile:\n${upload.url}`);
    }

    await ctx.reply('✅ Zip ready. Sending it here in chat. If Telegram rejects it, I will upload it to Gofile instead.');
    return sendDocumentOrGofile(ctx, zipResult.path, zipResult.caption || '📦 Project zip');
  } finally {
    await fs.unlink(zipResult.path).catch(() => {});
  }
}


async function handleCreationFollowup(ctx, userText) {
  const userId = ctx.from.id;
  const pending = creationSessions.get(userId);
  if (!pending) return false;

  if (pending.stage === 'await_update') {
    if (isYes(userText)) {
      pending.stage = 'await_details';
      creationSessions.set(userId, pending);
      return ctx.reply('Cool — what do you want added or changed in the project?');
    }

    if (isNoOrPackage(userText)) {
      return finalizeCreation(ctx, pending, { gofile: wantsGofile(userText) });
    }

    return ctx.reply('Please reply **yes** if you want updates, or **no** to zip and send it here. You can also say "upload to Gofile".');
  }

  if (pending.stage === 'await_details') {
    if (/^(cancel|nevermind|never mind|no|done)$/i.test(userText.trim())) {
      return finalizeCreation(ctx, pending);
    }

    const access = await consumeUsageOrReply(ctx, 'ai-update');
    if (!access) return;

    await appendLog(userId, 'creation_update', userText);
    historyManager.addMessage(userId, 'user', userText);
    const sendFeedback = async (msg) => {
      consoleCapture.append(userId, msg);
      await ctx.reply(`⏳ ${String(msg).slice(0, 3500)}`);
    };

    const result = await runAgent(
      `Update the existing project at ${pending.rootDir}. Keep the current structure, add or modify complete files as needed, and do not push to GitHub. User requested: ${userText}`,
      [],
      sendFeedback,
      userId
    );

    await deliverAgentResult(ctx, result);
    historyManager.addMessage(userId, 'assistant', typeof result === 'string' ? result : JSON.stringify(result).slice(0, 8000));

    const updated = creationSessions.get(userId) || pending;
    updated.stage = 'await_update';
    creationSessions.set(userId, updated);
    return promptForCreationUpdates(ctx);
  }

  creationSessions.delete(userId);
  return false;
}

async function switchModel(ctx, model) {
  if (!['gemini', 'groq', 'qwen', 'claude-haiku', 'gpt-4-mini', 'deepseek'].includes(model)) return ctx.reply('Unknown model. Use /gemini, /groq, qwen, claude-haiku, gpt-4-mini, or deepseek.');
  await accessControl.setModel(ctx.from.id, model);
  await appendLog(ctx.from.id, 'model_switch', model);
  return ctx.reply(`✅ Switched AI model to ${model}.`);
}

async function consumeUsageOrReply(ctx, action) {
  const access = await accessControl.canUse(ctx.from.id);
  if (!access.allowed) {
    const reason = access.reason === 'banned'
      ? '⛔ You are banned from using this bot.'
      : `⛔ Daily usage limit reached (${accessControl.DAILY_LIMIT}/day). Ask the admin to reset you or try again tomorrow.`;
    await ctx.reply(reason);
    return false;
  }
  await accessControl.incrementUsage(ctx.from.id);
  await appendLog(ctx.from.id, 'usage', `${action}:${access.remaining === Infinity ? 'admin' : access.remaining - 1}`);
  return true;
}

function normalizeGroqMessages(messages) {
  return (messages || [])
    .filter((message) => ['system', 'user', 'assistant'].includes(message.role))
    .map((message) => ({
      role: message.role,
      content: String(message.content || '').slice(0, message.role === 'system' ? 6000 : 12000)
    }))
    .filter((message) => message.content.trim())
    .slice(-24);
}

async function runGroqJsonFallback(userMsg, history, sendFeedback, userId, depth, previousError) {
  if (sendFeedback) await sendFeedback(`Retrying Groq without function-calling after API error: ${previousError}`);
  const toolNames = agentTools.tools.map((t) => t.name).join(', ');
  const messages = normalizeGroqMessages(buildMessages(
    `Available tools: ${toolNames}. Return ONLY JSON. To call a tool return {"tool":"toolName","args":{...}}. To answer return {"final":"message"}. User/task: ${userMsg}`,
    history,
    userId
  ));

  const resp = await requestWithRetry(axios, {
    method: 'post',
    url: 'https://api.groq.com/openai/v1/chat/completions',
    data: { model: GROQ_MODEL, messages, temperature: 0.2 },
    timeout: 120000,
    headers: { Authorization: `Bearer ${GROQ_API_KEY}`, 'Content-Type': 'application/json' }
  }, {
    retries: 2,
    onRetry: async (error, attempt, delayMs) => {
      if (sendFeedback) await sendFeedback(`Groq rate-limit/temporary error (${error.response?.status || error.code || error.message}); retry ${attempt} in ${Math.round(delayMs / 1000)}s...`);
    }
  });
  const raw = resp.data?.choices?.[0]?.message?.content || '';
  const parsed = parseToolJson(raw);
  if (!parsed) return raw || 'Done';
  if (parsed.memory) historyManager.addMemory(userId, parsed.memory, 'groq');
  if (parsed.tool) {
    const result = await executeToolCall(parsed.tool, parsed.args || {}, sendFeedback, userId);
    if (shouldDeliverToolResult(parsed.tool, result)) return result;
    return runAgent(`Tool result: ${JSON.stringify(result)}`, [...history, { role: 'user', content: userMsg }], sendFeedback, userId, depth + 1);
  }
  return parsed.final || raw;
}

async function runAgent(userMsg, history = [], sendFeedback, userId, depth = 0) {
  if (depth > 8) throw new Error('Tool recursion limit reached');
  const messages = buildMessages(userMsg, history, userId);
  const selectedBrain = await accessControl.getModel(userId, DEFAULT_BRAIN);

  if (selectedBrain === 'groq' && GROQ_API_KEY) {
    try {
      const resp = await requestWithRetry(axios, {
        method: 'post',
        url: 'https://api.groq.com/openai/v1/chat/completions',
        data: {
          model: GROQ_MODEL,
          messages: normalizeGroqMessages(messages),
          tools: agentTools.tools.map((t) => ({
            type: 'function',
            function: { name: t.name, description: t.description, parameters: t.parameters }
          })),
          tool_choice: 'auto'
        },
        timeout: 120000,
        headers: {
          Authorization: `Bearer ${GROQ_API_KEY}`,
          'Content-Type': 'application/json'
        }
      }, {
        retries: 2,
        onRetry: async (error, attempt, delayMs) => {
          if (sendFeedback) await sendFeedback(`Groq rate-limit/temporary error (${error.response?.status || error.code || error.message}); retry ${attempt} in ${Math.round(delayMs / 1000)}s...`);
        }
      });

      const msg = resp.data?.choices?.[0]?.message;
      if (msg?.tool_calls?.length) {
        let lastResult;
        for (const call of msg.tool_calls) {
          const parsedArgs = JSON.parse(call.function.arguments || '{}');
          lastResult = await executeToolCall(call.function.name, parsedArgs, sendFeedback, userId);
          if (shouldDeliverToolResult(call.function.name, lastResult)) return lastResult;
        }
        return runAgent(`Tool result: ${JSON.stringify(lastResult)}`, [...history, { role: 'user', content: userMsg }], sendFeedback, userId, depth + 1);
      }
      return msg?.content || 'Done';
    } catch (error) {
      const status = error.response?.status;
      const details = error.response?.data?.error?.message || error.response?.data?.message || error.message;
      if (status === 400) {
        try {
          return await runGroqJsonFallback(userMsg, history, sendFeedback, userId, depth, details);
        } catch (retryError) {
          if (sendFeedback) await sendFeedback(`Groq retry failed (${retryError.response?.status || retryError.message}); falling back to Claude Pro...`);
        }
      } else if (sendFeedback) {
        await sendFeedback(`Groq unavailable${status ? ` (${status})` : ''}; falling back to Claude Pro...`);
      }
      return runClaudeFallbackAgent(userMsg, history, sendFeedback, userId, depth);
    }
  }

  const directOmegaProvider = getOmegaProviders().find((provider) => provider.key === `omega-${selectedBrain}` || provider.key.endsWith(selectedBrain));
  if (directOmegaProvider) return runOmegaProviderAgent(directOmegaProvider, userMsg, history, sendFeedback, userId, depth);
  if (selectedBrain === 'gemini') return runGeminiFallbackAgent(userMsg, history, sendFeedback, userId, depth);
  return runClaudeFallbackAgent(userMsg, history, sendFeedback, userId, depth);
}

async function runClaudeFallbackAgent(userMsg, history = [], sendFeedback, userId, depth = 0) {
  if (depth > 8) throw new Error('Tool recursion limit reached');
  const toolNames = agentTools.tools.map((t) => t.name).join(', ');
  const prompt = `${SYSTEM_PROMPT}\n\n${historyManager.formatMemoryContext(userId)}

You are Claude Pro fallback mode in a shared-memory fallback chain (Groq -> Claude Pro -> Gemini -> Omega Qwen/Claude Haiku/Gemini Premium/GPT-4 Mini/DeepSeek). Available tools: ${toolNames}.
Return ONLY JSON. To call a tool return {"tool":"toolName","args":{...}}. To answer return {"final":"message"}.
If a scrape/build/install task produced code or data, make sure a tool has run it and include console output in your final.
User/task: ${userMsg}`;

  let raw;
  try {
    raw = await callClaudePro(userId, prompt);
    if (/^Claude Pro Error:/i.test(raw)) throw new Error(raw);
  } catch (error) {
    if (sendFeedback) await sendFeedback(`Claude Pro unavailable; falling back to Gemini, then Omega model APIs if needed...`);
    return runGeminiFallbackAgent(userMsg, history, sendFeedback, userId, depth);
  }

  const parsed = parseToolJson(raw);
  if (!parsed) return raw;

  if (parsed.memory) historyManager.addMemory(userId, parsed.memory, 'claude');
  if (parsed.tool) {
    const result = await executeToolCall(parsed.tool, parsed.args || {}, sendFeedback, userId);
    if (shouldDeliverToolResult(parsed.tool, result)) return result;
    return runClaudeFallbackAgent(`Tool result: ${JSON.stringify(result)}`, [...history, { role: 'user', content: userMsg }], sendFeedback, userId, depth + 1);
  }

  return parsed.final || raw;
}

async function runGeminiFallbackAgent(userMsg, history = [], sendFeedback, userId, depth = 0) {
  if (depth > 8) throw new Error('Tool recursion limit reached');
  const toolNames = agentTools.tools.map((t) => t.name).join(', ');
  const messages = buildMessages(
    `You are Gemini fallback mode in a shared-memory fallback chain (Groq -> Claude Pro -> Gemini -> Omega Qwen/Claude Haiku/Gemini Premium/GPT-4 Mini/DeepSeek). Available tools: ${toolNames}. Return ONLY JSON. To call a tool return {"tool":"toolName","args":{...}}. To answer return {"final":"message"}. If a scrape/build/install task produced code or data, make sure a tool has run it and include console output in your final. User/task: ${userMsg}`,
    history,
    userId
  );

  let raw;
  try {
    raw = await askGemini(messages);
  } catch (error) {
    if (sendFeedback) await sendFeedback(`Gemini unavailable; falling back to Omega model APIs...`);
    return runOmegaFallbackAgent(userMsg, history, sendFeedback, userId, depth, error);
  }

  const parsed = parseToolJson(raw);
  if (!parsed) return raw;

  if (parsed.memory) historyManager.addMemory(userId, parsed.memory, 'gemini');
  if (parsed.tool) {
    const result = await executeToolCall(parsed.tool, parsed.args || {}, sendFeedback, userId);
    if (shouldDeliverToolResult(parsed.tool, result)) return result;
    return runGeminiFallbackAgent(`Tool result: ${JSON.stringify(result)}`, [...history, { role: 'user', content: userMsg }], sendFeedback, userId, depth + 1);
  }

  return parsed.final || raw;
}

async function runOmegaFallbackAgent(userMsg, history = [], sendFeedback, userId, depth = 0, previousError = null) {
  const providers = getOmegaProviders();
  let lastError = previousError;
  for (const provider of providers) {
    try {
      if (sendFeedback) await sendFeedback(`Trying ${provider.label} fallback with shared session memory...`);
      return await runOmegaProviderAgent(provider, userMsg, history, sendFeedback, userId, depth);
    } catch (error) {
      lastError = error;
      if (sendFeedback) await sendFeedback(`${provider.label} fallback failed: ${error.message.slice(0, 220)}`);
    }
  }
  throw new Error(`All AI fallbacks failed: ${lastError?.message || 'unknown error'}`);
}

async function runOmegaProviderAgent(provider, userMsg, history = [], sendFeedback, userId, depth = 0) {
  if (depth > 8) throw new Error('Tool recursion limit reached');
  const toolNames = agentTools.tools.map((t) => t.name).join(', ');
  const prompt = `${SYSTEM_PROMPT}\n\n${historyManager.formatMemoryContext(userId)}\n\nYou are ${provider.label} fallback mode in the shared-memory AI chain. Available tools: ${toolNames}.\nReturn ONLY JSON. To call a tool return {"tool":"toolName","args":{...}}. To answer return {"final":"message"}. If a scrape/build/install task produced code or data, make sure a tool has run it and include console output in your final.\nUser/task: ${userMsg}`;
  const response = await callOmegaProvider(provider, userId, prompt);
  const raw = response.answer;
  const parsed = parseToolJson(raw);
  if (!parsed) return raw;

  if (parsed.memory) historyManager.addMemory(userId, parsed.memory, provider.key);
  if (parsed.tool) {
    const result = await executeToolCall(parsed.tool, parsed.args || {}, sendFeedback, userId);
    if (shouldDeliverToolResult(parsed.tool, result)) return result;
    return runOmegaProviderAgent(provider, `Tool result: ${JSON.stringify(result)}`, [...history, { role: 'user', content: userMsg }], sendFeedback, userId, depth + 1);
  }

  return parsed.final || raw;
}


async function runTerminalCommand(ctx, command, cwd) {
  await appendLog(ctx.from.id, 'terminal_run', command);
  consoleCapture.append(ctx.from.id, `$ ${command}`);
  await ctx.reply(`🔄 Running: \`${command}\``);
  try {
    const { output, cwd: activeCwd } = await terminal.run(ctx.from.id, command, cwd);
    consoleCapture.append(ctx.from.id, output);
    await appendLog(ctx.from.id, 'terminal_output', output.slice(0, 300));
    await ctx.reply(`✅ Output:\n\n\`\`\`\n${output.slice(0, 3500)}\n\`\`\``);
    await ctx.reply(`📁 CWD: ${activeCwd}`);
  } catch (error) {
    consoleCapture.append(ctx.from.id, `ERROR: ${error.message}`);
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
    const zipResult = await agentTools.createZipArchive(rootDir, null, sendFeedback);
    try {
      return await sendDocumentOrGofile(ctx, zipResult.path, zipResult.caption || '📦 App zip');
    } finally {
      await fs.unlink(zipResult.path).catch(() => {});
    }
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
