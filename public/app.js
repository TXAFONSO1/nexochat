window.__nexoBooted = false;

const API = {
  token: localStorage.getItem('nexo_token') || null,
  async req(path, options = {}) {
    const headers = {};
    const isRaw = options.body instanceof FormData || options.body instanceof Blob || options.body instanceof ArrayBuffer;
    if (!isRaw) headers['Content-Type'] = 'application/json';
    if (this.token) headers['Authorization'] = `Bearer ${this.token}`;
    const res = await fetch(path, { ...options, headers });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Erro de rede');
    return data;
  },
  get(path) { return this.req(path); },
  post(path, body) {
    if (body instanceof Blob || body instanceof ArrayBuffer) return this.req(path, { method: 'POST', body });
    return this.req(path, { method: 'POST', body: JSON.stringify(body || {}) });
  },
  patch(path, body) { return this.req(path, { method: 'PATCH', body: JSON.stringify(body || {}) }); },
  del(path) { return this.req(path, { method: 'DELETE' }); }
};

const state = {
  me: null,
  servers: [],
  currentServerId: null,
  channels: [],
  currentChannelId: null,
  members: [],
  onlineIds: new Set(),
  roles: [],
  messages: [],
  unreadServers: new Set(),
  typing: new Map(),
  sse: null,
  lastTypingSent: 0,
  homeMode: false,
  dms: [],
  activeDmPeerId: null,
  unreadDms: new Map(),
  friends: [],
  incomingReqs: [],
  outgoingReqs: [],
  voiceRooms: new Map(),
  pendingAttachments: [],
  unreadChannels: new Map(),
  replyingTo: null,
  haveMoreMessages: false,
  loadingOlder: false
};

const el = id => document.getElementById(id);
const authView = el('auth-view');
const appView = el('app-view');

function initials(name) {
  return name.trim().charAt(0).toUpperCase() || '?';
}

const STATUS_META = {
  online: { color: '#3ba55d', label: 'Online' },
  idle: { color: '#faa61a', label: 'Ausente' },
  dnd: { color: '#ed4245', label: 'Nao perturbe' },
  invisible: { color: '#747f8d', label: 'Invisivel' },
  offline: { color: '#747f8d', label: 'Offline' }
};

function statusDot(user, cls = '') {
  const connected = user.online !== undefined ? user.online : true;
  const st = !connected ? 'offline' : (STATUS_META[user.status] ? user.status : 'online');
  const dot = document.createElement('span');
  dot.className = 'presence-dot status-' + st + ' ' + cls;
  dot.style.background = STATUS_META[st].color;
  const txt = STATUS_META[st].label + (user.statusText ? ` - ${user.statusText}` : '');
  dot.title = txt;
  return dot;
}

function avatarEl(user, cls = '') {
  const div = document.createElement('div');
  div.className = `avatar ${cls}`;
  div.style.background = user.color || '#5865f2';
  if (user.avatarUrl) {
    const img = document.createElement('img');
    img.src = user.avatarUrl;
    img.alt = '';
    img.loading = 'lazy';
    img.addEventListener('error', () => {
      img.remove();
      if (!div.textContent) div.textContent = initials(user.username || '?');
    });
    div.appendChild(img);
  } else {
    div.textContent = initials(user.username || '?');
  }
  return div;
}

function fmtTime(ts) {
  return new Date(ts).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
}

function fmtSize(bytes) {
  if (bytes > 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
  if (bytes > 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return bytes + ' B';
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[c]);
}

function showModal(builder, cls) {
  const modal = el('modal-content');
  modal.className = 'modal ' + (cls || '');
  modal.innerHTML = '';
  builder(modal);
  el('modal-backdrop').classList.remove('hidden');
}

function closeModal() {
  el('modal-backdrop').classList.add('hidden');
}

el('modal-backdrop').addEventListener('click', e => {
  if (e.target === el('modal-backdrop')) closeModal();
});

document.addEventListener('keydown', e => {
  if (e.key === 'Escape') closeModal();
});

async function apiErrorGuard(fn) {
  try {
    return await fn();
  } catch (err) {
    if (err.message === 'Nao autenticado' || err.message === 'Não autenticado') {
      logout();
      return null;
    }
    throw err;
  }
}

let audioCtx = null;
function beep(f1, f2, dur, type = 'sine', gain = 0.07) {
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === 'suspended') audioCtx.resume();
    const t = audioCtx.currentTime;
    const o = audioCtx.createOscillator();
    const g = audioCtx.createGain();
    o.type = type;
    o.frequency.setValueAtTime(f1, t);
    o.frequency.linearRampToValueAtTime(f2, t + dur);
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g);
    g.connect(audioCtx.destination);
    o.start(t);
    o.stop(t + dur);
  } catch {}
}

const playPing = () => beep(880, 1245, 0.16);
const playPop = () => beep(520, 300, 0.09, 'triangle', 0.045);

function desktopNotify(title, body) {
  if (!('Notification' in window) || Notification.permission !== 'granted' || !document.hidden) return;
  try {
    const n = new Notification(title, { body, silent: true });
    setTimeout(() => n.close(), 5000);
  } catch {}
}

function ensureNotifPermission() {
  if ('Notification' in window && Notification.permission === 'default') {
    Notification.requestPermission().catch(() => {});
  }
}

function totalUnread() {
  let n = state.unreadServers.size;
  for (const v of state.unreadDms.values()) n += v;
  return n;
}

function updateTitle() {
  const n = totalUnread();
  document.title = n > 0 ? `(${n}) Nexo` : 'Nexo — chat leve';
}

async function boot() {
  if (!API.token) return showAuth();
  try {
    const data = await API.get('/api/me');
    enterApp(data.user, data.servers);
  } catch {
    localStorage.removeItem('nexo_token');
    API.token = null;
    showAuth();
  }
}

function showAuth() {
  authView.classList.remove('hidden');
  appView.classList.add('hidden');
}

el('tab-login').addEventListener('click', () => switchAuthTab(true));
el('tab-register').addEventListener('click', () => switchAuthTab(false));

function switchAuthTab(loginTab) {
  el('tab-login').classList.toggle('active', loginTab);
  el('tab-register').classList.toggle('active', !loginTab);
  el('login-form').classList.toggle('hidden', !loginTab);
  el('register-form').classList.toggle('hidden', loginTab);
}

el('login-form').addEventListener('submit', async e => {
  e.preventDefault();
  const errBox = el('login-error');
  errBox.classList.add('hidden');
  try {
    const data = await API.post('/api/login', {
      username: el('login-username').value.trim(),
      password: el('login-password').value
    });
    setSession(data);
  } catch (err) {
    errBox.textContent = err.message;
    errBox.classList.remove('hidden');
  }
});

el('register-form').addEventListener('submit', async e => {
  e.preventDefault();
  const errBox = el('reg-error');
  errBox.classList.add('hidden');
  try {
    const data = await API.post('/api/register', {
      username: el('reg-username').value.trim(),
      password: el('reg-password').value
    });
    setSession(data);
  } catch (err) {
    errBox.textContent = err.message;
    errBox.classList.remove('hidden');
  }
});

function setSession(data) {
  API.token = data.token;
  localStorage.setItem('nexo_token', data.token);
  enterApp(data.user, []);
}

function logout() {
  if (state.sse) {
    state.sse.onclose = null;
    try { state.sse.close(); } catch {}
  }
  window.NexoVoice.leave(true).catch(() => {});
  API.post('/api/logout').catch(() => {});
  API.token = null;
  localStorage.removeItem('nexo_token');
  location.reload();
}

el('btn-logout').addEventListener('click', logout);
el('btn-add-friend').addEventListener('click', addFriendModal);
el('me-handle').addEventListener('click', () => {
  navigator.clipboard.writeText(handleOf(state.me));
  const b = el('me-handle');
  const old = b.textContent;
  b.textContent = 'Copiado!';
  setTimeout(() => { b.textContent = old; }, 1200);
});

function connectSSE() {
  if (state.sse) {
    state.sse.onclose = null;
    try { state.sse.close(); } catch {}
  }
  const proto = location.protocol === 'https:' ? 'wss://' : 'ws://';
  let ws;
  try {
    ws = new WebSocket(`${proto}${location.host}/ws?token=${encodeURIComponent(API.token)}`);
  } catch {
    setTimeout(connectSSE, 3000);
    return;
  }
  state.sse = ws;

  ws.onmessage = e => {
    try {
      handleRealtime(JSON.parse(e.data));
    } catch {}
  };

  ws.onclose = () => {
    if (state.sse === ws) setTimeout(connectSSE, 2500);
  };
  ws.onerror = () => {};
}

function handleRealtime(event) {
  switch (event.type) {
    case 'message': onMessage(event.message); break;
    case 'typing': onTyping(event); break;
    case 'presence': onPresence(event); break;
    case 'member_join': onMemberJoin(event); break;
    case 'channel_create': onChannelCreate(event.channel); break;
    case 'dm': onDm(event.message); break;
    case 'signal': window.NexoVoice.handleSignal(event); break;
    case 'voice_state': onVoiceState(event); break;
    case 'reaction_update': onReactionUpdate(event); break;
    case 'message_edit': onMessageEdit(event); break;
    case 'message_delete': onMessageDelete(event); break;
    case 'roles_update': onRolesUpdate(event); break;
    case 'member_update': onMemberUpdate(event); break;
    case 'members_refresh': refreshMembers(); break;
    case 'friend_request': onFriendRequest(event); break;
    case 'friend_accept': loadFriends(); playPing(); break;
    case 'friend_update': loadFriends(); break;
    case 'pins_update': onPinsUpdate(event); break;
    case 'presence_status': onPresenceStatus(event); break;
    case 'member_leave': onMemberLeave(event); break;
    case 'channel_update': onChannelUpdate(event.channel); break;
    case 'server_update': onServerUpdate(event.server); break;
    case 'channel_delete': onChannelDelete(event); break;
    case 'invite_regenerated': onInviteRegenerated(event); break;
    case 'server_deleted': onServerDeleted(event); break;
    case 'you_were_kicked': onYouRemoved(event, 'Voce foi expulso do servidor', event.serverName); break;
    case 'you_were_banned': onYouRemoved(event, 'Voce foi banido do servidor', event.serverName); break;
  }
}

function onPinsUpdate(event) {
  const msg = state.messages.find(m => m.id === event.messageId);
  if (msg) {
    msg.pinned = event.pinned;
    if (messageVisibleNow(msg)) renderMessages();
  }
}

function onPresenceStatus(event) {
  if (event.userId === state.me.id) return;
  const member = state.members.find(m => m.id === event.userId);
  if (member) {
    member.status = event.status;
    member.statusText = event.statusText;
    renderMembers();
  }
  const conv = state.dms.find(d => d.partner.id === event.userId);
  if (conv) {
    conv.partner.status = event.status;
    conv.partner.statusText = event.statusText;
    if (state.homeMode) renderSidebar();
  }
}

function refreshServers() {
  return API.get('/api/me').then(data => {
    state.servers = data.servers || [];
    renderRail();
  }).catch(() => {});
}

function onMemberLeave(event) {
  if (event.serverId !== state.currentServerId) return;
  state.members = state.members.filter(m => m.id !== event.userId);
  renderMembers();
}

function onChannelUpdate(channel) {
  if (!channel || channel.serverId !== state.currentServerId) return;
  const idx = state.channels.findIndex(c => c.id === channel.id);
  if (idx >= 0) state.channels[idx] = channel;
  renderSidebar();
  if (state.currentChannelId === channel.id) updateChatHeader(channel, null);
}

function onChannelDelete(event) {
  if (event.serverId !== state.currentServerId) return;
  state.channels = state.channels.filter(c => c.id !== event.channelId);
  if (state.currentChannelId === event.channelId) {
    const firstText = state.channels.find(c => c.type !== 'voice');
    if (firstText) selectChannel(firstText.id);
    else { state.messages = []; renderMessages(); updateChatHeader(null, null); }
  }
  renderSidebar();
}

function onInviteRegenerated(event) {
  if (event.serverId !== state.currentServerId) return;
  const server = currentServer();
  if (server) server.inviteCode = event.inviteCode;
}

function onServerDeleted(event) {
  const wasCurrent = event.serverId === state.currentServerId;
  state.servers = state.servers.filter(s => s.id !== event.serverId);
  renderRail();
  if (wasCurrent) selectHome();
  alert(`O servidor "${event.serverName}" foi excluido pelo dono.`);
}

function onYouRemoved(event, message, serverName) {
  alert(`${message} "${serverName}".`);
  refreshServers().then(() => {
    if (!state.homeMode && !currentServer()) selectHome();
    else if (event.serverId === state.currentServerId) selectHome();
  });
}

function currentServer() {
  return state.servers.find(s => s.id === state.currentServerId);
}

function canModerateClient(serverId) {
  const server = state.servers.find(s => s.id === serverId) || currentServer();
  if (!server) return false;
  if (server.ownerId === state.me.id) return true;
  const meMember = state.members.find(m => m.id === state.me.id);
  if (!meMember) return false;
  return (meMember.roleIds || []).some(rid =>
    (state.roles || []).some(r => r.id === rid && r.admin)
  );
}

