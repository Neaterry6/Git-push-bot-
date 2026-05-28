const { Scenes } = require('telegraf');
const path = require('path');
const fs = require('fs-extra');
const exec = require('../utils/executor');
const workspace = require('../utils/workspace');
const { findLatestZip, getZipDocumentFromContext, listWorkspaceZips, saveTelegramZip, unzipFile } = require('../utils/fileHandler');
const accessControl = require('../utils/accessControl');
const { appendLog } = require('../utils/logs');

const GIT_AUTHOR_NAME = 'TelegramBot';
const GIT_AUTHOR_EMAIL = 'bot@telegram.com';
const INITIAL_COMMIT_MESSAGE = 'Initial commit from Telegram Bot';

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function sanitizeGitOutput(output, token) {
  if (!output) return '';
  return String(output).replaceAll(token, '[redacted-token]');
}

function normalizeRepoUrl(repoUrl) {
  const trimmed = String(repoUrl || '').trim();
  const match = trimmed.match(/^https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/);
  if (!match) return null;
  return `https://github.com/${match[1]}/${match[2]}.git`;
}

function buildAuthenticatedUrl(repoUrl, token) {
  return repoUrl.replace('https://', `https://x-access-token:${encodeURIComponent(token)}@`);
}

async function listDirectory(cwd) {
  const listing = await exec('find . -maxdepth 2 -not -path "./.git*" -print | sed "s#^./##" | sort | head -80', { cwd });
  return listing.stdout.trim() || '(empty)';
}

async function countCandidateFiles(cwd) {
  const result = await exec('find . -type f -not -path "./.git/*" | wc -l', { cwd });
  return Number.parseInt(result.stdout.trim(), 10) || 0;
}

async function getShortStatus(cwd) {
  const result = await exec('git status --short --untracked-files=all', { cwd });
  return result.stdout.trim();
}

async function hasStagedChanges(cwd) {
  try {
    await exec('git diff --cached --quiet', { cwd });
    return false;
  } catch (_error) {
    return true;
  }
}

async function hasCommit(cwd) {
  try {
    await exec('git rev-parse --verify HEAD', { cwd });
    return true;
  } catch (_error) {
    return false;
  }
}

async function getIgnoredFiles(cwd) {
  try {
    const ignored = await exec('git status --ignored --short', { cwd });
    return ignored.stdout
      .split('\n')
      .filter((line) => line.startsWith('!!'))
      .slice(0, 30)
      .join('\n');
  } catch (_error) {
    return '';
  }
}

async function prepareGitDirectory(ctx, userId, cwd) {
  await ctx.reply('🔍 Checking for the zip you sent or replied to...');
  let gitCwd = cwd;
  const repliedZip = getZipDocumentFromContext(ctx);

  if (repliedZip && !ctx.scene.state?.zipAlreadySaved) {
    const savedZip = await saveTelegramZip(ctx, cwd, repliedZip);
    await appendLog(userId, 'zip_saved', savedZip.name);
    await ctx.reply(`✅ Saved zip to workspace: ${savedZip.name}`);
  }

  const zipListing = await listWorkspaceZips(cwd);
  await ctx.reply(`📦 Workspace zip files (ls):

\`\`\`
${zipListing.slice(0, 3200)}
\`\`\``);

  const latestZip = await findLatestZip(cwd);

  if (latestZip) {
    await ctx.reply(`📦 Found ${latestZip.name}. Unzipping now...`);
    const extractedDir = path.join(cwd, 'extracted');
    await fs.remove(extractedDir);
    await unzipFile(latestZip.fullPath, extractedDir);
    gitCwd = extractedDir;
    await appendLog(userId, 'zip_unzipped', latestZip.name);
  }

  const fileCount = await countCandidateFiles(gitCwd);
  const listing = await listDirectory(gitCwd);
  const sourceLabel = latestZip ? 'ZIP contents' : 'workspace';

  await ctx.reply(`${latestZip ? '✅ ZIP extracted.' : 'ℹ️ No zip found.'} I will push your ${sourceLabel} from:
${gitCwd}

📂 Files found (${fileCount}):

\`\`\`
${listing.slice(0, 3200)}
\`\`\``);

  return { gitCwd, fileCount };
}

