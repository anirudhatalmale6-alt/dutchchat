'use strict';

const socket = io(CHAT_SERVER_URL);

let thisUser = null;
let channels = [];
let channelUsers = [];
let searchUsersList = [];
let totalUsers = 0;
let clickedUser = null;
let ignoreList = [];
let activePrivateTab = null;
let privateTabs = {};

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

// Screens
const connectingScreen = $('#connectingScreen');
const connectingStatus = $('#connectingStatus');
const loginScreen = $('#loginScreen');
const chatScreen = $('#chatScreen');

// Login
const loginBox = $('#loginBox');
const registerBox = $('#registerBox');
const loginForm = $('#loginForm');
const registerForm = $('#registerForm');
const loginError = $('#loginError');
const registerError = $('#registerError');
const loginButton = $('#loginButton');

// Chat
const channelsList = $('#channelsList');
const messagesList = $('#messages');
const messageForm = $('#messageForm');
const messageInput = $('#messageInput');
const colorPicker = $('#colorPicker');
const channelInfo = $('#channelInfo');
const userInfo = $('#userInfo');
const usersList = $('#usersList');
const usersHeader = $('#usersHeader');
const channelChatArea = $('#channelChatArea');

// Private
const privateChatArea = $('#privateChatArea');
const privateTabsEl = $('#privateTabs');
const privateMessagesEl = $('#privateMessages');

// Right panel
const searchUsersListEl = $('#searchUsersList');
const userActions = $('#userActions');
const selectedUserInfoEl = $('#selectedUserInfo');
const operButtons = $('#operButtons');

// Text size
const textSizeSlider = $('#textSizeSlider');
const textSizeValue = $('#textSizeValue');

// Emoticons
const emoticons = {
  ':-)': '😊', ':)': '😊', ':-(': '😢', ':(': '😢',
  ';-)': '😉', ';)': '😉', ';-(': '😭', ';(': '😭',
  '>-(': '😠', '>)': '😠', ':-/': '🤔', ':/': '🤔',
  ':-z': '😨', ':z': '😨', ':-$': '🤐', ':$': '🤐',
  '8-)': '😎', '8)': '😎', '+-)': '🤡', '+)': '🤡',
  ':-p': '😛', ':p': '😛', ':-D': '😁', ':D': '😁',
  ':-s': '😕', ':s': '😕', '(k)': '😘', '(l)': '❤️',
  '(6)': '😈', ':b': '🍺', ':-b': '🍺', ':k': '🐰',
  ':-k': '🐰', '(s)': '🤪', 'xd': '😆', 'XD': '😆',
  ':x': '🤫', ':-x': '🤫', ':|': '😐', ':-|': '😐',
};

