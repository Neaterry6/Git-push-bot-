require('dotenv').config();

module.exports = {
  BOT_TOKEN: process.env.BOT_TOKEN,
  ADMIN_ID: Number.parseInt(process.env.ADMIN_ID || '0', 10),
  GEMINIAPIKEY: process.env.GEMINIAPIKEY,
  GEMINI_MODEL: process.env.GEMINI_MODEL || 'gemini-1.5-flash'
};
