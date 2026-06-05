const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const os = require('os');
const archiver = require('archiver');
const axios = require('axios');
const cheerio = require('cheerio');
const { chromium } = require('playwright');
const FormData = require('form-data');
const { unzipFile: extractZipFile } = require('./utils/fileHandler');

const GOFILE_UPLOAD_API = 'https://upload.gofile.io/uploadfile';
const GOFILE_TOKEN = process.env.GOFILE_TOKEN || process.env.GOFILE_ACCOUNT_TOKEN || '';
const SCREENSHOTONE_ACCESS_KEY = process.env.SCREENSHOTONE_ACCESS_KEY || '';
const OMEGA_AI_BASE_URL = process.env.OMEGA_AI_BASE_URL || 'https://omegatech-api.dixonomega.tech/api/ai';
const MAX_EXEC_ATTEMPTS = 3;
const DEFAULT_SCRAPING_SETTINGS = {
  retries: 3,
  timeout: 30000,
  stealthMode: true,
  proxyRotation: false,
  headless: true
};

const DEEP_SCRAPE_USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'
];


const tools = [
  {
    name: 'exec',
    description: 'Run a terminal command and return stdout/stderr. Automatically retries common install/disk/browser-download failures and may install missing task tools when safe. Args: {command: string}',
    parameters: {
      type: 'object',
      properties: { command: { type: 'string' } },
      required: ['command']
    }
  },
  {
    name: 'webSearch',
    description: 'Search the web and return concise results. Args: {query: string}',
    parameters: {
      type: 'object',
      properties: { query: { type: 'string' } },
      required: ['query']
    }
  },
  {
    name: 'fetchUrl',
    description: 'Fetch a URL and return text content. Args: {url: string}',
    parameters: {
      type: 'object',
      properties: { url: { type: 'string' } },
      required: ['url']
    }
  },
  {
    name: 'scrapeSite',
    description: 'Scrape a website, save scraped JSON in the workspace/tmp folder, and return page titles, links, text, savedPath, and console output from validation. Args: {url: string, maxDepth?: number}',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string' },
        maxDepth: { type: 'number' }
      },
      required: ['url']
    }
  },
  {
    name: 'deepScrape',
    description: 'Render a page with Playwright using realistic browser context, optional stealth hardening, retries, scrolling, and save full rendered HTML/text/link data as JSON. Use for JavaScript-heavy pages. Args: {url: string, retries?: number, timeout?: number, stealthMode?: boolean, headless?: boolean, proxyRotation?: boolean}',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string' },
        retries: { type: 'number' },
        timeout: { type: 'number' },
        stealthMode: { type: 'boolean' },
        headless: { type: 'boolean' },
        proxyRotation: { type: 'boolean' }
      },
      required: ['url']
    }
  },
  {
    name: 'consoleScreenshot',
    description: 'Send a screenshot image of this bot chat console/output transcript. Use this when the user asks for a screenshot of your own console, terminal, running task, or bot output. Args: {path?: string}',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string' } }
    }
  },
  {
    name: 'unzipFile',
    description: 'Extract a zip file into a workspace folder without pushing to GitHub. Use this for unzip/extract requests unless the user explicitly asks to push to GitHub. Args: {zipPath: string, destination?: string}',
    parameters: {
      type: 'object',
      properties: { zipPath: { type: 'string' }, destination: { type: 'string' } },
      required: ['zipPath']
    }
  },
  {
    name: 'screenshot',
    description: 'Take a full-page website screenshot with ScreenshotOne when configured, falling back to Playwright, and return an image path to send in chat. Args: {url: string, path?: string, fullPage?: boolean}',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string' },
        path: { type: 'string' },
        fullPage: { type: 'boolean' }
      },
      required: ['url']
    }
  },
  {
    name: 'generateImage',
    description: 'Generate AI images from a text prompt with the Raphael text-to-image API and return image URLs for chat delivery. Args: {prompt: string, aspect?: string, modelId?: string, numberOfImages?: number, highQuality?: boolean, fastMode?: boolean, isSafeContent?: boolean, autoTranslate?: boolean, negativePrompt?: string}',
    parameters: {
      type: 'object',
      properties: {
        prompt: { type: 'string' },
        aspect: { type: 'string' },
        modelId: { type: 'string' },
        numberOfImages: { type: 'number' },
        highQuality: { type: 'boolean' },
        fastMode: { type: 'boolean' },
        isSafeContent: { type: 'boolean' },
        autoTranslate: { type: 'boolean' },
        negativePrompt: { type: 'string' }
      },
      required: ['prompt']
    }
  },
  {
    name: 'findAPIs',
    description: 'Find likely API/documentation endpoints on a website, validate candidates with live HTTP requests, and return status/content-type samples. Args: {url: string}',
    parameters: {
      type: 'object',
      properties: { url: { type: 'string' } },
      required: ['url']
    }
  },
  {
    name: 'zipAndUpload',
    description: 'Zip a folder/file. Upload to gofile.io using the configured account token and return a public Gofile download page URL. Args: {path: string}',
    parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] }
  },
  {
    name: 'sendFile',
    description: 'Return an existing file path so the bot sends that file directly into chat. Use this whenever the user asks to send/download a file in chat. Args: {path: string}',
    parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] }
  },
  {
    name: 'createWorkTree',
    description: 'Create a complete project worktree with a thoughtful folder/file structure and full code/config content for every needed directory. Args: {rootDir: string, files: [{path: string, content: string}]}',
    parameters: {
      type: 'object',
      properties: {
        rootDir: { type: 'string' },
        files: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              path: { type: 'string' },
              content: { type: 'string' }
            },
            required: ['path', 'content']
          }
        }
      },
      required: ['rootDir', 'files']
    }
  }
];