function replaceEmoticons(text) {
  let result = text;
  for (const [code, emoji] of Object.entries(emoticons)) {
    const escaped = code.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    result = result.replace(new RegExp('(?<=\\s|^)' + escaped + '(?=\\s|$)', 'g'), emoji);
  }
  return result;
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function scrollToBottom(el) {
  el.scrollTop = el.scrollHeight;
}

function getLevelClass(level) {
  const map = { 0: 'normal', 1: 'oper', 2: 'super', 3: 'cyber', 4: 'admin', 5: 'creator' };
  return map[level] || 'normal';
}

function getLevelName(level) {
  const map = { 0: 'Normaal', 1: 'Oper', 2: 'Super', 3: 'Cyber', 4: 'Admin', 5: 'Creator' };
  return map[level] || 'Normaal';
}

function getCurrentTime() {
  const d = new Date();
  return `${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}:${String(d.getSeconds()).padStart(2,'0')}`;
}

// ============================================
// CONNECTING SCREEN
// ============================================

socket.on('connect', () => {
  connectingScreen.style.display = 'none';
  loginScreen.style.display = 'flex';
});

socket.on('connect_error', () => {
  connectingStatus.textContent = 'Kan geen verbinding maken... opnieuw proberen';
  connectingStatus.style.color = '#cc0000';
});

socket.io.on('reconnect', () => {
  connectingStatus.textContent = 'Verbinding hersteld!';
  connectingStatus.style.color = '#00b894';
});

// ============================================
// UI EVENT LISTENERS
// ============================================

// Tab switching
$$('.tabBtn').forEach(btn => {
  btn.addEventListener('click', () => {
    $$('.tabBtn').forEach(b => b.classList.remove('active'));
    $$('.tabContent').forEach(c => c.classList.remove('active'));
    btn.classList.add('active');
    const tab = document.getElementById(btn.dataset.tab);
    if (tab) tab.classList.add('active');
  });
});

// Show/hide login/register
$('#showRegisterBtn').addEventListener('click', () => {
  loginBox.style.display = 'none';
  registerBox.style.display = 'block';
});
$('#showLoginBtn').addEventListener('click', () => {
  registerBox.style.display = 'none';
  loginBox.style.display = 'block';
});

// Text size slider
textSizeSlider.addEventListener('input', () => {
  textSizeValue.textContent = textSizeSlider.value;
  messagesList.style.fontSize = textSizeSlider.value + 'px';
});

// Welcome popup close
$('#closeWelcomeBtn').addEventListener('click', () => {
  $('#welcomePopup').style.display = 'none';
});

// LOGIN
loginForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const nick = $('#nickname').value.trim();
  const pass = $('#password').value;
  const age = $('#age').value || '';
  const gender = $('#gender').value;
  const location = $('#location').value || '';
  const info = $('#additionalInfo').value || '';

  if (!nick) return;

  const pw = pass || 'guest';
  socket.emit('login request', `${nick}|${pw}|${age}|${gender}|${location}|${info}`);
  loginButton.disabled = true;
});

// REGISTER
registerForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const nick = $('#regNickname').value.trim();
  const pass = $('#regPassword').value;
  const confirm = $('#regPasswordConfirm').value;
  const email = $('#regEmail').value.trim();

  if (pass !== confirm) {
    showError(registerError, 'Wachtwoorden komen niet overeen.');
    return;
  }
  if (pass.length < 6) {
    showError(registerError, 'Wachtwoord moet minimaal 6 tekens zijn.');
    return;
  }

  socket.emit('register request', `${nick}|${pass}|${email}`);
  $('#registerButton').disabled = true;
});

// MESSAGE FORM
messageForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const text = messageInput.value.trim();
  if (!text) return;

  if (text === '/clear') {
    messagesList.innerHTML = '';
  } else if (text === '/smilies') {
    let smileyStr = '';
    for (const [code, emoji] of Object.entries(emoticons)) {
      smileyStr += `${emoji} ${code} `;
    }
    addServerMessage(smileyStr);
  } else if (text.startsWith('/color ')) {
    const col = text.replace('/color ', '');
    if (/^#[0-9A-Fa-f]{3,6}$/.test(col)) {
      colorPicker.value = col.length === 4 ? col + col.slice(1) : col;
    }
  } else if (text === '/nocolor') {
    colorPicker.value = '#ffffff';
  } else if (text === '/help') {
    addServerMessage('Beschikbare commando\'s: /join, /part, /kick, /ban, /unban, /op, /deop, /topic, /wall, /whois, /silent, /unsilent, /sban, /sunban, /skick, /kill, /list, /hide, /unhide, /clear, /smilies, /color, /nocolor, /quit, /version, /info');
  } else if (text.startsWith('/select ')) {
    const selectNick = text.split(' ')[1];
    selectUserByNick(selectNick);
  } else if (text === '/deselect') {
    deselectUser();
  } else if (activePrivateTab && !text.startsWith('/')) {
    socket.emit('private message', `${activePrivateTab}|${JSON.stringify({ colour: colorPicker.value, content: text })}`);
    addPrivateMessage(activePrivateTab, { sender: thisUser.nickname, colour: colorPicker.value, content: escapeHtml(text), timestamp: getCurrentTime() });
  } else if (!text.startsWith('/')) {
    socket.emit('send channel message', JSON.stringify({ colour: colorPicker.value, content: text }));
  } else {
    socket.emit('command', text);
  }

  messageInput.value = '';
});

