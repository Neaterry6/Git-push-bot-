const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const archiver = require('archiver');
const axios = require('axios');
const cheerio = require('cheerio');
const { chromium } = require('playwright');
const FormData = require('form-data');

const GOFILE_API = 'https://api.gofile.io';

const tools = [
  {
    name: 'exec',
    description: 'Run a terminal command and return stdout/stderr. Args: {command: string}',
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
    description: 'Scrape a website with Playwright and return page titles, links, and text. Args: {url: string, maxDepth?: number}',
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

async function execTool(command, sendFeedback) {
  const blocked = ['rm -rf', 'dd ', 'mkfs', ':(){'];
  if (blocked.some((b) => command.includes(b))) throw new Error('Blocked command');

  if (sendFeedback) await sendFeedback(`Running: ${command}`);

  const { execa } = await import('execa');
  const subprocess = execa(command, { shell: true, timeout: 60000, all: true });
  let output = '';
  let lastFeedback = 0;

  if (subprocess.all) {
    subprocess.all.on('data', async (chunk) => {
      output += chunk.toString();
      const now = Date.now();
      if (sendFeedback && now - lastFeedback > 1500) {
        lastFeedback = now;
        await sendFeedback(`Output: ${output.slice(-500)}`).catch(() => {});
      }
    });
  }

  try {
    const result = await subprocess;
    output = (output || result.all || result.stdout || result.stderr || 'Command executed').trim();
    if (sendFeedback) await sendFeedback(`Done. Output: ${output.slice(0, 500)}`);
    return output;
  } catch (error) {
    output = (output || error.all || error.stdout || error.stderr || error.message).trim();
    if (sendFeedback) await sendFeedback(`Command failed. Output: ${output.slice(0, 500)}`);
    throw new Error(output || error.message);
  }
}

async function zipAndUpload(targetPath, sendFeedback) {
  const zipPath = `/tmp/${Date.now()}.zip`;
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
  return `Created ${files.length} files in ${rootDir}`;
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
    responseType: 'text'
  });
  const text = typeof data === 'string' ? cheerio.load(data).text().replace(/\s+/g, ' ').trim() : JSON.stringify(data);
  if (sendFeedback) await sendFeedback(`Fetched ${url}. Characters: ${text.length}`);
  return text.slice(0, 12000);
}

async function scrapeSite(url, maxDepth = 1, sendFeedback) {
  if (sendFeedback) await sendFeedback(`Scraping ${url}...`);
  const browser = await chromium.launch({ headless: true });
  const seen = new Set();
  const pages = [];
  try {
    await scrapePage(browser, url, Number(maxDepth) || 1, seen, pages, sendFeedback);
  } finally {
    await browser.close();
  }
  if (sendFeedback) await sendFeedback(`Scrape complete. Pages: ${pages.length}`);
  return pages;
}

async function scrapePage(browser, url, depth, seen, pages, sendFeedback) {
  if (depth < 0 || seen.has(url) || seen.size >= 10) return;
  seen.add(url);
  if (sendFeedback) await sendFeedback(`Scraping page: ${url}`);
  const page = await browser.newPage();
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
    const title = await page.title();
    const text = (await page.locator('body').innerText({ timeout: 10000 }).catch(() => '')).replace(/\s+/g, ' ').trim();
    const links = await page.$$eval('a[href]', (anchors) => anchors.map((a) => a.href).filter(Boolean).slice(0, 50));
    pages.push({ url, title, text: text.slice(0, 6000), links });
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
  findAPIs
};