const gitPushScene = new Scenes.WizardScene(
  'gitPush',
  async (ctx) => {
    const userId = ctx.from.id;
    const cwd = workspace.getPath(userId);
    const { gitCwd, fileCount } = await prepareGitDirectory(ctx, userId, cwd);

    if (fileCount === 0) {
      await ctx.reply('❌ I found no files to push. Upload a project/zip or create files in your workspace first, then run /gitpush again. I will not create an empty commit.');
      return ctx.scene.leave();
    }

    ctx.wizard.state.gitCwd = gitCwd;
    await ctx.reply('📤 Send GitHub repo URL (example: https://github.com/user/repo.git)');
    return ctx.wizard.next();
  },
  async (ctx) => {
    const repoUrl = normalizeRepoUrl(ctx.message?.text);
    if (!repoUrl) {
      await ctx.reply('❌ Invalid GitHub repo URL. Please send a URL like https://github.com/user/repo.git');
      return;
    }

    ctx.wizard.state.repoUrl = repoUrl;
    await ctx.reply('🔑 Send your GitHub Personal Access Token');
    return ctx.wizard.next();
  },
  async (ctx) => {
    const token = (ctx.message?.text || '').trim();
    const repoUrl = ctx.wizard.state.repoUrl;
    const userId = ctx.from.id;
    const cwd = workspace.getPath(userId);

    if (!token) {
      await ctx.reply('❌ Token cannot be empty. Run /gitpush again when you have a valid token.');
      return ctx.scene.leave();
    }

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

    await ctx.reply('🚀 Preparing git push with safety checks...');
    await appendLog(userId, 'gitpush_start', `repo=${repoUrl}`);

    try {
      await ctx.reply('1/9 Initializing repository...');
      await exec('git init', { cwd: gitCwd });

      await ctx.reply('2/9 Configuring git author...');
      await exec(`git config user.name ${shellQuote(GIT_AUTHOR_NAME)}`, { cwd: gitCwd });
      await exec(`git config user.email ${shellQuote(GIT_AUTHOR_EMAIL)}`, { cwd: gitCwd });

      await ctx.reply('3/9 Switching to main branch...');
      await exec('git checkout -B main', { cwd: gitCwd });

      await ctx.reply('4/9 Staging all visible files...');
      await exec('git add -A', { cwd: gitCwd });
      const status = await getShortStatus(gitCwd);
      const ignoredFiles = await getIgnoredFiles(gitCwd);
      const staged = await hasStagedChanges(gitCwd);
      const existingCommit = await hasCommit(gitCwd);

      if (!status && !existingCommit) {
        const ignoredMessage = ignoredFiles ? `\n\nIgnored files detected:\n\`\`\`\n${ignoredFiles}\n\`\`\`` : '';
        await ctx.reply(`❌ No trackable files were staged, so I stopped instead of creating an empty commit.${ignoredMessage}\n\nCheck .gitignore or upload files, then run /gitpush again.`);
        return ctx.scene.leave();
      }

      if (status) {
        await ctx.reply(`🧾 Git status after staging:\n\n\`\`\`\n${status.slice(0, 3200)}\n\`\`\``);
      } else {
        await ctx.reply('ℹ️ No new local changes, but an existing commit is present and can be pushed.');
      }

      await ctx.reply('5/9 Creating commit when needed...');
      if (staged) {
        await exec(`git commit -m ${shellQuote(INITIAL_COMMIT_MESSAGE)}`, { cwd: gitCwd });
      } else {
        await ctx.reply('ℹ️ Skipping commit because there are no staged changes.');
      }

      const pushUrl = buildAuthenticatedUrl(repoUrl, token);

      await ctx.reply('6/9 Verifying remote repository...');
      await exec(`git ls-remote ${shellQuote(pushUrl)} HEAD`, { cwd: gitCwd });

      await ctx.reply('7/9 Configuring remote origin...');
      try {
        await exec(`git remote add origin ${shellQuote(pushUrl)}`, { cwd: gitCwd });
      } catch (_error) {
        await exec(`git remote set-url origin ${shellQuote(pushUrl)}`, { cwd: gitCwd });
      }

      await ctx.reply('8/9 Confirming branch and latest commit...');
      const commitInfo = await exec('git log -1 --stat --oneline', { cwd: gitCwd });
      await ctx.reply(`✅ Ready to push branch: main\n\n\`\`\`\n${commitInfo.stdout.slice(0, 2500)}\n\`\`\``);

      await ctx.reply('9/9 Pushing files to GitHub main branch...');
      try {
        await exec('git push -u origin main', { cwd: gitCwd });
      } catch (pushError) {
        const message = sanitizeGitOutput(pushError.message, token);
        await ctx.reply(`⚠️ Normal push failed. Retrying safely with --force-with-lease.\n\nReason:\n\`\`\`\n${message.slice(0, 1800)}\n\`\`\``);
        await exec('git push -u origin main --force-with-lease', { cwd: gitCwd });
      }
      await accessControl.incrementPush(userId);

      await appendLog(userId, 'gitpush_success', `repo=${repoUrl}`);
      await ctx.reply(`✅ Push Successful!\n\nRepo: ${repoUrl.replace('.git', '')}\nBranch: main\nFiles were committed and pushed. If GitHub still looks empty, refresh and make sure the branch dropdown is set to main.`);
    } catch (error) {
      const safeError = sanitizeGitOutput(error.stderr || error.message, token);
      await appendLog(userId, 'gitpush_failed', safeError);
      await ctx.reply('❌ Push failed:\n' + safeError + '\n\nChecks:\n1) PAT has repo scope/access\n2) Repo URL is exactly the repo you are viewing\n3) Files are not excluded by .gitignore\n4) Branch is main and branch protection allows this push.');
    }

    return ctx.scene.leave();
  }
);

module.exports = gitPushScene;
