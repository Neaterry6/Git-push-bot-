const { ADMIN_ID } = require('../config');

function isAdmin(userId) {
  return Number(userId) === ADMIN_ID;
}

module.exports = { isAdmin };
