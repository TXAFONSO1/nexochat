const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const store = require('./lib/db');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');
const UPLOAD_DIR = path.join(__dirname, 'data', 'uploads');
const MAX_BODY = 100 * 1024;
const MAX_UPLOAD = 20 * 1024 * 1024;
const MAX_MESSAGES_PER_CHANNEL = 300;

if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.mp3': 'audio/mpeg',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.pdf': 'application/pdf',
  '.txt': 'text/plain; charset=utf-8'
};

function genId() {
  return Date.now().toString(36) + crypto.randomBytes(5).toString('hex');
}

function genInviteCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 6; i++) code += chars[crypto.randomInt(chars.length)];
  return code;
}

function hashPassword(password, salt) {
  return crypto.scryptSync(password, salt, 64).toString('hex');
}

function publicUser(user) {
  return { id: user.id, username: user.username, tag: user.tag || null, color: user.color, createdAt: user.createdAt, isBot: !!user.isBot };
}

function genTag() {
  return String(Math.floor(10000 + Math.random() * 90000));
}

function parseHandle(handle) {
  const m = String(handle || '').trim().match(/^([^#]{1,24})#(\d{4,6})$/);
  return m ? { name: m[1].trim(), tag: m[2] } : null;
}

function json(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', chunk => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(new Error('body_too_large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (chunks.length === 0) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(new Error('invalid_json'));
      }
    });
    req.on('error', reject);
  });
}

function readRaw(req, maxBytes) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', chunk => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(new Error('file_too_large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function tokenFromReq(req) {
  const header = req.headers['authorization'] || '';
  return header.startsWith('Bearer ') ? header.slice(7) : null;
}

function getAuthUser(req) {
  const token = tokenFromReq(req);
  if (!token) return null;
  const userId = store.db.sessions[token];
  if (!userId) return null;
  return store.db.users.find(u => u.id === userId) || null;
}

function userColor(username) {
  let hash = 0;
  for (let i = 0; i < username.length; i++) hash = (hash * 31 + username.charCodeAt(i)) >>> 0;
  const hues = [210, 230, 260, 280, 320, 340, 10, 30, 50, 90, 140, 170];
  return `hsl(${hues[hash % hues.length]}, 55%, 45%)`;
}

function serversOf(userId) {
  return store.db.members
    .filter(m => m.userId === userId)
    .map(m => store.db.servers.find(s => s.id === m.serverId))
    .filter(Boolean);
}

function isMember(serverId, userId) {
  return store.db.members.some(m => m.serverId === serverId && m.userId === userId);
}

function dmKey(a, b) {
  return 'dm_' + [a, b].sort().join('_');
}

function dmPartners(userId) {
  const partners = new Set();
  const prefix = 'dm_';
  for (const msg of store.db.messages) {
    if (!msg.channelId.startsWith(prefix)) continue;
    const parts = msg.channelId.split('_');
    if (parts.length !== 3) continue;
    if (parts[1] === userId) partners.add(parts[2]);
    else if (parts[2] === userId) partners.add(parts[1]);
  }
  return [...partners];
}

function sharesServer(a, b) {
  return serversOf(a).some(s => isMember(s.id, b));
}

function areFriends(a, b) {
  return store.db.friends.some(f => (f.a === a && f.b === b) || (f.a === b && f.b === a));
}

function canModerate(serverId, userId) {
  const s = store.db.servers.find(x => x.id === serverId);
  if (!s) return false;
  if (s.ownerId === userId) return true;
  const m = store.db.members.find(x => x.serverId === serverId && x.userId === userId);
  if (!m || !m.roleIds) return false;
  return (m.roleIds || []).some(rid => {
    const r = (s.roles || []).find(x => x.id === rid);
    return r && r.admin;
  });
}

function findMessageForUser(messageId, user) {
  const message = store.db.messages.find(m => m.id === messageId);
  if (!message) return {};
  const key = message.channelId;
  if (key.startsWith('dm_')) {
    const parts = key.split('_');
    if (parts[1] !== user.id && parts[2] !== user.id) return {};
    return { message, isDm: true, dmParts: [parts[1], parts[2]] };
  }
  const channel = store.db.channels.find(c => c.id === key);
  if (!channel || !isMember(channel.serverId, user.id)) return {};
  return { message, isDm: false, serverId: channel.serverId };
}

function broadcastMessageEvent(message, event) {
  if (event.channelId.startsWith && event.channelId.startsWith('dm_')) {
    const parts = event.channelId.split('_');
    sendToUser(parts[1], event);
    sendToUser(parts[2], event);
  } else if (message.serverId) {
    broadcastServer(message.serverId, event);
  }
}

const sseClients = new Map();

function sseWrite(client, event) {
  try {
    if (client.readyState === 1) client.send(JSON.stringify(event));
  } catch {}
}

function sendToUser(userId, event) {
  const set = sseClients.get(userId);
  if (!set) return false;
  for (const client of set) sseWrite(client, event);
  return true;
}

function broadcastServer(serverId, event, exceptUserId) {
  for (const m of store.db.members) {
    if (m.serverId !== serverId || m.userId === exceptUserId) continue;
    sendToUser(m.userId, event);
  }
}

