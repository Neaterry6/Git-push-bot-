const axios = require('axios');
const { GEMINIAPIKEY, GEMINI_MODEL } = require('../config');

function normalizeGeminiMessages(messagesOrPrompt) {
  if (typeof messagesOrPrompt === 'string') {
    return [{ role: 'user', parts: [{ text: messagesOrPrompt }] }];
  }

  return (messagesOrPrompt || [])
    .filter((message) => message?.content)
    .map((message) => ({
      role: message.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: String(message.content) }]
    }));
}

async function askGemini(promptOrMessages) {
  if (!GEMINIAPIKEY) throw new Error('Missing GEMINIAPIKEY');

  const model = GEMINI_MODEL || 'gemini-1.5-flash';
  const res = await axios.post(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
    { contents: normalizeGeminiMessages(promptOrMessages) },
    {
      timeout: 120000,
      headers: {
        'x-goog-api-key': GEMINIAPIKEY,
        'Content-Type': 'application/json'
      }
    }
  );

  return res.data?.candidates?.[0]?.content?.parts?.map((part) => part.text || '').join('\n').trim() || 'No response from Gemini.';
}

module.exports = { askGemini };