// CREATE CHANNEL
$('#createChannelBtn').addEventListener('click', () => {
  $('#createChannelDialog').style.display = 'flex';
});
$('#cancelCreateChannel').addEventListener('click', () => {
  $('#createChannelDialog').style.display = 'none';
});
$('#createChannelForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const name = $('#newChannelName').value.trim();
  const topic = $('#newChannelTopic').value.trim();
  const type = document.querySelector('input[name="newChannelType"]:checked').value;
  if (!name) return;
  socket.emit('create channel', `${name}|${topic}|${type}`);
  $('#newChannelName').value = '';
  $('#newChannelTopic').value = '';
  $('#createChannelDialog').style.display = 'none';
});

// SEARCH
$('#searchForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const searchOn = document.querySelector('input[name="searchOn"]:checked').value;
  const gender = document.querySelector('input[name="searchGender"]:checked').value;
  const name = $('#searchName').value.trim();
  socket.emit('search', `${searchOn}|${gender}|${name}`);
});
$('#cancelSearchBtn').addEventListener('click', () => {
  searchUsersListEl.style.display = 'none';
  usersList.style.display = 'block';
  $$('.tabBtn').forEach(b => b.classList.remove('active'));
  $$('.tabContent').forEach(c => c.classList.remove('active'));
  $$('.tabBtn')[0].classList.add('active');
  $('#usersTab').classList.add('active');
});

// MOD BUTTONS
$('#privateBtn').addEventListener('click', () => {
  if (clickedUser) openPrivateTab(clickedUser.nickname);
});
$('#ignoreBtn').addEventListener('click', () => {
  if (clickedUser) {
    if (ignoreList.includes(clickedUser.nickname)) {
      ignoreList = ignoreList.filter(n => n !== clickedUser.nickname);
      addServerMessage(`${clickedUser.nickname} is niet meer genegeerd.`);
    } else {
      ignoreList.push(clickedUser.nickname);
      addServerMessage(`${clickedUser.nickname} wordt nu genegeerd.`);
    }
  }
});
$('#operBtn').addEventListener('click', () => { if (clickedUser) socket.emit('command', `/op ${clickedUser.nickname} oper`); });
$('#superBtn').addEventListener('click', () => { if (clickedUser) socket.emit('command', `/op ${clickedUser.nickname} super`); });
$('#kickBtn').addEventListener('click', () => { if (clickedUser) socket.emit('command', `/kick ${clickedUser.nickname}`); });
$('#banBtn').addEventListener('click', () => { if (clickedUser) socket.emit('command', `/ban ${clickedUser.nickname}`); });
$('#silentBtn').addEventListener('click', () => { if (clickedUser) socket.emit('command', `/silent ${clickedUser.nickname}`); });
$('#unsilentBtn').addEventListener('click', () => { if (clickedUser) socket.emit('command', `/unsilent ${clickedUser.nickname}`); });

// PROFILE IMAGE UPLOAD
$('#uploadImageBtn').addEventListener('click', () => {
  const fileInput = $('#profileImageInput');
  if (!fileInput.files.length) return;
  const formData = new FormData();
  formData.append('profileImage', fileInput.files[0]);
  formData.append('nickname', thisUser.nickname);
  fetch(CHAT_SERVER_URL + '/upload', { method: 'POST', body: formData })
    .then(r => r.json())
    .then(data => {
      if (data.success) addServerMessage('Profielafbeelding geupload: ' + data.filename);
    })
    .catch(() => addServerMessage('Upload mislukt.'));
});

// CLOG DIALOG
$('#closeClogBtn').addEventListener('click', () => {
  $('#clogDialog').style.display = 'none';
});

// ============================================
// SOCKET EVENT HANDLERS
// ============================================

