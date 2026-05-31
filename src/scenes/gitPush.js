const { Scenes } = require('telegraf');
const path = require('path');
const fs = require('fs-extra');
const axios = require('axios');
const exec = require('../utils/executor');
const workspace = require('../utils/workspace');
const { findLatestZip, getZipDocumentFromContext, listWorkspaceZips, saveTelegramZip, unzipFile } = require('../utils/fileHandler');
const accessControl = require('../utils/accessControl');
const { appendLog } = require('../utils/logs');

const GIT_AUTHOR_NAME = 'TelegramBot';
const GIT_AUTHOR_EMAIL = 'bot@telegram.com';
const INITIAL_COMMIT_MESSAGE = 'Initial commit from Telegram Bot';

const SECRET_REDACTION_PLACEHOLDER = '[redacted-github-token]';
const GITHUB_TOKEN_PATTERNS = [
  /github_pat_[A-Za-z0-9_]{20,}/g,
  /\bgh[pousr]_[A-Za-z0-9_]{20,}\b/g,
];
const SKIP_SECRET_SCAN_DIRS = new Set(['.git', 'node_modules', 'vendor', 'dist', 'build', '.next']);
const MAX_SECRET_SCAN_FILE_BYTES = 1024 * 1024;

function looksBinary(buffer) {
  return buffer.includes(0);
}

async function redactGitHubTokensInWorkspace(cwd) {
  const redactedFiles = [];

  async function scanDirectory(directory) {
    const entries = await fs.readdir(directory, { withFileTypes: true });

    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (!SKIP_SECRET_SCAN_DIRS.has(entry.name)) {
          await scanDirectory(path.join(directory, entry.name));
        }
        continue;
      }

      if (!entry.isFile()) continue;

      const filePath = path.join(directory, entry.name);
      const stat = await fs.stat(filePath);
      if (stat.size > MAX_SECRET_SCAN_FILE_BYTES) continue;

      const buffer = await fs.readFile(filePath);
      if (looksBinary(buffer)) continue;

      const original = buffer.toString('utf8');
      let redacted = original;
      for (const pattern of GITHUB_TOKEN_PATTERNS) {
        redacted = redacted.replace(pattern, SECRET_REDACTION_PLACEHOLDER);
      }

      if (redacted !== original) {
        await fs.writeFile(filePath, redacted, 'utf8');
        redactedFiles.push(path.relative(cwd, filePath));
      }
    }
  }

  await scanDirectory(cwd);
  return redactedFiles;
}

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

function parseGitHubRepo(repoUrl) {
  const match = String(repoUrl || '').match(/^https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)\.git$/);
  if (!match) return null;
  return { owner: match[1], repo: match[2] };
}

function buildAuthenticatedUrl(repoUrl, token) {
  return repoUrl.replace('https://', `https://x-access-token:${encodeURIComponent(token)}@`);
}

function getGitErrorText(error, token) {
  return sanitizeGitOutput(error?.stderr || error?.message || error, token);
}

function isPushProtectionSecretError(output) {
  const text = String(output || '').toLowerCase();
  return text.includes('gh013')
    || text.includes('github push protection')
    || text.includes('push cannot contain secrets')
    || text.includes('repository rule violations') && text.includes('secret');
}

function isAuthOrTokenError(output) {
  if (isPushProtectionSecretError(output)) return false;

  const text = String(output || '').toLowerCase();
  return [
    'authentication failed',
    'bad credentials',
    'invalid username or token',
    'personal access token',
    'token expired',
    'expired token',
    'could not read username',
    'could not read password',
    'support for password authentication was removed',
    'password authentication is not supported',
    'permission denied',
    'http 401',
    'http 403',
    'github api 401',
    'github api 403',
  ].some((needle) => text.includes(needle));
}

function isRepoAccessError(output) {
  const text = String(output || '').toLowerCase();
  return text.includes('repository not found') || text.includes('github api 404: not found');
}

