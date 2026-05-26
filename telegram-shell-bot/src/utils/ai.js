const axios = require('axios');
const { GEMINIAPIKEY } = require('../config');

async function askGemini(prompt) {
  const res = await axios.post(
    'https://generativelanguage.googleapis.com/v1beta/models/gemini-pro:generateContent',
    { contents: [{ parts: [{ text: prompt }] }] },
    {
      headers: {
        'x-goog-api-key': GEMINIAPIKEY,
        'Content-Type': 'application/json'
      }
    }
  );

  return res.data?.candidates?.[0]?.content?.parts?.[0]?.text || 'No response from Gemini.';
}

module.exports = { askGemini };