socket.on('login result', (msg) => {
  loginButton.disabled = false;

  if (msg === 'fail') {
    showError(loginError, 'Verkeerde inloggegevens, probeer opnieuw.');
  } else if (msg === 'fail|logged in') {
    showError(loginError, 'Dit account is al ingelogd op een andere locatie.');
  } else if (msg === 'fail|too short') {
    showError(loginError, 'Nickname moet minimaal 3 tekens zijn.');
  } else if (msg === 'fail|guest taken') {
    showError(loginError, 'Die gast-nickname is al in gebruik.');
  } else if (msg === 'fail|actual user') {
    showError(loginError, 'Een geregistreerde gebruiker heeft al deze nickname.');
  } else if (msg.startsWith('banned')) {
    showError(loginError, msg.replace('banned|', ''));
  } else {
    thisUser = JSON.parse(msg);
    enterChat();
  }
});

socket.on('register result', (msg) => {
  $('#registerButton').disabled = false;
  if (msg === 'ok') {
    alert('Account geregistreerd! Je kunt nu inloggen.');
    registerBox.style.display = 'none';
    loginBox.style.display = 'block';
  } else if (msg === 'nickname taken') {
    showError(registerError, 'Die nickname is al bezet.');
  } else if (msg === 'forbidden term') {
    showError(registerError, 'Nickname bevat een verboden woord.');
  } else if (msg === 'nickname wrong') {
    showError(registerError, 'Nickname moet 3-20 tekens zijn, zonder spaties.');
  } else if (msg === 'password wrong') {
    showError(registerError, 'Wachtwoord moet minimaal 6 tekens zijn.');
  } else if (msg === 'email wrong') {
    showError(registerError, 'Ongeldig email adres.');
  } else {
    showError(registerError, 'Er ging iets mis: ' + msg);
  }
});

socket.on('channel list', (msg) => {
  channels = JSON.parse(msg);
  renderChannelList();
});

socket.on('channel message', (msg) => {
  const m = JSON.parse(msg);
  if (ignoreList.includes(m.sender)) return;
  addChannelMessage(m);
});

socket.on('private message', (msg) => {
  if ($('#ignorePrivateMessages').checked) return;
  const m = JSON.parse(msg);
  if (ignoreList.includes(m.sender)) return;

  if ($('#privateWindows').checked) {
    if (!privateTabs[m.sender]) openPrivateTab(m.sender);
    addPrivateMessage(m.sender, m);
  } else {
    const li = document.createElement('li');
    li.innerHTML = `<span class="timestamp">[PRIVE][${m.timestamp}]</span> <span class="sender">${m.sender}</span> zegt: <span style="color:${m.colour}">${replaceEmoticons(m.content)}</span>`;
    messagesList.appendChild(li);
    scrollToBottom(channelChatArea);
  }
});

socket.on('server message', (msg) => {
  if ($('#noStatusMessages').checked && (msg.includes('komt kanaal') || msg.includes('verlaat kanaal'))) return;
  addServerMessage(msg);
});

socket.on('channel users list', (msg) => {
  channelUsers = JSON.parse(msg);
  renderUsersList();
});

socket.on('user joined channel', (msg) => {
  const u = JSON.parse(msg);
  const existing = channelUsers.find(cu => cu.nickname === u.nickname);
  if (!existing) channelUsers.push(u);
  else Object.assign(existing, u);
  renderUsersList();
});

socket.on('user left channel', (nickname) => {
  channelUsers = channelUsers.filter(u => u.nickname !== nickname);
  renderUsersList();
  if (clickedUser && clickedUser.nickname === nickname) deselectUser();
});

socket.on('user updated', (msg) => {
  const u = JSON.parse(msg);
  const idx = channelUsers.findIndex(cu => cu.nickname === u.nickname);
  if (idx !== -1) channelUsers[idx] = u;
  renderUsersList();
  if (clickedUser && clickedUser.nickname === u.nickname) {
    clickedUser = u;
    showUserInfo(u);
  }
});