function broadcastPresence(userId, online) {
  const user = store.db.users.find(u => u.id === userId);
  if (!user) return;
  const event = { type: 'presence', userId, username: user.username, color: user.color, online };
  for (const s of serversOf(userId)) broadcastServer(s.id, event);
  for (const partner of dmPartners(userId)) sendToUser(partner, event);
  for (const f of store.db.friends) {
    if (f.a === userId) sendToUser(f.b, event);
    else if (f.b === userId) sendToUser(f.a, event);
  }
}

const voiceRooms = new Map();

function voiceRoomList(channelId) {
  const room = voiceRooms.get(channelId);
  if (!room) return [];
  const users = [];
  for (const uid of room.keys()) {
    const u = store.db.users.find(x => x.id === uid);
    if (u) users.push({ id: u.id, username: u.username, color: u.color });
  }
  return users;
}

function broadcastVoiceState(channelId) {
  const channel = store.db.channels.find(c => c.id === channelId);
  if (!channel) return;
  broadcastServer(channel.serverId, {
    type: 'voice_state',
    channelId,
    serverId: channel.serverId,
    users: voiceRoomList(channelId)
  });
}

function leaveVoiceAll(userId) {
  const affected = [];
  for (const [channelId, room] of voiceRooms) {
    if (room.has(userId)) {
      room.delete(userId);
      affected.push(channelId);
      if (room.size === 0) voiceRooms.delete(channelId);
    }
  }
  for (const channelId of affected) broadcastVoiceState(channelId);
}

function ensureNexoBot() {
  let bot = store.db.users.find(u => u.id === 'nexobot');
  if (!bot) {
    bot = {
      id: 'nexobot',
      username: 'NexoBot',
      tag: genTag(),
      salt: '',
      passHash: '',
      color: '#5865f2',
      createdAt: Date.now(),
      isBot: true
    };
    store.db.users.push(bot);
    store.save();
  }
  return bot;
}

function addBotMembership(serverId, botUserId) {
  if (!isMember(serverId, botUserId)) {
    store.db.members.push({ serverId, userId: botUserId, joinedAt: Date.now() });
  }
}

function postMessageInternal(user, channelId, content, attachmentIds) {
  const channel = store.db.channels.find(c => c.id === channelId);
  const isDm = channelId.startsWith('dm_');
  if (!isDm && !channel) return null;
  const now = Date.now();
  const attachments = (attachmentIds || [])
    .map(id => store.db.attachments.find(a => a.id === id))
    .filter(Boolean)
    .slice(0, 5);
  const message = {
    id: genId(),
    channelId,
    serverId: channel ? channel.serverId : null,
    userId: user.id,
    username: user.username,
    color: user.color,
    isBot: !!user.isBot,
    content,
    attachments,
    reactions: {},
    editedAt: null,
    createdAt: now
  };
  if (channel) {
    const channelMessages = store.db.messages.filter(m => m.channelId === channelId);
    if (channelMessages.length >= MAX_MESSAGES_PER_CHANNEL) {
      const toRemove = new Set(
        channelMessages.slice(0, channelMessages.length - MAX_MESSAGES_PER_CHANNEL + 1).map(m => m.id)
      );
      store.db.messages = store.db.messages.filter(m => !toRemove.has(m.id));
    }
  }
  store.db.messages.push(message);
  store.save();
  if (isDm) {
    const parts = channelId.split('_');
    sendToUser(parts[1], { type: 'dm', message });
    sendToUser(parts[2], { type: 'dm', message });
  } else {
    broadcastServer(channel.serverId, { type: 'message', message });
  }
  return message;
}

function handleBotCommands(message) {
  if (message.isBot) return;
  const text = message.content.trim();
  if (!text.startsWith('/')) return;
  const bot = ensureNexoBot();
  const [cmdRaw, ...argsRaw] = text.slice(1).split(/\s+/);
  const cmd = cmdRaw.toLowerCase();
  const args = argsRaw.join(' ');
  let reply = null;

  if (cmd === 'ajuda' || cmd === 'help') {
    reply = [
      'Comandos disponiveis:',
      '/ajuda - mostra esta lista',
      '/dado [lados] - rola um dado (padrao 6 lados)',
      '/moeda - cara ou coroa',
      '/escolher opcao1 | opcao2 | ... - escolhe uma opcao',
      '/say <texto> - repete o que voce disse',
      '/ping - verifica a latencia do bot'
    ].join('\n');
  } else if (cmd === 'ping') {
    reply = `Pong! ${Date.now() - message.createdAt}ms`;
  } else if (cmd === 'dado') {
    const sides = Math.min(Math.max(parseInt(args) || 6, 2), 1000);
    reply = `${message.username} rolou um dado de ${sides} lados e tirou ${crypto.randomInt(sides) + 1}!`;
  } else if (cmd === 'moeda') {
    reply = `A moeda caiu em: ${crypto.randomInt(2) === 0 ? 'Cara' : 'Coroa'}`;
  } else if (cmd === 'escolher') {
    const options = args.split('|').map(o => o.trim()).filter(Boolean);
    if (options.length < 2) reply = 'Me de pelo menos 2 opcoes separadas por |. Ex: /escolher pizza | hamburguer';
    else reply = `Eu escolho: ${options[crypto.randomInt(options.length)]}`;
  } else if (cmd === 'say') {
    if (args) reply = args;
  }

  if (reply) postMessageInternal(bot, message.channelId, reply);
}