function getInstallSafeEnv(command = '') {
  const cacheRoot = process.env.BOT_CACHE_DIR || path.join(os.tmpdir(), 'git-push-bot-cache');
  const env = {
    ...process.env,
    PUPPETEER_SKIP_DOWNLOAD: process.env.PUPPETEER_SKIP_DOWNLOAD || '1',
    PUPPETEER_SKIP_CHROMIUM_DOWNLOAD: process.env.PUPPETEER_SKIP_CHROMIUM_DOWNLOAD || '1',
    npm_config_cache: process.env.npm_config_cache || path.join(cacheRoot, 'npm'),
    YARN_CACHE_FOLDER: process.env.YARN_CACHE_FOLDER || path.join(cacheRoot, 'yarn'),
    PNPM_HOME: process.env.PNPM_HOME || path.join(cacheRoot, 'pnpm')
  };

  if (!/npx\s+playwright\s+install|playwright\s+install/i.test(command)) {
    env.PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD = process.env.PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD || '1';
  }

  return env;
}

function isInstallCommand(command) {
  return /(^|\s)(npm|pnpm|yarn|bun)\s+(i|install|add)\b/i.test(command) || /npx\s+playwright\s+install/i.test(command);
}

function looksLikeDiskFailure(output) {
  return /ENOSPC|no space left on device|insufficient disk|disk quota/i.test(output || '');
}

function appendInstallGuards(command) {
  if (/^\s*npm\s+(i|install)\b/i.test(command) && !/--ignore-scripts/.test(command)) {
    return `${command} --no-audit --no-fund`;
  }
  return command;
}

async function cleanInstallCaches(sendFeedback) {
  const { execa } = await import('execa');
  const cleanupCommands = [
    'npm cache clean --force',
    'rm -rf /tmp/git-push-bot-cache /tmp/ms-playwright /tmp/playwright-* ~/.cache/ms-playwright ~/.cache/puppeteer'
  ];
  for (const command of cleanupCommands) {
    if (sendFeedback) await sendFeedback(`Freeing disk space: ${command}`);
    await execa(command, { shell: true, timeout: 120000, all: true, reject: false, env: getInstallSafeEnv(command) });
  }
}