function roleColorOf(user) {
  const member = state.members.find(m => m.id === user.id);
  if (member && member.roleIds && state.roles.length) {
    for (let i = member.roleIds.length - 1; i >= 0; i--) {
      const role = state.roles.find(r => r.id === member.roleIds[i]);
      if (role && role.color) return role.color;
    }
  }
  return user.color;
}

function enterApp(me, servers) {
  state.me = me;
  state.servers = servers || [];
  window.NexoVoice.api = {
    me,
    post: (path, body) => API.post(path, body)
  };
  window.NexoVoice.onChange = () => {
    renderVoiceStage();
    renderSidebar();
  };
  authView.classList.add('hidden');
  appView.classList.remove('hidden');
  ensureNotifPermission();
  renderUserPanel();
  connectSSE();
  loadFriends();
  loadDms();
  selectHome();
}

function welcomeModal() {
  showModal(modal => {
    modal.innerHTML = `
      <h2>Ola, ${escapeHtml(state.me.username)}!</h2>
      <p class="desc">Seu codigo para adicionar amigos e:</p>
      <div class="handle-box" id="w-handle">${escapeHtml(handleOf(state.me))}</div>
      <p class="desc">Compartilhe esse codigo com quem quiser conversar. Voce tambem pode criar um servidor ou entrar com um convite.</p>
      <div class="modal-actions">
        <button class="btn-secondary" id="m-copy">Copiar codigo</button>
        <button class="btn-primary" id="m-create" style="padding:10px 16px;border-radius:6px;">Criar servidor</button>
      </div>`;
    modal.querySelector('#m-create').addEventListener('click', createServerModal);
    const joinBtn = modal.querySelector('#m-join');
    if (joinBtn) joinBtn.remove();
    modal.querySelector('#m-copy').addEventListener('click', () => {
      navigator.clipboard.writeText(handleOf(state.me));
      modal.querySelector('#m-copy').textContent = 'Copiado!';
    });
  });
}

function handleOf(u) {
  return u && u.tag ? `${u.username}#${u.tag}` : (u ? u.username : '');
}

function tagSpan(u) {
  const span = document.createElement('span');
  span.className = 'user-tag';
  span.textContent = u && u.tag ? '#' + u.tag : '';
  return span;
}

function renderUserPanel() {
  const av = el('me-avatar');
  av.innerHTML = '';
  av.style.background = state.me.color;
  if (state.me.avatarUrl) {
    const img = document.createElement('img');
    img.src = state.me.avatarUrl + (state.me.avatarUrl.includes('?') ? '&' : '?') + 't=' + Date.now();
    img.alt = '';
    av.appendChild(img);
  } else {
    av.textContent = initials(state.me.username);
  }
  const st = STATUS_META[state.me.status] ? state.me.status : 'online';
  let dot = av.querySelector('.me-status-dot');
  if (!dot) {
    dot = document.createElement('span');
    dot.className = 'presence-dot me-status-dot';
    av.appendChild(dot);
  }
  dot.className = 'presence-dot me-status-dot status-' + st;
  dot.style.background = STATUS_META[st].color;
  dot.title = STATUS_META[st].label + (state.me.statusText ? ` - ${state.me.statusText}` : '');
  el('me-name').textContent = state.me.username;
  el('me-handle').textContent = handleOf(state.me);
}

function renderRail() {
  const rail = el('server-rail');
  rail.innerHTML = '';

  const homeBtn = document.createElement('button');
  const totalUnreadDms = [...state.unreadDms.values()].reduce((a, b) => a + b, 0) + state.incomingReqs.length;
  homeBtn.className = 'server-icon rail-home' + (state.homeMode ? ' active' : '') + (totalUnreadDms > 0 ? ' unread' : '');
  homeBtn.innerHTML = '&#127968;';
  homeBtn.title = 'Amigos e mensagens diretas';
  homeBtn.addEventListener('click', selectHome);
  rail.appendChild(homeBtn);

  const sep = document.createElement('div');
  sep.className = 'rail-sep';
  rail.appendChild(sep);

  for (const server of state.servers) {
    const btn = document.createElement('button');
    const active = !state.homeMode && server.id === state.currentServerId;
    btn.className = 'server-icon' + (active ? ' active' : '') + (state.unreadServers.has(server.id) ? ' unread' : '');
    btn.title = server.name;
    if (server.iconUrl) {
      btn.textContent = '';
      const img = document.createElement('img');
      img.src = server.iconUrl;
      img.alt = '';
      btn.appendChild(img);
    } else {
      btn.textContent = initials(server.name);
    }
    btn.addEventListener('click', () => selectServer(server.id));
    rail.appendChild(btn);
  }

  const addBtn = document.createElement('button');
  addBtn.className = 'rail-action';
  addBtn.textContent = '+';
  addBtn.title = 'Adicionar servidor';
  addBtn.addEventListener('click', welcomeModal);
  rail.appendChild(addBtn);
  updateTitle();
}

async function loadDms() {
  try {
    const data = await API.get('/api/dms');
    state.dms = data.conversations;
    if (state.homeMode) renderSidebar();
    renderRail();
  } catch {}
}

async function loadFriends() {
  try {
    const data = await API.get('/api/friends');
    state.friends = data.friends || [];
    state.incomingReqs = data.incoming || [];
    state.outgoingReqs = data.outgoing || [];
    if (state.homeMode) renderSidebar();
    renderRail();
  } catch {}
}

function onFriendRequest(event) {
  playPing();
  desktopNotify('Pedido de amizade', `${event.user.username} quer ser seu amigo`);
  state.incomingReqs.push({ id: event.requestId, user: event.user });
  renderRail();
  if (state.homeMode) renderSidebar();
}

function updateHeaderButtons() {
  const isHome = state.homeMode;
  el('btn-add-friend').classList.toggle('hidden', !isHome);
  el('btn-new-channel').classList.toggle('hidden', isHome);
  el('btn-invite').classList.toggle('hidden', isHome);
  el('btn-server-menu').classList.toggle('hidden', isHome);
  const searchBtn = el('btn-search');
  if (searchBtn) searchBtn.classList.toggle('hidden', isHome);
}

async function refreshMembers() {
  if (state.homeMode || !state.currentServerId) return;
  const data = await apiErrorGuard(() => API.get(`/api/servers/${state.currentServerId}/members`));
  if (data) applyMembers(data);
  renderMembers();
}

async function selectHome() {
  state.homeMode = true;
  state.currentServerId = null;
  state.currentChannelId = null;
  state.activeDmPeerId = null;
  el('server-name').textContent = 'Mensagens diretas';
  updateHeaderButtons();
  renderRail();
  renderSidebar();
  state.messages = [];
  renderMessages();
  renderVoiceStage();
  updateChatHeader(null, null);
  loadFriends();
  loadDms();
}

async function selectServer(serverId) {
  state.homeMode = false;
  state.currentServerId = serverId;
  state.currentChannelId = null;
  state.unreadServers.delete(serverId);
  const server = currentServer();
  el('server-name').textContent = server ? server.name : '';
  updateHeaderButtons();
  renderRail();

  const [chData, memData] = await Promise.all([
    apiErrorGuard(() => API.get(`/api/servers/${serverId}/channels`)),
    apiErrorGuard(() => API.get(`/api/servers/${serverId}/members`))
  ]);
  if (!chData) return;
  state.channels = chData.channels;
  if (memData) applyMembers(memData);

  const firstText = state.channels.find(c => c.type !== 'voice') || state.channels[0];
  renderSidebar();
  renderMembers();
  if (firstText) {
    selectChannel(firstText.id);
  } else {
    state.messages = [];
    renderMessages();
    updateChatHeader(null, null);
  }
}

function applyMembers(data) {
  state.members = data.members;
  state.onlineIds = new Set(data.online);
  state.onlineIds.add(state.me.id);
  state.roles = data.roles || [];
}

function renderSidebar() {
  if (state.homeMode) return renderDmList();
  renderChannels();
}

function renderChannels() {
  const list = el('channel-list');
  list.innerHTML = '';

  const textChannels = state.channels.filter(c => c.type !== 'voice');
  const voiceChannels = state.channels.filter(c => c.type === 'voice');

  const cat1 = document.createElement('div');
  cat1.className = 'channel-category-inline';
  cat1.textContent = 'CANAIS DE TEXTO';
  list.appendChild(cat1);
  for (const ch of textChannels) list.appendChild(channelItem(ch));

  const cat2 = document.createElement('div');
  cat2.className = 'channel-category-inline';
  cat2.textContent = 'CANAIS DE VOZ';
  list.appendChild(cat2);
  for (const ch of voiceChannels) {
    list.appendChild(channelItem(ch));
    const roomUsers = state.voiceRooms.get(ch.id);
    if (roomUsers) {
      for (const u of roomUsers) {
        const item = document.createElement('div');
        item.className = 'voice-participant';
        item.appendChild(avatarEl(u, 'avatar-sm'));
        const name = document.createElement('span');
        name.textContent = u.username;
        item.appendChild(name);
        list.appendChild(item);
      }
    }
  }

  if (!textChannels.length && !voiceChannels.length) {
    const empty = document.createElement('div');
    empty.className = 'channel-category-inline';
    empty.textContent = 'Nenhum canal ainda';
    list.appendChild(empty);
  }
}

function channelItem(ch) {
  const isVoice = ch.type === 'voice';
  const btn = document.createElement('button');
  const selected = ch.id === state.currentChannelId && !state.homeMode;
  btn.className = 'channel-item' + (selected ? ' active' : '') + (isVoice ? ' voice-item' : '');
  btn.innerHTML = isVoice ? '<span class="hash">&#128266;</span>' : '<span class="hash">#</span>';
  const label = document.createElement('span');
  label.textContent = ch.name;
  btn.appendChild(label);
  if (!isVoice) {
    const unread = state.unreadChannels.get(ch.id) || 0;
    if (unread > 0) {
      const badge = document.createElement('span');
      badge.className = 'unread-badge';
      badge.textContent = unread;
      btn.appendChild(badge);
      btn.classList.add('has-unread');
    }
    if (!state.homeMode && canModerateClient(state.currentServerId)) {
      const gear = document.createElement('span');
      gear.className = 'channel-gear';
      gear.innerHTML = '&#9881;';
      gear.title = 'Editar / excluir canal';
      gear.addEventListener('click', e => {
        e.stopPropagation();
        channelManageModal(ch);
      });
      btn.appendChild(gear);
    }
  }
  if (isVoice) {
    const roomUsers = state.voiceRooms.get(ch.id);
    if (roomUsers && roomUsers.length) {
      const badge = document.createElement('span');
      badge.className = 'voice-count';
      badge.textContent = roomUsers.length;
      btn.appendChild(badge);
    }
  }
  btn.addEventListener('click', async () => {
    if (isVoice) {
      try {
        await window.NexoVoice.join(ch);
      } catch (err) {
        alert(err.message);
      }
      if (!state.homeMode && state.currentServerId === ch.serverId) {
        await selectChannel(ch.id, true);
      }
      return;
    }
    selectChannel(ch.id);
  });
  return btn;
}

function botTag() {
  const tag = document.createElement('span');
  tag.className = 'bot-tag';
  tag.textContent = 'BOT';
  return tag;
}

function renderDmList() {
  const list = el('channel-list');
  list.innerHTML = '';

  const addBtn = document.createElement('button');
  addBtn.className = 'dm-new-btn';
  addBtn.textContent = '+ Adicionar amigo';
  addBtn.addEventListener('click', addFriendModal);
  list.appendChild(addBtn);

  if (state.incomingReqs.length) {
    const lbl = document.createElement('div');
    lbl.className = 'section-label';
    lbl.textContent = `SOLICITACOES — ${state.incomingReqs.length}`;
    list.appendChild(lbl);
    for (const req of state.incomingReqs) list.appendChild(requestRow(req));
  }
  if (state.outgoingReqs.length) {
    const lbl = document.createElement('div');
    lbl.className = 'section-label';
    lbl.textContent = `ENVIADOS — ${state.outgoingReqs.length}`;
    list.appendChild(lbl);
    for (const req of state.outgoingReqs) {
      const row = document.createElement('div');
      row.className = 'friend-row pending';
      row.appendChild(avatarEl(req.user, 'avatar-sm'));
      const nm = document.createElement('span');
      nm.className = 'friend-name';
      nm.textContent = req.user.username;
      nm.appendChild(tagSpan(req.user));
      nm.style.color = 'var(--text-muted)';
      row.appendChild(nm);
      const tag = document.createElement('span');
      tag.className = 'pending-tag';
      tag.textContent = 'aguardando';
      row.appendChild(tag);
      list.appendChild(row);
    }
  }

  if (state.friends.length) {
    const onlineFriends = state.friends.filter(f => f.online);
    const lbl = document.createElement('div');
    lbl.className = 'section-label';
    lbl.textContent = `AMIGOS — ${onlineFriends.length} ONLINE`;
    list.appendChild(lbl);
    for (const friend of [...state.friends].sort((a, b) => (b.online ? 1 : 0) - (a.online ? 1 : 0))) {
      list.appendChild(friendRow(friend));
    }
  }

  const convLbl = document.createElement('div');
  convLbl.className = 'section-label';
  convLbl.textContent = 'CONVERSAS';
  list.appendChild(convLbl);

  if (!state.dms.length && !state.friends.length && !state.incomingReqs.length) {
    const hint = document.createElement('div');
    hint.className = 'dm-empty-hint';
    hint.textContent = 'Adicione amigos pelo nome de usuario ou entre em um servidor pelo botao + da barra esquerda.';
    list.appendChild(hint);
    return;
  }

  if (!state.dms.length) {
    const hint = document.createElement('div');
    hint.className = 'dm-empty-hint';
    hint.textContent = 'Clique em um amigo para comecar uma conversa.';
    list.appendChild(hint);
    return;
  }

  for (const conv of state.dms) list.appendChild(conversationItem(conv));
}

