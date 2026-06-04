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
    '',
    'Admin only:',
    `${prefix}users - list users`,
    `${prefix}ban <userId> - ban user`,
    `${prefix}unban <userId> - unban user`,
    `${prefix}resetuser <userId> - reset limits and unban`,
    '',
    'Zip workflow:',
    '- Send a .zip file and the bot saves it to your workspace, lists saved zips, then asks for repo URL and token.',
    '- You can also reply to a .zip with /gitpush and the bot saves that replied zip before pushing.',
    '',
    'Limits:',
    '- Admin has unlimited usage. Other users can use AI/run and push up to the configured daily limit.'
  ].join('\n');
}

module.exports = { buildHelpText };