async function handleUpload(req, res, url, me) {
  const rawName = url.searchParams.get('name') || 'arquivo';
  const safeName = rawName.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 80) || 'arquivo';
  const mime = (url.searchParams.get('type') || 'application/octet-stream').slice(0, 100);
  let buf;
  try {
    buf = await readRaw(req, MAX_UPLOAD);
  } catch (err) {
    return json(res, err.message === 'file_too_large' ? 413 : 400, { error: 'Arquivo muito grande ou invalido (max 20MB)' });
  }
  if (buf.length === 0) return json(res, 400, { error: 'Arquivo vazio' });
  const id = genId();
  const storedName = id + '_' + safeName;
  fs.writeFileSync(path.join(UPLOAD_DIR, storedName), buf);
  const attachment = {
    id,
    name: safeName,
    type: mime,
    size: buf.length,
    url: `/files/${storedName}`
  };
  store.db.attachments.push(attachment);
  if (store.db.attachments.length > 2000) {
    const removed = store.db.attachments.splice(0, store.db.attachments.length - 2000);
    for (const a of removed) {
      try {
        const file = path.join(UPLOAD_DIR, path.basename(a.url));
        if (fs.existsSync(file)) fs.unlinkSync(file);
      } catch {}
    }
  }
  store.save();
  json(res, 201, { attachment });
}

