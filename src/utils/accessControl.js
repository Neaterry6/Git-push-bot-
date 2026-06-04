const path = require('path');
const fs = require('fs-extra');
const workspace = require('./workspace');

const DATA_DIR = path.join(process.cwd(), 'data');
const USERS_FILE = path.join(DATA_DIR, 'users.json');
const DAILY_LIMIT = Number.parseInt(process.env.DAILY_LIMIT || '10', 10);

async function loadUsers() {
  await fs.ensureDir(DATA_DIR);
  if (!(await fs.pathExists(USERS_FILE))) {
    await fs.writeJson(USERS_FILE, { users: {} }, { spaces: 2 });
  }
  const data = await fs.readJson(USERS_FILE);
  return data?.users || {};
}

async function saveUsers(users) {
  await fs.writeJson(USERS_FILE, { users }, { spaces: 2 });
}

function todayKey() {
  return new Date().toISOString().slice(0, 10);
}

async function ensureUser(user) {
  const users = await loadUsers();
  const id = String(user.id);
  if (!users[id]) {
    users[id] = {
      id: user.id,
      username: user.username || '',
      firstName: user.first_name || '',
      banned: false,
      pushCount: 0,
      pushDate: todayKey(),
      usageCount: 0,
      usageDate: todayKey(),
      selectedModel: (process.env.BRAIN || 'groq').toLowerCase()
    };
    await saveUsers(users);
  }
  return users[id];
}

async function registerUser(user) {
  await ensureUser(user);
}

async function isAdmin(userId) {
  const adminId = Number.parseInt(process.env.ADMIN_ID || '0', 10);
  return Number(userId) === adminId && adminId > 0;
}


async function canUse(userId) {
  if (await isAdmin(userId)) return { allowed: true, remaining: Infinity };

  const users = await loadUsers();
  const key = String(userId);
  const user = users[key] || null;
  if (!user) return { allowed: true, remaining: DAILY_LIMIT };
  if (user.banned) return { allowed: false, reason: 'banned' };

  const today = todayKey();
  if (user.usageDate !== today) {
    user.usageDate = today;
    user.usageCount = 0;
    users[key] = user;
    await saveUsers(users);
  }

  const usageCount = Number(user.usageCount || 0);
  if (usageCount >= DAILY_LIMIT) return { allowed: false, reason: 'limit', remaining: 0 };
  return { allowed: true, remaining: DAILY_LIMIT - usageCount };
}

async function incrementUsage(userId) {
  if (await isAdmin(userId)) return;

  const users = await loadUsers();
  const key = String(userId);
  if (!users[key]) return;
  const today = todayKey();
  if (users[key].usageDate !== today) {
    users[key].usageDate = today;
    users[key].usageCount = 0;
  }
  users[key].usageCount = Number(users[key].usageCount || 0) + 1;
  await saveUsers(users);
}

async function setModel(userId, model) {
  const users = await loadUsers();
  const key = String(userId);
  if (!users[key]) {
    users[key] = { id: Number(userId), username: '', firstName: '', banned: false, pushCount: 0, pushDate: todayKey(), usageCount: 0, usageDate: todayKey(), selectedModel: (process.env.BRAIN || 'groq').toLowerCase() };
  }
  users[key].selectedModel = ['gemini', 'groq'].includes(model) ? model : 'groq';
  await saveUsers(users);
}

async function getModel(userId, fallback = 'groq') {
  const users = await loadUsers();
  const model = users[String(userId)]?.selectedModel;
  return ['gemini', 'groq'].includes(model) ? model : fallback;
}

async function canPush(userId) {
  if (await isAdmin(userId)) return { allowed: true, remaining: Infinity };
  const users = await loadUsers();
  const user = users[String(userId)] || null;
  if (!user) return { allowed: true, remaining: DAILY_LIMIT };
  if (user.banned) return { allowed: false, reason: 'banned' };
  const today = todayKey();
  if (user.pushDate !== today) {
    user.pushDate = today;
    user.pushCount = 0;
    users[String(userId)] = user;
    await saveUsers(users);
  }
  if (user.pushCount >= DAILY_LIMIT) return { allowed: false, reason: 'limit', remaining: 0 };
  return { allowed: true, remaining: DAILY_LIMIT - user.pushCount };
}

async function incrementPush(userId) {
  if (await isAdmin(userId)) return;
  const users = await loadUsers();
  const key = String(userId);
  if (!users[key]) return;
  const today = todayKey();
  if (users[key].pushDate !== today) {
    users[key].pushDate = today;
    users[key].pushCount = 0;
  }
  users[key].pushCount += 1;
  await saveUsers(users);
}

async function listUsers() {
  const users = await loadUsers();
  return Object.values(users);
}

async function setBan(userId, banned) {
  const users = await loadUsers();
  const key = String(userId);
  if (!users[key]) {
    users[key] = { id: Number(userId), username: '', firstName: '', banned: false, pushCount: 0, pushDate: todayKey(), usageCount: 0, usageDate: todayKey(), selectedModel: (process.env.BRAIN || 'groq').toLowerCase() };
  }
  users[key].banned = banned;
  await saveUsers(users);
}

async function resetUser(userId) {
  const users = await loadUsers();
  const key = String(userId);
  if (!users[key]) return false;
  users[key].pushCount = 0;
  users[key].pushDate = todayKey();
  users[key].usageCount = 0;
  users[key].usageDate = todayKey();
  users[key].banned = false;
  await saveUsers(users);
  return true;
}

async function getWorkspaceFiles(userId) {
  const cwd = workspace.getPath(userId);
  await fs.ensureDir(cwd);
  const items = await fs.readdir(cwd);
  return { cwd, items };
}

module.exports = {
  DAILY_LIMIT,
  registerUser,
  isAdmin,
  canUse,
  incrementUsage,
  setModel,
  getModel,
  canPush,
  incrementPush,
  listUsers,
  setBan,
  resetUser,
  getWorkspaceFiles
};