function requestRow(req) {
  const row = document.createElement('div');
  row.className = 'friend-row';
  row.appendChild(avatarEl(req.user, 'avatar-sm'));
  const nm = document.createElement('span');
  nm.className = 'friend-name';
  nm.textContent = req.user.username;
  nm.appendChild(tagSpan(req.user));
  row.appendChild(nm);

  const accept = document.createElement('button');
  accept.className = 'req-btn accept';
  accept.innerHTML = '&#10003;';
  accept.title = 'Aceitar';
  accept.addEventListener('click', async e => {
    e.stopPropagation();
    try {
      await API.post(`/api/friends/${req.id}`);
      loadFriends();
      loadDms();
    } catch (err) { alert(err.message); }
  });
  row.appendChild(accept);

  const deny = document.createElement('button');
  deny.className = 'req-btn deny';
  deny.innerHTML = '&#10005;';
  deny.title = 'Recusar';
  deny.addEventListener('click', async e => {
    e.stopPropagation();
    try {
      await API.del(`/api/friends/${req.id}`);
      loadFriends();
    } catch (err) { alert(err.message); }
  });
  row.appendChild(deny);
  return row;
}

function friendRow(friend) {
  const item = document.createElement('button');
  item.className = 'friend-row clickable';
  item.appendChild(statusDot(friend));
  item.appendChild(avatarEl(friend, 'avatar-sm'));
  const nm = document.createElement('span');
  nm.className = 'friend-name';
  nm.textContent = friend.username;
  nm.appendChild(tagSpan(friend));
  const connected = !!friend.online;
  const stKey = !connected ? 'offline' : (STATUS_META[friend.status] ? friend.status : 'online');
  nm.style.color = connected ? friend.color : 'var(--text-muted)';
  if (friend.statusText) nm.title = STATUS_META[stKey].label + ' - ' + friend.statusText;
  item.appendChild(nm);

  const rm = document.createElement('button');
  rm.className = 'req-btn deny';
  rm.innerHTML = '&#128465;';
  rm.title = 'Remover amigo';
  rm.addEventListener('click', async e => {
    e.stopPropagation();
    if (!confirm(`Remover ${friend.username} dos amigos?`)) return;
    try {
      await API.post('/api/friends/remove', { userId: friend.id });
      loadFriends();
    } catch (err) { alert(err.message); }
  });
  item.appendChild(rm);

  item.addEventListener('click', () => openDmFromAnywhere(friend.id));
  return item;
}

function conversationItem(conv) {
  const item = document.createElement('button');
  item.className = 'dm-item' + (conv.partner.id === state.activeDmPeerId ? ' active' : '');
  item.appendChild(avatarEl(conv.partner, 'avatar-sm'));
  const wrap = document.createElement('div');
  wrap.className = 'dm-item-info';
  const nameRow = document.createElement('div');
  nameRow.className = 'dm-name-row';
  const name = document.createElement('strong');
  name.textContent = conv.partner.username;
  name.style.color = conv.online ? conv.partner.color : 'var(--text-muted)';
  nameRow.appendChild(name);
  if (conv.partner.isBot) nameRow.appendChild(botTag());
  wrap.appendChild(nameRow);
  const preview = document.createElement('span');
  preview.className = 'dm-preview';
  const prefix = conv.lastMessage.fromMe ? 'Voce: ' : '';
  preview.textContent = prefix + ((conv.lastMessage.content || '').slice(0, 28) || 'Nova conversa');
  wrap.appendChild(preview);
  item.appendChild(wrap);
  const unread = state.unreadDms.get(conv.partner.id) || 0;
  if (unread > 0) {
    const badge = document.createElement('span');
    badge.className = 'unread-badge';
    badge.textContent = unread;
    item.appendChild(badge);
  }
  item.addEventListener('click', () => openDm(conv.partner.id));
  return item;
}

function addFriendModal() {
  showModal(modal => {
    modal.innerHTML = `
      <h2>Adicionar amigo</h2>
      <p class="desc">Digite o nome de usuario exato da pessoa.</p>
      <label>Nome de usuario
        <input type="text" id="m-fr-username" maxlength="32" placeholder="ex: Neemias#18263" autofocus>
      </label>
      <div class="auth-error hidden" id="m-fr-error"></div>
      <p class="desc hidden" id="m-fr-ok" style="color:#57f287;"></p>
      <div id="m-fr-pending"></div>
      <div class="modal-actions">
        <button class="btn-secondary" id="m-close">Fechar</button>
        <button class="btn-primary" id="m-send-req" style="padding:10px 16px;border-radius:6px;">Enviar pedido</button>
      </div>`;
    const inputEl = modal.querySelector('#m-fr-username');
    inputEl.focus();

    const renderPending = () => {
      const box = modal.querySelector('#m-fr-pending');
      box.innerHTML = '';
      if (!state.outgoingReqs.length) return;
      const p = document.createElement('p');
      p.className = 'desc';
      p.textContent = 'Pedidos aguardando: ' + state.outgoingReqs.map(r => r.user.username).join(', ');
      box.appendChild(p);
    };
    renderPending();

    modal.querySelector('#m-send-req').addEventListener('click', async () => {
      const errBox = modal.querySelector('#m-fr-error');
      const okBox = modal.querySelector('#m-fr-ok');
      errBox.classList.add('hidden');
      okBox.classList.add('hidden');
      try {
        const res = await API.post('/api/friends/request', { username: inputEl.value.trim() });
        inputEl.value = '';
        okBox.textContent = res.friend ? 'Voces agora sao amigos!' : 'Pedido enviado!';
        okBox.classList.remove('hidden');
        renderPending();
        loadFriends();
      } catch (err) {
        errBox.textContent = err.message;
        errBox.classList.remove('hidden');
      }
    });
    inputEl.addEventListener('keydown', async e => {
      if (e.key === 'Enter') modal.querySelector('#m-send-req').click();
    });
    modal.querySelector('#m-close').addEventListener('click', closeModal);
  });
}

async function openDm(peerId) {
  state.activeDmPeerId = peerId;
  state.unreadDms.delete(peerId);
  clearReplyingTo();
  renderRail();
  renderSidebar();

  const data = await apiErrorGuard(() => API.get(`/api/dms/${peerId}/messages`));
  if (!data) return;
  if (state.activeDmPeerId !== peerId) return;
  state.messages = data.messages;
  state.haveMoreMessages = data.messages.length >= 50;
  state.loadingOlder = false;
  renderMessages();
  updateChatHeader(null, data.peer);
  el('message-input').focus();
}

async function selectChannel(channelId, keepVoice) {
  state.currentChannelId = channelId;
  state.typing.clear();
  renderTyping();
  state.unreadChannels.delete(channelId);
  clearReplyingTo();
  renderChannels();
  const channel = state.channels.find(c => c.id === channelId);
  updateChatHeader(channel, null);

  const data = await apiErrorGuard(() => API.get(`/api/channels/${channelId}/messages`));
  if (!data) return;
  if (state.currentChannelId !== channelId) return;
  state.messages = data.messages;
  state.haveMoreMessages = data.messages.length >= 50;
  state.loadingOlder = false;
  renderMessages();
  renderVoiceStage();
  if (channel && channel.type !== 'voice') el('message-input').focus();
}

function updateChatHeader(channel, dmPeer) {
  const hashEl = document.querySelector('.chat-header .hash');
  if (dmPeer) {
    hashEl.innerHTML = '@';
    el('channel-name').textContent = dmPeer.username;
    el('channel-name').appendChild(tagSpan(dmPeer));
    el('channel-topic').textContent = dmPeer.isBot ? 'Bot' : 'Mensagem direta';
    el('message-input').disabled = false;
    el('message-input').placeholder = `Conversar com @${dmPeer.username}`;
    return;
  }
  if (!channel) {
    hashEl.innerHTML = '@';
    el('channel-name').textContent = state.homeMode ? 'Suas conversas' : 'Nenhum canal';
    el('channel-topic').textContent = state.homeMode ? 'Amigos e mensagens diretas' : '';
    el('message-input').disabled = true;
    el('message-input').placeholder = state.homeMode ? 'Selecione um amigo ou conversa' : 'Selecione um canal';
    return;
  }
  const isVoice = channel.type === 'voice';
  hashEl.innerHTML = isVoice ? '&#128266;' : '#';
  el('channel-name').textContent = channel.name;
  el('channel-topic').textContent = isVoice
    ? 'Canal de voz - chat de texto abaixo'
    : (channel.topic || `Bem-vindo ao #${channel.name}`);
  el('message-input').disabled = false;
  el('message-input').placeholder = isVoice ? `Chat do canal ${channel.name}` : `Conversar em #${channel.name}`;
}

function attachmentEl(att) {
  if ((att.type || '').startsWith('image/')) {
    const img = document.createElement('img');
    img.className = 'msg-image';
    img.src = att.url;
    img.alt = att.name;
    img.loading = 'lazy';
    img.addEventListener('click', () => window.open(att.url, '_blank'));
    return img;
  }
  const card = document.createElement('a');
  card.className = 'file-card';
  card.href = att.url + '?download=' + encodeURIComponent(att.name);
  card.innerHTML = `<span class="file-icon">&#128196;</span>`;
  const info = document.createElement('div');
  info.className = 'file-info';
  const nm = document.createElement('strong');
  nm.textContent = att.name;
  const sz = document.createElement('span');
  sz.textContent = fmtSize(att.size);
  info.appendChild(nm);
  info.appendChild(sz);
  card.appendChild(info);
  return card;
}

const EMOJIS = [
  '\u{1F600}','\u{1F602}','\u{1F60A}','\u{1F60D}','\u{1F60E}','\u{1F929}','\u{1F62D}','\u{1F631}','\u{1F621}','\u{1F644}',
  '\u{1F60F}','\u{1F914}','\u{1F910}','\u{1F634}','\u{1F974}','\u{1F920}','\u{1F973}','\u{1F976}','\u{1F971}','\u{1F636}',
  '\u{1F44D}','\u{1F44C}','\u{1F44B}','\u{1F64C}','\u{1F64F}','\u{1F91D}','\u{1F4AA}','\u{1F44E}','\u{1F44A}','\u{270C}',
  '\u2764','\u{1F49B}','\u{1F49A}','\u{1F499}','\u{1F49C}','\u{1F494}','\u{1F498}','\u{1F381}','\u{1F389}','\u{1F382}',
  '\u{1F525}','\u{2B50}','\u{1F31F}','\u26A1','\u{1F4A5}','\u{1F4AF}','\u{1F680}','\u{1F31E}','\u{1F31D}','\u2601',
  '\u{1F43A}','\u{1F430}','\u{1F43C}','\u{1F435}','\u{1F98A}','\u{1F436}','\u{1F431}','\u{1F42F}','\u{1F984}','\u{1F41D}',
  '\u{1F355}','\u{1F354}','\u{1F35F}','\u{1F32D}','\u{1F36B}','\u{1F369}','\u{2615}','\u{1F37A}','\u{1F34E}','\u{1F951}',
  '\u26BD','\u{1F3C0}','\u{1F3BE}','\u{1F3AE}','\u{1F3A7}','\u{1F3B5}','\u{1F3AC}','\u{1F3AF}','\u{1F3C6}','\u{1F947}',
  '\u{1F4BB}','\u{1F4F1}','\u{1F4A1}','\u{1F4DA}','\u270F','\u{1F511}','\u{1F512}','\u{1F4B0}','\u{1F4C8}','\u23F0',
  '\u{1F44D}\u{1F3FB}','\u{1F937}','\u{1F926}','\u{1F64B}','\u{1F483}','\u{1F57A}','\u{1F607}','\u{1F608}','\u{1F921}','\u{1F47B}'
];