function findRedirectTargets(command) {
  const targets = [];
  const redirectPattern = /(?:^|\s)(?:>|>>)(?!&)(?:\s*)(["']?)([^"'\s;&|<>]+)\1/g;
  let match;
  while ((match = redirectPattern.exec(String(command || '')))) {
    const target = match[2];
    if (target && !/^(?:\/dev\/|&\d+$)/.test(target)) targets.push(target);
  }
  return targets;
}

async function ensureRedirectDirectories(command, sendFeedback) {
  const targets = findRedirectTargets(command);
  for (const target of targets) {
    const dir = path.dirname(path.resolve(target));
    if (dir && dir !== process.cwd()) {
      await fsp.mkdir(dir, { recursive: true });
      if (sendFeedback) await sendFeedback(`Ensured output directory exists: ${dir}`);
    }
  }
}

function looksLikeMissingRedirectDirectory(output) {
  return /cannot create .*Directory nonexistent|No such file or directory/i.test(output || '');
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

async function execTool(command, sendFeedback) {
  const blocked = ['rm -rf /', 'dd ', 'mkfs', ':(){'];
  if (blocked.some((b) => command.includes(b))) throw new Error('Blocked command');

  const baseCommand = String(command || '').trim();
  if (!baseCommand) throw new Error('No command provided');

  let lastOutput = '';
  for (let attempt = 1; attempt <= MAX_EXEC_ATTEMPTS; attempt += 1) {
    const guardedCommand = isInstallCommand(baseCommand) ? appendInstallGuards(baseCommand) : baseCommand;
    if (attempt > 1 && looksLikeMissingRedirectDirectory(lastOutput)) {
      await ensureRedirectDirectories(baseCommand, sendFeedback);
    }
    if (sendFeedback) await sendFeedback(`Running${attempt > 1 ? ` retry ${attempt}/${MAX_EXEC_ATTEMPTS}` : ''}: ${guardedCommand}`);

    try {
      const output = await runCommand(guardedCommand, sendFeedback, getInstallSafeEnv(guardedCommand));
      if (sendFeedback) await sendFeedback(`Done. Console output:\n${output.slice(0, 900)}`);
      return output;
    } catch (error) {
      lastOutput = error.message || String(error);
      if (sendFeedback) await sendFeedback(`Command failed. Console output:\n${lastOutput.slice(0, 900)}`);

      if (attempt < MAX_EXEC_ATTEMPTS && looksLikeMissingRedirectDirectory(lastOutput)) {
        await ensureRedirectDirectories(baseCommand, sendFeedback);
        continue;
      }

      if (attempt < MAX_EXEC_ATTEMPTS && (looksLikeDiskFailure(lastOutput) || isInstallCommand(baseCommand))) {
        await cleanInstallCaches(sendFeedback);
        continue;
      }
      break;
    }
  }

  throw new Error(lastOutput || 'Command failed');
}

async function runCommand(command, sendFeedback, env) {
  const { execa } = await import('execa');
  const subprocess = execa(command, { shell: true, timeout: 180000, all: true, env });
  let output = '';
  let lastFeedback = 0;

  if (subprocess.all) {
    subprocess.all.on('data', async (chunk) => {
      output += chunk.toString();
      const now = Date.now();
      if (sendFeedback && now - lastFeedback > 1500) {
        lastFeedback = now;
        await Promise.resolve(sendFeedback(`Output:\n${output.slice(-700)}`)).catch(() => {});
      }
    });
  }

  const result = await subprocess;
  return (output || result.all || result.stdout || result.stderr || 'Command executed').trim();
}

async function createZipArchive(targetPath, outputPath, sendFeedback) {
  const resolvedPath = path.resolve(targetPath);
  const stats = await fsp.stat(resolvedPath);
  const defaultName = `${path.basename(resolvedPath).replace(/[^a-z0-9._-]/gi, '_') || 'archive'}-${Date.now()}.zip`;
  const zipPath = path.resolve(outputPath || path.join(os.tmpdir(), defaultName));

  await fsp.mkdir(path.dirname(zipPath), { recursive: true });
  if (sendFeedback) await sendFeedback(`Zipping ${resolvedPath} to ${zipPath}...`);

  await new Promise((resolve, reject) => {
    const output = fs.createWriteStream(zipPath);
    const archive = archiver('zip', { zlib: { level: 9 } });
    output.on('close', resolve);
    archive.on('error', reject);
    archive.pipe(output);
    if (stats.isDirectory()) archive.directory(resolvedPath, false);
    else archive.file(resolvedPath, { name: path.basename(resolvedPath) });
    archive.finalize();
  });

  if (sendFeedback) await sendFeedback(`Zip ready: ${zipPath}`);
  return { path: zipPath, mimetype: 'application/zip', caption: `📦 Zip archive for ${path.basename(resolvedPath)}` };
}

async function zipAndUpload(targetPath, sendFeedback) {
  const zipResult = await createZipArchive(targetPath, null, sendFeedback);

  try {
    return await uploadFileToGofile(zipResult.path, sendFeedback);
  } finally {
    await fsp.unlink(zipResult.path).catch(() => {});
  }
}

async function uploadFileToGofile(filePath, sendFeedback) {
  if (sendFeedback) await sendFeedback('Uploading to gofile.io account...');

  const form = new FormData();
  form.append('file', fs.createReadStream(filePath), { filename: path.basename(filePath) });

  const headers = { ...form.getHeaders() };
  if (GOFILE_TOKEN) headers.Authorization = `Bearer ${GOFILE_TOKEN}`;

  const uploadRes = await axios.post(GOFILE_UPLOAD_API, form, {
    headers,
    maxBodyLength: Infinity,
    timeout: 180000,
    validateStatus: () => true
  });

  if (uploadRes.status >= 400 || uploadRes.data?.status === 'error') {
    throw new Error(`gofile.io upload failed (${uploadRes.status}): ${JSON.stringify(uploadRes.data).slice(0, 500)}`);
  }

  const data = uploadRes.data?.data || uploadRes.data || {};
  const downloadUrl = data.downloadPage || data.downloadUrl || data.link || (data.code ? `https://gofile.io/d/${data.code}` : '');
  if (!downloadUrl) throw new Error(`gofile.io upload did not return a download URL: ${JSON.stringify(uploadRes.data).slice(0, 500)}`);

  if (sendFeedback) await sendFeedback(`Uploaded. Link: ${downloadUrl}`);
  return {
    type: 'url',
    url: downloadUrl,
    fileId: data.fileId || '',
    folderId: data.parentFolder || data.folderId || '',
    accountUpload: Boolean(GOFILE_TOKEN)
  };
}

async function sendFile(filePath, sendFeedback) {
  const resolvedPath = path.resolve(filePath);
  const stats = await fsp.stat(resolvedPath);
  if (!stats.isFile()) throw new Error(`Not a file: ${filePath}`);
  if (sendFeedback) await sendFeedback(`Preparing file for chat: ${resolvedPath}`);
  return { path: resolvedPath };
}

async function createWorkTree(rootDir, files, sendFeedback) {
  if (sendFeedback) await sendFeedback(`Creating project structure in ${rootDir}...`);

  const root = path.resolve(rootDir);
  await fsp.mkdir(root, { recursive: true });

  for (const file of files) {
    if (!file.path || path.isAbsolute(file.path) || file.path.split(/[\\/]+/).includes('..')) {
      throw new Error(`Invalid worktree file path: ${file.path}`);
    }
    const fullPath = path.join(root, file.path);
    await fsp.mkdir(path.dirname(fullPath), { recursive: true });
    await fsp.writeFile(fullPath, file.content, 'utf-8');
    if (sendFeedback) await sendFeedback(`Wrote: ${file.path}`);
  }

  if (sendFeedback) await sendFeedback(`Project created. Total files: ${files.length}`);
  return { rootDir: root, fileCount: files.length, files: files.map((file) => file.path) };
}

function normalizeSearchResultUrl(rawUrl) {
  if (!rawUrl) return '';
  try {
    const parsed = new URL(rawUrl, 'https://duckduckgo.com');
    const redirected = parsed.searchParams.get('uddg') || parsed.searchParams.get('u');
    return redirected ? decodeURIComponent(redirected) : parsed.href;
  } catch (_error) {
    return rawUrl;
  }
}

function collectSearchResults(html, selectors) {
  const $ = cheerio.load(html);
  const results = [];
  $(selectors.container).each((_, el) => {
    const title = $(el).find(selectors.title).first().text().replace(/\s+/g, ' ').trim();
    const rawUrl = $(el).find(selectors.link).first().attr('href');
    const snippet = $(el).find(selectors.snippet).first().text().replace(/\s+/g, ' ').trim();
    const url = normalizeSearchResultUrl(rawUrl);
    if ((title || snippet) && url && !results.some((item) => item.url === url)) {
      results.push({ title, url, snippet });
    }
  });
  return results;
}

async function fetchSearchProvider(provider, query) {
  const headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36',
    Accept: 'text/html,application/xhtml+xml'
  };

  if (provider === 'duckduckgo-html') {
    const { data } = await axios.get('https://duckduckgo.com/html/', { params: { q: query }, timeout: 60000, headers });
    return collectSearchResults(data, {
      container: '.result',
      title: '.result__title',
      link: '.result__a',
      snippet: '.result__snippet'
    });
  }

  if (provider === 'duckduckgo-lite') {
    const { data } = await axios.get('https://lite.duckduckgo.com/lite/', { params: { q: query }, timeout: 60000, headers });
    return collectSearchResults(data, {
      container: 'tr',
      title: 'a.result-link, a[href]',
      link: 'a.result-link, a[href]',
      snippet: '.result-snippet, td:last-child'
    });
  }

  const { data } = await axios.get('https://www.bing.com/search', { params: { q: query }, timeout: 60000, headers });
  return collectSearchResults(data, {
    container: 'li.b_algo',
    title: 'h2',
    link: 'h2 a',
    snippet: '.b_caption p, p'
  });
}

async function webSearch(query, sendFeedback) {
  if (sendFeedback) await sendFeedback(`Searching web for: ${query}`);
  const providers = ['duckduckgo-html', 'duckduckgo-lite', 'bing'];
  const errors = [];

  for (const provider of providers) {
    try {
      const results = (await fetchSearchProvider(provider, query)).slice(0, 8);
      if (results.length) {
        if (sendFeedback) await sendFeedback(`Search complete using ${provider}. Results: ${results.length}`);
        return results;
      }
      errors.push(`${provider}: no results parsed`);
    } catch (error) {
      errors.push(`${provider}: ${error.message}`);
    }
  }

  throw new Error(`Search failed. ${errors.join(' | ')}`);
}

async function fetchUrl(url, sendFeedback) {
  if (sendFeedback) await sendFeedback(`Fetching ${url}...`);
  const { data } = await axios.get(url, {
    timeout: 60000,
    headers: { 'User-Agent': 'Mozilla/5.0 TelegramBot/1.0' },
    responseType: 'text',
    validateStatus: () => true
  });
  const text = typeof data === 'string' ? cheerio.load(data).text().replace(/\s+/g, ' ').trim() : JSON.stringify(data);
  if (sendFeedback) await sendFeedback(`Fetched ${url}. Characters: ${text.length}`);
  return text.slice(0, 12000);
}

function findBrowserExecutable() {
  const candidates = [
    process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
    process.env.CHROME_BIN,
    '/usr/bin/google-chrome-stable',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium-browser',
    '/usr/bin/chromium'
  ].filter(Boolean);
  return candidates.find((candidate) => fs.existsSync(candidate));
}

function getPlaywrightExecutablePath() {
  try {
    return chromium.executablePath();
  } catch (_error) {
    return '';
  }
}

async function ensurePlaywrightChromium(sendFeedback) {
  const executablePath = getPlaywrightExecutablePath();
  if (executablePath && fs.existsSync(executablePath)) return executablePath;

  if (sendFeedback) await sendFeedback('Playwright Chromium is missing. Installing browser runtime with: npx playwright install chromium');
  try {
    await runCommand('npx playwright install chromium', sendFeedback, getInstallSafeEnv('npx playwright install chromium'));
  } catch (error) {
    if (sendFeedback) await sendFeedback(`Playwright browser install failed (${error.message.slice(0, 180)}). I will try any system Chrome/Chromium fallback.`);
  }

  const installedPath = getPlaywrightExecutablePath();
  return installedPath && fs.existsSync(installedPath) ? installedPath : '';
}

async function launchBrowser(sendFeedback, launchOptions = {}) {
  const executablePath = findBrowserExecutable();
  const options = {
    headless: launchOptions.headless !== undefined ? Boolean(launchOptions.headless) : true,
    args: launchOptions.args || []
  };
  if (launchOptions.proxy) options.proxy = launchOptions.proxy;
  if (executablePath) {
    options.executablePath = executablePath;
    if (sendFeedback) await sendFeedback(`Using browser: ${executablePath}`);
    return chromium.launch(options);
  }

  await ensurePlaywrightChromium(sendFeedback);
  return chromium.launch(options);
}

function buildScrapeSettings(options = {}) {
  const retries = Number(options.retries ?? DEFAULT_SCRAPING_SETTINGS.retries);
  const timeout = Number(options.timeout ?? DEFAULT_SCRAPING_SETTINGS.timeout);
  return {
    retries: Number.isFinite(retries) && retries > 0 ? Math.min(Math.floor(retries), 5) : DEFAULT_SCRAPING_SETTINGS.retries,
    timeout: Number.isFinite(timeout) && timeout > 0 ? Math.min(Math.floor(timeout), 120000) : DEFAULT_SCRAPING_SETTINGS.timeout,
    stealthMode: options.stealthMode !== undefined ? Boolean(options.stealthMode) : DEFAULT_SCRAPING_SETTINGS.stealthMode,
    headless: options.headless !== undefined ? Boolean(options.headless) : DEFAULT_SCRAPING_SETTINGS.headless,
    proxyRotation: Boolean(options.proxyRotation ?? DEFAULT_SCRAPING_SETTINGS.proxyRotation)
  };
}

function randomFrom(items) {
  return items[Math.floor(Math.random() * items.length)];
}

function getProxySettings(settings) {
  if (!settings.proxyRotation) return undefined;
  const proxyUrl = process.env.SCRAPE_PROXY_URL || process.env.HTTPS_PROXY || process.env.HTTP_PROXY;
  return proxyUrl ? { server: proxyUrl } : undefined;
}

async function applyStealthContext(context) {
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
    Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
    Object.defineProperty(navigator, 'hardwareConcurrency', { get: () => 8 });
    window.chrome = window.chrome || { runtime: {} };
    const originalQuery = window.navigator.permissions && window.navigator.permissions.query;
    if (originalQuery) {
      window.navigator.permissions.query = (parameters) => (
        parameters && parameters.name === 'notifications'
          ? Promise.resolve({ state: Notification.permission })
          : originalQuery(parameters)
      );
    }
  });
}

