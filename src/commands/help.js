function buildHelpText(prefix = '/') {
  return [
    '🤖 Bot Usage (prefix commands only)',
    '',
    `${prefix}help - show this help`,
    `${prefix}gitpush - start GitHub push flow`,
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
    'Limits:',
    '- Every user can push up to 10 times per day.'
  ].join('\n');
}

module.exports = { buildHelpText };