function emojiPicker(callback, small) {
  showModal(modal => {
    modal.innerHTML = `
      <h2>Escolha um emoji</h2>
      <div class="emoji-grid" id="emoji-grid"></div>`;
    if (small) modal.classList.add('modal-sm');
    const grid = modal.querySelector('#emoji-grid');
    for (const em of EMOJIS) {
      const b = document.createElement('button');
      b.className = 'emoji-cell';
      b.textContent = em;
      b.addEventListener('click', () => {
        closeModal();
        callback(em);
      });
      grid.appendChild(b);
    }
  }, small ? 'modal-sm' : '');
}

function insertEmojiAtCursor(em) {
  const inp = el('message-input');
  if (inp.disabled) return;
  const selStart = inp.selectionStart === null || inp.selectionStart === undefined ? inp.value.length : inp.selectionStart;
  const selEnd = inp.selectionEnd === null || inp.selectionEnd === undefined ? selStart : inp.selectionEnd;
  inp.value = inp.value.slice(0, selStart) + em + inp.value.slice(selEnd);
  inp.focus();
  inp.selectionStart = inp.selectionEnd = selStart + em.length;
}

el('btn-emoji').addEventListener('click', () => emojiPicker(insertEmojiAtCursor));

function findKnownUser(username) {
  const lower = username.toLowerCase();
  const m = state.members.find(x => x.username.toLowerCase() === lower);
  if (m) return m;
  const peer = state.dms.find(d => d.partner.username.toLowerCase() === lower);
  return peer ? peer.partner : null;
}

function contentWithMentions(text) {
  const frag = document.createDocumentFragment();
  const re = /@([A-Za-z0-9_]{3,24})/g;
  let last = 0;
  let match;
  while ((match = re.exec(text)) !== null) {
    frag.appendChild(document.createTextNode(text.slice(last, match.index)));
    const known = findKnownUser(match[1]);
    if (known) {
      const span = document.createElement('span');
      span.className = 'mention' + (known.id === state.me.id ? ' mention-me' : '');
      span.textContent = '@' + known.username;
      frag.appendChild(span);
    } else {
      frag.appendChild(document.createTextNode(match[0]));
    }
    last = match.index + match[0].length;
  }
  frag.appendChild(document.createTextNode(text.slice(last)));
  return frag;
}

function reactionsEl(msg) {
  const box = document.createElement('div');
  box.className = 'reactions-row';
  const entries = Object.entries(msg.reactions || {}).filter(([, ids]) => ids.length > 0);
  for (const [emoji, ids] of entries) {
    const chip = document.createElement('button');
    chip.className = 'reaction-chip' + (ids.includes(state.me.id) ? ' mine' : '');
    chip.textContent = `${emoji} ${ids.length}`;
    chip.title = ids.map(uid => {
      const m = state.members.find(x => x.id === uid);
      return m ? m.username : uid === state.me.id ? state.me.username : 'alguem';
    }).join(', ');
    chip.addEventListener('click', () => toggleReaction(msg, emoji));
    box.appendChild(chip);
  }
  const addBtn = document.createElement('button');
  addBtn.className = 'reaction-add';
  addBtn.textContent = '+';
  addBtn.title = 'Adicionar reacao';
  addBtn.addEventListener('click', () => emojiPicker(em => toggleReaction(msg, em), true));
  box.appendChild(addBtn);
  return box;
}

async function toggleReaction(msg, emoji) {
  try {
    await apiErrorGuard(() => API.post(`/api/messages/${msg.id}/reactions`, { emoji }));
  } catch (err) {
    alert(err.message);
  }
}

function messageActions(msg) {
  const bar = document.createElement('div');
  bar.className = 'msg-actions';

  const mkBtn = (icon, title, fn) => {
    const b = document.createElement('button');
    b.innerHTML = icon;
    b.title = title;
    b.addEventListener('click', fn);
    bar.appendChild(b);
  };

  mkBtn('&#8617;', 'Responder', () => setReplyingTo(msg));
  mkBtn('&#128512;', 'Reagir', () => emojiPicker(em => toggleReaction(msg, em), true));

  const canPin = msg.userId === state.me.id ||
    (!state.homeMode && msg.serverId && canModerateClient(msg.serverId));
  if (canPin) {
    mkBtn('&#128204;', msg.pinned ? 'Desafixar' : 'Fixar mensagem', async () => {
      try {
        await apiErrorGuard(() => API.post(`/api/messages/${msg.id}/pin`));
      } catch (err) {
        alert(err.message);
      }
    });
  }

  if (msg.userId === state.me.id) {
    mkBtn('&#9999;', 'Editar', () => startEditMessage(msg));
  }

  const canDelete = msg.userId === state.me.id ||
    (!state.homeMode && msg.serverId && canModerateClient(msg.serverId));
  if (canDelete) {
    mkBtn('&#128465;', 'Apagar', async () => {
      if (!confirm('Apagar esta mensagem?')) return;
      try {
        await apiErrorGuard(() => API.del(`/api/messages/${msg.id}`));
      } catch (err) {
        alert(err.message);
      }
    });
  }
  return bar;
}

function startEditMessage(msg) {
  const row = document.querySelector(`.message[data-id="${msg.id}"] .message-body`);
  if (!row) return;
  const contentDiv = row.querySelector('.message-content');
  if (!contentDiv) return;

  const editor = document.createElement('div');
  editor.className = 'edit-box';
  const ta = document.createElement('textarea');
  ta.value = msg.content;
  ta.rows = Math.min(Math.ceil(msg.content.length / 80) + 1, 6);
  const actions = document.createElement('div');
  actions.className = 'edit-actions';
  actions.innerHTML = `
    <span>enter para salvar - esc para cancelar</span>
    <button class="btn-primary" style="padding:4px 12px;border-radius:5px;font-size:12px;">Salvar</button>`;
  editor.appendChild(ta);
  editor.appendChild(actions);
  contentDiv.replaceWith(editor);
  ta.focus();

  const save = async () => {
    const val = ta.value.trim();
    if (!val || val === msg.content) return renderMessages();
    try {
      await apiErrorGuard(() => API.patch(`/api/messages/${msg.id}`, { content: val }));
    } catch (err) {
      alert(err.message);
      renderMessages();
    }
  };
  ta.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      save();
    } else if (e.key === 'Escape') {
      renderMessages();
    }
  });
  actions.querySelector('button').addEventListener('click', save);
}

function messageEl(msg, grouped) {
  const row = document.createElement('div');
  row.className = 'message' + (grouped ? ' grouped' : '') + (msg.pinned ? ' pinned-msg' : '');
  row.dataset.id = msg.id;

  if (msg.pinned) {
    const flag = document.createElement('span');
    flag.className = 'pin-flag';
    flag.innerHTML = '&#128204;';
    flag.title = 'Mensagem fixada';
    row.appendChild(flag);
  }

  const body = document.createElement('div');
  body.className = 'message-body';

  if (msg.replyTo) {
    const quote = document.createElement('div');
    quote.className = 'reply-quote';
    const qname = document.createElement('span');
    qname.className = 'rq-name';
    qname.textContent = msg.replyTo.username;
    const qtext = document.createElement('span');
    qtext.className = 'rq-text';
    qtext.textContent = msg.replyTo.hasAttachment ? '(anexo)' : msg.replyTo.content;
    quote.appendChild(qname);
    quote.appendChild(qtext);
    quote.title = 'Ir para a mensagem original';
    quote.addEventListener('click', () => jumpToMessage(msg.replyTo.id));
    body.appendChild(quote);
  }

  if (!grouped) {
    row.appendChild(avatarEl({ color: roleColorOf(msg), username: msg.username }));
    const meta = document.createElement('div');
    meta.className = 'message-meta';
    const author = document.createElement('strong');
    author.textContent = msg.username;
    author.style.color = roleColorOf(msg);
    meta.appendChild(author);
    if (msg.isBot) meta.appendChild(botTag());
    const time = document.createElement('span');
    time.className = 'message-time';
    time.textContent = `Hoje as ${fmtTime(msg.createdAt)}`;
    time.title = new Date(msg.createdAt).toLocaleString('pt-BR');
    meta.appendChild(time);
    if (msg.editedAt) {
      const ed = document.createElement('span');
      ed.className = 'edited-tag';
      ed.textContent = '(editado)';
      meta.appendChild(ed);
    }
    body.appendChild(meta);
  }

  if (msg.content) {
    const content = document.createElement('div');
    content.className = 'message-content';
    content.appendChild(contentWithMentions(msg.content));
    body.appendChild(content);
  }

  for (const att of msg.attachments || []) {
    body.appendChild(attachmentEl(att));
  }

  const hasReactions = Object.values(msg.reactions || {}).some(ids => ids.length > 0);
  if (hasReactions) body.appendChild(reactionsEl(msg));

  row.appendChild(messageActions(msg));
  row.appendChild(body);
  return row;
}

function renderMessages() {
  const box = el('messages');
  const prevScroll = box.scrollHeight - box.scrollTop;
  box.innerHTML = '';
  if (!state.messages.length) {
    let ctxName;
    if (state.homeMode && state.activeDmPeerId) {
      const dm = state.dms.find(d => d.partner.id === state.activeDmPeerId);
      ctxName = '@' + (dm ? dm.partner.username : '');
    } else if (state.homeMode) {
      ctxName = 'Mensagens diretas';
    } else {
      const ch = state.channels.find(c => c.id === state.currentChannelId);
      ctxName = '#' + (ch ? ch.name : '');
    }
    const welcome = document.createElement('div');
    welcome.className = 'welcome-block';
    welcome.innerHTML = `<h2>${escapeHtml(ctxName)}</h2><div>Este e o inicio da conversa. Diga oi!</div>`;
    box.appendChild(welcome);
    return;
  }
  let prevUser = null;
  let prevTime = 0;
  for (const msg of state.messages) {
    const grouped = prevUser === msg.userId && msg.createdAt - prevTime < 5 * 60 * 1000;
    box.appendChild(messageEl(msg, grouped));
    prevUser = msg.userId;
    prevTime = msg.createdAt;
  }
  if (box.scrollHeight - box.scrollTop < prevScroll + 60) {
    box.scrollTop = box.scrollHeight;
  }
}

function scrollToBottom(force) {
  const box = el('messages');
  const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 150;
  if (force || nearBottom) box.scrollTop = box.scrollHeight;
}

function appendMessageLive(msg) {
  state.messages.push(msg);
  const box = el('messages');
  if (box.querySelector('.welcome-block')) box.innerHTML = '';
  const prev = state.messages[state.messages.length - 2];
  const grouped = prev && prev.userId === msg.userId && msg.createdAt - prev.createdAt < 5 * 60 * 1000;
  box.appendChild(messageEl(msg, grouped));
  scrollToBottom(false);
}

function messageVisibleNow(msg) {
  if (state.homeMode) {
    const parts = msg.channelId.split('_');
    return state.activeDmPeerId && parts.includes(state.activeDmPeerId);
  }
  return msg.channelId === state.currentChannelId;
}

function notifyForMessage(msg, forcePing) {
  const mentionsMe = msg.content && msg.content.toLowerCase().includes('@' + state.me.username.toLowerCase());
  if (mentionsMe || forcePing) {
    playPing();
    desktopNotify(`${msg.username} mencionou voce / DM`, msg.content || 'Enviou um anexo');
  } else {
    playPop();
  }
}

function onMessage(message) {
  if (message.serverId !== state.currentServerId || state.homeMode) {
    state.unreadServers.add(message.serverId);
    if (message.userId !== state.me.id) {
      state.unreadChannels.set(message.channelId, (state.unreadChannels.get(message.channelId) || 0) + 1);
    }
    renderRail();
    notifyForMessage(message, false);
    return;
  }
  if (message.channelId !== state.currentChannelId) {
    if (message.userId !== state.me.id) {
      state.unreadChannels.set(message.channelId, (state.unreadChannels.get(message.channelId) || 0) + 1);
      renderChannels();
    }
    return;
  }
  appendMessageLive(message);
  clearTyping(message.userId);
  notifyForMessage(message, false);
}

function onDm(message) {
  const parts = message.channelId.split('_');
  const partnerId = parts[1] === state.me.id ? parts[2] : parts[1];

  const conv = state.dms.find(d => d.partner.id === partnerId);
  if (conv) {
    conv.lastMessage = { content: message.content, createdAt: message.createdAt, fromMe: message.userId === state.me.id };
  } else {
    loadDms();
  }

  const isOpenHere = state.homeMode && state.activeDmPeerId === partnerId;
  if (isOpenHere) {
    appendMessageLive(message);
  } else if (message.userId !== state.me.id) {
    state.unreadDms.set(partnerId, (state.unreadDms.get(partnerId) || 0) + 1);
    notifyForMessage(message, true);
  }
  renderRail();
  if (state.homeMode) renderSidebar();
}

let typingTimer = null;

function renderTyping() {
  const box = el('typing-indicator');
  const names = [...state.typing.values()];
  if (!names.length) {
    box.textContent = '';
    return;
  }
  const label = names.length === 1 ? `${names[0]} esta digitando` : `${names.slice(0, 2).join(', ')} estao digitando`;
  box.textContent = `${label}...`;
}

