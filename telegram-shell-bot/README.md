# Telegram Shell Bot

A modular Node.js Telegram bot with:

- Shell emulator commands
- Git integration
- Zip upload/list/push/delete flow
- Admin-only controls
- Gemini AI fallback chat

## Setup

1. Copy env file:
   ```bash
   cp .env.example .env
   ```
2. Fill values in `.env`.
3. Install and start:
   ```bash
   npm install
   npm start
   ```

## Commands

- Shell: `/ls`, `/cd <dir>`, `/pwd`, `/cat <file>`, `/rm <file>`, `/exec <cmd>`
- Git: `/gitclone <url>`, `/gitstatus`, `/gitcommit <msg>`, `/gitpush`
- Zip: Upload `.zip`, then `/listzips`, `/pushzip <name>`, `/deletezip <name>`
- Help: `/help`

Any text message not starting with `/` is sent to Gemini.
