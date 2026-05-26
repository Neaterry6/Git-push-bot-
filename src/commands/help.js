function showHelp(bot, msg) {
  const helpText = `Shell Commands:
  /ls, /cd <dir>, /pwd, /cat <file>, /rm <file>, /exec <cmd>
Git Commands:
  /gitclone <url>, /gitstatus, /gitcommit <msg>, /gitpush
Zip Commands:
  Upload zip → saved by name
  /listzips, /pushzip <name>, /deletezip <name>
AI Chat:
  Just type a message without '/' and bot will reply using Gemini`;

  bot.sendMessage(msg.chat.id, helpText);
}

module.exports = { showHelp };
