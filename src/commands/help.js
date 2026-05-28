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
    '- Every user can push up to 10 times per day.'
  ].join('\n');
}

module.exports = { buildHelpText };