socket.on('changed channel', (channelName) => {
  if (!channelName) {
    thisUser.currentChannel = '';
    messagesList.innerHTML = '';
    channelUsers = [];
    renderUsersList();
    updateChannelInfo();
    return;
  }
  thisUser.currentChannel = channelName;
  messagesList.innerHTML = '';
  channelUsers = [];
  deselectUser();
  activePrivateTab = null;
  updateChannelInfo();
  highlightActiveChannel();
});

socket.on('channel user numbers update', (msg) => {
  if (!msg) return;
  const parts = msg.split('|');
  totalUsers = 0;
  for (const part of parts) {
    const [name, count] = part.split(':');
    const ch = channels.find(c => c.name === name);
    if (ch) ch.currentUsers = parseInt(count) || 0;
    totalUsers += parseInt(count) || 0;
  }
  renderChannelList();
  updateChannelInfo();
});

socket.on('channel topic update', (topic) => {
  const ch = channels.find(c => c.name === thisUser.currentChannel);
  if (ch) ch.topic = topic;
  updateChannelInfo();
});

socket.on('search result', (msg) => {
  const results = JSON.parse(msg);
  renderSearchResults(results);
});

socket.on('clog', (msg) => {
  $('#clogContent').innerHTML = msg;
  $('#clogDialog').style.display = 'flex';
});

socket.on('kicked', (reason) => {
  addServerMessage('Je bent gekickt: ' + reason);
});

socket.on('disconnect', () => {
  $('#disconnectOverlay').style.display = 'flex';
});

// ============================================
// UI FUNCTIONS
// ============================================

function showError(el, msg) {
  el.textContent = msg;
  el.style.display = 'block';
  setTimeout(() => { el.style.display = 'none'; }, 5000);
}

function enterChat() {
  loginScreen.style.display = 'none';
  chatScreen.style.display = 'flex';
  userInfo.textContent = 'Welkom ' + thisUser.nickname;
  messageInput.focus();

  $('#welcomePopup').style.display = 'flex';

  if (thisUser.guest) {
    $('#uploadImageBtn').style.display = 'none';
    $('#profileImageInput').style.display = 'none';
  }
}

function renderChannelList() {
  channelsList.innerHTML = '';
  for (const ch of channels) {
    const li = document.createElement('li');
    li.innerHTML = `<span class="channelName">${ch.name}</span><span class="channelCount">${ch.currentUsers || 0}</span>`;
    li.dataset.channel = ch.name;
    if (thisUser && ch.name === thisUser.currentChannel) li.classList.add('active');
    li.addEventListener('click', () => {
      socket.emit('change channel', ch.name);
    });
    channelsList.appendChild(li);
  }
}

function highlightActiveChannel() {
  channelsList.querySelectorAll('li').forEach(li => {
    li.classList.toggle('active', li.dataset.channel === thisUser.currentChannel);
  });
}

function updateChannelInfo() {
  if (!thisUser || !thisUser.currentChannel) {
    channelInfo.textContent = 'Kies een kanaal';
    return;
  }
  const ch = channels.find(c => c.name === thisUser.currentChannel);
  const topic = ch ? ch.topic : '';
  const count = ch ? (ch.currentUsers || 0) : 0;
  channelInfo.innerHTML = `<strong>${thisUser.currentChannel}</strong> - ${count} van ${totalUsers} chatters ${topic ? '| ' + replaceEmoticons(topic) : ''}`;
}

