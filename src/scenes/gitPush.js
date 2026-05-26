const { Scenes } = require('telegraf');
const exec = require('../utils/executor');
const workspace = require('../utils/workspace');
const { findLatestZip, unzipFile } = require('../utils/fileHandler');

const gitPushScene = new Scenes.WizardScene(
  'gitPush',
  async (ctx) => {
    await ctx.reply('📤 Send GitHub repo URL (https://github.com/user/repo.git)');
    return ctx.wizard.next();
  },
  async (ctx) => {
    ctx.wizard.state.repoUrl = (ctx.message?.text || '').trim();
    await ctx.reply('🔑 Send your GitHub Personal Access Token');
    return ctx.wizard.next();
  },
  async (ctx) => {
    const token = (ctx.message?.text || '').trim();
    const repoUrl = ctx.wizard.state.repoUrl;
    const userId = ctx.from.id;
    const cwd = workspace.getPath(userId);

    await ctx.reply('🔍 Checking workspace...');

    const latestZip = await findLatestZip(cwd);
    if (latestZip) {
      await ctx.reply(`📦 Found ${latestZip.name} — Unzipping...`);
      await unzipFile(latestZip.fullPath, cwd);
      const ls = await exec('ls -la', { cwd });
      await ctx.reply(`✅ ZIP extracted. Listing files:\n\n\`\`\`\n${ls.stdout}\n\`\`\``);
    }

    await ctx.reply('🚀 Preparing git push...');

    try {
      await exec('git init', { cwd });
      await exec('git config user.name "TelegramBot"', { cwd });
      await exec('git config user.email "bot@telegram.com"', { cwd });
      await exec('git checkout -B main', { cwd });
      await exec('git add .', { cwd });

      try {
        await exec('git commit -m "Initial commit from Telegram Bot"', { cwd });
      } catch (error) {
        if (!String(error.message).includes('nothing to commit')) {
          throw error;
        }
      }

      const pushUrl = repoUrl.replace('https://', `https://x-access-token:${token}@`);

      try {
        await exec(`git remote add origin ${pushUrl}`, { cwd });
      } catch (_error) {
        await exec(`git remote set-url origin ${pushUrl}`, { cwd });
      }

      try {
        await exec('git fetch origin main', { cwd });
      } catch (_error) {
        // Remote may be empty; continue.
      }

      try {
        await exec('git pull --rebase origin main', { cwd });
      } catch (_error) {
        // If histories are unrelated/new repo, pushing a fresh branch still works.
      }

      await exec('git push -u origin main', { cwd });

      await ctx.reply(`✅ Push Successful!\n\nRepo: ${repoUrl.replace('.git', '')}`);
    } catch (error) {
      await ctx.reply(`❌ Push failed:\n${error.message}\n\nChecks:\n1) PAT has repo scope\n2) Repo URL is correct\n3) Default branch permission allows push`);
    }

    return ctx.scene.leave();
  }
);

module.exports = gitPushScene;