function isNonFastForwardError(output) {
  const text = String(output || '').toLowerCase();
  return text.includes('fetch first')
    || text.includes('non-fast-forward')
    || text.includes('failed to push some refs')
    || text.includes('updates were rejected');
}

function isBranchProtectionError(output) {
  const text = String(output || '').toLowerCase();
  return text.includes('protected branch')
    || text.includes('branch protection')
    || text.includes('gh006')
    || text.includes('cannot force-push')
    || text.includes('protected branch hook declined');
}

function isStaleLeaseError(output) {
  const text = String(output || '').toLowerCase();
  return text.includes('stale info') || text.includes('fetch first');
}

function buildGitFailureHelp(output) {
  const safeOutput = String(output || '');

  if (isPushProtectionSecretError(safeOutput)) {
    return 'GitHub blocked the push because a secret is still present in the commit history or files. Remove the token from the uploaded project, rotate/revoke that exposed token, then run /gitpush again. A newly generated token is still a secret and GitHub will block it if it is committed.';
  }

  if (isAuthOrTokenError(safeOutput)) {
    return 'Your GitHub token was rejected or may be expired/revoked. Please create a new Personal Access Token with repo access for this repository, then run /gitpush again.';
  }

  if (isRepoAccessError(safeOutput)) {
    return 'GitHub could not find the repository with this token. Check that the repo URL is exact and that your token owner has access to it.';
  }

  if (isStaleLeaseError(safeOutput)) {
    return 'The remote branch changed while I was pushing. Run /gitpush again so I can create a fresh pull request branch, or integrate the remote commits manually.';
  }

  if (isNonFastForwardError(safeOutput) || isBranchProtectionError(safeOutput)) {
    return 'The main branch could not be updated directly. I can push the upload to a new branch and open a pull request so the repo owner can review and merge it.';
  }

  return 'Checks:\n1) PAT is not expired/revoked and has repo scope/access\n2) Repo URL is exactly the repo you are viewing\n3) Files are not excluded by .gitignore\n4) Branch is main and branch protection allows this push.';
}

function buildPullRequestBranch(userId) {
  const timestamp = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
  return `telegram-bot-upload-${userId}-${timestamp}`;
}

function getGitHubApiErrorText(error) {
  const status = error?.response?.status;
  const message = error?.response?.data?.message || error?.message || 'GitHub API request failed';
  const errors = error?.response?.data?.errors;
  const details = Array.isArray(errors)
    ? errors.map((entry) => entry.message || entry.code).filter(Boolean).join('; ')
    : '';
  return [status ? `GitHub API ${status}` : null, message, details].filter(Boolean).join(': ');
}

async function createGitHubPullRequest(repoUrl, token, branchName) {
  const repoInfo = parseGitHubRepo(repoUrl);
  if (!repoInfo) {
    throw new Error('Could not parse GitHub repository URL for pull request creation.');
  }

  const response = await axios.post(
    `https://api.github.com/repos/${repoInfo.owner}/${repoInfo.repo}/pulls`,
    {
      title: INITIAL_COMMIT_MESSAGE,
      head: branchName,
      base: 'main',
      body: 'Automated upload from Telegram Bot. Please review and merge this pull request if the changes look correct.',
      maintainer_can_modify: true,
    },
    {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
    }
  );

  return response.data?.html_url;
}

async function overlayTreeOnRemoteMain(cwd, branchName, noChangeMessage) {
  const uploadTree = (await exec('git rev-parse HEAD^{tree}', { cwd })).stdout.trim();

  await exec('git fetch origin main', { cwd });
  await exec(`git checkout -B ${shellQuote(branchName)} origin/main`, { cwd });
  await exec(`git read-tree --reset -u ${shellQuote(uploadTree)}`, { cwd });

  if (!(await hasStagedChanges(cwd))) {
    throw new Error(noChangeMessage);
  }

  await exec(`git commit -m ${shellQuote(INITIAL_COMMIT_MESSAGE)}`, { cwd });
}

async function createPullRequestBranchFromUpload(cwd, branchName) {
  await overlayTreeOnRemoteMain(
    cwd,
    branchName,
    'The uploaded files already match the remote main branch, so there are no changes to open as a pull request.'
  );
}