function renderUsersList() {
  usersList.innerHTML = '';
  const sorted = [...channelUsers].sort((a, b) => {
    const levelA = a.currentChannelUserLevel || 0;
    const levelB = b.currentChannelUserLevel || 0;
    if (levelA !== levelB) return levelB - levelA;
    return a.nickname.localeCompare(b.nickname);
  });

  usersHeader.textContent = `Gebruikers (${sorted.length})`;

  for (const u of sorted) {
    const li = document.createElement('li');
    const levelClass = getLevelClass(u.currentChannelUserLevel || 0);
    const isGuest = u.nickname.startsWith('~');
    const iconClass = isGuest ? 'guest' : levelClass;
    const silencedClass = u.silenced ? ' silenced' : '';

    li.innerHTML = `<span class="userIcon ${iconClass}"></span><span class="userName${silencedClass}">${u.nickname}</span>`;
    li.dataset.nickname = u.nickname;

    if (clickedUser && clickedUser.nickname === u.nickname) li.classList.add('selected');

    li.addEventListener('click', () => selectUser(u));
    li.addEventListener('mouseenter', (e) => showUserPopup(u, e));
    li.addEventListener('mouseleave', hideUserPopup);

    usersList.appendChild(li);
  }

  if (thisUser && (thisUser.currentChannelUserLevel >= 1 || thisUser.accountType >= 3)) {
    operButtons.style.display = 'flex';
  } else {
    operButtons.style.display = 'none';
  }
}

function selectUser(u) {
  if (clickedUser && clickedUser.nickname === u.nickname) {
    deselectUser();
    return;
  }
  clickedUser = u;
  userActions.style.display = 'block';
  showUserInfo(u);
  renderUsersList();
}

function selectUserByNick(nick) {
  const u = channelUsers.find(cu => cu.nickname === nick);
  if (u) selectUser(u);
}

function deselectUser() {
  clickedUser = null;
  userActions.style.display = 'none';
  renderUsersList();
}

function showUserInfo(u) {
  const levelName = getLevelName(u.currentChannelUserLevel || 0);
  const isGuest = u.nickname.startsWith('~');
  selectedUserInfoEl.innerHTML = `
    <strong>${u.nickname}</strong> ${isGuest ? '(Gast)' : ''}<br>
    Niveau: ${levelName}<br>
    ${u.age ? 'Leeftijd: ' + u.age + '<br>' : ''}
    ${u.gender ? 'Geslacht: ' + (u.gender === 'male' ? 'Man' : 'Vrouw') + '<br>' : ''}
    ${u.location ? 'Locatie: ' + u.location + '<br>' : ''}
    ${u.additionalInfo ? 'Info: ' + u.additionalInfo : ''}
  `;
}

let popupEl = null;
function showUserPopup(u, e) {
  hideUserPopup();
  popupEl = document.createElement('div');
  popupEl.className = 'userPopup';
  const isGuest = u.nickname.startsWith('~');
  popupEl.innerHTML = `
    <div class="popupNick">${u.nickname}</div>
    ${isGuest ? 'Gast' : getLevelName(u.currentChannelUserLevel || 0)}<br>
    ${u.age ? 'Leeftijd: ' + u.age + '<br>' : ''}
    ${u.gender ? (u.gender === 'male' ? 'Man' : 'Vrouw') + '<br>' : ''}
    ${u.location ? u.location : ''}
  `;
  document.body.appendChild(popupEl);

  const rect = e.target.getBoundingClientRect();
  popupEl.style.left = (rect.left - 160) + 'px';
  popupEl.style.top = rect.top + 'px';
  if (rect.left < 200) {
    popupEl.style.left = (rect.right + 10) + 'px';
  }
}

function hideUserPopup() {
  if (popupEl) {
    popupEl.remove();
    popupEl = null;
  }
}

function addChannelMessage(m) {
  const li = document.createElement('li');
  const senderUser = channelUsers.find(u => u.nickname === m.sender);
  let senderLevel = 0;
  if (senderUser) senderLevel = senderUser.currentChannelUserLevel || 0;
  const isGuest = m.sender.startsWith('~');
  const levelClass = isGuest ? 'guest' : getLevelClass(senderLevel);
  const isBold = (senderLevel >= 3) ? 'font-weight:bold;' : '';

  let color = m.colour || '#ffffff';
  if ($('#textStandardColor').checked) color = '#ffffff';

  li.innerHTML = `<span class="timestamp">[${m.timestamp}]</span> <span class="sender ${levelClass}">${m.sender}</span> zegt: <span style="color:${color};${isBold}">${replaceEmoticons(m.content)}</span>`;
  messagesList.appendChild(li);
  scrollToBottom(channelChatArea);
}