async function handleApi(req, res, url) {
  const route = `${req.method} ${url.pathname}`;
  const isUpload = route === 'POST /api/upload';
  const body = !isUpload && ['POST', 'PUT', 'PATCH'].includes(req.method) ? await readBody(req) : {};
  const me = getAuthUser(req);

  if (route === 'POST /api/register') {
    const username = String(body.username || '').trim();
    const password = String(body.password || '');
    if (!/^[A-Za-z0-9_]{3,24}$/.test(username)) {
      return json(res, 400, { error: 'Nome de usuario invalido: use 3 a 24 letras, numeros ou _' });
    }
    if (password.length < 6) {
      return json(res, 400, { error: 'A senha precisa ter pelo menos 6 caracteres' });
    }
    let tag;
    do {
      tag = genTag();
    } while (store.db.users.some(u => u.username.toLowerCase() === username.toLowerCase() && u.tag === tag));
    const salt = crypto.randomBytes(16).toString('hex');
    const user = {
      id: genId(),
      username,
      tag,
      salt,
      passHash: hashPassword(password, salt),
      color: userColor(username),
      createdAt: Date.now()
    };
    store.db.users.push(user);
    const token = crypto.randomBytes(32).toString('hex');
    store.db.sessions[token] = user.id;
    store.save();
    return json(res, 201, { token, user: publicUser(user) });
  }

  if (route === 'POST /api/login') {
    const handle = String(body.username || '').trim();
    const password = String(body.password || '');
    let candidates;
    const parsed = parseHandle(handle);
    if (parsed) {
      candidates = store.db.users.filter(u => !u.isBot && u.username.toLowerCase() === parsed.name.toLowerCase() && u.tag === parsed.tag);
    } else {
      candidates = store.db.users.filter(u => !u.isBot && u.username.toLowerCase() === handle.toLowerCase());
      if (candidates.length > 1) {
        return json(res, 409, { error: 'Existem varias contas com esse nome. Entre como Nome#tag (ex: Neemias#18263)' });
      }
    }
    const user = candidates[0];
    if (!user || !user.salt || hashPassword(password, user.salt) !== user.passHash) {
      return json(res, 401, { error: 'Usuario ou senha incorretos' });
    }
    const token = crypto.randomBytes(32).toString('hex');
    store.db.sessions[token] = user.id;
    store.save();
    return json(res, 200, { token, user: publicUser(user) });
  }

  if (route === 'POST /api/bot/message') {
    const botToken = tokenFromReq(req);
    const botUserId = store.db.botTokens[botToken];
    const botUser = botUserId ? store.db.users.find(u => u.id === botUserId) : null;
    if (!botUser || !botUser.isBot) return json(res, 401, { error: 'Token de bot invalido' });
    const channelId = String(body.channelId || '');
    const channel = store.db.channels.find(c => c.id === channelId);
    if (!channel || !isMember(channel.serverId, botUser.id)) return json(res, 403, { error: 'Bot sem acesso ao canal' });
    const content = String(body.content || '').trim().slice(0, 2000);
    if (!content) return json(res, 400, { error: 'Mensagem vazia' });
    const message = postMessageInternal(botUser, channelId, content);
    return json(res, 201, { message });
  }

  if (!me) return json(res, 401, { error: 'Nao autenticado' });

  if (route === 'GET /api/me') {
    return json(res, 200, { user: publicUser(me), servers: serversOf(me.id) });
  }

  if (route === 'POST /api/logout') {
    delete store.db.sessions[tokenFromReq(req)];
    store.save();
    return json(res, 200, { ok: true });
  }

  if (route === 'POST /api/upload') {
    return handleUpload(req, res, url, me);
  }

  if (route === 'POST /api/servers') {
    const name = String(body.name || '').trim().slice(0, 40);
    if (name.length < 2) return json(res, 400, { error: 'Nome do servidor muito curto' });
    const server = { id: genId(), name, ownerId: me.id, inviteCode: genInviteCode(), createdAt: Date.now() };
    const textChannel = { id: genId(), serverId: server.id, name: 'geral', position: 0, type: 'text' };
    const voiceChannel = { id: genId(), serverId: server.id, name: 'Canal de voz', position: 0, type: 'voice' };
    store.db.servers.push(server);
    store.db.channels.push(textChannel, voiceChannel);
    store.db.members.push({ serverId: server.id, userId: me.id, joinedAt: Date.now() });
    addBotMembership(server.id, ensureNexoBot().id);
    store.save();
    return json(res, 201, { server, channels: [textChannel, voiceChannel] });
  }

  if (route === 'POST /api/servers/join') {
    const code = String(body.inviteCode || '').trim().toUpperCase();
    const server = store.db.servers.find(s => s.inviteCode === code);
    if (!server) return json(res, 404, { error: 'Codigo de convite invalido' });
    if (!isMember(server.id, me.id)) {
      store.db.members.push({ serverId: server.id, userId: me.id, joinedAt: Date.now() });
      addBotMembership(server.id, ensureNexoBot().id);
      store.save();
      broadcastServer(server.id, {
        type: 'member_join',
        serverId: server.id,
        user: publicUser(me)
      }, me.id);
    }
    const channels = store.db.channels.filter(c => c.serverId === server.id).sort((a, b) => a.position - b.position);
    return json(res, 200, { server, channels });
  }

  let match = url.pathname.match(/^\/api\/servers\/([a-z0-9]+)\/channels$/);
  if (match && req.method === 'GET') {
    const serverId = match[1];
    if (!isMember(serverId, me.id)) return json(res, 403, { error: 'Sem acesso' });
    const channels = store.db.channels.filter(c => c.serverId === serverId).sort((a, b) => a.position - b.position);
    return json(res, 200, { channels });
  }

  if (match && req.method === 'POST') {
    const serverId = match[1];
    if (!isMember(serverId, me.id)) return json(res, 403, { error: 'Sem acesso' });
    const name = String(body.name || '').trim().toLowerCase().replace(/\s+/g, '-').slice(0, 32);
    const type = body.type === 'voice' ? 'voice' : 'text';
    if (!/^[a-z0-9_-]{2,32}$/.test(name)) {
      return json(res, 400, { error: 'Nome de canal invalido (letras minusculas, numeros e hifen)' });
    }
    const position = store.db.channels.filter(c => c.serverId === serverId && c.type === type).length;
    const channel = { id: genId(), serverId, name, position, type };
    store.db.channels.push(channel);
    store.save();
    broadcastServer(serverId, { type: 'channel_create', channel });
    return json(res, 201, { channel });
  }

  match = url.pathname.match(/^\/api\/servers\/([a-z0-9]+)\/members$/);
  if (match && req.method === 'GET') {
    const serverId = match[1];
    if (!isMember(serverId, me.id)) return json(res, 403, { error: 'Sem acesso' });
    const members = store.db.members
      .filter(m => m.serverId === serverId)
      .map(m => {
        const u = store.db.users.find(u => u.id === m.userId);
        return u ? { ...publicUser(u), roleIds: m.roleIds || [] } : null;
      })
      .filter(Boolean);
    const online = members.filter(u => sseClients.has(u.id)).map(u => u.id);
    const server = store.db.servers.find(s => s.id === serverId);
    return json(res, 200, { members, online, roles: server.roles || [] });
  }

  match = url.pathname.match(/^\/api\/servers\/([a-z0-9]+)\/bots$/);
  if (match && req.method === 'POST') {
    const serverId = match[1];
    const server = store.db.servers.find(s => s.id === serverId);
    if (!server || server.ownerId !== me.id) return json(res, 403, { error: 'Apenas o dono pode criar bots' });
    const name = String(body.name || '').trim().replace(/[^A-Za-z0-9_-]/g, '').slice(0, 24);
    if (name.length < 3) return json(res, 400, { error: 'Nome do bot invalido (min 3 letras)' });
    let botTag;
    do {
      botTag = genTag();
    } while (store.db.users.some(u => u.username.toLowerCase() === name.toLowerCase() && u.tag === botTag));
    const bot = { id: genId(), username: name, tag: botTag, salt: '', passHash: '', color: '#3ba55c', createdAt: Date.now(), isBot: true, ownerId: me.id };
    const token = crypto.randomBytes(24).toString('hex');
    store.db.users.push(bot);
    store.db.botTokens[token] = bot.id;
    addBotMembership(serverId, bot.id);
    store.save();
    broadcastServer(serverId, { type: 'member_join', serverId, user: publicUser(bot) });
    return json(res, 201, { bot: publicUser(bot), token });
  }

  match = url.pathname.match(/^\/api\/channels\/([a-z0-9]+)\/messages$/);
  if (match && req.method === 'GET') {
    const channelId = match[1];
    const channel = store.db.channels.find(c => c.id === channelId);
    if (!channel || !isMember(channel.serverId, me.id)) return json(res, 403, { error: 'Sem acesso' });
    const limit = Math.min(parseInt(url.searchParams.get('limit')) || 50, 100);
    const messages = store.db.messages.filter(m => m.channelId === channelId).slice(-limit);
    return json(res, 200, { messages });
  }

  if (match && req.method === 'POST') {
    const channelId = match[1];
    const channel = store.db.channels.find(c => c.id === channelId);
    if (!channel || !isMember(channel.serverId, me.id)) return json(res, 403, { error: 'Sem acesso' });
    const content = String(body.content || '').trim().slice(0, 2000);
    if (!content && !(body.attachmentIds || []).length) return json(res, 400, { error: 'Mensagem vazia' });
    const now = Date.now();
    if (lastMessageAt.get(me.id) && now - lastMessageAt.get(me.id) < 150) {
      return json(res, 429, { error: 'Muito rapido' });
    }
    lastMessageAt.set(me.id, now);
    const message = postMessageInternal(me, channelId, content, body.attachmentIds);
    if (!message) return json(res, 400, { error: 'Falha ao enviar' });
    handleBotCommands(message);
    return json(res, 201, { message });
  }

  match = url.pathname.match(/^\/api\/typing$/);
  if (match && req.method === 'POST') {
    const channel = store.db.channels.find(c => c.id === body.channelId);
    if (!channel || !isMember(channel.serverId, me.id)) return json(res, 403, { error: 'Sem acesso' });
    const now = Date.now();
    if (lastTypingAt.get(me.id) && now - lastTypingAt.get(me.id) < 2500) {
      return json(res, 200, { ok: true });
    }
    lastTypingAt.set(me.id, now);
    broadcastServer(channel.serverId, {
      type: 'typing',
      channelId: channel.id,
      userId: me.id,
      username: me.username
    }, me.id);
    return json(res, 200, { ok: true });
  }

  match = url.pathname.match(/^\/api\/channels\/([a-z0-9]+)\/voice\/join$/);
  if (match && req.method === 'POST') {
    const channelId = match[1];
    const channel = store.db.channels.find(c => c.id === channelId);
    if (!channel || channel.type !== 'voice') return json(res, 400, { error: 'Canal de voz invalido' });
    if (!isMember(channel.serverId, me.id)) return json(res, 403, { error: 'Sem acesso' });
    leaveVoiceAll(me.id);
    if (!voiceRooms.has(channelId)) voiceRooms.set(channelId, new Set());
    voiceRooms.get(channelId).add(me.id);
    broadcastVoiceState(channelId);
    return json(res, 200, { users: voiceRoomList(channelId) });
  }

  match = url.pathname.match(/^\/api\/channels\/([a-z0-9]+)\/voice\/leave$/);
  if (match && req.method === 'POST') {
    leaveVoiceAll(me.id);
    return json(res, 200, { ok: true });
  }

  if (route === 'POST /api/signal') {
    const { channelId, targetUserId, payload } = body;
    const room = voiceRooms.get(String(channelId));
    if (!room || !room.has(me.id) || !room.has(targetUserId)) {
      return json(res, 400, { error: 'Sinalizacao invalida' });
    }
    const sent = sendToUser(targetUserId, {
      type: 'signal',
      fromUserId: me.id,
      channelId,
      payload
    });
    return json(res, sent ? 200 : 404, { ok: sent });
  }

  if (route === 'GET /api/friends') {
    const friends = store.db.friends
      .filter(f => f.a === me.id || f.b === me.id)
      .map(f => (f.a === me.id ? f.b : f.a))
      .map(uid => {
        const u = store.db.users.find(x => x.id === uid);
        return u ? { ...publicUser(u), online: sseClients.has(u.id) } : null;
      })
      .filter(Boolean);
    const incoming = store.db.friendRequests
      .filter(r => r.to === me.id)
      .map(r => ({ id: r.id, user: publicUser(store.db.users.find(u => u.id === r.from)) }))
      .filter(x => x.user);
    const outgoing = store.db.friendRequests
      .filter(r => r.from === me.id)
      .map(r => ({ id: r.id, user: publicUser(store.db.users.find(u => u.id === r.to)) }))
      .filter(x => x.user);
    return json(res, 200, { friends, incoming, outgoing });
  }

  if (route === 'POST /api/friends/remove') {
    const userId = String(body.userId || '');
    const before = store.db.friends.length;
    store.db.friends = store.db.friends.filter(f => !((f.a === me.id && f.b === userId) || (f.a === userId && f.b === me.id)));
    if (store.db.friends.length === before) return json(res, 404, { error: 'Amizade nao encontrada' });
    store.db.friendRequests = store.db.friendRequests.filter(
      r => !((r.from === me.id && r.to === userId) || (r.from === userId && r.to === me.id))
    );
    store.save();
    sendToUser(userId, { type: 'friend_update' });
    return json(res, 200, { ok: true });
  }

  if (route === 'POST /api/friends/request') {
    const handle = String(body.username || '').trim();
    let target;
    const parsed = parseHandle(handle);
    if (parsed) {
      target = store.db.users.find(u => !u.isBot && u.username.toLowerCase() === parsed.name.toLowerCase() && u.tag === parsed.tag) || null;
    } else {
      const cands = store.db.users.filter(u => !u.isBot && u.username.toLowerCase() === handle.toLowerCase());
      if (cands.length > 1) return json(res, 400, { error: 'Esse nome tem mais de uma conta. Use o formato Nome#tag' });
      target = cands[0] || null;
    }
    if (!target) return json(res, 404, { error: 'Usuario nao encontrado' });
    if (target.id === me.id) return json(res, 400, { error: 'Voce nao pode se adicionar' });
    if (areFriends(me.id, target.id)) return json(res, 400, { error: 'Voces ja sao amigos' });
    const reverse = store.db.friendRequests.find(r => r.from === target.id && r.to === me.id);
    if (reverse) {
      store.db.friendRequests = store.db.friendRequests.filter(r => r !== reverse);
      store.db.friends.push({ a: me.id, b: target.id, since: Date.now() });
      store.save();
      sendToUser(target.id, { type: 'friend_accept', user: publicUser(me) });
      return json(res, 200, { friend: publicUser(target) });
    }
    if (store.db.friendRequests.some(r => r.from === me.id && r.to === target.id)) {
      return json(res, 200, { pending: true });
    }
    const request = { id: genId(), from: me.id, to: target.id, createdAt: Date.now() };
    store.db.friendRequests.push(request);
    store.save();
    sendToUser(target.id, { type: 'friend_request', requestId: request.id, user: publicUser(me) });
    return json(res, 201, { pending: true });
  }

  match = url.pathname.match(/^\/api\/friends\/([a-z0-9]+)$/);
  if (match && req.method === 'POST') {
    const request = store.db.friendRequests.find(r => r.id === match[1]);
    if (!request || request.to !== me.id) return json(res, 404, { error: 'Pedido nao encontrado' });
    const friendUser = store.db.users.find(u => u.id === request.from);
    store.db.friendRequests = store.db.friendRequests.filter(r => r !== request);
    store.db.friends.push({ a: me.id, b: request.from, since: Date.now() });
    store.save();
    sendToUser(request.from, { type: 'friend_accept', user: publicUser(me) });
    return json(res, 200, { friend: friendUser ? publicUser(friendUser) : null });
  }

  if (match && req.method === 'DELETE') {
    const request = store.db.friendRequests.find(r => r.id === match[1]);
    if (!request || request.to !== me.id) return json(res, 404, { error: 'Pedido nao encontrado' });
    store.db.friendRequests = store.db.friendRequests.filter(r => r !== request);
    store.save();
    return json(res, 200, { ok: true });
  }

  if (route === 'GET /api/dms') {
    const conversations = [];
    const seen = new Set();
    for (let i = store.db.messages.length - 1; i >= 0; i--) {
      const msg = store.db.messages[i];
      if (!msg.channelId.startsWith('dm_')) continue;
      const parts = msg.channelId.split('_');
      if (parts[1] !== me.id && parts[2] !== me.id) continue;
      const partnerId = parts[1] === me.id ? parts[2] : parts[1];
      if (seen.has(partnerId)) continue;
      seen.add(partnerId);
      const partner = store.db.users.find(u => u.id === partnerId);
      if (!partner) continue;
      conversations.push({
        partner: publicUser(partner),
        online: sseClients.has(partnerId),
        lastMessage: { content: msg.content, createdAt: msg.createdAt, fromMe: msg.userId === me.id }
      });
      if (conversations.length >= 50) break;
    }
    return json(res, 200, { conversations });
  }

  match = url.pathname.match(/^\/api\/dms\/([a-z0-9]+)\/messages$/);
  if (match) {
    const peerId = match[1];
    const peer = store.db.users.find(u => u.id === peerId);
    if (!peer) return json(res, 404, { error: 'Usuario nao encontrado' });
    const key = dmKey(me.id, peerId);
    if (req.method === 'GET') {
      const limit = Math.min(parseInt(url.searchParams.get('limit')) || 50, 100);
      const messages = store.db.messages.filter(m => m.channelId === key).slice(-limit);
      return json(res, 200, { messages, peer: publicUser(peer) });
    }
    if (req.method === 'POST') {
      if (me.id !== peerId && !sharesServer(me.id, peerId) && !areFriends(me.id, peerId)) {
        return json(res, 403, { error: 'Voces precisam ser amigos ou compartilhar um servidor' });
      }
      const content = String(body.content || '').trim().slice(0, 2000);
      if (!content && !(body.attachmentIds || []).length) return json(res, 400, { error: 'Mensagem vazia' });
      const now = Date.now();
      if (lastMessageAt.get(me.id) && now - lastMessageAt.get(me.id) < 150) {
        return json(res, 429, { error: 'Muito rapido' });
      }
      lastMessageAt.set(me.id, now);
      const message = postMessageInternal(me, key, content, body.attachmentIds);
      return json(res, 201, { message });
    }
  }

  match = url.pathname.match(/^\/api\/servers\/([a-z0-9]+)\/roles$/);
  if (match && req.method === 'POST') {
    const serverId = match[1];
    if (!canModerate(serverId, me.id)) return json(res, 403, { error: 'Apenas administradores podem gerenciar cargos' });
    const name = String(body.name || '').trim().slice(0, 24);
    if (name.length < 2) return json(res, 400, { error: 'Nome do cargo muito curto' });
    const server = store.db.servers.find(s => s.id === serverId);
    if (!server.roles) server.roles = [];
    const role = {
      id: genId(),
      name,
      color: /^#[0-9a-fA-F]{6}$/.test(body.color || '') ? body.color : '#99aab5',
      admin: !!body.admin
    };
    server.roles.push(role);
    store.save();
    broadcastServer(serverId, { type: 'roles_update', serverId, roles: server.roles });
    return json(res, 201, { role });
  }

  match = url.pathname.match(/^\/api\/servers\/([a-z0-9]+)\/roles\/([a-z0-9]+)$/);
  if (match && req.method === 'DELETE') {
    const [, serverId, roleId] = match;
    if (!canModerate(serverId, me.id)) return json(res, 403, { error: 'Apenas administradores podem gerenciar cargos' });
    const server = store.db.servers.find(s => s.id === serverId);
    server.roles = (server.roles || []).filter(r => r.id !== roleId);
    for (const m of store.db.members) {
      if (m.serverId === serverId && m.roleIds) {
        m.roleIds = m.roleIds.filter(rid => rid !== roleId);
      }
    }
    store.save();
    broadcastServer(serverId, { type: 'roles_update', serverId, roles: server.roles });
    broadcastServer(serverId, { type: 'members_refresh', serverId });
    return json(res, 200, { ok: true });
  }

  match = url.pathname.match(/^\/api\/servers\/([a-z0-9]+)\/members\/([a-z0-9]+)\/roles$/);
  if (match && req.method === 'POST') {
    const [, serverId, targetUserId] = match;
    if (!canModerate(serverId, me.id)) return json(res, 403, { error: 'Apenas administradores podem atribuir cargos' });
    const member = store.db.members.find(m => m.serverId === serverId && m.userId === targetUserId);
    if (!member) return json(res, 404, { error: 'Membro nao encontrado' });
    const server = store.db.servers.find(s => s.id === serverId);
    const role = (server.roles || []).find(r => r.id === body.roleId);
    if (!role) return json(res, 404, { error: 'Cargo nao encontrado' });
    member.roleIds = member.roleIds || [];
    if (member.roleIds.includes(role.id)) {
      member.roleIds = member.roleIds.filter(rid => rid !== role.id);
    } else {
      member.roleIds.push(role.id);
    }
    store.save();
    broadcastServer(serverId, { type: 'member_update', serverId, userId: targetUserId, roleIds: member.roleIds });
    return json(res, 200, { roleIds: member.roleIds });
  }

  match = url.pathname.match(/^\/api\/messages\/([a-z0-9]+)\/reactions$/);
  if (match && req.method === 'POST') {
    const found = findMessageForUser(match[1], me);
    if (!found.message) return json(res, 404, { error: 'Mensagem nao encontrada' });
    const emoji = String(body.emoji || '').slice(0, 8).trim();
    if (!emoji) return json(res, 400, { error: 'Emoji invalido' });
    const msg = found.message;
    msg.reactions = msg.reactions || {};
    if (!msg.reactions[emoji]) msg.reactions[emoji] = [];
    const list = msg.reactions[emoji];
    if (list.includes(me.id)) {
      msg.reactions[emoji] = list.filter(uid => uid !== me.id);
      if (msg.reactions[emoji].length === 0) delete msg.reactions[emoji];
    } else {
      if (list.length >= 20) return json(res, 400, { error: 'Reacoes demais' });
      list.push(me.id);
    }
    store.save();
    broadcastMessageEvent(msg, {
      type: 'reaction_update',
      messageId: msg.id,
      channelId: msg.channelId,
      reactions: msg.reactions
    });
    return json(res, 200, { reactions: msg.reactions });
  }

  match = url.pathname.match(/^\/api\/messages\/([a-z0-9]+)$/);
  if (match && req.method === 'PATCH') {
    const found = findMessageForUser(match[1], me);
    if (!found.message) return json(res, 404, { error: 'Mensagem nao encontrada' });
    const msg = found.message;
    if (msg.userId !== me.id) return json(res, 403, { error: 'Voce so pode editar suas mensagens' });
    const content = String(body.content || '').trim().slice(0, 2000);
    if (!content && !(msg.attachments || []).length) return json(res, 400, { error: 'Mensagem vazia' });
    msg.content = content;
    msg.editedAt = Date.now();
    store.save();
    broadcastMessageEvent(msg, {
      type: 'message_edit',
      messageId: msg.id,
      channelId: msg.channelId,
      content: msg.content,
      editedAt: msg.editedAt
    });
    return json(res, 200, { message: msg });
  }

  if (match && req.method === 'DELETE') {
    const found = findMessageForUser(match[1], me);
    if (!found.message) return json(res, 404, { error: 'Mensagem nao encontrada' });
    const msg = found.message;
    const isMine = msg.userId === me.id;
    const canMod = !found.isDm && canModerate(found.serverId, me.id);
    if (!isMine && !canMod) return json(res, 403, { error: 'Sem permissao para apagar esta mensagem' });
    store.db.messages = store.db.messages.filter(m => m.id !== msg.id);
    store.save();
    broadcastMessageEvent(msg, {
      type: 'message_delete',
      messageId: msg.id,
      channelId: msg.channelId
    });
    return json(res, 200, { ok: true });
  }

  return json(res, 404, { error: 'Rota nao encontrada' });
}

