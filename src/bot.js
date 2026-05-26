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

if (!process.env.BOT_TOKEN) {
  throw new Error('Missing BOT_TOKEN in environment.');
}

const bot = new Telegraf(process.env.BOT_TOKEN);
const stage = new Scenes.Stage([gitPushScene]);

bot.use(session());
bot.use(stage.middleware());

bot.start(async (ctx) => {
  await workspace.create(ctx.from.id);
  await ctx.reply('✅ Bot connected successfully.\nWorkspace ready.\nTalk naturally — I remember everything.');
});

bot.on('text', async (ctx) => {
  const userText = (ctx.message?.text || '').trim();
  if (userText.length < 2) return;

  const userId = ctx.from.id;
  await workspace.create(userId);
  const cwd = workspace.getPath(userId);

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
  await ctx.reply(`🔄 Running: \`${command}\``);
  try {
    const { output, cwd: activeCwd } = await terminal.run(ctx.from.id, command, cwd);
    await ctx.reply(`✅ Output:\n\n\`\`\`\n${output.slice(0, 3500)}\n\`\`\``);
    await ctx.reply(`📁 CWD: ${activeCwd}`);
  } catch (error) {
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

console.log('Connecting to Telegram...');
bot
  .launch()
  .then(() => console.log(`🤖 Dirty Bot LIVE → Connected as @${bot.botInfo?.username || 'YourBot'}`))
  .catch((error) => console.error('Launch failed:', error));

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