function clearTyping(userId) {
  if (state.typing.delete(userId)) renderTyping();
  clearTimeout(typingTimer);
  typingTimer = setTimeout(renderTyping, 4000);
}

function onTyping(event) {
  if (event.userId === state.me.id) return;
  let expected = state.currentChannelId;
  if (state.homeMode && state.activeDmPeerId) {
    expected = dmKeyClient(state.me.id, state.activeDmPeerId);
  }
  if (!expected || event.channelId !== expected) return;
  state.typing.set(event.userId, event.username);
  renderTyping();
  clearTimeout(typingTimer);
  typingTimer = setTimeout(() => {
    state.typing.clear();
    renderTyping();
  }, 3500);
}

function dmKeyClient(a, b) {
  return 'dm_' + [a, b].sort().join('_');
}

function onPresence(event) {
  const member = state.members.find(m => m.id === event.userId);
  if (member) {
    member.status = event.status || member.status;
    member.statusText = event.statusText || '';
  } else if (event.online) {
    state.members.push({ id: event.userId, username: event.username, tag: null, color: event.color, status: 'online', statusText: '' });
  }
  if (event.online) {
    state.onlineIds.add(event.userId);
  } else {
    state.onlineIds.delete(event.userId);
  }
  renderMembers();
  const conv = state.dms.find(d => d.partner.id === event.userId);
  if (conv) {
    conv.online = event.online;
    if (state.homeMode) renderSidebar();
  }
}

function onMemberJoin(event) {
  if (event.serverId !== state.currentServerId) return;
  if (!state.members.some(m => m.id === event.user.id)) {
    state.members.push({ ...event.user, roleIds: [] });
    renderMembers();
  }
}

function onChannelCreate(channel) {
  if (channel.serverId !== state.currentServerId) return;
  if (!state.channels.some(c => c.id === channel.id)) {
    state.channels.push(channel);
    renderSidebar();
  }
}

function onServerUpdate(server) {
  const idx = state.servers.findIndex(s => s.id === server.id);
  if (idx >= 0) state.servers[idx] = { ...state.servers[idx], ...server };
  else state.servers.push(server);
  renderRail();
}

function onVoiceState(event) {
  if (event.serverId !== state.currentServerId && !state.voiceRooms.has(event.channelId)) {
    if (window.NexoVoice.channelId !== event.channelId) return;
  }
  if (event.users.length === 0) {
    state.voiceRooms.delete(event.channelId);
  } else {
    state.voiceRooms.set(event.channelId, event.users);
  }
  renderSidebar();
}

function onReactionUpdate(event) {
  const msg = state.messages.find(m => m.id === event.messageId);
  if (!msg) return;
  msg.reactions = event.reactions;
  if (messageVisibleNow(msg)) renderMessages();
}

function onMessageEdit(event) {
  const msg = state.messages.find(m => m.id === event.messageId);
  if (!msg) return;
  msg.content = event.content;
  msg.editedAt = event.editedAt;
  if (messageVisibleNow(msg)) renderMessages();
}

function onMessageDelete(event) {
  const idx = state.messages.findIndex(m => m.id === event.messageId);
  if (idx < 0) return;
  state.messages.splice(idx, 1);
  if (messageVisibleNow(event)) renderMessages();
}

function onRolesUpdate(event) {
  if (event.serverId !== state.currentServerId) return;
  state.roles = event.roles;
  renderMembers();
  renderMessages();
}

function onMemberUpdate(event) {
  if (event.serverId !== state.currentServerId) return;
  const member = state.members.find(m => m.id === event.userId);
  if (member) member.roleIds = event.roleIds;
  renderMembers();
  renderMessages();
}

function renderMembers() {
  const onlineBox = el('members-online');
  const offlineBox = el('members-offline');
  onlineBox.innerHTML = '';
  offlineBox.innerHTML = '';

  const sorted = [...state.members].sort((a, b) => a.username.localeCompare(b.username, 'pt-BR'));
  let onlineCount = 0;
  for (const member of sorted) {
    const isOnline = state.onlineIds.has(member.id);
    if (isOnline) onlineCount++;
    const item = document.createElement('div');
    item.className = 'member-item' + (isOnline ? '' : ' offline');
    item.appendChild(avatarEl(member, 'avatar-sm'));
    const name = document.createElement('span');
    name.className = 'member-name-click';
    name.textContent = member.username + (member.id === state.me.id ? ' (voce)' : '');
    name.style.color = isOnline ? roleColorOf(member) : 'var(--text-muted)';
    name.title = handleOf(member) + ' - Ver perfil / cargos';
    name.addEventListener('click', () => memberModal(member));
    item.appendChild(name);
    if (member.isBot) item.appendChild(botTag());
    (isOnline ? onlineBox : offlineBox).appendChild(item);
  }
  el('online-count').textContent = onlineCount;
  el('offline-count').textContent = sorted.length - onlineCount;
}

function memberModal(member) {
  const mod = canModerateClient(state.currentServerId);
  showModal(m => {
    const head = document.createElement('div');
    head.className = 'member-modal-head';
    head.appendChild(avatarEl(member));
    const info = document.createElement('div');
    const nm = document.createElement('strong');
    nm.textContent = member.username;
    nm.style.color = roleColorOf(member);
    nm.className = 'member-modal-name';
    info.appendChild(nm);
    if (member.isBot) info.appendChild(botTag());
    const statusLine = document.createElement('div');
    statusLine.className = 'member-modal-status';
    const isConnectedHere = state.onlineIds.has(member.id);
    const stKey = !isConnectedHere ? 'offline' : (STATUS_META[member.status] ? member.status : 'online');
    statusLine.textContent = STATUS_META[stKey].label + (member.statusText ? ` - ${member.statusText}` : '');
    info.appendChild(statusLine);
    if (member.bio) {
      const bioP = document.createElement('div');
      bioP.className = 'member-modal-bio';
      bioP.textContent = member.bio;
      info.appendChild(bioP);
    }
    if (member.tag && !member.isBot) {
      const handleBtn = document.createElement('button');
      handleBtn.className = 'member-modal-handle';
      handleBtn.textContent = handleOf(member);
      handleBtn.title = 'Clique para copiar';
      handleBtn.addEventListener('click', () => {
        navigator.clipboard.writeText(handleOf(member));
        handleBtn.textContent = 'Copiado!';
        setTimeout(() => { handleBtn.textContent = handleOf(member); }, 1200);
      });
      info.appendChild(handleBtn);
    }
    head.appendChild(info);
    m.appendChild(head);

    const actions = document.createElement('div');
    actions.className = 'modal-actions';
    actions.style.flexDirection = 'column';
    actions.style.alignItems = 'stretch';

    if (!member.isBot && member.id !== state.me.id) {
      const dmBtn = document.createElement('button');
      dmBtn.className = 'btn-secondary';
      dmBtn.textContent = 'Enviar mensagem direta';
      dmBtn.addEventListener('click', () => {
        closeModal();
        openDmFromAnywhere(member.id);
      });
      actions.appendChild(dmBtn);
    }

    const server = currentServer();
    if (mod && server && member.id !== state.me.id && server.ownerId !== member.id && !member.isBot) {
      const kickBtn = document.createElement('button');
      kickBtn.className = 'btn-secondary btn-danger-text';
      kickBtn.innerHTML = '&#128296; Expulsar do servidor';
      kickBtn.addEventListener('click', async () => {
        if (!confirm(`Expulsar ${member.username} do servidor?`)) return;
        try {
          await API.post(`/api/servers/${state.currentServerId}/members/${member.id}/kick`);
          closeModal();
        } catch (err) { alert(err.message); }
      });
      actions.appendChild(kickBtn);
      const banBtn = document.createElement('button');
      banBtn.className = 'btn-secondary btn-danger-text';
      banBtn.innerHTML = '&#9940; Banir do servidor';
      banBtn.addEventListener('click', async () => {
        const reason = prompt(`Banir ${member.username}. Motivo (opcional):`) ;
        if (reason === null) return;
        try {
          await API.post(`/api/servers/${state.currentServerId}/members/${member.id}/ban`, { reason });
          closeModal();
        } catch (err) { alert(err.message); }
      });
      actions.appendChild(banBtn);
    }
    m.appendChild(actions);

    if (mod && !member.isBot) {
      const section = document.createElement('div');
      section.className = 'roles-section';
      const h = document.createElement('h4');
      h.textContent = 'CARGOS';
      section.appendChild(h);

      if (!state.roles.length) {
        const p = document.createElement('p');
        p.className = 'desc';
        p.textContent = 'Nenhum cargo criado ainda. Use o menu do servidor para criar cargos.';
        section.appendChild(p);
      }

      for (const role of state.roles) {
        const labelWrap = document.createElement('label');
        labelWrap.className = 'role-check';
        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.checked = (member.roleIds || []).includes(role.id);
        cb.addEventListener('change', async () => {
          try {
            await API.post(`/api/servers/${state.currentServerId}/members/${member.id}/roles`, { roleId: role.id });
          } catch (err) {
            alert(err.message);
            cb.checked = !cb.checked;
          }
        });
        const dot = document.createElement('span');
        dot.className = 'role-dot';
        dot.style.background = role.color;
        const lbl = document.createElement('span');
        lbl.textContent = role.name + (role.admin ? ' (admin)' : '');
        labelWrap.appendChild(cb);
        labelWrap.appendChild(dot);
        labelWrap.appendChild(lbl);
        section.appendChild(labelWrap);
      }
      m.appendChild(section);
    }
  });
}

function rolesManagerModal() {
  const mod = canModerateClient(state.currentServerId);
  if (!mod) return alert('Apenas administradores podem gerenciar cargos.');
  showModal(m => {
    m.innerHTML = `
      <h2>Cargos</h2>
      <p class="desc">Crie cargos com cores e permissao de administrador.</p>
      <div class="roles-list" id="roles-list"></div>
      <label>Novo cargo
        <input type="text" id="m-role-name" maxlength="24" placeholder="Moderador">
      </label>
      <div class="color-swatches" id="color-swatches"></div>
      <label class="role-check" style="margin-bottom:14px;">
        <input type="checkbox" id="m-role-admin">
        <span>Cargo de administrador (pode gerenciar tudo)</span>
      </label>
      <div class="auth-error hidden" id="m-role-error"></div>
      <div class="modal-actions">
        <button class="btn-secondary" id="m-close">Fechar</button>
        <button class="btn-primary" id="m-create-role" style="padding:10px 16px;border-radius:6px;">Criar cargo</button>
      </div>`;

    let selectedColor = '#5865f2';
    const swatches = m.querySelector('#color-swatches');
    for (const c of ['#5865f2','#3ba55c','#faa61a','#ed4245','#eb459e','#9b59b6','#00a8fc','#57f287','#e67e22','#99aab5']) {
      const sw = document.createElement('button');
      sw.className = 'swatch' + (c === selectedColor ? ' selected' : '');
      sw.style.background = c;
      sw.addEventListener('click', () => {
        selectedColor = c;
        swatches.querySelectorAll('.swatch').forEach(x => x.classList.remove('selected'));
        sw.classList.add('selected');
      });
      swatches.appendChild(sw);
    }

    const renderList = () => {
      const list = m.querySelector('#roles-list');
      list.innerHTML = '';
      for (const role of state.roles) {
        const row = document.createElement('div');
        row.className = 'role-row';
        const dot = document.createElement('span');
        dot.className = 'role-dot';
        dot.style.background = role.color;
        const nm = document.createElement('span');
        nm.textContent = role.name + (role.admin ? ' (admin)' : '');
        nm.style.color = role.color;
        const del = document.createElement('button');
        del.textContent = 'x';
        del.title = 'Excluir cargo';
        del.addEventListener('click', async () => {
          if (!confirm(`Excluir cargo "${role.name}"?`)) return;
          try {
            await API.del(`/api/servers/${state.currentServerId}/roles/${role.id}`);
          } catch (err) {
            alert(err.message);
          }
        });
        row.appendChild(dot);
        row.appendChild(nm);
        row.appendChild(del);
        list.appendChild(row);
      }
    };
    renderList();

    m.addEventListener('roles-changed', () => renderList());

    m.querySelector('#m-create-role').addEventListener('click', async () => {
      try {
        await API.post(`/api/servers/${state.currentServerId}/roles`, {
          name: m.querySelector('#m-role-name').value,
          color: selectedColor,
          admin: m.querySelector('#m-role-admin').checked
        });
        m.querySelector('#m-role-name').value = '';
      } catch (err) {
        const eb = m.querySelector('#m-role-error');
        eb.textContent = err.message;
        eb.classList.remove('hidden');
      }
    });

    m.querySelector('#m-close').addEventListener('click', closeModal);
  });
}