const lastMessageAt = new Map();
const lastTypingAt = new Map();

function serveFileFromDisk(res, filePath, downloadName) {
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('Nao encontrado');
    }
    const ext = path.extname(filePath).toLowerCase();
    const headers = { 'Content-Type': MIME[ext] || 'application/octet-stream' };
    if (downloadName) {
      headers['Content-Disposition'] = `attachment; filename*=UTF-8''${encodeURIComponent(downloadName)}`;
    }
    res.writeHead(200, headers);
    res.end(data);
  });
}

function serveStatic(req, res, url) {
  let filePath = decodeURIComponent(url.pathname);
  if (filePath === '/') filePath = '/index.html';

  if (filePath.startsWith('/files/')) {
    const fileName = filePath.slice('/files/'.length);
    if (!/^[A-Za-z0-9._-]+$/.test(fileName)) {
      res.writeHead(400);
      return res.end('Nome invalido');
    }
    return serveFileFromDisk(res, path.join(UPLOAD_DIR, fileName), url.searchParams.get('download') || undefined);
  }

  const resolved = path.normalize(path.join(PUBLIC_DIR, filePath));
  if (!resolved.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    return res.end('Proibido');
  }
  serveFileFromDisk(res, resolved);
}

function handleSse(req, res, url) {
  res.writeHead(410);
  res.end('use /ws');
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  try {
    if (url.pathname === '/sse') return handleSse(req, res, url);
    if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url);
    serveStatic(req, res, url);
  } catch (err) {
    console.error(err);
    if (!res.headersSent) {
      const status = err.message === 'body_too_large' ? 413 : err.message === 'invalid_json' ? 400 : 500;
      json(res, status, { error: 'Erro interno' });
    }
  }
});

