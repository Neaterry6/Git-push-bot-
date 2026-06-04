const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const os = require('os');
const archiver = require('archiver');
const axios = require('axios');
const cheerio = require('cheerio');
const { chromium } = require('playwright');
const FormData = require('form-data');

const GOFILE_API = 'https://api.gofile.io';
const MAX_EXEC_ATTEMPTS = 3;

const tools = [
  {
    name: 'exec',
    description: 'Run a terminal command and return stdout/stderr. Automatically retries common install/disk/browser-download failures. Args: {command: string}',
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
    name: 'screenshot',
    description: 'Take a screenshot of a website with Playwright and return the saved image path. Args: {url: string, path?: string, fullPage?: boolean}',
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
    name: 'findAPIs',
    description: 'Find likely API/documentation endpoints on a website. Args: {url: string}',
    parameters: {
      type: 'object',
      properties: { url: { type: 'string' } },
      required: ['url']
    }
  },
  {
    name: 'zipAndUpload',
    description: 'Zip a folder/file. Upload to gofile.io and return direct download URL',
    parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] }
  },
  {
    name: 'createWorkTree',
    description: 'Create a full project structure with files and code. Args: {rootDir: string, files: [{path: string, content: string}]}',
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

function getInstallSafeEnv() {
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
    await execa(command, { shell: true, timeout: 120000, all: true, reject: false, env: getInstallSafeEnv() });
  }
}

async function execTool(command, sendFeedback) {
  const blocked = ['rm -rf /', 'dd ', 'mkfs', ':(){'];
  if (blocked.some((b) => command.includes(b))) throw new Error('Blocked command');

  const baseCommand = String(command || '').trim();
  if (!baseCommand) throw new Error('No command provided');

  let lastOutput = '';
  for (let attempt = 1; attempt <= MAX_EXEC_ATTEMPTS; attempt += 1) {
    const guardedCommand = isInstallCommand(baseCommand) ? appendInstallGuards(baseCommand) : baseCommand;
    if (sendFeedback) await sendFeedback(`Running${attempt > 1 ? ` retry ${attempt}/${MAX_EXEC_ATTEMPTS}` : ''}: ${guardedCommand}`);

    try {
      const output = await runCommand(guardedCommand, sendFeedback, getInstallSafeEnv());
      if (sendFeedback) await sendFeedback(`Done. Console output:\n${output.slice(0, 900)}`);
      return output;
    } catch (error) {
      lastOutput = error.message || String(error);
      if (sendFeedback) await sendFeedback(`Command failed. Console output:\n${lastOutput.slice(0, 900)}`);

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
        await sendFeedback(`Output:\n${output.slice(-700)}`).catch(() => {});
      }
    });
  }

  const result = await subprocess;
  return (output || result.all || result.stdout || result.stderr || 'Command executed').trim();
}