async function openDmFromAnywhere(userId) {
  const known = state.dms.some(d => d.partner.id === userId);
  if (!known) {
    let user = state.members.find(m => m.id === userId);
    if (!user) {
      try {
        const data = await API.get(`/api/dms/${userId}/messages`);
        user = data.peer;
      } catch { return; }
    } else {
      user = { id: user.id, username: user.username, tag: user.tag || null, color: user.color, isBot: !!user.isBot };
    }
    if (!state.dms.some(d => d.partner.id === userId)) {
      state.dms.unshift({
        partner: user,
        online: state.onlineIds.has(userId),
        lastMessage: { content: '', createdAt: Date.now(), fromMe: false }
      });
    }
  }
  selectHome();
  openDm(userId);
}

const input = el('message-input');

input.addEventListener('keydown', e => {
  if (e.key === 'Enter') sendMessage();
});
input.addEventListener('input', () => {
  const now = Date.now();
  if (now - state.lastTypingSent <= 2500) return;
  if (!state.homeMode && state.currentChannelId) {
    state.lastTypingSent = now;
    API.post('/api/typing', { channelId: state.currentChannelId }).catch(() => {});
  } else if (state.homeMode && state.activeDmPeerId) {
    state.lastTypingSent = now;
    API.post('/api/typing', { peerId: state.activeDmPeerId }).catch(() => {});
  }
});

el('messages').addEventListener('scroll', async () => {
  const box = el('messages');
  if (box.scrollTop > 80 || state.loadingOlder || !state.haveMoreMessages || !state.messages.length) return;
  const isDm = state.homeMode && !!state.activeDmPeerId;
  if (isDm ? !state.activeDmPeerId : !state.currentChannelId) return;
  state.loadingOlder = true;
  const oldest = state.messages[0].id;
  const ctx = isDm ? state.activeDmPeerId : state.currentChannelId;
  try {
    const url = isDm
      ? `/api/dms/${ctx}/messages?limit=50&before=${oldest}`
      : `/api/channels/${ctx}/messages?limit=50&before=${oldest}`;
    const data = await apiErrorGuard(() => API.get(url));
    if (!data) return;
    const stillSame = isDm ? state.activeDmPeerId === ctx && state.homeMode : state.currentChannelId === ctx && !state.homeMode;
    if (!stillSame) return;
    state.messages = data.messages.concat(state.messages);
    state.haveMoreMessages = data.messages.length >= 50;
    const st = box.scrollTop;
    const sh = box.scrollHeight;
    renderMessages();
    requestAnimationFrame(() => {
      const b = el('messages');
      b.scrollTop = b.scrollHeight - sh + st;
    });
  } catch (err) {
    /* silencioso */
  } finally {
    state.loadingOlder = false;
  }
});

async function sendMessage() {
  const content = input.value.trim();
  const attachmentIds = state.pendingAttachments.map(a => a.attachment.id);
  if (!content && !attachmentIds.length) return;

  const replyToId = state.replyingTo ? state.replyingTo.id : null;
  let request;
  if (state.homeMode && state.activeDmPeerId) {
    request = () => API.post(`/api/dms/${state.activeDmPeerId}/messages`, { content, attachmentIds, replyToId });
  } else if (state.currentChannelId) {
    request = () => API.post(`/api/channels/${state.currentChannelId}/messages`, { content, attachmentIds, replyToId });
  } else {
    return;
  }

  input.value = '';
  clearReplyingTo();
  state.pendingAttachments = [];
  renderAttachmentChips();
  try {
    await apiErrorGuard(request);
  } catch (err) {
    alert(err.message);
  }
}

function setReplyingTo(msg) {
  if (state.homeMode && !state.activeDmPeerId) return;
  state.replyingTo = { id: msg.id, username: msg.username };
  renderReplyChip();
  input.focus();
}

function clearReplyingTo() {
  state.replyingTo = null;
  renderReplyChip();
}

function renderReplyChip() {
  const chip = el('reply-chip');
  if (!chip) return;
  if (!state.replyingTo) {
    chip.classList.add('hidden');
    chip.innerHTML = '';
    return;
  }
  chip.innerHTML = `<span class="reply-chip-label">&#8617; Respondendo a <strong>${escapeHtml(state.replyingTo.username)}</strong></span>`;
  const cancel = document.createElement('button');
  cancel.className = 'reply-chip-cancel';
  cancel.textContent = 'x';
  cancel.title = 'Cancelar resposta';
  cancel.addEventListener('click', clearReplyingTo);
  chip.appendChild(cancel);
  chip.classList.remove('hidden');
}

function renderAttachmentChips() {
  const box = el('attachment-chips');
  box.innerHTML = '';
  for (const p of state.pendingAttachments) {
    const chip = document.createElement('div');
    chip.className = 'attach-chip';
    const label = document.createElement('span');
    label.textContent = p.status === 'sending' ? `Enviando ${p.file.name}...` : p.file.name;
    chip.appendChild(label);
    const rm = document.createElement('button');
    rm.textContent = 'x';
    rm.addEventListener('click', () => {
      state.pendingAttachments = state.pendingAttachments.filter(x => x !== p);
      renderAttachmentChips();
    });
    chip.appendChild(rm);
    box.appendChild(chip);
  }
}

el('btn-attach').addEventListener('click', () => el('file-input').click());

el('file-input').addEventListener('change', async e => {
  const files = [...e.target.files].slice(0, 5);
  e.target.value = '';
  for (const file of files) {
    if (file.size > 20 * 1024 * 1024) {
      alert(`${file.name} passa de 20MB`);
      continue;
    }
    const entry = { file, attachment: null, status: 'sending' };
    state.pendingAttachments.push(entry);
    renderAttachmentChips();
    try {
      const res = await API.post(`/api/upload?name=${encodeURIComponent(file.name)}&type=${encodeURIComponent(file.type || 'application/octet-stream')}`, file);
      entry.attachment = res.attachment;
      entry.status = 'done';
    } catch (err) {
      alert(`Falha ao enviar ${file.name}: ${err.message}`);
      state.pendingAttachments = state.pendingAttachments.filter(x => x !== entry);
    }
    renderAttachmentChips();
  }
});

el('btn-photo').addEventListener('click', cameraModal);

function cameraModal() {
  let stream = null;
  showModal(modal => {
    modal.innerHTML = `
      <h2>Tirar foto</h2>
      <p class="desc">Posicione e capture. A foto sera enviada como imagem.</p>
      <div class="camera-preview"><video id="cam-video" autoplay playsinline muted></video></div>
      <div class="auth-error hidden" id="cam-error"></div>
      <div class="modal-actions">
        <button class="btn-secondary" id="m-close">Cancelar</button>
        <button class="btn-primary" id="m-capture" style="padding:10px 16px;border-radius:6px;">Capturar e enviar</button>
      </div>`;
    const video = modal.querySelector('#cam-video');
    const errBox = modal.querySelector('#cam-error');
    navigator.mediaDevices.getUserMedia({ video: true }).then(s => {
      stream = s;
      video.srcObject = s;
    }).catch(() => {
      errBox.textContent = 'Nao foi possivel acessar a camera.';
      errBox.classList.remove('hidden');
    });

    const cleanup = () => {
      if (stream) stream.getTracks().forEach(t => t.stop());
      closeModal();
    };
    modal.querySelector('#m-close').addEventListener('click', cleanup);

    modal.querySelector('#m-capture').addEventListener('click', async () => {
      if (!stream) return;
      const canvas = document.createElement('canvas');
      canvas.width = video.videoWidth || 640;
      canvas.height = video.videoHeight || 480;
      canvas.getContext('2d').drawImage(video, 0, 0);
      const blob = await new Promise(r => canvas.toBlob(r, 'image/jpeg', 0.9));
      cleanup();
      const name = `foto_${Date.now()}.jpg`;
      try {
        const res = await API.post(`/api/upload?name=${name}&type=image/jpeg`, blob);
        state.pendingAttachments.push({ file: { name }, attachment: res.attachment, status: 'done' });
        renderAttachmentChips();
        el('message-input').focus();
      } catch (err) {
        alert('Falha ao enviar foto: ' + err.message);
      }
    });
  });
}

function renderVoiceStage() {
  const stage = el('voice-stage');
  const V = window.NexoVoice;
  const inThisServer = V.connected && V.serverId === state.currentServerId;
  const viewingVoiceChannel = inThisServer && V.channelId === state.currentChannelId;

  stage.classList.toggle('hidden', !inThisServer);
  stage.classList.toggle('expanded', viewingVoiceChannel);
  stage.classList.toggle('slim', inThisServer && !viewingVoiceChannel);
  document.body.classList.toggle('in-voice', inThisServer);

  if (!inThisServer) {
    stage.innerHTML = '';
    return;
  }

  if (stage.dataset.mode === (viewingVoiceChannel ? 'full' : 'slim') && stage.childElementCount) {
    updateTiles();
    return;
  }
  stage.dataset.mode = viewingVoiceChannel ? 'full' : 'slim';

  stage.innerHTML = '';
  const grid = document.createElement('div');
  grid.className = 'voice-grid';
  grid.id = 'voice-grid';
  stage.appendChild(grid);

  const controls = document.createElement('div');
  controls.className = 'voice-controls';
  const mkBtn = (icon, title, fn) => {
    const b = document.createElement('button');
    b.className = 'voice-btn';
    b.innerHTML = icon;
    b.title = title;
    b.addEventListener('click', fn);
    return b;
  };
  const statusSpan = document.createElement('span');
  statusSpan.className = 'voice-status';
  statusSpan.id = 'voice-status-label';
  controls.appendChild(statusSpan);
  controls.appendChild(mkBtn('&#127908;', 'Microfone', () => { V.toggleMute(); }));
  controls.appendChild(mkBtn('&#127911;', 'Audio', () => { V.toggleDeafen(); }));
  controls.appendChild(mkBtn('&#128249;', 'Camera', async () => {
    try { await V.toggleCamera(); } catch (err) { alert(err.message); }
  }));
  controls.appendChild(mkBtn('&#128421;', 'Compartilhar tela', async () => {
    try { await V.toggleScreen(); } catch (err) { alert(err.message); }
  }));
  controls.appendChild(mkBtn('&#10060;', 'Desconectar', () => V.leave(), ));
  stage.appendChild(controls);

  updateTiles();
}

setInterval(updateTiles, 2000);

function updateTiles() {
  const V = window.NexoVoice;
  const grid = document.getElementById('voice-grid');
  if (!grid || !V.connected) return;
  const roster = [{ id: state.me.id, username: state.me.username, color: state.me.color }];
  const roomUsers = state.voiceRooms.get(V.channelId) || [];
  for (const u of roomUsers) {
    if (u.id !== state.me.id && !roster.some(r => r.id === u.id)) roster.push(u);
  }

  grid.innerHTML = '';
  for (const user of roster) {
    const peer = user.id === state.me.id ? null : V.peers.get(user.id);
    const tile = document.createElement('div');
    tile.className = 'voice-tile' + (V.speakingSet.has(user.id === state.me.id ? 'me' : user.id) ? ' speaking' : '');
    tile.dataset.uid = user.id;

    const video = document.createElement('video');
    video.autoplay = true;
    video.playsInline = true;
    if (user.id === state.me.id) {
      video.muted = true;
      const camActive = V.localVideoTrack && V.currentVideoSource;
      if (camActive) {
        if (!tile._localStream) tile._localStream = new MediaStream([V.localVideoTrack]);
        video.srcObject = tile._localStream;
      }
      tile.classList.toggle('has-video', !!camActive);
    } else if (peer && peer.stream) {
      video.srcObject = peer.stream;
      video.muted = V.deafened;
      tile.classList.toggle('has-video', !!(peer.videoActive && peer.stream.getVideoTracks().length));
    }

    const overlay = document.createElement('div');
    overlay.className = 'voice-tile-overlay';
    overlay.appendChild(avatarEl(user, 'avatar-sm'));
    const nameTag = document.createElement('span');
    nameTag.className = 'voice-tile-name';
    nameTag.textContent = user.username + (user.id === state.me.id ? ' (voce)' : '');
    overlay.appendChild(nameTag);
    if (user.id === state.me.id && V.muted) {
      const muteTag = document.createElement('span');
      muteTag.className = 'mute-tag';
      muteTag.textContent = 'mudo';
      overlay.appendChild(muteTag);
    }
    tile.appendChild(video);
    tile.appendChild(overlay);
    grid.appendChild(tile);
  }

  const statusLabel = document.getElementById('voice-status-label');
  if (statusLabel) {
    statusLabel.textContent = `Conectado a ${V.channelName} - ${roster.length} na chamada`;
  }
}

