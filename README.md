# Git-push-bot-

Telegram bot for basic shell/file operations, zip workflows, simple Git helpers, and Gemini chat.

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
- `/gitpush` - push the current workspace or latest uploaded zip to GitHub `main`. If you reply to a zip with `/gitpush`, the bot downloads that replied zip into your workspace, immediately lists saved zips, extracts the newest zip, asks for the GitHub repo URL, then asks for your token. The bot refuses empty commits and reports ignored/untracked files before pushing.
- `/run <command>` - run a shell command in your workspace.
- `/play <song name>` - search and play a song using the configured play API.
- `/workspace` - list files in your workspace.
- `/getfile <relative-path>` - download a workspace file.
- Upload a `.zip` document to save it into your workspace, immediately list saved zip files, and automatically start the GitHub URL/token push flow.

## Environment variables

Create a `.env` file with:

```env
BOT_TOKEN=your_telegram_bot_token
ADMIN_ID=your_telegram_user_id
GEMINIAPIKEY=your_gemini_api_key
```
