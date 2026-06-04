const { exec } = require('child_process');
const os = require('os');
const path = require('path');

function getSafeEnv() {
  const cacheRoot = process.env.BOT_CACHE_DIR || path.join(os.tmpdir(), 'git-push-bot-cache');
  return {
    ...process.env,
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: process.env.PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD || '1',
    PUPPETEER_SKIP_DOWNLOAD: process.env.PUPPETEER_SKIP_DOWNLOAD || '1',
    PUPPETEER_SKIP_CHROMIUM_DOWNLOAD: process.env.PUPPETEER_SKIP_CHROMIUM_DOWNLOAD || '1',
    npm_config_cache: process.env.npm_config_cache || path.join(cacheRoot, 'npm'),
    YARN_CACHE_FOLDER: process.env.YARN_CACHE_FOLDER || path.join(cacheRoot, 'yarn'),
    PNPM_HOME: process.env.PNPM_HOME || path.join(cacheRoot, 'pnpm')
  };
}

module.exports = function run(command, options = {}) {
  return new Promise((resolve, reject) => {
    exec(command, { ...options, env: { ...getSafeEnv(), ...(options.env || {}) }, timeout: 180000, maxBuffer: 1024 * 1024 * 10 }, (error, stdout, stderr) => {
      if (error) {
        return reject(new Error(stderr || stdout || error.message));
      }
      resolve({ stdout, stderr });
    });
  });
};
