const { Scenes } = require('telegraf');
const path = require('path');
const exec = require('../utils/executor');
const workspace = require('../utils/workspace');
const { findLatestZip, unzipFile } = require('../utils/fileHandler');
const accessControl = require('../utils/accessControl');
const { appendLog } = require('../utils/logs');

const gitPushScene = new Scenes.WizardScene(
  'gitPush',
  async (ctx) => {
    const userId = ctx.from.id;
    const cwd = workspace.getPath(userId);

    await ctx.reply('🔍 Checking workspace for zip before push...');
    let gitCwd = cwd;
    const latestZip = await findLatestZip(cwd);
    if (latestZip) {
      await ctx.reply(`📦 Found ${latestZip.name}. Unzipping now...`);
      const extractedDir = path.join(cwd, 'extracted');
      await unzipFile(latestZip.fullPath, extractedDir);
      gitCwd = extractedDir;
      const ls = await exec('ls -la', { cwd: gitCwd });
      await ctx.reply(`✅ ZIP extracted. I will use this folder:
${gitCwd}

📂 Files:

\`\`\`
${ls.stdout}
\`\`\``);
      await appendLog(userId, 'zip_unzipped', latestZip.name);
    } else {
      const ls = await exec('ls -la', { cwd: gitCwd });
      await ctx.reply(`ℹ️ No zip found. I will use your workspace directly:
${gitCwd}

📂 Files:

\`\`\`
${ls.stdout}
\`\`\``);
    }

    ctx.wizard.state.gitCwd = gitCwd;
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

    const gitCwd = ctx.wizard.state.gitCwd || cwd;

    await ctx.reply('🚀 Preparing git push with progress updates...');
    await appendLog(userId, 'gitpush_start', `repo=${repoUrl}`);

    try {
      await ctx.reply('1/8 Initializing repository...');
      await exec('git init', { cwd: gitCwd });
      await ctx.reply('2/8 Configuring git user...');
      await exec('git config user.name "TelegramBot"', { cwd: gitCwd });
      await exec('git config user.email "bot@telegram.com"', { cwd: gitCwd });
      await ctx.reply('3/8 Creating/switching to main branch...');
      await exec('git checkout -B main', { cwd: gitCwd });
      await ctx.reply('4/8 Staging files...');
      await exec('git add -A', { cwd: gitCwd });
      const statusOutput = await exec('git status --short', { cwd: gitCwd });
      if (statusOutput.stdout.trim()) {
        await ctx.reply(`🧾 Staged changes:\n\n\`\`\`\n${statusOutput.stdout}\n\`\`\``);
      } else {
        await ctx.reply('ℹ️ No file changes detected after staging. I will create an empty commit so push can continue.');
      }

      await ctx.reply('5/8 Committing files...');
      try {
        await exec('git commit -m "Initial commit from Telegram Bot"', { cwd: gitCwd });
      } catch (error) {
        const commitError = String(error.stderr || error.message);
        if (commitError.includes('nothing to commit')) {
          await exec('git commit --allow-empty -m "Initial commit from Telegram Bot"', { cwd: gitCwd });
        } else {
          throw error;
        }
      }

      const pushUrl = repoUrl.replace('https://', `https://x-access-token:${token}@`);

      await ctx.reply('6/8 Configuring remote origin...');
      try {
        await exec(`git remote add origin ${pushUrl}`, { cwd: gitCwd });
      } catch (_error) {
        await exec(`git remote set-url origin ${pushUrl}`, { cwd: gitCwd });
      }

      await ctx.reply('7/8 Syncing with remote when available...');
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

      await ctx.reply('8/8 Pushing to GitHub...');
      try {
        await exec('git push -u origin main --force', { cwd: gitCwd });
      } catch (_forceError) {
        await ctx.reply('Primary push method failed. Retrying with upstream-safe push...');
        await exec('git push --set-upstream origin main', { cwd: gitCwd });
      }
      await accessControl.incrementPush(userId);

      await appendLog(userId, 'gitpush_success', `repo=${repoUrl}`);
      await ctx.reply(`✅ Push Successful!\n\nRepo: ${repoUrl.replace('.git', '')}`);
    } catch (error) {
      await appendLog(userId, 'gitpush_failed', error.stderr || error.message);
      await ctx.reply('❌ Push failed:\n' + (error.stderr || error.message) + '\n\nChecks:\n1) PAT has repo scope\n2) Repo URL is correct\n3) Default branch permission allows push\n4) If protected branch enabled, allow force push or use an unprotected branch.');
    }

    return ctx.scene.leave();
  }
);

module.exports = gitPushScene;