async function createScrapeContext(browser, settings) {
  const context = await browser.newContext({
    userAgent: randomFrom(DEEP_SCRAPE_USER_AGENTS),
    viewport: { width: 1920, height: 1080 },
    locale: 'en-US',
    timezoneId: 'America/New_York',
    deviceScaleFactor: 1,
    javaScriptEnabled: true,
    ignoreHTTPSErrors: true,
    extraHTTPHeaders: {
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9',
      'Upgrade-Insecure-Requests': '1'
    }
  });
  if (settings.stealthMode) await applyStealthContext(context);
  return context;
}

async function simulateHumanActivity(page) {
  await page.mouse.move(250 + Math.random() * 200, 250 + Math.random() * 200);
  await page.mouse.wheel(0, 400 + Math.floor(Math.random() * 400));
  await page.waitForTimeout(800 + Math.floor(Math.random() * 1200));
}

async function deepScrape(url, options = {}, sendFeedback) {
  const normalizedUrl = normalizeUrl(url);
  const settings = buildScrapeSettings(options);
  const launchArgs = [
    '--disable-blink-features=AutomationControlled',
    '--disable-dev-shm-usage',
    '--no-sandbox'
  ];
  const proxy = getProxySettings(settings);
  let lastError;

  for (let attempt = 1; attempt <= settings.retries; attempt += 1) {
    if (sendFeedback) await sendFeedback(`Deep scraping ${normalizedUrl} (attempt ${attempt}/${settings.retries})...`);
    let browser;
    let context;
    let page;
    const consoleLines = [];

    try {
      browser = await launchBrowser(sendFeedback, { headless: settings.headless, args: launchArgs, proxy });
      context = await createScrapeContext(browser, settings);
      page = await context.newPage();
      const apiResponses = [];
      page.on('console', (message) => consoleLines.push(`${message.type()}: ${message.text()}`));
      page.on('response', (responseItem) => {
        const request = responseItem.request();
        const responseUrl = responseItem.url();
        const resourceType = request.resourceType();
        if (!/^(xhr|fetch)$/i.test(resourceType) && !/api|graphql|\.json(?:$|[?#])/i.test(responseUrl)) return;
        if (apiResponses.some((item) => item.url === responseUrl && item.method === request.method())) return;
        apiResponses.push({
          url: responseUrl,
          method: request.method(),
          status: responseItem.status(),
          contentType: responseItem.headers()['content-type'] || '',
          resourceType
        });
      });
      const response = await page.goto(normalizedUrl, { waitUntil: 'networkidle', timeout: settings.timeout });
      await simulateHumanActivity(page);
      const title = await page.title();
      const content = await page.content();
      const text = (await page.locator('body').innerText({ timeout: 10000 }).catch(() => '')).replace(/\s+/g, ' ').trim();
      const links = await page.$$eval('a[href]', (anchors) => anchors.map((a) => a.href).filter(Boolean).slice(0, 100));
      const status = response ? response.status() : null;
      const screenshotPath = path.join(os.tmpdir(), `${new URL(normalizedUrl).hostname.replace(/[^a-z0-9.-]/gi, '_')}-deep-${Date.now()}.png`);
      await page.screenshot({ path: screenshotPath, fullPage: true }).catch(() => null);
      const pages = [{
        url: normalizedUrl,
        title,
        status,
        text: text.slice(0, 12000),
        links,
        html: content,
        apiResponses: apiResponses.slice(0, 100),
        consoleOutput: consoleLines.slice(-50).join('\n')
      }];
      const savedPath = await saveScrapeResult(normalizedUrl, pages, 'deep-playwright');
      const consoleOutput = await validateScrapeResult(savedPath, sendFeedback);
      if (sendFeedback) await sendFeedback(`Deep scrape complete. Title: ${title || '(untitled)'}. Saved: ${savedPath}`);
      return {
        mode: 'deep-playwright',
        savedPath,
        consoleOutput,
        title,
        status,
        contentLength: content.length,
        screenshotPath: fs.existsSync(screenshotPath) ? screenshotPath : '',
        screenshotCaption: `🖼️ Deep scrape screenshot for ${normalizedUrl}`,
        apiResponses: apiResponses.slice(0, 100),
        text: text.slice(0, 6000),
        links
      };
    } catch (error) {
      lastError = error;
      if (sendFeedback) await sendFeedback(`Deep scrape attempt ${attempt} failed: ${error.message.slice(0, 180)}`);
      if (attempt < settings.retries) await new Promise((resolve) => setTimeout(resolve, 1000 * attempt));
    } finally {
      if (page) await page.close().catch(() => {});
      if (context) await context.close().catch(() => {});
      if (browser) await browser.close().catch(() => {});
    }
  }

  if (sendFeedback) await sendFeedback(`Deep scrape failed (${lastError.message.slice(0, 180)}). Trying HTTP fallback...`);
  const text = await fetchUrl(normalizedUrl, sendFeedback);
  const pages = [{ url: normalizedUrl, title: '', status: null, text, links: [], html: '' }];
  const savedPath = await saveScrapeResult(normalizedUrl, pages, 'http-fallback');
  const consoleOutput = await validateScrapeResult(savedPath, sendFeedback);
  return { mode: 'http-fallback', savedPath, consoleOutput, text, links: [] };
}

async function scrapeSite(url, maxDepth = 1, sendFeedback) {
  if (sendFeedback) await sendFeedback(`Scraping ${url}...`);
  const seen = new Set();
  const pages = [];
  let mode = 'playwright';

  try {
    const browser = await launchBrowser(sendFeedback);
    try {
      await scrapePage(browser, url, Number(maxDepth) || 1, seen, pages, sendFeedback);
    } finally {
      await browser.close();
    }
  } catch (error) {
    mode = 'http-fallback';
    if (sendFeedback) await sendFeedback(`Browser scrape failed (${error.message.slice(0, 180)}). Trying HTTP fallback...`);
    const text = await fetchUrl(url, sendFeedback);
    pages.push({ url, title: '', text, links: [] });
  }

  const savedPath = await saveScrapeResult(url, pages, mode);
  const consoleOutput = await validateScrapeResult(savedPath, sendFeedback);
  if (sendFeedback) await sendFeedback(`Scrape complete. Pages: ${pages.length}. Saved: ${savedPath}`);
  return { mode, savedPath, consoleOutput, pages };
}

async function saveScrapeResult(url, pages, mode) {
  const dir = path.join(os.tmpdir(), 'git-push-bot-scrapes');
  await fsp.mkdir(dir, { recursive: true });
  const hostname = new URL(url).hostname.replace(/[^a-z0-9.-]/gi, '_');
  const savedPath = path.join(dir, `${hostname}-${Date.now()}.json`);
  await fsp.writeFile(savedPath, JSON.stringify({ url, mode, pages }, null, 2));
  return savedPath;
}

async function validateScrapeResult(savedPath, sendFeedback) {
  const script = `const fs=require('fs');const data=JSON.parse(fs.readFileSync(${JSON.stringify(savedPath)},'utf8'));console.log('Scrape validation OK. Pages:', data.pages.length); console.log('Mode:', data.mode);`;
  return execTool(`node -e ${shellQuote(script)}`, sendFeedback);
}

async function screenshot(url, outputPath, fullPage = true, sendFeedback) {
  const normalizedUrl = normalizeUrl(url);
  const safeName = `${new URL(normalizedUrl).hostname.replace(/[^a-z0-9.-]/gi, '_')}-${Date.now()}.jpg`;
  const resolvedPath = path.resolve(outputPath || path.join(os.tmpdir(), safeName));
  await fsp.mkdir(path.dirname(resolvedPath), { recursive: true });

  if (SCREENSHOTONE_ACCESS_KEY) {
    try {
      if (sendFeedback) await sendFeedback(`Taking full-page ScreenshotOne capture of ${normalizedUrl}...`);
      const response = await axios.get('https://api.screenshotone.com/take', {
        params: {
          access_key: SCREENSHOTONE_ACCESS_KEY,
          url: normalizedUrl,
          format: 'jpg',
          full_page: Boolean(fullPage),
          block_ads: true,
          block_cookie_banners: true,
          block_trackers: true,
          image_quality: 80,
          response_type: 'by_format'
        },
        responseType: 'arraybuffer',
        timeout: 60000,
        validateStatus: () => true
      });

      if (response.status >= 400) {
        throw new Error(`ScreenshotOne returned HTTP ${response.status}`);
      }

      await fsp.writeFile(resolvedPath, Buffer.from(response.data));
      if (sendFeedback) await sendFeedback(`Screenshot saved: ${resolvedPath}`);
      return { path: resolvedPath, mimetype: 'image/jpeg', caption: `🖼️ Full-page screenshot of:\n${normalizedUrl}` };
    } catch (error) {
      if (sendFeedback) await sendFeedback(`ScreenshotOne failed (${error.message.slice(0, 180)}). Trying local browser fallback...`);
    }
  }

  const pngPath = resolvedPath.replace(/\.jpe?g$/i, '.png');
  if (sendFeedback) await sendFeedback(`Taking local browser screenshot of ${normalizedUrl}...`);
  const browser = await launchBrowser(sendFeedback);
  try {
    const page = await browser.newPage({ viewport: { width: 1365, height: 768 } });
    const consoleLines = [];
    page.on('console', (message) => consoleLines.push(`${message.type()}: ${message.text()}`));
    await page.goto(normalizedUrl, { waitUntil: 'networkidle', timeout: 90000 });
    await page.screenshot({ path: pngPath, fullPage: Boolean(fullPage) });
    if (sendFeedback) await sendFeedback(`Screenshot saved: ${pngPath}`);
    return {
      path: pngPath,
      mimetype: 'image/png',
      caption: `🖼️ Screenshot of:\n${normalizedUrl}`,
      consoleOutput: consoleLines.slice(-50).join('\n') || 'No browser console messages.'
    };
  } finally {
    await browser.close();
  }
}

function normalizeUrl(url) {
  const trimmed = String(url || '').trim();
  if (!trimmed) throw new Error('URL is required');
  return /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
}

async function scrapePage(browser, url, depth, seen, pages, sendFeedback) {
  if (depth < 0 || seen.has(url) || seen.size >= 10) return;
  seen.add(url);
  if (sendFeedback) await sendFeedback(`Scraping page: ${url}`);
  const page = await browser.newPage();
  const consoleLines = [];
  page.on('console', (message) => consoleLines.push(`${message.type()}: ${message.text()}`));
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
    const title = await page.title();
    const text = (await page.locator('body').innerText({ timeout: 10000 }).catch(() => '')).replace(/\s+/g, ' ').trim();
    const links = await page.$$eval('a[href]', (anchors) => anchors.map((a) => a.href).filter(Boolean).slice(0, 50));
    pages.push({ url, title, text: text.slice(0, 6000), links, consoleOutput: consoleLines.slice(-30).join('\n') });
    if (depth > 1) {
      const origin = new URL(url).origin;
      for (const link of links.filter((l) => l.startsWith(origin)).slice(0, 3)) {
        await scrapePage(browser, link, depth - 1, seen, pages, sendFeedback);
      }
    }
  } finally {
    await page.close();
  }
}

async function generateImage(options = {}, sendFeedback) {
  const prompt = String(options.prompt || '').trim();
  if (!prompt) throw new Error('Image prompt is required');
  const numberOfImages = Math.min(Math.max(Number(options.numberOfImages || 4), 1), 8);
  const params = {
    prompt,
    aspect: options.aspect || '1:1',
    model_id: options.modelId || options.model_id || 'raphael-basic',
    number_of_images: numberOfImages,
    highQuality: options.highQuality !== undefined ? Boolean(options.highQuality) : true,
    fastMode: options.fastMode !== undefined ? Boolean(options.fastMode) : true,
    isSafeContent: options.isSafeContent !== undefined ? Boolean(options.isSafeContent) : false,
    autoTranslate: options.autoTranslate !== undefined ? Boolean(options.autoTranslate) : true
  };
  if (options.negativePrompt) params.negativePrompt = options.negativePrompt;

  if (sendFeedback) await sendFeedback(`Generating ${numberOfImages} image(s): ${prompt}`);
  const response = await axios.get(`${OMEGA_AI_BASE_URL}/Raphael-text-to-image`, {
    params,
    timeout: 180000,
    validateStatus: () => true
  });

  const { data, status } = response;
  if (status >= 400 || data?.statusCode >= 400 || data?.success === false) {
    throw new Error(`Image generation failed (${status}): ${JSON.stringify(data).slice(0, 500)}`);
  }

  const images = Array.isArray(data?.images) ? data.images.filter((image) => image?.url) : [];
  if (!images.length) throw new Error(`Image generation returned no images: ${JSON.stringify(data).slice(0, 500)}`);
  if (sendFeedback) await sendFeedback(`Generated ${images.length} image(s).`);
  return {
    type: 'images',
    prompt: data.prompt || prompt,
    model: data.model || params.model_id,
    aspect: data.aspect || params.aspect,
    images,
    raw: data
  };
}

async function validateApiEndpoint(candidate, baseUrl) {
  const target = typeof candidate === 'string' ? candidate : candidate.url;
  try {
    const response = await axios.get(target, {
      timeout: 15000,
      maxRedirects: 3,
      headers: {
        Accept: 'application/json,text/plain,*/*',
        Referer: baseUrl,
        'User-Agent': 'Mozilla/5.0 TelegramBot/1.0'
      },
      validateStatus: () => true
    });
    const data = typeof response.data === 'string' ? response.data : JSON.stringify(response.data);
    return {
      url: target,
      method: 'GET',
      status: response.status,
      ok: response.status >= 200 && response.status < 400,
      contentType: response.headers['content-type'] || '',
      sample: String(data || '').replace(/\s+/g, ' ').slice(0, 500)
    };
  } catch (error) {
    return {
      url: target,
      method: 'GET',
      status: null,
      ok: false,
      contentType: '',
      error: error.message
    };
  }
}

async function findAPIs(url, sendFeedback) {
  const normalizedUrl = normalizeUrl(url);
  if (sendFeedback) await sendFeedback(`Finding and validating APIs on ${normalizedUrl}...`);
  const { data } = await axios.get(normalizedUrl, {
    timeout: 60000,
    headers: { 'User-Agent': 'Mozilla/5.0 TelegramBot/1.0' },
    validateStatus: () => true
  });
  const $ = cheerio.load(data);
  const candidates = new Set();
  const base = new URL(normalizedUrl);
  $('a[href], script[src], link[href], form[action]').each((_, el) => {
    const raw = $(el).attr('href') || $(el).attr('src') || $(el).attr('action');
    if (!raw) return;
    const absolute = new URL(raw, base).href;
    if (/api|swagger|openapi|graphql|developer|docs|reference|\.json(?:$|[?#])/i.test(absolute)) candidates.add(absolute);
  });
  const inlineMatches = String(data).match(/(?:(?:https?:)?\/\/[^"'\s<>]+|\/[^"'\s<>]+)(?:api|graphql|openapi|swagger|\.json)[^"'\s<>]*/gi) || [];
  inlineMatches.forEach((entry) => candidates.add(new URL(entry, base).href));
  const common = ['/api', '/api/docs', '/api/v1', '/api/v2', '/swagger', '/swagger.json', '/openapi.json', '/graphql', '/docs', '/developers'];
  common.forEach((entry) => candidates.add(new URL(entry, base).href));

  const candidateList = [...candidates].slice(0, 50);
  const validated = [];
  for (const candidate of candidateList.slice(0, 20)) {
    validated.push(await validateApiEndpoint(candidate, normalizedUrl));
  }

  const live = validated.filter((item) => item.ok);
  if (sendFeedback) await sendFeedback(`Found ${candidateList.length} possible API/docs endpoints. Live/valid responses: ${live.length}.`);
  return { url: normalizedUrl, candidates: candidateList, validated, live };
}


async function unzipFileTool(zipPath, destination, sendFeedback) {
  const resolvedZip = path.resolve(zipPath);
  const stats = await fsp.stat(resolvedZip);
  if (!stats.isFile()) throw new Error(`Not a file: ${zipPath}`);
  const resolvedDestination = path.resolve(destination || path.join(path.dirname(resolvedZip), path.basename(resolvedZip, path.extname(resolvedZip))));
  if (sendFeedback) await sendFeedback(`Extracting ${resolvedZip} to ${resolvedDestination} without pushing to GitHub...`);
  const result = await extractZipFile(resolvedZip, resolvedDestination);
  if (sendFeedback) await sendFeedback(`Extracted zip. Destination: ${resolvedDestination}`);
  return { destination: resolvedDestination, strippedRoot: result.strippedRoot || null, pushedToGitHub: false };
}

module.exports = {
  tools,
  execTool,
  zipAndUpload,
  uploadFileToGofile,
  createZipArchive,
  sendFile,
  createWorkTree,
  unzipFileTool,
  webSearch,
  fetchUrl,
  scrapeSite,
  deepScrape,
  screenshot,
  findAPIs,
  generateImage
};