const backup = require('./lib/backup');
backup.init(store);

process.on('SIGINT', () => {
  console.log('\nSalvando dados...');
  store.flushSync();
  process.exit(0);
});

store.load();
if (!store.db.botTokens) store.db.botTokens = {};
if (!store.db.attachments) store.db.attachments = [];
if (!store.db.friends) store.db.friends = [];
if (!store.db.friendRequests) store.db.friendRequests = [];

function migrate() {
  const botId = ensureNexoBot().id;
  let changed = false;
  for (const m of store.db.members) {
    if (!m.roleIds) {
      m.roleIds = [];
      changed = true;
    }
  }
  for (const msg of store.db.messages) {
    if (!msg.reactions) {
      msg.reactions = {};
      changed = true;
    }
    if (msg.editedAt === undefined) {
      msg.editedAt = null;
      changed = true;
    }
  }
  for (const s of store.db.servers) {
    if (!store.db.channels.some(c => c.serverId === s.id && c.type !== 'voice')) {
      store.db.channels.push({ id: genId(), serverId: s.id, name: 'geral', position: 0, type: 'text' });
      changed = true;
    }
    if (!store.db.channels.some(c => c.serverId === s.id && c.type === 'voice')) {
      store.db.channels.push({ id: genId(), serverId: s.id, name: 'Canal de voz', position: 0, type: 'voice' });
      changed = true;
    }
    if (!isMember(s.id, botId)) {
      store.db.members.push({ serverId: s.id, userId: botId, joinedAt: Date.now() });
      changed = true;
    }
  }
  if (changed) store.save();
}

