const { execSync } = require('child_process');

function runShell(cmd, cwd = process.cwd()) {
  try {
    return execSync(cmd, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (err) {
    return (err.stderr || err.message || 'Command failed').toString();
  }
}

module.exports = { runShell };