el('btn-new-channel').addEventListener('click', () => {
  if (!state.currentServerId) {
    alert('Crie ou entre em um servidor primeiro.');
    return;
  }
  showModal(modal => {
    modal.innerHTML = `
      <h2>Criar canal</h2>
      <p class="desc">Escolha o tipo do canal.</p>
      <label>Tipo
        <select id="m-channel-type" style="background:#313338;border:1px solid rgba(0,0,0,0.4);border-radius:6px;padding:10px;color:#f2f3f5;">
          <option value="text">Texto</option>
          <option value="voice">Voz</option>
        </select>
      </label>
      <label>Nome do canal
        <input type="text" id="m-channel-name" maxlength="32" placeholder="novo-canal" autofocus>
      </label>
      <div class="auth-error hidden" id="m-channel-error"></div>
      <div class="modal-actions">
        <button class="btn-secondary" id="m-cancel">Cancelar</button>
        <button class="btn-primary" id="m-create-channel" style="padding:10px 16px;border-radius:6px;">Criar</button>
      </div>`;
    const nameInput = modal.querySelector('#m-channel-name');
    nameInput.focus();
    const submit = async () => {
      try {
        await API.post(`/api/servers/${state.currentServerId}/channels`, {
          name: nameInput.value,
          type: modal.querySelector('#m-channel-type').value
        });
        closeModal();
      } catch (err) {
        const eb = modal.querySelector('#m-channel-error');
        eb.textContent = err.message;
        eb.classList.remove('hidden');
      }
    };
    modal.querySelector('#m-create-channel').addEventListener('click', submit);
    nameInput.addEventListener('keydown', e => { if (e.key === 'Enter') submit(); });
    modal.querySelector('#m-cancel').addEventListener('click', closeModal);
  });
});

el('btn-invite').addEventListener('click', () => {
  if (!currentServer()) return alert('Crie ou entre em um servidor primeiro.');
  showModal(modal => {
    modal.innerHTML = `
      <h2>Convidar pessoas</h2>
      <p class="desc">Compartilhe este codigo para entrarem em "${escapeHtml(currentServer().name)}".</p>
      <div class="invite-code-box">
        <code>${currentServer().inviteCode}</code>
        <button class="btn-primary" id="m-copy" style="padding:10px 14px;border-radius:6px;">Copiar</button>
      </div>
      <div class="modal-actions"><button class="btn-secondary" id="m-close">Fechar</button></div>`;
    modal.querySelector('#m-copy').addEventListener('click', () => {
      navigator.clipboard.writeText(currentServer().inviteCode).catch(() => {});
      modal.querySelector('#m-copy').textContent = 'Copiado!';
    });
    modal.querySelector('#m-close').addEventListener('click', closeModal);
  });
});

function createServerModal() {
  showModal(modal => {
    modal.innerHTML = `
      <h2>Criar seu servidor</h2>
      <p class="desc">Deixe um nome legal!</p>
      <label>Nome do servidor
        <input type="text" id="m-server-name" maxlength="40" placeholder="Meu servidor" autofocus>
      </label>
      <div class="auth-error hidden" id="m-server-error"></div>
      <div class="modal-actions">
        <button class="btn-secondary" id="m-cancel">Cancelar</button>
        <button class="btn-primary" id="m-create-server" style="padding:10px 16px;border-radius:6px;">Criar</button>
      </div>`;
    const nameInput = modal.querySelector('#m-server-name');
    nameInput.focus();
    const submit = async () => {
      try {
        const data = await API.post('/api/servers', { name: nameInput.value });
        state.servers.push(data.server);
        closeModal();
        selectServer(data.server.id);
        inviteHint(data.server);
      } catch (err) {
        const eb = modal.querySelector('#m-server-error');
        eb.textContent = err.message;
        eb.classList.remove('hidden');
      }
    };
    modal.querySelector('#m-create-server').addEventListener('click', submit);
    nameInput.addEventListener('keydown', e => { if (e.key === 'Enter') submit(); });
    modal.querySelector('#m-cancel').addEventListener('click', closeModal);
  });
}

function inviteHint(server) {
  showModal(modal => {
    modal.innerHTML = `
      <h2>Servidor criado!</h2>
      <p class="desc">Envie este codigo para seus amigos entrarem em "${escapeHtml(server.name)}".</p>
      <div class="invite-code-box">
        <code>${server.inviteCode}</code>
        <button class="btn-primary" id="m-copy" style="padding:10px 14px;border-radius:6px;">Copiar</button>
      </div>
      <div class="modal-actions"><button class="btn-primary" id="m-go" style="padding:10px 16px;border-radius:6px;">Comecar</button></div>`;
    modal.querySelector('#m-copy').addEventListener('click', () => {
      navigator.clipboard.writeText(server.inviteCode).catch(() => {});
      modal.querySelector('#m-copy').textContent = 'Copiado!';
    });
    modal.querySelector('#m-go').addEventListener('click', closeModal);
  });
}

function joinServerModal() {
  showModal(modal => {
    modal.innerHTML = `
      <h2>Entrar em um servidor</h2>
      <p class="desc">Digite o codigo de convite que voce recebeu.</p>
      <label>Codigo de convite
        <input type="text" id="m-invite-code" maxlength="6" placeholder="ABC123" style="text-transform:uppercase;" autofocus>
      </label>
      <div class="auth-error hidden" id="m-join-error"></div>
      <div class="modal-actions">
        <button class="btn-secondary" id="m-back">Voltar</button>
        <button class="btn-primary" id="m-join" style="padding:10px 16px;border-radius:6px;">Entrar</button>
      </div>`;
    const codeInput = modal.querySelector('#m-invite-code');
    codeInput.focus();
    const submit = async () => {
      try {
        const data = await API.post('/api/servers/join', { inviteCode: codeInput.value });
        if (!state.servers.some(s => s.id === data.server.id)) {
          state.servers.push(data.server);
        }
        closeModal();
        selectServer(data.server.id);
      } catch (err) {
        const eb = modal.querySelector('#m-join-error');
        eb.textContent = err.message;
        eb.classList.remove('hidden');
      }
    };
    modal.querySelector('#m-join').addEventListener('click', submit);
    codeInput.addEventListener('keydown', e => { if (e.key === 'Enter') submit(); });
    modal.querySelector('#m-back').addEventListener('click', welcomeModal);
  });
}

function newDmModal() {
  const seen = new Map();
  for (const m of state.members) {
    if (m.id !== state.me.id && !m.isBot) seen.set(m.id, m);
  }
  const users = [...seen.values()];
  showModal(modal => {
    modal.innerHTML = `<h2>Nova conversa</h2><p class="desc">Selecione alguem dos seus servidores.</p><div class="pick-list" id="pick-list"></div>`;
    const list = modal.querySelector('#pick-list');
    if (!users.length) {
      list.innerHTML = '<p class="desc">Entre em um servidor com outras pessoas primeiro.</p>';
    }
    for (const u of users) {
      const item = document.createElement('button');
      item.className = 'pick-item';
      item.appendChild(avatarEl(u, 'avatar-sm'));
      const nm = document.createElement('span');
      nm.textContent = u.username;
      nm.style.color = u.color;
      item.appendChild(nm);
      item.addEventListener('click', () => {
        closeModal();
        openDmFromAnywhere(u.id);
      });
      list.appendChild(item);
    }
  });
}

function fileToAvatarBlob(file) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      const size = 256;
      const canvas = document.createElement('canvas');
      canvas.width = size;
      canvas.height = size;
      const ctx = canvas.getContext('2d');
      const side = Math.min(img.width, img.height);
      ctx.drawImage(img, (img.width - side) / 2, (img.height - side) / 2, side, side, 0, 0, size, size);
      URL.revokeObjectURL(url);
      canvas.toBlob(b => b ? resolve(b) : reject(new Error('Falha ao processar imagem')), 'image/png');
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Imagem invalida')); };
    img.src = url;
  });
}

function myProfileModal() {
  showModal(modal => {
    modal.innerHTML = `
      <h2>Meu perfil</h2>
      <div class="profile-head">
        <div class="avatar" id="m-av-preview"></div>
        <div class="profile-head-info">
          <strong>${escapeHtml(state.me.username)}</strong><span class="user-tag">#${state.me.tag || ''}</span>
          <button class="btn-secondary btn-sm" id="m-av-change">Trocar avatar</button>
          <input type="file" id="m-av-file" accept="image/png,image/jpeg,image/gif,image/webp" hidden>
        </div>
      </div>
      <label>Status</label>
      <div class="status-options" id="m-status-options"></div>
      <label>Status personalizado
        <input type="text" id="m-statustext" maxlength="128" placeholder="O que voce esta fazendo?" value="${escapeHtml(state.me.statusText || '')}">
      </label>
      <label>Sobre mim
        <textarea id="m-bio" maxlength="200" rows="3" placeholder="Conte algo sobre voce...">${escapeHtml(state.me.bio || '')}</textarea>
      </label>
      <div class="auth-error hidden" id="m-profile-error"></div>
      <div class="modal-actions">
        <button class="btn-secondary" id="m-cancel">Cancelar</button>
        <button class="btn-primary" id="m-save" style="padding:10px 16px;border-radius:6px;">Salvar</button>
      </div>`;
    const preview = modal.querySelector('#m-av-preview');
    preview.style.background = state.me.color;
    if (state.me.avatarUrl) {
      const img = document.createElement('img');
      img.src = state.me.avatarUrl + (state.me.avatarUrl.includes('?') ? '&' : '?') + 't=' + Date.now();
      preview.appendChild(img);
    } else {
      preview.textContent = initials(state.me.username);
    }
    let chosenStatus = state.me.status || 'online';
    let avatarFile = null;
    const opts = modal.querySelector('#m-status-options');
    for (const key of ['online', 'idle', 'dnd', 'invisible']) {
      const b = document.createElement('button');
      b.className = 'status-option' + (key === chosenStatus ? ' selected' : '');
      b.innerHTML = `<span class="presence-dot" style="background:${STATUS_META[key].color}"></span> ${STATUS_META[key].label}`;
      b.addEventListener('click', () => {
        chosenStatus = key;
        opts.querySelectorAll('.status-option').forEach(x => x.classList.remove('selected'));
        b.classList.add('selected');
      });
      opts.appendChild(b);
    }
    modal.querySelector('#m-av-change').addEventListener('click', () => modal.querySelector('#m-av-file').click());
    modal.querySelector('#m-av-file').addEventListener('change', async e => {
      const f = e.target.files[0];
      if (!f) return;
      try {
        avatarFile = await fileToAvatarBlob(f);
        preview.innerHTML = '';
        const img = document.createElement('img');
        img.src = URL.createObjectURL(avatarFile);
        preview.appendChild(img);
      } catch (err) {
        const eb = modal.querySelector('#m-profile-error');
        eb.textContent = err.message;
        eb.classList.remove('hidden');
      }
    });
    modal.querySelector('#m-cancel').addEventListener('click', closeModal);
    modal.querySelector('#m-save').addEventListener('click', async () => {
      const eb = modal.querySelector('#m-profile-error');
      try {
        if (avatarFile) await API.post('/api/me/avatar', avatarFile);
        const st = await API.patch('/api/me/status', { status: chosenStatus, statusText: modal.querySelector('#m-statustext').value });
        await API.patch('/api/me/profile', { bio: modal.querySelector('#m-bio').value });
        Object.assign(state.me, st.user);
        closeModal();
        renderUserPanel();
      } catch (err) {
        eb.textContent = err.message;
        eb.classList.remove('hidden');
      }
    });
  });
}

function pinsModal() {
  let qs = '';
  if (state.homeMode) {
    if (!state.activeDmPeerId) return alert('Abra uma conversa primeiro.');
    qs = `?peerId=${state.activeDmPeerId}`;
  } else {
    if (!state.currentChannelId) return alert('Selecione um canal.');
    qs = `?channelId=${state.currentChannelId}`;
  }
  API.get(`/api/pins${qs}`).then(({ pins }) => {
    showModal(modal => {
      modal.innerHTML = `<h2>&#128204; Mensagens fixadas</h2><div class="pins-list" id="pins-list"></div>
        <div class="modal-actions"><button class="btn-secondary" id="m-close">Fechar</button></div>`;
      const list = modal.querySelector('#pins-list');
      if (!pins.length) list.innerHTML = '<p class="desc">Nenhuma mensagem fixada ainda. Passe o mouse sobre uma mensagem e clique no alfinete.</p>';
      for (const p of [...pins].reverse()) {
        const row = document.createElement('div');
        row.className = 'pin-row';
        row.appendChild(avatarEl({ color: p.color, username: p.username }, 'avatar-sm'));
        const info = document.createElement('div');
        info.className = 'pin-info';
        const meta = document.createElement('div');
        meta.className = 'pin-meta';
        meta.textContent = `${p.username} - ${new Date(p.createdAt).toLocaleString('pt-BR')}`;
        const content = document.createElement('div');
        content.className = 'pin-content';
        content.textContent = p.content || '(anexo)';
        info.appendChild(meta);
        info.appendChild(content);
        row.appendChild(info);
        const actionsBox = document.createElement('div');
        actionsBox.className = 'pin-actions';
        const canUnpin = p.userId === state.me.id || (!state.homeMode && canModerateClient(p.serverId));
        if (canUnpin) {
          const unpin = document.createElement('button');
          unpin.className = 'req-btn deny';
          unpin.innerHTML = '&#128204;';
          unpin.title = 'Desafixar';
          unpin.addEventListener('click', async () => {
            try {
              await API.post(`/api/messages/${p.id}/pin`);
              row.remove();
            } catch (err) { alert(err.message); }
          });
          actionsBox.appendChild(unpin);
        }
        const jump = document.createElement('button');
        jump.className = 'req-btn';
        jump.title = 'Ir para a mensagem';
        jump.innerHTML = '&#8599;';
        jump.addEventListener('click', () => {
          closeModal();
          const target = document.querySelector(`.message[data-id="${p.id}"]`);
          if (target) {
            target.scrollIntoView({ behavior: 'smooth', block: 'center' });
            target.classList.add('flash');
            setTimeout(() => target.classList.remove('flash'), 1600);
          }
        });
        actionsBox.appendChild(jump);
        row.appendChild(actionsBox);
        list.appendChild(row);
      }
      modal.querySelector('#m-close').addEventListener('click', closeModal);
    });
  }).catch(err => alert(err.message));
}