async function syncMainWithRemoteBeforePush(cwd) {
  try {
    await overlayTreeOnRemoteMain(
      cwd,
      'main',
      'The uploaded files already match the remote main branch, so there is nothing new to push.'
    );
    return { synced: true, changed: true };
  } catch (error) {
    const message = String(error?.message || error);

    if (
      message.includes("couldn't find remote ref main")
      || message.includes("fatal: couldn't find remote ref main")
    ) {
      return { synced: false, changed: true, reason: 'remote main does not exist yet' };
    }

    if (message.includes('nothing new to push')) {
      return { synced: true, changed: false };
    }

    throw error;
  }
}

async function pushPullRequestBranch(ctx, cwd, repoUrl, token, userId, reason) {
  const branchName = buildPullRequestBranch(userId);
  await ctx.reply(`⚠️ Main branch push still failed, so I will push your upload to a new branch and open a pull request for you to review and merge.\n\nReason:\n\`\`\`\n${reason.slice(0, 1800)}\n\`\`\``);

  try {
    await createPullRequestBranchFromUpload(cwd, branchName);
    await exec(`git push -u origin ${shellQuote(branchName)}`, { cwd });
  } catch (branchPushError) {
    const branchPushMessage = getGitErrorText(branchPushError, token);
    throw new Error(branchPushMessage);
  }

  try {
    const pullRequestUrl = await createGitHubPullRequest(repoUrl, token, branchName);
    return { mode: 'pull_request', branchName, pullRequestUrl };
  } catch (pullRequestError) {
    const pullRequestMessage = sanitizeGitOutput(getGitHubApiErrorText(pullRequestError), token);
    throw new Error(`${pullRequestMessage}\n\nThe upload branch was pushed as ${branchName}, but I could not create the pull request. Your token may need Pull requests: Read and write permission, or an open pull request may already exist for this branch.`);
  }
}

