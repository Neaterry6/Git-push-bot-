const { Scenes } = require('telegraf');
const path = require('path');
const exec = require('../utils/executor');
const workspace = require('../utils/workspace');
const { findLatestZip, unzipFile } = require('../utils/fileHandler');
const accessControl = require('../utils/accessControl');

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

    const pushAccess = await accessControl.canPush(userId);
    if (!pushAccess.allowed) {
      if (pushAccess.reason === 'banned') {
        await ctx.reply('⛔ You are banned from using this bot.');
      } else {
        await ctx.reply(`⛔ Daily push limit reached (${accessControl.DAILY_LIMIT}/day). Try again tomorrow or ask admin to reset you.`);
      }
      return ctx.scene.leave();
    }

    await ctx.reply('🔍 Checking workspace...');

    let gitCwd = cwd;
    const latestZip = await findLatestZip(cwd);
    if (latestZip) {
      await ctx.reply(`📦 Found ${latestZip.name} — Unzipping...`);
      const extractedDir = path.join(cwd, 'extracted');
      await unzipFile(latestZip.fullPath, extractedDir);
      gitCwd = extractedDir;
      const ls = await exec('ls -la', { cwd: gitCwd });
      await ctx.reply(`✅ ZIP extracted. Using: ${gitCwd}\n\n\`\`\`\n${ls.stdout}\n\`\`\``);
    }

    await ctx.reply('🚀 Preparing git push...');

    try {
      await exec('git init', { cwd: gitCwd });
      await exec('git config user.name "TelegramBot"', { cwd: gitCwd });
      await exec('git config user.email "bot@telegram.com"', { cwd: gitCwd });
      await exec('git checkout -B main', { cwd: gitCwd });
      await exec('git add .', { cwd: gitCwd });

      try {
        await exec('git commit -m "Initial commit from Telegram Bot"', { cwd: gitCwd });
      } catch (error) {
        if (!String(error.stderr || error.message).includes('nothing to commit')) {
          throw error;
        }
      }

      const pushUrl = repoUrl.replace('https://', `https://x-access-token:${token}@`);

      try {
        await exec(`git remote add origin ${pushUrl}`, { cwd: gitCwd });
      } catch (_error) {
        await exec(`git remote set-url origin ${pushUrl}`, { cwd: gitCwd });
      }

      try {
        await exec('git fetch origin main', { cwd: gitCwd });
      } catch (_error) {
        // Remote may be empty; continue.
      }

      try {
        await exec('git pull --allow-unrelated-histories origin main', { cwd: gitCwd });
      } catch (_error) {
        // If histories are unrelated/new repo, force push can still proceed.
      }

      await exec('git push -u origin main --force', { cwd: gitCwd });
      await accessControl.incrementPush(userId);

      await ctx.reply(`✅ Push Successful!\n\nRepo: ${repoUrl.replace('.git', '')}`);
    } catch (error) {
      await ctx.reply('❌ Push failed:\n' + (error.stderr || error.message) + '\n\nChecks:\n1) PAT has repo scope\n2) Repo URL is correct\n3) Default branch permission allows push');
    }

    return ctx.scene.leave();
  }
);

module.exports = gitPushScene;