function searchModal() {
  if (state.homeMode || !state.currentServerId) return;
  showModal(modal => {
    modal.innerHTML = `
      <h2>Buscar no servidor</h2>
      <div class="search-box">
        <input type="text" id="m-search-q" maxlength="100" placeholder="Digite para buscar nas mensagens..." autofocus>
        <button class="btn-primary btn-sm" id="m-search-go">Buscar</button>
      </div>
      <div class="search-results" id="m-search-results"><p class="desc">Os resultados aparecem aqui.</p></div>
      <div class="modal-actions"><button class="btn-secondary" id="m-close">Fechar</button></div>`;
    const input = modal.querySelector('#m-search-q');
    const resultsBox = modal.querySelector('#m-search-results');
    input.focus();
    const runSearch = async () => {
      const q = input.value.trim();
      if (q.length < 2) return;
      resultsBox.innerHTML = '<p class="desc">Buscando...</p>';
      try {
        const { results } = await API.get(`/api/servers/${state.currentServerId}/search?q=${encodeURIComponent(q)}`);
        resultsBox.innerHTML = '';
        if (!results.length) {
          resultsBox.innerHTML = '<p class="desc">Nenhum resultado.</p>';
          return;
        }
        for (const r of results) {
          const row = document.createElement('button');
          row.className = 'search-row';
          const head = document.createElement('div');
          head.className = 'pin-meta';
          head.innerHTML = `<strong style="color:#5865f2;">#${escapeHtml(r.channelName)}</strong> - ${escapeHtml(r.username)} - ${new Date(r.createdAt).toLocaleString('pt-BR')}`;
          const content = document.createElement('div');
          content.className = 'pin-content';
          content.textContent = r.content;
          row.appendChild(head);
          row.appendChild(content);
          row.addEventListener('click', () => {
            closeModal();
            if (r.channelId !== state.currentChannelId) {
              selectChannel(r.channelId).then(() => jumpToMessage(r.id));
            } else {
              jumpToMessage(r.id);
            }
          });
          resultsBox.appendChild(row);
        }
      } catch (err) {
        resultsBox.innerHTML = `<p class="desc">${escapeHtml(err.message)}</p>`;
      }
    };
    modal.querySelector('#m-search-go').addEventListener('click', runSearch);
    input.addEventListener('keydown', e => { if (e.key === 'Enter') runSearch(); });
    modal.querySelector('#m-close').addEventListener('click', closeModal);
  });
}

function jumpToMessage(messageId) {
  setTimeout(() => {
    const target = document.querySelector(`.message[data-id="${messageId}"]`);
    if (target) {
      target.scrollIntoView({ behavior: 'smooth', block: 'center' });
      target.classList.add('flash');
      setTimeout(() => target.classList.remove('flash'), 1600);
    }
  }, 250);
}

function channelManageModal(ch) {
  if (state.homeMode || !canModerateClient(state.currentServerId)) return;
  showModal(modal => {
    modal.innerHTML = `
      <h2>#${escapeHtml(ch.name)}</h2>
      <label>Novo nome
        <input type="text" id="m-ch-name" maxlength="32" value="${escapeHtml(ch.name)}">
      </label>
      ${ch.type !== 'voice' ? `<label>Topico do canal
        <input type="text" id="m-ch-topic" maxlength="200" value="${escapeHtml(ch.topic || '')}" placeholder="Ex: Conversa geral da galera">
      </label>` : ''}
      <div class="auth-error hidden" id="m-ch-error"></div>
      <div class="modal-actions">
        <button class="btn-secondary" id="m-cancel">Cancelar</button>
        <button class="btn-primary" id="m-save" style="padding:10px 16px;border-radius:6px;">Salvar</button>
        <button class="btn-secondary btn-danger-text" id="m-delete">&#128465; Excluir canal</button>
      </div>`;
    modal.querySelector('#m-cancel').addEventListener('click', closeModal);
    const saveBtn = modal.querySelector('#m-save');
    if (saveBtn) saveBtn.addEventListener('click', async () => {
      try {
        const payload = { name: modal.querySelector('#m-ch-name').value };
        const topicInput = modal.querySelector('#m-ch-topic');
        if (topicInput) payload.topic = topicInput.value;
        await API.patch(`/api/channels/${ch.id}`, payload);
        closeModal();
      } catch (err) {
        const eb = modal.querySelector('#m-ch-error');
        eb.textContent = err.message;
        eb.classList.remove('hidden');
      }
    });
    modal.querySelector('#m-delete').addEventListener('click', async () => {
      if (!confirm(`Excluir o canal #${ch.name}? As mensagens serao perdidas.`)) return;
      try {
        await API.del(`/api/channels/${ch.id}`);
        closeModal();
      } catch (err) { alert(err.message); }
    });
  });
}

function bansModal() {
  const sid = state.currentServerId;
  if (!sid || !canModerateClient(sid)) return;
  API.get(`/api/servers/${sid}/bans`).then(({ bans }) => {
    showModal(modal => {
      modal.innerHTML = `<h2>&#9940; Banimentos</h2><div class="pins-list" id="bans-list"></div>
        <div class="modal-actions"><button class="btn-secondary" id="m-close">Fechar</button></div>`;
      const list = modal.querySelector('#bans-list');
      if (!bans.length) list.innerHTML = '<p class="desc">Ninguem banido neste servidor.</p>';
      for (const b of bans) {
        const row = document.createElement('div');
        row.className = 'pin-row';
        const info = document.createElement('div');
        info.className = 'pin-info';
        info.innerHTML = `<strong>${escapeHtml(b.username)}</strong>${b.reason ? ` - <span class="desc">${escapeHtml(b.reason)}</span>` : ''}`;
        row.appendChild(info);
        const unban = document.createElement('button');
        unban.className = 'req-btn';
        unban.textContent = 'Desbanir';
        unban.addEventListener('click', async () => {
          try {
            await API.del(`/api/servers/${sid}/bans/${b.userId}`);
            row.remove();
          } catch (err) { alert(err.message); }
        });
        row.appendChild(unban);
        list.appendChild(row);
      }
      modal.querySelector('#m-close').addEventListener('click', closeModal);
    });
  }).catch(err => alert(err.message));
}

el('me-avatar').parentElement.addEventListener('click', e => {
  if (e.target.closest('#btn-logout') || e.target.closest('#me-handle')) return;
  myProfileModal();
});

el('btn-server-menu').addEventListener('click', () => {
  const server = currentServer();
  if (!server) return;
  const isOwner = server.ownerId === state.me.id;
  const isMod = canModerateClient(server.id);
  showModal(modal => {
    modal.innerHTML = `
      <h2>${escapeHtml(server.name)}</h2>
      <p class="desc">Codigo de convite: <strong style="letter-spacing:2px;" id="m-invite-code">${server.inviteCode}</strong> | O NexoBot responde a /ajuda no chat.</p>
      <div class="modal-actions" style="flex-direction:column;align-items:stretch;">
        <button class="btn-secondary" id="m-add-channel">+ Criar canal</button>
        ${isMod ? '<button class="btn-secondary" id="m-server-icon">&#128444; Trocar icone do servidor</button>' : ''}
        ${isMod ? '<button class="btn-secondary" id="m-regen-invite">&#128257; Gerar novo codigo de convite</button>' : ''}
        <button class="btn-secondary" id="m-manage-roles">Gerenciar cargos</button>
        ${isMod ? '<button class="btn-secondary" id="m-bans">&#9940; Banimentos</button>' : ''}
        ${isOwner ? '<button class="btn-secondary" id="m-add-bot">Criar bot personalizado</button>' : ''}
        ${isOwner
          ? '<button class="btn-secondary btn-danger-text" id="m-delete-server">&#128465; Excluir servidor</button>'
          : '<button class="btn-secondary btn-danger-text" id="m-leave-server">&#128682; Sair do servidor</button>'}
        <button class="btn-secondary" id="m-close">Fechar</button>
      </div>`;
    modal.querySelector('#m-add-channel').addEventListener('click', () => el('btn-new-channel').click());
    modal.querySelector('#m-manage-roles').addEventListener('click', rolesManagerModal);
    const iconBtn = modal.querySelector('#m-server-icon');
    if (iconBtn) iconBtn.addEventListener('click', () => {
      const fileInput = document.createElement('input');
      fileInput.type = 'file';
      fileInput.accept = 'image/png,image/jpeg,image/gif,image/webp';
      fileInput.addEventListener('change', async () => {
        const file = fileInput.files && fileInput.files[0];
        if (!file) return;
        try {
          const blob = await fileToAvatarBlob(file);
          const data = await API.post(`/api/servers/${server.id}/icon`, blob);
          onServerUpdate(data.server);
          closeModal();
        } catch (err) { alert(err.message); }
      });
      fileInput.click();
    });
    const regenBtn = modal.querySelector('#m-regen-invite');
    if (regenBtn) regenBtn.addEventListener('click', async () => {
      try {
        const data = await API.post(`/api/servers/${server.id}/invite/regenerate`);
        server.inviteCode = data.inviteCode;
        modal.querySelector('#m-invite-code').textContent = data.inviteCode;
      } catch (err) { alert(err.message); }
    });
    const bansBtn = modal.querySelector('#m-bans');
    if (bansBtn) bansBtn.addEventListener('click', bansModal);
    const botBtn = modal.querySelector('#m-add-bot');
    if (botBtn) botBtn.addEventListener('click', () => createBotModal(server));
    const leaveBtn = modal.querySelector('#m-leave-server');
    if (leaveBtn) leaveBtn.addEventListener('click', async () => {
      if (!confirm(`Sair do servidor "${server.name}"?`)) return;
      try {
        await API.post(`/api/servers/${server.id}/leave`);
        closeModal();
        state.servers = state.servers.filter(s => s.id !== server.id);
        renderRail();
        selectHome();
      } catch (err) { alert(err.message); }
    });
    const deleteBtn = modal.querySelector('#m-delete-server');
    if (deleteBtn) deleteBtn.addEventListener('click', async () => {
      if (!confirm(`EXCLUIR o servidor "${server.name}" para sempre? Canais e mensagens serao apagados.`)) return;
      try {
        await API.del(`/api/servers/${server.id}`);
        closeModal();
        state.servers = state.servers.filter(s => s.id !== server.id);
        renderRail();
        selectHome();
      } catch (err) { alert(err.message); }
    });
    modal.querySelector('#m-close').addEventListener('click', closeModal);
  });
});

function createBotModal(server) {
  showModal(modal => {
    modal.innerHTML = `
      <h2>Criar bot</h2>
      <p class="desc">O bot entra no servidor. Use o token para programar via POST /api/bot/message.</p>
      <label>Nome do bot
        <input type="text" id="m-bot-name" maxlength="24" placeholder="MeuBot" autofocus>
      </label>
      <div class="auth-error hidden" id="m-bot-error"></div>
      <div class="modal-actions">
        <button class="btn-secondary" id="m-cancel">Cancelar</button>
        <button class="btn-primary" id="m-create-bot" style="padding:10px 16px;border-radius:6px;">Criar</button>
      </div>
      <div id="m-bot-result"></div>`;
    const nameInput = modal.querySelector('#m-bot-name');
    nameInput.focus();
    modal.querySelector('#m-create-bot').addEventListener('click', async () => {
      try {
        const data = await API.post(`/api/servers/${server.id}/bots`, { name: nameInput.value.trim() });
        modal.querySelector('#m-bot-result').innerHTML = `
          <p class="desc" style="margin-top:14px;">Token (guarde bem, mostrado uma vez):</p>
          <code style="word-break:break-all;background:#313338;padding:10px;border-radius:6px;display:block;">${data.token}</code>`;
      } catch (err) {
        const eb = modal.querySelector('#m-bot-error');
        eb.textContent = err.message;
        eb.classList.remove('hidden');
      }
    });
    modal.querySelector('#m-cancel').addEventListener('click', closeModal);
  });
}

el('btn-members-toggle').addEventListener('click', () => {
  appView.classList.toggle('members-hidden');
});

const onSafe = (id, fn) => { const n = el(id); if (n) n.addEventListener('click', fn); };
onSafe('btn-pins', pinsModal);
onSafe('btn-search', searchModal);

boot().then(() => { window.__nexoBooted = true; }).catch(() => {});