function addServerMessage(msg) {
  const li = document.createElement('li');
  li.className = 'serverMsg';
  li.innerHTML = '&lt; ' + replaceEmoticons(msg) + ' &gt;';
  messagesList.appendChild(li);
  scrollToBottom(channelChatArea);
}

// PRIVATE CHAT
function openPrivateTab(nickname) {
  if (privateTabs[nickname]) {
    switchPrivateTab(nickname);
    return;
  }

  privateChatArea.style.display = 'flex';

  const tab = document.createElement('div');
  tab.className = 'privateTab active';
  tab.dataset.nick = nickname;
  tab.innerHTML = `<span>${nickname}</span><span class="closeTab">&times;</span>`;

  tab.querySelector('.closeTab').addEventListener('click', (e) => {
    e.stopPropagation();
    closePrivateTab(nickname);
  });
  tab.addEventListener('click', () => switchPrivateTab(nickname));
  privateTabsEl.appendChild(tab);

  const msgList = document.createElement('ul');
  msgList.className = 'privateMsgList active';
  msgList.dataset.nick = nickname;
  privateMessagesEl.appendChild(msgList);

  privateTabs[nickname] = { tab, msgList };

  privateTabsEl.querySelectorAll('.privateTab').forEach(t => t.classList.remove('active'));
  privateMessagesEl.querySelectorAll('.privateMsgList').forEach(l => l.classList.remove('active'));
  tab.classList.add('active');
  msgList.classList.add('active');

  activePrivateTab = nickname;
}

function switchPrivateTab(nickname) {
  privateTabsEl.querySelectorAll('.privateTab').forEach(t => t.classList.toggle('active', t.dataset.nick === nickname));
  privateMessagesEl.querySelectorAll('.privateMsgList').forEach(l => l.classList.toggle('active', l.dataset.nick === nickname));
  activePrivateTab = nickname;
}

function closePrivateTab(nickname) {
  const pt = privateTabs[nickname];
  if (pt) {
    pt.tab.remove();
    pt.msgList.remove();
    delete privateTabs[nickname];
  }
  if (activePrivateTab === nickname) {
    const remaining = Object.keys(privateTabs);
    if (remaining.length > 0) {
      switchPrivateTab(remaining[remaining.length - 1]);
    } else {
      activePrivateTab = null;
      privateChatArea.style.display = 'none';
    }
  }
}

function addPrivateMessage(nickname, m) {
  if (!privateTabs[nickname]) openPrivateTab(nickname);
  const li = document.createElement('li');
  let color = m.colour || '#ffffff';
  if ($('#textStandardColor').checked) color = '#ffffff';
  li.innerHTML = `<span class="timestamp">[${m.timestamp}]</span> <span class="sender">${m.sender}</span> zegt: <span style="color:${color}">${replaceEmoticons(m.content)}</span>`;
  privateTabs[nickname].msgList.appendChild(li);
  scrollToBottom(privateMessagesEl);
}

function renderSearchResults(results) {
  searchUsersListEl.innerHTML = '';
  searchUsersListEl.style.display = 'block';
  usersList.style.display = 'none';

  for (const u of results) {
    const li = document.createElement('li');
    const levelClass = getLevelClass(u.currentChannelUserLevel || 0);
    const isGuest = u.nickname.startsWith('~');
    const iconClass = isGuest ? 'guest' : levelClass;
    li.innerHTML = `<span class="userIcon ${iconClass}"></span><span class="userName">${u.nickname}</span> <span style="color:var(--text-dim);font-size:11px;">(${u.currentChannel || ''})</span>`;
    li.addEventListener('click', () => selectUser(u));
    searchUsersListEl.appendChild(li);
  }
}
