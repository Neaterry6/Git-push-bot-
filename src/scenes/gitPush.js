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
      await exec('git add .', { cwd });

      try {
        await exec('git commit -m "Initial commit from Telegram Bot"', { cwd });
      } catch (error) {
        if (!String(error.message).includes('nothing to commit')) {
          throw error;
        }
      }

      const pushUrl = repoUrl.replace('https://', `https://${token}@`);
      const branchOut = await exec('git branch --show-current', { cwd });
      const branch = branchOut.stdout.trim() || 'main';
      await exec(`git push -u ${pushUrl} ${branch} --force-with-lease`, { cwd });

      await ctx.reply(`✅ Push Successful!\n\nRepo: ${repoUrl.replace('.git', '')}`);
    } catch (error) {
      await ctx.reply(`❌ Push failed:\n${error.message}\n\nTry: git pull --rebase or check token scopes.`);
    }

    return ctx.scene.leave();
  }
);

module.exports = gitPushScene;
