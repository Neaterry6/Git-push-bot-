const { exec } = require('child_process');

module.exports = function run(command, options = {}) {
  return new Promise((resolve, reject) => {
    exec(command, { ...options, timeout: 180000, maxBuffer: 1024 * 1024 * 10 }, (error, stdout, stderr) => {
      if (error) {
        return reject(new Error(stderr || error.message));
      }
      resolve({ stdout, stderr });
    });
  });
};
