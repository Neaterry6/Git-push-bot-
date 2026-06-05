function buildHelpText(prefix = '/') {
  return [
    '🤖 Bot Usage (prefix commands only)',
    '',
    `${prefix}help - show this help`,
    `${prefix}gitpush - start GitHub push flow (upload/reply to a .zip first to push its contents)`,
    `${prefix}run <command> - run shell command in your workspace`,
    `${prefix}play <song name> - search and play a song`,
    `${prefix}workspace - list files/folders in your workspace`,
    `${prefix}getfile <relative-path> - download a file from workspace`,
    `${prefix}model - show model switch buttons`,
    `${prefix}gemini - switch AI chat to Gemini`,
    `${prefix}groq - switch AI chat to Groq`,
    `${prefix}qwen - switch AI chat to Omega Qwen fallback`,
    `${prefix}claudehaiku - switch AI chat to Omega Claude Haiku fallback`,
    `${prefix}gpt4mini - switch AI chat to Omega GPT-4 Mini fallback`,
    `${prefix}deepseek - switch AI chat to Omega DeepSeek fallback`,
    'Send a photo with a caption to analyze it with GPT-4 Mini image fallback.',
    '',
    'Admin only:',
    `${prefix}users - list users`,
    `${prefix}ban <userId> - ban user`,
    `${prefix}unban <userId> - unban user`,
    `${prefix}resetuser <userId> - reset limits and unban`,
    '',
    'Zip / create workflow:',
    '- Send a .zip file and the bot saves and extracts it only. It will not ask for GitHub details from a plain upload.',
    '- When you ask the AI to create a project, it creates a full worktree, asks if you want updates, then zips locally and sends the zip in chat with Gofile fallback.',
    '- Use /gitpush only when you want the extracted workspace pushed to GitHub; then the bot asks for repo URL and token.',
    '',
    'Limits:',
    '- Admin has unlimited usage. Other users can use AI/run and push up to the configured daily limit.'
  ].join('\n');
}

module.exports = { buildHelpText };