async function pushMainOrCreatePullRequest(ctx, cwd, repoUrl, token, userId) {
  try {
    await exec('git push -u origin main', { cwd });
    return { mode: 'direct' };
  } catch (pushError) {
    const message = getGitErrorText(pushError, token);

    if (isPushProtectionSecretError(message) || isAuthOrTokenError(message) || isRepoAccessError(message)) {
      throw new Error(message);
    }

    if (!isNonFastForwardError(message) && !isBranchProtectionError(message)) {
      throw pushError;
    }

    await ctx.reply(`⚠️ Normal push to main failed. I will try a safer force push with lease once, then fall back to a pull request if GitHub still rejects it.\n\nReason:\n\`\`\`\n${message.slice(0, 1800)}\n\`\`\``);

    try {
      await exec('git push --force-with-lease -u origin main', { cwd });
      return { mode: 'force_direct' };
    } catch (forcePushError) {
      const forcePushMessage = getGitErrorText(forcePushError, token);

      if (isPushProtectionSecretError(forcePushMessage) || isAuthOrTokenError(forcePushMessage) || isRepoAccessError(forcePushMessage)) {
        throw new Error(forcePushMessage);
      }

      return pushPullRequestBranch(ctx, cwd, repoUrl, token, userId, forcePushMessage);
    }
  }
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
      await ctx.reply('1/11 Initializing clean repository metadata...');
      await fs.remove(path.join(gitCwd, '.git'));
      await exec('git init', { cwd: gitCwd });

      await ctx.reply('2/11 Configuring git author...');
      await exec(`git config user.name ${shellQuote(GIT_AUTHOR_NAME)}`, { cwd: gitCwd });
      await exec(`git config user.email ${shellQuote(GIT_AUTHOR_EMAIL)}`, { cwd: gitCwd });

      await ctx.reply('3/11 Switching to main branch...');
      await exec('git checkout -B main', { cwd: gitCwd });

      await ctx.reply('4/11 Scanning project files for committed GitHub tokens...');
      const redactedFiles = await redactGitHubTokensInWorkspace(gitCwd);
      if (redactedFiles.length) {
        await ctx.reply(`🧹 Removed committed GitHub token text from ${redactedFiles.length} file(s) before committing, because GitHub push protection blocks any PAT that is inside the repo. Rotate/revoke any token that was already pasted into project files.\n\nFiles changed:\n\`\`\`\n${redactedFiles.slice(0, 30).join('\n').slice(0, 2500)}\n\`\`\``);
      } else {
        await ctx.reply('✅ No committed GitHub token patterns found in project files.');
      }

      await ctx.reply('5/11 Staging all visible files...');
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

      await ctx.reply('6/11 Creating commit when needed...');
      if (staged) {
        await exec(`git commit -m ${shellQuote(INITIAL_COMMIT_MESSAGE)}`, { cwd: gitCwd });
      } else {
        await ctx.reply('ℹ️ Skipping commit because there are no staged changes.');
      }

      const pushUrl = buildAuthenticatedUrl(repoUrl, token);

      await ctx.reply('7/11 Verifying remote repository...');
      await exec(`git ls-remote ${shellQuote(pushUrl)} HEAD`, { cwd: gitCwd });

      await ctx.reply('8/11 Configuring remote origin...');
      try {
        await exec(`git remote add origin ${shellQuote(pushUrl)}`, { cwd: gitCwd });
      } catch (_error) {
        await exec(`git remote set-url origin ${shellQuote(pushUrl)}`, { cwd: gitCwd });
      }

      await ctx.reply('9/11 Syncing upload with the latest remote main branch...');
      const syncResult = await syncMainWithRemoteBeforePush(gitCwd);
      if (syncResult.synced && syncResult.changed) {
        await ctx.reply('✅ Remote main was fetched, and your upload was committed on top of the latest remote main before pushing.');
      } else if (syncResult.synced) {
        await ctx.reply('ℹ️ Your upload already matches remote main. I will still verify whether a push is needed.');
      } else {
        await ctx.reply(`ℹ️ Skipping remote sync because ${syncResult.reason}.`);
      }

      await ctx.reply('10/11 Confirming branch and latest commit...');
      const commitInfo = await exec('git log -1 --stat --oneline', { cwd: gitCwd });
      await ctx.reply(`✅ Ready to push branch: main\n\n\`\`\`\n${commitInfo.stdout.slice(0, 2500)}\n\`\`\``);

      await ctx.reply('11/11 Pushing files to GitHub main branch...');
      const pushResult = await pushMainOrCreatePullRequest(ctx, gitCwd, repoUrl, token, userId);
      await accessControl.incrementPush(userId);

      await appendLog(userId, 'gitpush_success', `repo=${repoUrl}`);
      if (pushResult.mode === 'pull_request') {
        await ctx.reply(`✅ Pull Request Created!\n\nRepo: ${repoUrl.replace('.git', '')}\nBranch: ${pushResult.branchName}\nPull Request: ${pushResult.pullRequestUrl}\n\nOpen the pull request link on GitHub, review the files, then merge it when you are ready.`);
      } else if (pushResult.mode === 'force_direct') {
        await ctx.reply(`✅ Force Push Successful!\n\nRepo: ${repoUrl.replace('.git', '')}\nBranch: main\nFiles were committed and pushed with --force-with-lease after the normal push failed. If GitHub still looks empty, refresh and make sure the branch dropdown is set to main.`);
      } else {
        await ctx.reply(`✅ Push Successful!\n\nRepo: ${repoUrl.replace('.git', '')}\nBranch: main\nFiles were committed and pushed. If GitHub still looks empty, refresh and make sure the branch dropdown is set to main.`);
      }
    } catch (error) {
      const safeError = getGitErrorText(error, token);
      const help = buildGitFailureHelp(safeError);
      await appendLog(userId, 'gitpush_failed', safeError);
      await ctx.reply(`❌ Push failed:\n${safeError}\n\n${help}`);
    }

    return ctx.scene.leave();
  }
);

module.exports = gitPushScene;