migrate();

const wss = new WebSocketServer({ noServer: true });

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  if (url.pathname !== '/ws') {
    socket.destroy();
    return;
  }
  const token = url.searchParams.get('token');
  const userId = token ? store.db.sessions[token] : null;
  const user = userId ? store.db.users.find(u => u.id === userId) : null;
  if (!user) {
    try {
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
    } catch {}
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, ws => {
    ws.userId = userId;
    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });

    let wasOnline = sseClients.has(userId) && [...sseClients.get(userId)].some(c => c.readyState === 1);
    if (!wasOnline) sseClients.set(userId, new Set());
    sseClients.get(userId).add(ws);

    if (!wasOnline) broadcastPresence(userId, true);

    ws.on('close', () => {
      const set = sseClients.get(userId);
      if (set) {
        set.delete(ws);
        if ([...set].every(c => c.readyState !== 1)) {
          sseClients.delete(userId);
          leaveVoiceAll(userId);
          broadcastPresence(userId, false);
        }
      }
    });
  });
});

const wsHeartbeat = setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.isAlive === false) { try { ws.terminate(); } catch {} continue; }
    ws.isAlive = false;
    try { ws.ping(); } catch {}
  }
}, 25000);

server.on('error', err => {
  console.error('Erro no servidor:', err.message);
});

server.listen(PORT, () => {
  console.log(`Nexo rodando em http://localhost:${PORT}`);
});
