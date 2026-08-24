const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');

let db = {
  users: [],
  servers: [],
  channels: [],
  members: [],
  messages: [],
  attachments: [],
  friends: [],
  friendRequests: [],
  botTokens: {},
  sessions: {}
};

function genTag() {
  return String(Math.floor(10000 + Math.random() * 90000));
}

function load() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(DB_FILE)) return;
  try {
    const raw = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
    for (const key of Object.keys(db)) {
      if (raw[key] !== undefined) db[key] = raw[key];
    }
    let migrated = false;
    for (const u of db.users) {
      if (!u.tag) {
        do {
          u.tag = genTag();
        } while (db.users.some(o => o !== u && o.tag && o.username.toLowerCase() === u.username.toLowerCase() && o.tag === u.tag));
        migrated = true;
      }
    }
    if (migrated) fs.writeFileSync(DB_FILE, JSON.stringify(db));
    console.log(`Banco carregado: ${db.users.length} usuarios, ${db.servers.length} servidores, ${db.messages.length} mensagens`);
  } catch (err) {
    console.error('Falha ao carregar banco de dados:', err.message);
  }
}

let saveTimer = null;
function save() {
  if (saveTimer) return;
  saveTimer = setTimeout(flushSync, 400);
  try { require('./backup').markDirty(); } catch {}
}

function flushSync() {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  try {
    fs.writeFileSync(DB_FILE, JSON.stringify(db));
  } catch (err) {
    console.error('Falha ao salvar banco de dados:', err.message);
  }
}

module.exports = { get db() { return db; }, load, save, flushSync };
