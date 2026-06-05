# Git-push-bot-

Telegram bot for shell/file operations, zip workflows, simple Git helpers, and a three-model AI chain (Groq -> Claude Pro -> Gemini).

## Fix for Pterodactyl crash (`Cannot find module './index.js'`)

If your startup command points to `index.js` (or uses `ts-node index.js`), the server will crash when that file does not exist.

This repository now includes a root `index.js` entrypoint that starts the bot by loading `src/bot.js`.

## Run

```bash
npm install
npm start
```

`npm start` runs the root launcher:

```bash
node bot.js
```

You can also run via the new root entrypoint:

```bash
node index.js
```

## Commands

- `/help` - show bot help.
- `/gitpush` - push the current workspace or latest uploaded zip to GitHub `main`. If you reply to a zip with `/gitpush`, the bot downloads that replied zip into your workspace, immediately lists saved zips, extracts the newest zip, removes a single top-level wrapper folder such as `repo-main` so the project is pushed to the repository root, asks for the GitHub repo URL, then asks for your token. The bot refuses empty commits, resets uploaded Git metadata, redacts committed GitHub Personal Access Tokens before committing to avoid push-protection blocks, reports ignored/untracked files, tries `--force-with-lease` if a normal main push is rejected, and falls back to opening a pull request when direct pushes still cannot update `main`.
- `/run <command>` - run a shell command in your workspace.
- `/play <song name>` - search and play a song using the configured play API.
- `/workspace` - list files in your workspace.
- `/getfile <relative-path>` - download a workspace file.
- `/model` - show Groq, Gemini, Qwen, Claude Haiku, GPT-4 Mini, and DeepSeek switch buttons.
- `/gemini`, `/groq`, `/qwen`, `/claudehaiku`, `/gpt4mini`, and `/deepseek` - prefix commands for switching the AI provider.
- Plain chat messages use the autonomous AI agent. It remembers per-user chat history, can scrape pages, run `deepScrape` for JavaScript-heavy pages with Playwright retries/stealth context/network API capture/screenshot output/fallback HTTP fetching, validate likely API endpoints before presenting endpoint scripts, take screenshots, install missing tools/modules with browser-download guards, run generated code, report console output, and send completed project zips directly in Telegram with Gofile fallback, generate images with the Raphael text-to-image API, and analyze uploaded photos with GPT-4 Mini image fallback.
- Upload a `.zip` document to save it into your workspace, immediately list saved zip files, and automatically start the GitHub URL/token push flow.


## Browser and disk-space behavior

The Docker image installs Alpine Chromium through `apk` and sets Playwright/Puppeteer skip-download environment variables. This prevents `npm install` from downloading large browser archives into the app disk, which avoids common `ENOSPC: no space left on device` failures while still allowing scrape and screenshot tools to use the system Chromium.

## Environment variables

Create a `.env` file with:

```env
BOT_TOKEN=your_telegram_bot_token
ADMIN_ID=your_telegram_user_id
GEMINIAPIKEY=your_gemini_api_key
GEMINI_MODEL=gemini-1.5-flash
GROQ_API_KEY=your_groq_api_key
GROQ_MODEL=llama-3.3-70b-versatile
GOFILE_TOKEN=your_gofile_account_token
SCREENSHOTONE_ACCESS_KEY=your_screenshotone_access_key
DAILY_LIMIT=10
# Optional: set BRAIN=gemini to start with Gemini instead of Groq. Default is groq.
BRAIN=groq
# Optional: shared fallback API base for Qwen/Claude Haiku/Gemini Premium/GPT-4 Mini/DeepSeek/Raphael
OMEGA_AI_BASE_URL=https://omegatech-api.dixonomega.tech/api/ai
```