async function zipAndUpload(targetPath, sendFeedback) {
  const zipPath = path.join(os.tmpdir(), `${Date.now()}.zip`);
  const resolvedPath = path.resolve(targetPath);
  const stats = await fsp.stat(resolvedPath);

  if (sendFeedback) await sendFeedback(`Zipping ${targetPath}...`);

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

  if (sendFeedback) await sendFeedback('Uploading to gofile.io...');

  const serverRes = await axios.get(`${GOFILE_API}/servers`, { timeout: 60000 });
  const servers = serverRes.data?.data?.servers || serverRes.data?.servers || [];
  const server = servers[0]?.name;
  if (!server) throw new Error('No gofile.io upload server available');

  const form = new FormData();
  form.append('file', fs.createReadStream(zipPath), { filename: path.basename(zipPath) });

  const uploadRes = await axios.post(`https://${server}.gofile.io/uploadFile`, form, {
    headers: form.getHeaders(),
    maxBodyLength: Infinity,
    timeout: 120000
  });

  await fsp.unlink(zipPath).catch(() => {});

  const downloadUrl = uploadRes.data?.data?.downloadPage || uploadRes.data?.downloadPage;
  if (!downloadUrl) throw new Error(`gofile.io upload did not return a download URL: ${JSON.stringify(uploadRes.data).slice(0, 500)}`);
  if (sendFeedback) await sendFeedback(`Uploaded. Link: ${downloadUrl}`);

  return { type: 'url', url: downloadUrl };
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

async function webSearch(query, sendFeedback) {
  if (sendFeedback) await sendFeedback(`Searching web for: ${query}`);
  const { data } = await axios.get('https://duckduckgo.com/html/', {
    params: { q: query },
    timeout: 60000,
    headers: { 'User-Agent': 'Mozilla/5.0 TelegramBot/1.0' }
  });
  const $ = cheerio.load(data);
  const results = [];
  $('.result').slice(0, 8).each((_, el) => {
    const title = $(el).find('.result__title').text().replace(/\s+/g, ' ').trim();
    const url = $(el).find('.result__a').attr('href');
    const snippet = $(el).find('.result__snippet').text().replace(/\s+/g, ' ').trim();
    if (title || url || snippet) results.push({ title, url, snippet });
  });
  if (sendFeedback) await sendFeedback(`Search complete. Results: ${results.length}`);
  return results;
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

async function launchBrowser(sendFeedback) {
  const executablePath = findBrowserExecutable();
  const options = { headless: true };
  if (executablePath) {
    options.executablePath = executablePath;
    if (sendFeedback) await sendFeedback(`Using browser: ${executablePath}`);
  }
  return chromium.launch(options);
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
  const consoleOutput = await execTool(`node -e "const fs=require('fs');const data=JSON.parse(fs.readFileSync('${savedPath.replace(/'/g, "'\\''")}','utf8'));console.log('Scrape validation OK. Pages:', data.pages.length); console.log('Mode:', data.mode);"`, sendFeedback);
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

async function screenshot(url, outputPath, fullPage = true, sendFeedback) {
  const safeName = `${new URL(url).hostname.replace(/[^a-z0-9.-]/gi, '_')}-${Date.now()}.png`;
  const resolvedPath = path.resolve(outputPath || path.join(os.tmpdir(), safeName));
  await fsp.mkdir(path.dirname(resolvedPath), { recursive: true });
  if (sendFeedback) await sendFeedback(`Taking screenshot of ${url}...`);

  const browser = await launchBrowser(sendFeedback);
  try {
    const page = await browser.newPage({ viewport: { width: 1365, height: 768 } });
    const consoleLines = [];
    page.on('console', (message) => consoleLines.push(`${message.type()}: ${message.text()}`));
    await page.goto(url, { waitUntil: 'networkidle', timeout: 90000 });
    await page.screenshot({ path: resolvedPath, fullPage: Boolean(fullPage) });
    if (sendFeedback) await sendFeedback(`Screenshot saved: ${resolvedPath}`);
    return { path: resolvedPath, consoleOutput: consoleLines.slice(-50).join('\n') || 'No browser console messages.' };
  } finally {
    await browser.close();
  }
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

async function findAPIs(url, sendFeedback) {
  if (sendFeedback) await sendFeedback(`Finding APIs on ${url}...`);
  const { data } = await axios.get(url, {
    timeout: 60000,
    headers: { 'User-Agent': 'Mozilla/5.0 TelegramBot/1.0' }
  });
  const $ = cheerio.load(data);
  const candidates = new Set();
  const base = new URL(url);
  $('a[href], script[src], link[href]').each((_, el) => {
    const raw = $(el).attr('href') || $(el).attr('src');
    if (!raw) return;
    const absolute = new URL(raw, base).href;
    if (/api|swagger|openapi|graphql|developer|docs|reference/i.test(absolute)) candidates.add(absolute);
  });
  const common = ['/api', '/api/docs', '/swagger', '/swagger.json', '/openapi.json', '/graphql', '/docs', '/developers'];
  common.forEach((entry) => candidates.add(new URL(entry, base).href));
  const result = [...candidates].slice(0, 50);
  if (sendFeedback) await sendFeedback(`Found ${result.length} possible API/docs endpoints.`);
  return result;
}

module.exports = {
  tools,
  execTool,
  zipAndUpload,
  createWorkTree,
  webSearch,
  fetchUrl,
  scrapeSite,
  screenshot,
  findAPIs
};
