'use strict';

// ============================================================
// DutchChat v2.0 - FunkyChat Protocol Server
// Rebuilt from DutchChat v2.0 to speak the FunkyChat Socket.IO protocol
// Single "command" in / "event" out channel, HTTPS support
// ============================================================

require('dotenv').config();

const express = require('express');
const http = require('http');
const https = require('https');
const socketio = require('socket.io');
const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');
const validator = require('validator');
const multer = require('multer');
const db = require('./db');

const app = express();

// ============================================================
// HTTPS / HTTP SERVER SETUP
// ============================================================

let server;
const SSL_CERT_PATH = '/etc/letsencrypt/live/turksezenders.nl/fullchain.pem';
const SSL_KEY_PATH = '/etc/letsencrypt/live/turksezenders.nl/privkey.pem';

try {
  const sslOptions = {
    cert: fs.readFileSync(SSL_CERT_PATH),
    key: fs.readFileSync(SSL_KEY_PATH),
  };
  server = https.createServer(sslOptions, app);
  console.log('HTTPS server created with SSL certificates');
} catch (err) {
  console.log('SSL certificates not found, falling back to HTTP:', err.message);
  server = http.createServer(app);
}

const io = socketio(server, {
  origins: '*:*',
  pingInterval: 25000,
  pingTimeout: 20000,
});

const PORT = parseInt(process.env.PORT, 10) || 3100;
const VERSION = 'v2.0';
const BCRYPT_ROUNDS = 10;
const MAX_IMAGE_SIZE = 150 * 1024; // 150KB
const CHAT_LOG_SAVE_INTERVAL = 100; // Save log to DB every 100 messages

// ============================================================
// FUNKYCHAT ERROR CODES
// ============================================================

const ERR_NICK_IN_USE = 102;
const ERR_NO_PERMISSION = 103;
const ERR_CHANNEL_NOT_EXIST = 104;
const ERR_NOT_LOGGED_IN = 105;
const ERR_BANNED = 106;
const ERR_NICK_RESERVED = 109;
const ERR_NAME_NOT_ALLOWED = 110;
const ERR_ALREADY_IN_CHANNEL = 112;
const ERR_WRONG_PASSWORD = 118;

// ============================================================
// GLOBAL STATE (in-memory)
// ============================================================

const connections = []; // Array of Connection objects
const channels = [];    // Array of Channel objects
let filterList = [];    // Loaded from filter.txt

// Load filter list
try {
  const filterContent = fs.readFileSync(path.join(__dirname, 'filter.txt'), 'utf-8');
  filterList = filterContent.split(/\r?\n/).filter((line) => line.trim().length > 0);
  console.log(`Loaded ${filterList.length} filter entries`);
} catch (err) {
  console.log('No filter.txt found or error reading it, filter list empty');
  filterList = [];
}

// ============================================================
// MULTER SETUP FOR PROFILE IMAGE UPLOADS
// ============================================================

const uploadDir = path.join(__dirname, 'public', 'uploads');
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    const nickname = req.body.nickname || 'unknown';
    cb(null, nickname + ext);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: MAX_IMAGE_SIZE },
  fileFilter: (req, file, cb) => {
    const allowedTypes = ['.jpg', '.jpeg', '.png', '.gif'];
    const ext = path.extname(file.originalname).toLowerCase();
    if (allowedTypes.includes(ext)) {
      cb(null, true);
    } else {
      cb(new Error('Only jpg, jpeg, png, gif files are allowed'));
    }
  },
});

// ============================================================
// CORS + STATIC FILE SERVING
// ============================================================

app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

app.use('/static', express.static(path.join(__dirname, 'public')));
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Serve uploaded profile images
app.get('/uploads/:filename', (req, res) => {
  const filePath = path.join(uploadDir, req.params.filename);
  if (fs.existsSync(filePath)) {
    res.sendFile(filePath);
  } else {
    res.status(404).send('File not found');
  }
});

// Profile image upload endpoint
app.post('/upload', upload.single('profileImage'), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No file uploaded' });
  }

  const nickname = req.body.nickname;
  if (!nickname) {
    fs.unlinkSync(req.file.path);
    return res.status(400).json({ error: 'Nickname required' });
  }

  const filename = req.file.filename;

  // Update in-memory user and DB
  const user = findUserByNickname(nickname);
  if (user) {
    user.profileImage = filename;
    const ch = findChannelByName(user.currentChannel);
    if (ch) {
      // Notify channel about updated user via FunkyChat protocol
      broadcastUserlistToChannel(ch);
    }
    db.updateUser(nickname, { profileImage: filename }).catch((err) => {
      console.error('Error updating profile image in DB:', err);
    });
  }

  res.json({ success: true, filename });
});

// ============================================================
// HELPER: TIME STRING
// ============================================================

function getTimeString() {
  const date = new Date();
  const hour = String(date.getHours()).padStart(2, '0');
  const min = String(date.getMinutes()).padStart(2, '0');
  const sec = String(date.getSeconds()).padStart(2, '0');
  return `${hour}:${min}:${sec}`;
}

// ============================================================
// HELPER: DATE ADD (for ban duration calculation)
// ============================================================

function dateAdd(date, interval, units) {
  const ret = new Date(date);
  switch (interval.toLowerCase()) {
    case 'year':    ret.setFullYear(ret.getFullYear() + units); break;
    case 'quarter': ret.setMonth(ret.getMonth() + 3 * units); break;
    case 'month':   ret.setMonth(ret.getMonth() + units); break;
    case 'week':    ret.setDate(ret.getDate() + 7 * units); break;
    case 'day':     ret.setDate(ret.getDate() + units); break;
    case 'hour':    ret.setTime(ret.getTime() + units * 3600000); break;
    case 'minute':  ret.setTime(ret.getTime() + units * 60000); break;
    case 'second':  ret.setTime(ret.getTime() + units * 1000); break;
    default: return undefined;
  }
  return ret;
}

// ============================================================
// LEVEL CONVERSION HELPERS
// ============================================================

// DB stores numeric levels: 0=normal, 1=oper, 2=superuser, 3=cyber, 4=admin, 5=creator
// FunkyChat uses string profiles: "", "oper", "super", "creator", "cyber", "admin", "silent"

function numericLevelToProfile(n) {
  const map = { 0: '', 1: 'oper', 2: 'super', 3: 'cyber', 4: 'admin', 5: 'creator' };
  return map[n] !== undefined ? map[n] : '';
}

function profileToNumericLevel(s) {
  if (!s || s === '' || s === 'geen') return 0;
  const map = { oper: 1, super: 2, cyber: 3, admin: 4, creator: 5 };
  return map[s] !== undefined ? map[s] : 0;
}

// Legacy helpers (used in original business logic)
function convertLevelToString(n) {
  const map = { 0: 'normal', 1: 'oper', 2: 'super', 3: 'cyber', 4: 'admin', 5: 'creator' };
  return map[n] || null;
}

function convertStringToLevel(s) {
  const map = { normal: 0, oper: 1, super: 2, cyber: 3, admin: 4, creator: 5 };
  return map[s] !== undefined ? map[s] : null;
}

// If levelA is higher authority than levelB, return true
// Special rule: admin (4) > creator (5) in terms of power
function compareUserLevels(levelA, levelB) {
  if (levelA === 4 && levelB === 5) return true;
  if (levelA === 5 && levelB === 4) return false;
  return levelA > levelB;
}

// ============================================================
// FILTER CHECK
// ============================================================

function containsFilteredWord(text) {
  const lower = text.toLowerCase();
  for (const word of filterList) {
    if (word && lower.includes(word.toLowerCase())) {
      return true;
    }
  }
  return false;
}

// ============================================================
// CLASS: Message (internal, for chat log tracking)
// ============================================================

class Message {
  constructor(sender, colour, content) {
    this.sender = sender;
    this.colour = colour;
    this.timestamp = getTimeString();
    this.content = content;
  }
}

// ============================================================
// CLASS: User
// ============================================================

class User {
  constructor(nickname, accountType, age, gender, location, additionalInfo, email, profileImage, isGuest) {
    this.nickname = nickname;
    this.accountType = accountType; // numeric: 0=normal, 1=oper, 2=super, 3=cyber, 4=admin
    this.age = age;
    this.gender = gender;
    this.location = location;       // maps to FunkyChat "domicile"
    this.additionalInfo = additionalInfo; // maps to FunkyChat "extra"
    this.email = email;
    this.profileImage = profileImage;

    this.ip = '';
    this.guest = isGuest;
    this.hidden = false;
    this.silenced = false;

    this.currentChannel = '';
    this.currentChannelUserLevel = accountType; // numeric level in current channel
    this.userWhoGave = '';

    this.lastActive = Date.now();
    this.loggedIn = Date.now();

    // FunkyChat ignore list
    this.ignoreList = [];
  }

  // Get FunkyChat profile string for current channel level
  getProfile() {
    if (this.silenced) return 'silent';
    return numericLevelToProfile(this.currentChannelUserLevel);
  }

  // Get FunkyChat profile string for server-level (accountType)
  getServerProfile() {
    return numericLevelToProfile(this.accountType);
  }

  kick(reason) {
    const con = findConnectionFromUser(this);
    if (con) {
      sendEvent(con.socket, 'kick', {
        name: 'server',
        target: this.nickname,
        channel: this.currentChannel,
        reason: reason || '',
      });
      con.socket.disconnect();
    }
  }
}

// ============================================================
// CLASS: Channel
// ============================================================

class Channel {
  constructor(name, creator, topic, type, chatLog, isStatic) {
    this.name = name;
    this.creator = creator;
    this.topic = topic;
    this.type = type; // 0=normal, 1=admin
    this.currentUsers = 0;
    this.isStatic = isStatic;

    // Channel settings
    this.password = '';
    this.secret = false;
    this.welcomeMessage = '';

    // Permanent permissions loaded from DB
    this.permOperators = [];    // [{nickname, givenBy}]
    this.permSuperAdmins = [];  // [{nickname, givenBy}]
    this.banList = [];           // [{nickname, bannedBy}]

    // Chat log
    this.chatLog = chatLog || '';
    this.chatLogSaveCount = 0;
  }

  // Send a FunkyChat event to all users currently in this channel
  sendEventToChannel(eventName, data) {
    for (const con of connections) {
      if (con && con.user && con.user.currentChannel === this.name) {
        sendEvent(con.socket, eventName, data);
      }
    }
  }

  // Send server message to channel
  sendServerMessage(message) {
    this.sendEventToChannel('servermessage', { message });
  }

  // Send a chat message to all users in the channel (and update log)
  sendMessage(messageObj) {
    this.chatLog += '<br />' + messageObj.sender + ' : ' + messageObj.content;
    this.chatLogSaveCount++;

    if (this.chatLogSaveCount >= CHAT_LOG_SAVE_INTERVAL) {
      db.saveChatLog(this.name, this.chatLog).catch((err) => {
        console.error('Error saving chat log:', err);
      });
      this.chatLogSaveCount = 0;
    }

    const senderUser = findUserByNickname(messageObj.sender);

    this.sendEventToChannel('channelmessage', {
      name: messageObj.sender,
      profile: senderUser ? senderUser.getProfile() : '',
      channel: this.name,
      message: messageObj.content,
      color: messageObj.colour || '#000000',
      emote: '',
      blocked: '',
      history: '',
    });
  }

  // Add a user to this channel
  addToChannel(user) {
    // Check ban list
    for (const ban of this.banList) {
      if (ban && ban.nickname === user.nickname) {
        const con = findConnectionFromUser(user);
        if (con) {
          sendEvent(con.socket, 'error', {
            type: ERR_BANNED,
            name: user.nickname,
            target: '',
            channel: this.name,
          });
          sendEvent(con.socket, 'servermessage', {
            message: 'Je bent verbannen van dit kanaal.',
          });
        }
        return;
      }
    }

    if (!user.hidden) {
      this.currentUsers++;
    }

    // Determine user's channel permission level
    let foundUserPermissions = user.accountType;

    if (foundUserPermissions !== 4 && foundUserPermissions !== 3) {
      // Not admin or cyber, check channel-specific permissions
      for (const perm of this.permOperators) {
        if (perm && perm.nickname === user.nickname) {
          foundUserPermissions = 1;
          break;
        }
      }

      for (const perm of this.permSuperAdmins) {
        if (perm && perm.nickname === user.nickname) {
          foundUserPermissions = 2;
          break;
        }
      }

      if (this.creator === user.nickname) {
        foundUserPermissions = 5;
      }
    }

    user.currentChannel = this.name;
    user.currentChannelUserLevel = foundUserPermissions;

    if (!user.hidden) {
      // Notify channel about join
      this.sendEventToChannel('joined', {
        name: user.nickname,
        profile: user.getProfile(),
        channel: this.name,
        chattercount: getTotalOnlineUsers(),
        channelcount: getActiveChannelCount(),
      });
    }

    // Send userlist to the joining user
    broadcastUserlistToChannel(this, user);

    // Send channel info to joining user
    const con = findConnectionFromUser(user);
    if (con) {
      sendEvent(con.socket, 'channelinfo', {
        name: '',
        channel: this.name,
        info: {
          topic: this.topic,
          creator: this.creator,
          password: this.password ? true : false,
          secret: this.secret,
          welcome_message: this.welcomeMessage,
        },
      });

      if (this.isStatic === 1) {
        sendEvent(con.socket, 'servermessage', {
          message: '★Welkom op de DutchChat chat server',
        });
      }
      sendEvent(con.socket, 'servermessage', {
        message: 'kanaal topic: ' + this.topic,
      });
      if (this.isStatic === 0) {
        sendEvent(con.socket, 'servermessage', {
          message: 'kanaal aangemaakt door ' + this.creator,
        });
        sendEvent(con.socket, 'servermessage', {
          message: 'Dit kanaal is niet gemaakt door DutchChat. De maker van dit kanaal heeft het recht om je permanent of tijdelijk van dit kanaal te verwijderen.',
        });
      }
    }

    sendChannelListToAll();
  }

  // Remove a user from this channel
  removeFromChannel(user) {
    if (!user.hidden) {
      this.currentUsers--;
    }

    user.currentChannelUserLevel = user.accountType;
    const leftChannel = user.currentChannel;
    user.currentChannel = '';
    user.lastActive = Date.now();

    if (!user.hidden) {
      this.sendEventToChannel('parted', {
        name: user.nickname,
        channel: leftChannel,
        chattercount: getTotalOnlineUsers(),
        channelcount: getActiveChannelCount(),
      });
    }

    if (this.currentUsers <= 0) {
      this.currentUsers = 0;
      if (this.isStatic === 0) {
        // Kill the channel - remove from array
        const idx = channels.indexOf(this);
        if (idx !== -1) {
          channels[idx] = null;
        }

        db.deleteChannel(this.name).catch((err) => {
          console.error('Error deleting channel:', err);
        });

        sendChannelListToAll();
      }
    } else {
      sendChannelListToAll();
    }
  }

  // Load permanent permissions from database
  async loadPermissions() {
    this.permSuperAdmins = [];
    this.permOperators = [];

    try {
      const rows = await db.getChannelRights(this.name);
      for (const row of rows) {
        if (row.level === 1) {
          this.permOperators.push({ nickname: row.nickname, givenBy: row.given_by });
          console.log('Perm oper on ' + this.name + ': ' + row.nickname);
        } else if (row.level === 2) {
          this.permSuperAdmins.push({ nickname: row.nickname, givenBy: row.given_by });
          console.log('Perm super on ' + this.name + ': ' + row.nickname);
        }
      }
    } catch (err) {
      console.error('Error loading permissions for channel ' + this.name + ':', err);
    }
  }

  // Load chat log from database
  async loadChatLog() {
    try {
      const logRow = await db.getChatLog(this.name);
      if (logRow) {
        this.chatLog = logRow.text || '';
        console.log('Loaded chat log for ' + this.name);
      }
    } catch (err) {
      console.error('Error loading chat log for channel ' + this.name + ':', err);
    }
  }

  // Load ban list from database
  async loadBans() {
    this.banList = [];
    try {
      const rows = await db.getChannelBans(this.name);
      for (const row of rows) {
        this.banList.push({ nickname: row.nickname, bannedBy: row.banned_by });
      }
      console.log('Loaded ban list for ' + this.name + ' (' + this.banList.length + ' bans)');
    } catch (err) {
      console.error('Error loading ban list for channel ' + this.name + ':', err);
    }
  }
}

// ============================================================
// CLASS: Connection
// ============================================================

class Connection {
  constructor(user, socket, ip) {
    this.user = user;
    this.socket = socket;
    this.ip = ip;
  }
}

// ============================================================
// FUNKYCHAT PROTOCOL: sendEvent helper
// All server→client communication goes through socket.emit('event', {...})
// ============================================================

function sendEvent(socket, eventName, data) {
  socket.emit('event', { event: eventName, ...data });
}

// ============================================================
// GLOBAL HELPER FUNCTIONS
// ============================================================

function findConnectionBySocket(socket) {
  for (const con of connections) {
    if (con && con.socket && con.socket === socket) {
      return con;
    }
  }
  return null;
}

function findConnectionFromUser(user) {
  for (const con of connections) {
    if (con && con.user && con.user === user) {
      return con;
    }
  }
  return null;
}

function findUserByNickname(nickname) {
  for (const con of connections) {
    if (con && con.user && con.user.nickname === nickname) {
      return con.user;
    }
  }
  return null;
}

function findChannelByName(name) {
  for (const ch of channels) {
    if (ch && ch.name === name) {
      return ch;
    }
  }
  return null;
}

function removeConnection(con) {
  if (!con) return;

  for (let i = 0; i < connections.length; i++) {
    if (connections[i] && connections[i] === con) {
      if (connections[i].user && con.user.currentChannel !== '') {
        const ch = findChannelByName(con.user.currentChannel);
        if (ch) {
          ch.removeFromChannel(con.user);
        }
      }
      connections[i] = null;
    }
  }
  sendChannelListToAll();
}

function isUserLoggedIn(nickname) {
  for (const con of connections) {
    if (con && con.socket && con.user) {
      if (con.user.nickname === nickname) {
        return true;
      }
    }
  }
  return false;
}

function getTotalOnlineUsers() {
  let count = 0;
  for (const con of connections) {
    if (con && con.user) count++;
  }
  return count;
}

function getActiveChannelCount() {
  let count = 0;
  for (const ch of channels) {
    if (ch) count++;
  }
  return count;
}

// Build the FunkyChat channel list array
function buildChannelList(forUser) {
  const channelArr = [];
  for (const ch of channels) {
    if (ch !== null) {
      // If the channel is admin-only (type 1) and user isn't admin/cyber, skip secret channels
      if (ch.secret && forUser && forUser.accountType < 3) continue;
      channelArr.push({
        name: ch.name,
        type: ch.type === 1 ? 'admin' : 'public',
        usercount: ch.currentUsers,
        password: ch.password ? '***' : '',
        secret: ch.secret,
        prio: ch.isStatic === 1 ? 1 : 0,
      });
    }
  }
  return channelArr;
}

// Send channel list to a specific user
function sendChannelListToUser(user) {
  const con = findConnectionFromUser(user);
  if (!con) return;
  sendEvent(con.socket, 'channellist', {
    channels: buildChannelList(user),
  });
}

// Send channel list to all logged-in users
function sendChannelListToAll() {
  for (const con of connections) {
    if (con && con.user) {
      sendEvent(con.socket, 'channellist', {
        channels: buildChannelList(con.user),
      });
    }
  }
}

// Build and send userlist for a channel to a specific user (or all in channel)
function broadcastUserlistToChannel(ch, onlyToUser) {
  const usersArr = [];
  for (const c of connections) {
    if (c && c.socket && c.user) {
      if (c.user.currentChannel === ch.name) {
        usersArr.push({
          name: c.user.nickname,
          profile: c.user.getProfile(),
          channel: ch.name,
          hidden: c.user.hidden ? 'true' : '',
        });
      }
    }
  }

  if (onlyToUser) {
    const con = findConnectionFromUser(onlyToUser);
    if (con) {
      sendEvent(con.socket, 'userlist', { users: usersArr, channel: ch.name });
    }
  } else {
    // Send to all in channel
    for (const c of connections) {
      if (c && c.user && c.user.currentChannel === ch.name) {
        sendEvent(c.socket, 'userlist', { users: usersArr, channel: ch.name });
      }
    }
  }
}

function sendEventToAllLoggedInUsers(eventName, data) {
  for (const con of connections) {
    if (con && con.user) {
      sendEvent(con.socket, eventName, data);
    }
  }
}

function sendServerMessageToAll(message) {
  sendEventToAllLoggedInUsers('servermessage', { message });
}

// ============================================================
// PARSE COLOR TAGS IN TEXT (for /wall and /topic)
// ============================================================

function parseColoredText(text) {
  const parts = text.split(' ');
  let parsed = '';
  let firstCol = true;

  for (const part of parts) {
    if (/(^#[0-9A-F]{6}$)|(^#[0-9A-F]{3}$)/i.test(part)) {
      if (firstCol) {
        firstCol = false;
      } else {
        parsed += '</span>';
      }
      parsed += '<span style="color: ' + part + '">';
    } else {
      parsed += ' ' + part;
    }
  }

  if (!firstCol) {
    parsed += '</span>';
  }

  return parsed;
}

// ============================================================
// DATABASE INITIALIZATION: Load channels from DB
// ============================================================

async function loadChannelsFromDatabase() {
  try {
    const rows = await db.getChannels();
    console.log('Loading channels from database...');
    for (const row of rows) {
      const ch = new Channel(row.name, row.owner, row.topic, row.type, '', row.is_static);
      await ch.loadPermissions();
      await ch.loadBans();
      await ch.loadChatLog();
      channels.push(ch);
      console.log('Loaded channel: ' + ch.name);
    }
    console.log('All channels loaded (' + channels.length + ' total)');
  } catch (err) {
    console.error('Error loading channels from database:', err);
  }
}

// ============================================================
// SOCKET.IO - FunkyChat Protocol Handler
// All client→server: socket.emit('command', { command: 'name', ...params })
// All server→client: socket.emit('event', { event: 'name', ...params })
// ============================================================

io.on('connection', (socket) => {
  const ip = socket.handshake.headers['x-forwarded-for'] || socket.handshake.address || '';
  console.log('New connection from ' + ip);
  connections.push(new Connection(null, socket, ip));

  // ----------------------------------------------------------
  // DISCONNECT
  // ----------------------------------------------------------
  socket.on('disconnect', () => {
    console.log('Connection lost from ' + ip);
    const con = findConnectionBySocket(socket);
    if (con) {
      removeConnection(con);
    }
  });

  socket.on('error', (err) => {
    console.log('Socket Error:', err);
  });

  // ----------------------------------------------------------
  // SINGLE "command" HANDLER - FunkyChat Protocol
  // ----------------------------------------------------------
  socket.on('command', async (data) => {
    try {
      if (!data || typeof data !== 'object' || !data.command) return;

      const cmd = data.command.toLowerCase();

      // ======================================================
      // SIGNUP (login)
      // ======================================================
      if (cmd === 'signup') {
        await handleSignup(socket, data);
      }

      // ======================================================
      // REGISTER
      // ======================================================
      else if (cmd === 'register') {
        await handleRegister(socket, data);
      }

      // ======================================================
      // JOIN
      // ======================================================
      else if (cmd === 'join') {
        await handleJoin(socket, data);
      }

      // ======================================================
      // PART
      // ======================================================
      else if (cmd === 'part') {
        handlePart(socket, data);
      }

      // ======================================================
      // CHANNELMESSAGE
      // ======================================================
      else if (cmd === 'channelmessage') {
        handleChannelMessage(socket, data);
      }

      // ======================================================
      // PRIVATEMESSAGE
      // ======================================================
      else if (cmd === 'privatemessage') {
        handlePrivateMessage(socket, data);
      }

      // ======================================================
      // OP
      // ======================================================
      else if (cmd === 'op') {
        await handleOp(socket, data);
      }

      // ======================================================
      // DEOP
      // ======================================================
      else if (cmd === 'deop') {
        await handleDeop(socket, data);
      }

      // ======================================================
      // KICK
      // ======================================================
      else if (cmd === 'kick') {
        handleKick(socket, data);
      }

      // ======================================================
      // BAN
      // ======================================================
      else if (cmd === 'ban') {
        await handleBan(socket, data);
      }

      // ======================================================
      // UNBAN
      // ======================================================
      else if (cmd === 'unban') {
        await handleUnban(socket, data);
      }

      // ======================================================
      // BANLIST
      // ======================================================
      else if (cmd === 'banlist') {
        handleBanlist(socket, data);
      }

      // ======================================================
      // TOPIC
      // ======================================================
      else if (cmd === 'topic') {
        handleTopic(socket, data);
      }

      // ======================================================
      // USERLIST
      // ======================================================
      else if (cmd === 'userlist') {
        handleUserlist(socket, data);
      }

      // ======================================================
      // CHANNELLIST
      // ======================================================
      else if (cmd === 'channellist') {
        handleChannelList(socket);
      }

      // ======================================================
      // GETUSERINFO
      // ======================================================
      else if (cmd === 'getuserinfo') {
        handleGetUserInfo(socket, data);
      }

      // ======================================================
      // GETCHANNELINFO
      // ======================================================
      else if (cmd === 'getchannelinfo') {
        handleGetChannelInfo(socket, data);
      }

      // ======================================================
      // SETCHANNELINFO
      // ======================================================
      else if (cmd === 'setchannelinfo') {
        handleSetChannelInfo(socket, data);
      }

      // ======================================================
      // HIDE
      // ======================================================
      else if (cmd === 'hide') {
        handleHide(socket, data);
      }

      // ======================================================
      // UNHIDE
      // ======================================================
      else if (cmd === 'unhide') {
        handleUnhide(socket, data);
      }

      // ======================================================
      // SBAN (server ban)
      // ======================================================
      else if (cmd === 'sban') {
        await handleSban(socket, data);
      }

      // ======================================================
      // SUNBAN (server unban)
      // ======================================================
      else if (cmd === 'sunban') {
        await handleSunban(socket, data);
      }

      // ======================================================
      // SKICK (server kick)
      // ======================================================
      else if (cmd === 'skick') {
        handleSkick(socket, data);
      }

      // ======================================================
      // SOP (server op - temporary)
      // ======================================================
      else if (cmd === 'sop') {
        await handleSop(socket, data);
      }

      // ======================================================
      // SDEOP (server deop - temporary)
      // ======================================================
      else if (cmd === 'sdeop') {
        handleSdeop(socket, data);
      }

      // ======================================================
      // AUTOOP (permanent channel op)
      // ======================================================
      else if (cmd === 'autoop') {
        await handleAutoOp(socket, data);
      }

      // ======================================================
      // AUTODEOP (remove permanent channel op)
      // ======================================================
      else if (cmd === 'autodeop') {
        await handleAutoDeop(socket, data);
      }

      // ======================================================
      // AUTOOPLIST
      // ======================================================
      else if (cmd === 'autooplist') {
        await handleAutoOpList(socket, data);
      }

      // ======================================================
      // AUTOSOP (permanent server op)
      // ======================================================
      else if (cmd === 'autosop') {
        await handleAutoSop(socket, data);
      }

      // ======================================================
      // AUTOSOPLIST
      // ======================================================
      else if (cmd === 'autosoplist') {
        await handleAutoSopList(socket);
      }

      // ======================================================
      // AUTOSDEOP (permanent server deop)
      // ======================================================
      else if (cmd === 'autosdeop') {
        await handleAutoSdeop(socket, data);
      }

      // ======================================================
      // FIGNORE
      // ======================================================
      else if (cmd === 'fignore') {
        handleFignore(socket, data);
      }

      // ======================================================
      // FUNIGNORE
      // ======================================================
      else if (cmd === 'funignore') {
        handleFunignore(socket, data);
      }

      // ======================================================
      // SERVERMESSAGE (admin broadcast)
      // ======================================================
      else if (cmd === 'servermessage') {
        handleServerMessageCmd(socket, data);
      }

      // ======================================================
      // KILLCHANNEL
      // ======================================================
      else if (cmd === 'killchannel') {
        await handleKillChannel(socket, data);
      }

      // ======================================================
      // PING
      // ======================================================
      else if (cmd === 'ping') {
        sendEvent(socket, 'pong', {});
      }

      // ======================================================
      // QUIT
      // ======================================================
      else if (cmd === 'quit') {
        socket.disconnect();
      }

      // ======================================================
      // SILENT (mute user in channel)
      // ======================================================
      else if (cmd === 'silent') {
        handleSilent(socket, data);
      }

      // ======================================================
      // UNSILENT (unmute user in channel)
      // ======================================================
      else if (cmd === 'unsilent') {
        handleUnsilent(socket, data);
      }

      // ======================================================
      // CREATECHANNEL
      // ======================================================
      else if (cmd === 'createchannel') {
        await handleCreateChannel(socket, data);
      }

      // ======================================================
      // SEARCH
      // ======================================================
      else if (cmd === 'search') {
        handleSearch(socket, data);
      }

      // ======================================================
      // WHOIS
      // ======================================================
      else if (cmd === 'whois') {
        handleWhois(socket, data);
      }

      // ======================================================
      // ALLUSERS
      // ======================================================
      else if (cmd === 'allusers') {
        handleAllUsers(socket);
      }

      // ======================================================
      // VERSION
      // ======================================================
      else if (cmd === 'version') {
        const thisCon = findConnectionBySocket(socket);
        if (thisCon && thisCon.user) {
          sendEvent(socket, 'info', { message: 'Current version is: ' + VERSION });
        }
      }

      // ======================================================
      // INFO
      // ======================================================
      else if (cmd === 'info') {
        const thisCon = findConnectionBySocket(socket);
        if (thisCon && thisCon.user) {
          sendEvent(socket, 'info', {
            message: 'Chat Server owned by: Sunto<br />Coded By: joehollo<br />Rebuilt: DutchChat v2.0 (2026)',
          });
        }
      }

      // ======================================================
      // MAKESTATIC
      // ======================================================
      else if (cmd === 'makestatic') {
        await handleMakeStatic(socket, data);
      }

      // ======================================================
      // SBANLIST
      // ======================================================
      else if (cmd === 'sbanlist') {
        await handleSbanList(socket);
      }

      // ======================================================
      // SERRORLOG
      // ======================================================
      else if (cmd === 'serrorlog') {
        await handleErrorLog(socket);
      }

      // ======================================================
      // CLOG
      // ======================================================
      else if (cmd === 'clog') {
        handleClog(socket);
      }

      // ======================================================
      // CLEANLOG
      // ======================================================
      else if (cmd === 'cleanlog') {
        await handleCleanLog(socket);
      }

      // ======================================================
      // UNKNOWN COMMAND
      // ======================================================
      else {
        sendEvent(socket, 'error', {
          type: ERR_NO_PERMISSION,
          name: '',
          target: '',
          channel: '',
        });
      }

    } catch (err) {
      console.error('Command error:', err);
      db.logError(String(err), err.stack || '').catch(() => {});
    }
  });
});

// ============================================================
// COMMAND HANDLERS
// ============================================================

// ----------------------------------------------------------
// SIGNUP (login)
// FunkyChat: { command: "signup", nickname: "user", password: "", age: "25", gender: "man", domicile: "city", extra: "info" }
// ----------------------------------------------------------
async function handleSignup(socket, data) {
  try {
    const thisCon = findConnectionBySocket(socket);
    if (!thisCon) return;

    let nickname = (data.nickname || '').toLowerCase().trim();
    const password = data.password || '';
    const age = data.age || '';
    const gender = data.gender || '';
    const domicile = data.domicile || '';
    const extra = data.extra || '';

    console.log('Login request for: ' + nickname);

    // Check IP-based server ban
    const ipBans = await db.checkServerBanByIp(thisCon.ip);
    if (ipBans.length > 0) {
      const ban = ipBans[0];
      if (ban.unban_timestamp > Date.now()) {
        sendEvent(socket, 'error', {
          type: ERR_BANNED,
          name: nickname,
          target: '',
          channel: '',
        });
        sendEvent(socket, 'servermessage', {
          message: 'Je bent verbannen door ' + ban.banned_by + ' tot ' + new Date(parseInt(ban.unban_timestamp)).toString(),
        });
        socket.disconnect();
        return;
      } else {
        await db.removeServerBan(ban.nickname);
        sendEvent(socket, 'servermessage', {
          message: 'Je hebt weer toegang tot de chatserver, log opnieuw in.',
        });
        return;
      }
    }

    // Validate nickname length
    if (nickname.length < 3) {
      sendEvent(socket, 'error', {
        type: ERR_NAME_NOT_ALLOWED,
        name: nickname,
        target: '',
        channel: '',
      });
      return;
    }

    // Check filter
    if (containsFilteredWord(nickname)) {
      sendEvent(socket, 'error', {
        type: ERR_NAME_NOT_ALLOWED,
        name: nickname,
        target: '',
        channel: '',
      });
      return;
    }

    if (!password || password === '') {
      // GUEST login
      const existingUser = await db.findUser(nickname);
      if (existingUser) {
        // A registered user with that name exists
        sendEvent(socket, 'error', {
          type: ERR_NICK_RESERVED,
          name: nickname,
          target: '',
          channel: '',
        });
        return;
      }

      const guestNick = '~' + nickname;
      if (isUserLoggedIn(guestNick)) {
        sendEvent(socket, 'error', {
          type: ERR_NICK_IN_USE,
          name: guestNick,
          target: '',
          channel: '',
        });
        return;
      }

      thisCon.user = new User(
        guestNick, 0,
        age, gender, domicile, extra,
        '', 'none', true
      );
      thisCon.user.ip = thisCon.ip;

      // FunkyChat success: addedchatter + channellist
      sendEvent(socket, 'addedchatter', { nickname: guestNick });
      sendEvent(socket, 'channellist', { channels: buildChannelList(thisCon.user) });

    } else {
      // Authenticated login
      if (isUserLoggedIn(nickname)) {
        sendEvent(socket, 'error', {
          type: ERR_NICK_IN_USE,
          name: nickname,
          target: '',
          channel: '',
        });
        return;
      }

      const dbUser = await db.findUser(nickname);
      if (!dbUser) {
        sendEvent(socket, 'error', {
          type: ERR_WRONG_PASSWORD,
          name: nickname,
          target: '',
          channel: '',
        });
        return;
      }

      // bcrypt compare
      const passwordMatch = await bcrypt.compare(password, dbUser.password_hash);
      if (!passwordMatch) {
        sendEvent(socket, 'error', {
          type: ERR_WRONG_PASSWORD,
          name: nickname,
          target: '',
          channel: '',
        });
        return;
      }

      // Check server ban by nickname
      const nickBans = await db.checkServerBanByNickname(nickname);
      if (nickBans.length > 0) {
        const ban = nickBans[0];
        if (ban.unban_timestamp > Date.now()) {
          sendEvent(socket, 'error', {
            type: ERR_BANNED,
            name: nickname,
            target: '',
            channel: '',
          });
          sendEvent(socket, 'servermessage', {
            message: 'Je bent verbannen door ' + ban.banned_by + ' tot ' + new Date(parseInt(ban.unban_timestamp)).toString(),
          });
          socket.disconnect();
          return;
        } else {
          await db.removeServerBan(nickname);
          sendEvent(socket, 'servermessage', {
            message: 'Je hebt weer toegang tot de chatserver, log opnieuw in.',
          });
          return;
        }
      }

      // Use provided values or fall back to DB values
      let ageN = age || '';
      let genderN = gender || '';
      let locationN = domicile || '';
      let additionalInfoN = extra || '';

      if (ageN === '') ageN = dbUser.age;
      if (genderN === '') genderN = dbUser.gender;
      if (locationN === '') locationN = dbUser.location;
      if (additionalInfoN === '') additionalInfoN = dbUser.additional_info;

      thisCon.user = new User(
        dbUser.nickname, dbUser.account_type,
        ageN, genderN, locationN, additionalInfoN,
        dbUser.email, dbUser.profile_image, false
      );
      thisCon.user.ip = thisCon.ip;

      // Update DB if values have changed
      if (dbUser.age != ageN || dbUser.gender !== genderN || dbUser.location !== locationN || dbUser.additional_info !== additionalInfoN) {
        db.updateUser(nickname, {
          age: parseInt(ageN) || 0,
          gender: genderN,
          location: locationN,
          additionalInfo: additionalInfoN,
        }).catch((err) => console.error('Error updating user on login:', err));
      }

      // FunkyChat success: addedchatter + channellist
      sendEvent(socket, 'addedchatter', { nickname: dbUser.nickname });
      sendEvent(socket, 'channellist', { channels: buildChannelList(thisCon.user) });
    }
  } catch (err) {
    console.error('Login request error:', err);
    sendEvent(socket, 'error', {
      type: ERR_WRONG_PASSWORD,
      name: '',
      target: '',
      channel: '',
    });
  }
}

// ----------------------------------------------------------
// REGISTER
// FunkyChat: { command: "register", nickname: "user", password: "pass", email: "a@b.com" }
// ----------------------------------------------------------
async function handleRegister(socket, data) {
  try {
    const thisCon = findConnectionBySocket(socket);
    if (!thisCon) return;

    let nickname = (data.nickname || '').toLowerCase().trim();
    const password = data.password || '';
    const email = data.email || '';

    console.log('Register request for: ' + nickname);

    // Check filter
    if (containsFilteredWord(nickname)) {
      sendEvent(socket, 'error', {
        type: ERR_NAME_NOT_ALLOWED,
        name: nickname,
        target: '',
        channel: '',
      });
      return;
    }

    // Validate nickname: 3-20 chars, no spaces
    if (!validator.isLength(nickname, { min: 3, max: 20 }) || nickname.indexOf(' ') > -1) {
      sendEvent(socket, 'error', {
        type: ERR_NAME_NOT_ALLOWED,
        name: nickname,
        target: '',
        channel: '',
      });
      return;
    }

    // Validate password: at least 6 chars
    if (!password || password.length < 6) {
      sendEvent(socket, 'error', {
        type: ERR_WRONG_PASSWORD,
        name: nickname,
        target: '',
        channel: '',
      });
      return;
    }

    // Validate email
    if (!validator.isEmail(email)) {
      sendEvent(socket, 'error', {
        type: ERR_NAME_NOT_ALLOWED,
        name: nickname,
        target: '',
        channel: '',
      });
      return;
    }

    // Check if nickname taken
    const existing = await db.findUser(nickname);
    if (existing) {
      sendEvent(socket, 'error', {
        type: ERR_NICK_IN_USE,
        name: nickname,
        target: '',
        channel: '',
      });
      return;
    }

    // Hash password with bcrypt
    const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);

    await db.createUser(nickname, passwordHash, email);
    sendEvent(socket, 'registered', {});
  } catch (err) {
    console.error('Register request error:', err);
    sendEvent(socket, 'error', {
      type: ERR_NO_PERMISSION,
      name: '',
      target: '',
      channel: '',
    });
  }
}

// ----------------------------------------------------------
// JOIN
// FunkyChat: { command: "join", channel: "General", password: "" }
// ----------------------------------------------------------
async function handleJoin(socket, data) {
  try {
    const thisCon = findConnectionBySocket(socket);
    if (!thisCon || !thisCon.user) {
      sendEvent(socket, 'error', { type: ERR_NOT_LOGGED_IN, name: '', target: '', channel: '' });
      return;
    }

    const channelName = data.channel || '';
    const password = data.password || '';

    if (!channelName || channelName.length < 1) {
      sendEvent(socket, 'error', { type: ERR_CHANNEL_NOT_EXIST, name: '', target: '', channel: channelName });
      return;
    }

    // Check if already in this channel
    if (thisCon.user.currentChannel === channelName) {
      sendEvent(socket, 'error', { type: ERR_ALREADY_IN_CHANNEL, name: thisCon.user.nickname, target: '', channel: channelName });
      return;
    }

    thisCon.user.silenced = false;

    let chan = findChannelByName(channelName);

    if (!chan) {
      // Create channel on-the-fly (like /join in the old system)
      if (channelName.length < 3) {
        sendEvent(socket, 'servermessage', { message: 'The channel name must be 3 or more characters in length.' });
        return;
      }
      if (channelName.indexOf(' ') !== -1) {
        sendEvent(socket, 'servermessage', { message: 'The channel name must not contain spaces.' });
        return;
      }

      await db.createChannel(channelName, thisCon.user.nickname, '', 0);
      await db.createChatLog(channelName);

      chan = new Channel(channelName, thisCon.user.nickname, '', 0, '', 0);
      channels.push(chan);

      sendChannelListToAll();
    }

    // Check channel password
    if (chan.password && chan.password !== '' && chan.password !== password) {
      if (thisCon.user.accountType < 3) {
        sendEvent(socket, 'error', { type: ERR_WRONG_PASSWORD, name: thisCon.user.nickname, target: '', channel: channelName });
        return;
      }
    }

    // Leave current channel
    if (thisCon.user.currentChannel !== '') {
      const oldCh = findChannelByName(thisCon.user.currentChannel);
      if (oldCh) {
        oldCh.removeFromChannel(thisCon.user);
      }
    }

    // Join new channel
    chan.addToChannel(thisCon.user);
  } catch (err) {
    console.error('Join error:', err);
  }
}

// ----------------------------------------------------------
// PART
// FunkyChat: { command: "part", channel: "General" }
// ----------------------------------------------------------
function handlePart(socket, data) {
  try {
    const thisCon = findConnectionBySocket(socket);
    if (!thisCon || !thisCon.user) return;

    const channelName = data.channel || thisCon.user.currentChannel;

    if (thisCon.user.currentChannel === channelName) {
      const ch = findChannelByName(channelName);
      if (ch) {
        ch.removeFromChannel(thisCon.user);
      }

      // Auto-join General
      const generalCh = findChannelByName('General');
      if (generalCh) {
        generalCh.addToChannel(thisCon.user);
      }
    }
  } catch (err) {
    console.error('Part error:', err);
  }
}

// ----------------------------------------------------------
// CHANNELMESSAGE
// FunkyChat: { command: "channelmessage", channel: "General", message: "hello", emote: false }
// ----------------------------------------------------------
function handleChannelMessage(socket, data) {
  try {
    const sender = findConnectionBySocket(socket);
    if (!sender || !sender.user) return;

    if (sender.user.silenced) {
      sendEvent(socket, 'servermessage', {
        message: 'You do not have permission to talk on channel: ' + sender.user.currentChannel,
      });
      return;
    }

    const messageText = data.message || '';
    const channelName = data.channel || sender.user.currentChannel;
    const isEmote = data.emote || false;

    // Sanitize
    const sanitizedMessage = validator.escape(messageText);

    // Filter check
    if (containsFilteredWord(sanitizedMessage)) {
      sendEvent(socket, 'servermessage', {
        message: 'The message you entered contains a forbidden phrase, please try again.',
      });
      return;
    }

    const ch = findChannelByName(channelName);
    if (ch && sender.user.currentChannel === ch.name) {
      // Build the message internally for chat log
      const newMessage = new Message(sender.user.nickname, data.color || '#000000', sanitizedMessage);

      // Update chat log
      ch.chatLog += '<br />' + newMessage.sender + ' : ' + newMessage.content;
      ch.chatLogSaveCount++;

      if (ch.chatLogSaveCount >= CHAT_LOG_SAVE_INTERVAL) {
        db.saveChatLog(ch.name, ch.chatLog).catch((err) => {
          console.error('Error saving chat log:', err);
        });
        ch.chatLogSaveCount = 0;
      }

      // Broadcast via FunkyChat protocol
      ch.sendEventToChannel('channelmessage', {
        name: sender.user.nickname,
        profile: sender.user.getProfile(),
        channel: ch.name,
        message: sanitizedMessage,
        color: data.color || '#000000',
        emote: isEmote ? 'true' : '',
        blocked: '',
        history: '',
      });
    }
  } catch (err) {
    console.error('Channel message error:', err);
  }
}

// ----------------------------------------------------------
// PRIVATEMESSAGE
// FunkyChat: { command: "privatemessage", target: "user", message: "hello" }
// ----------------------------------------------------------
function handlePrivateMessage(socket, data) {
  try {
    const sender = findConnectionBySocket(socket);
    if (!sender || !sender.user) return;

    const targetName = data.target || '';
    const messageText = data.message || '';

    // Sanitize
    const sanitizedMessage = validator.escape(messageText);

    // Filter check
    if (containsFilteredWord(sanitizedMessage)) {
      sendEvent(socket, 'servermessage', {
        message: 'The message you entered contains a forbidden phrase, please try again.',
      });
      return;
    }

    const receiver = findUserByNickname(targetName);
    if (receiver) {
      // Check ignore list
      if (receiver.ignoreList && receiver.ignoreList.includes(sender.user.nickname)) {
        // Silently drop the message
        return;
      }

      const receiverCon = findConnectionFromUser(receiver);
      if (receiverCon) {
        sendEvent(receiverCon.socket, 'privatemessage', {
          name: sender.user.nickname,
          profile: sender.user.getProfile(),
          message: sanitizedMessage,
          color: data.color || '#000000',
        });
      }
    }
  } catch (err) {
    console.error('Private message error:', err);
  }
}

// ----------------------------------------------------------
// OP
// FunkyChat: { command: "op", channel: "General", target: "user", profile: "oper" }
// ----------------------------------------------------------
async function handleOp(socket, data) {
  try {
    const thisCon = findConnectionBySocket(socket);
    if (!thisCon || !thisCon.user) return;

    const targetName = data.target || '';
    const profileStr = data.profile || 'oper';
    const channelName = data.channel || thisCon.user.currentChannel;

    const userToUpgrade = findUserByNickname(targetName);
    if (!userToUpgrade) {
      sendEvent(socket, 'servermessage', { message: 'That user is not logged in or does not exist' });
      return;
    }

    const positionToSet = convertStringToLevel(profileStr);
    if (positionToSet === null) {
      sendEvent(socket, 'servermessage', { message: 'Account type must be oper, super, cyber or admin' });
      return;
    }

    const ch = findChannelByName(channelName);
    if (!ch) return;

    if (userToUpgrade.currentChannel !== thisCon.user.currentChannel) {
      sendEvent(socket, 'servermessage', { message: 'That user is not in the channel currently' });
      return;
    }

    let carryOut = false;

    if (thisCon.user.accountType === 4 || (thisCon.user.accountType === 3 && userToUpgrade.accountType !== 4 && positionToSet !== 4)) {
      carryOut = true;
    } else if (userToUpgrade.nickname === thisCon.user.nickname) {
      if (ch.creator === thisCon.user.nickname && positionToSet !== 3 && positionToSet !== 4) {
        carryOut = true;
      } else if (positionToSet === 0 && thisCon.user.currentChannelUserLevel !== 0) {
        carryOut = true;
      } else {
        try {
          const rights = await db.getChannelRights(ch.name);
          const userRight = rights.find((r) => r.nickname === thisCon.user.nickname);
          if (userRight) {
            if (userRight.level === 5 && positionToSet !== 4 && positionToSet !== 3) {
              carryOut = true;
            } else if (userRight.level >= positionToSet) {
              carryOut = true;
            }
          }
        } catch (err) {
          console.error('Error checking channel rights:', err);
        }

        if (!carryOut) {
          sendEvent(socket, 'error', { type: ERR_NO_PERMISSION, name: thisCon.user.nickname, target: targetName, channel: channelName });
          return;
        }
      }
    } else {
      if (thisCon.user.currentChannelUserLevel === userToUpgrade.currentChannelUserLevel ||
          compareUserLevels(thisCon.user.currentChannelUserLevel, userToUpgrade.currentChannelUserLevel)) {
        carryOut = true;
      }
    }

    if (carryOut) {
      userToUpgrade.currentChannelUserLevel = positionToSet;
      userToUpgrade.userWhoGave = thisCon.user.nickname;

      // Notify channel
      ch.sendEventToChannel('op', {
        name: thisCon.user.nickname,
        target: userToUpgrade.nickname,
        profile: userToUpgrade.getProfile(),
        channel: ch.name,
      });

      // Update userlist
      broadcastUserlistToChannel(ch);
    } else {
      sendEvent(socket, 'error', { type: ERR_NO_PERMISSION, name: thisCon.user.nickname, target: targetName, channel: channelName });
    }
  } catch (err) {
    console.error('Op error:', err);
  }
}

// ----------------------------------------------------------
// DEOP
// FunkyChat: { command: "deop", channel: "General", target: "user" }
// ----------------------------------------------------------
async function handleDeop(socket, data) {
  try {
    const thisCon = findConnectionBySocket(socket);
    if (!thisCon || !thisCon.user) return;

    const targetName = data.target || thisCon.user.nickname;
    const channelName = data.channel || thisCon.user.currentChannel;
    const ch = findChannelByName(channelName);

    if (targetName === thisCon.user.nickname || !targetName) {
      // Self-deop
      const lvl = thisCon.user.currentChannelUserLevel;
      if (lvl >= 1) {
        thisCon.user.currentChannelUserLevel = 0;
        if (ch) {
          ch.sendEventToChannel('op', {
            name: thisCon.user.nickname,
            target: thisCon.user.nickname,
            profile: '',
            channel: ch.name,
          });
          broadcastUserlistToChannel(ch);
        }
      } else {
        sendEvent(socket, 'error', { type: ERR_NO_PERMISSION, name: thisCon.user.nickname, target: targetName, channel: channelName });
      }
    } else {
      // Deop someone else
      const reqLevel = thisCon.user.currentChannelUserLevel;
      if (reqLevel === 5 || reqLevel === 4 || reqLevel === 3 || reqLevel === 2) {
        const userToDowngrade = findUserByNickname(targetName);
        if (userToDowngrade) {
          if (userToDowngrade.currentChannelUserLevel === 1 || userToDowngrade.currentChannelUserLevel === 2) {
            if (compareUserLevels(thisCon.user.currentChannelUserLevel, userToDowngrade.currentChannelUserLevel) || thisCon.user.currentChannelUserLevel === 4) {
              if (thisCon.user.currentChannel !== userToDowngrade.currentChannel) {
                sendEvent(socket, 'servermessage', { message: 'The user you specified is not in this channel at present.' });
                return;
              }

              userToDowngrade.currentChannelUserLevel = 0;
              userToDowngrade.userWhoGave = thisCon.user.nickname;

              if (ch) {
                ch.sendEventToChannel('op', {
                  name: thisCon.user.nickname,
                  target: userToDowngrade.nickname,
                  profile: '',
                  channel: ch.name,
                });
                broadcastUserlistToChannel(ch);
              }
            } else {
              sendEvent(socket, 'error', { type: ERR_NO_PERMISSION, name: thisCon.user.nickname, target: targetName, channel: channelName });
            }
          } else {
            sendEvent(socket, 'servermessage', { message: 'That user is not oper or super, did you mean /sdeop?' });
          }
        }
      } else {
        sendEvent(socket, 'error', { type: ERR_NO_PERMISSION, name: thisCon.user.nickname, target: targetName, channel: channelName });
      }
    }
  } catch (err) {
    console.error('Deop error:', err);
  }
}

// ----------------------------------------------------------
// KICK
// FunkyChat: { command: "kick", channel: "General", target: "user", reason: "" }
// ----------------------------------------------------------
function handleKick(socket, data) {
  try {
    const thisCon = findConnectionBySocket(socket);
    if (!thisCon || !thisCon.user) return;

    const targetName = data.target || '';
    const channelName = data.channel || thisCon.user.currentChannel;
    const reason = data.reason || '';

    const reqLevel = thisCon.user.currentChannelUserLevel;
    if (reqLevel === 4 || reqLevel === 3 || reqLevel === 2 || reqLevel === 1 || reqLevel === 5) {
      const userToKick = findUserByNickname(targetName);
      if (userToKick) {
        if (userToKick.accountType === 3 || userToKick.accountType === 4) {
          sendEvent(socket, 'servermessage', { message: 'Can not kick cyber/admin accounts.' });
          return;
        }

        const kickCh = findChannelByName(userToKick.currentChannel);
        if (
          (compareUserLevels(thisCon.user.currentChannelUserLevel, userToKick.currentChannelUserLevel) &&
           userToKick.nickname !== (kickCh ? kickCh.creator : '')) ||
          thisCon.user.currentChannelUserLevel === 4
        ) {
          if (userToKick.currentChannel === thisCon.user.currentChannel) {
            // Notify channel about the kick
            const ch = findChannelByName(thisCon.user.currentChannel);
            if (ch) {
              ch.sendEventToChannel('kick', {
                name: thisCon.user.nickname,
                target: userToKick.nickname,
                channel: ch.name,
                reason: reason,
              });
            }

            const kickCon = findConnectionFromUser(userToKick);
            if (kickCh) {
              kickCh.removeFromChannel(userToKick);
            }

            // Move kicked user to General
            if (kickCon) {
              const generalCh = findChannelByName('General');
              if (generalCh) {
                generalCh.addToChannel(userToKick);
              }
            }

            sendChannelListToAll();
          }
        } else {
          sendEvent(socket, 'error', { type: ERR_NO_PERMISSION, name: thisCon.user.nickname, target: targetName, channel: channelName });
        }
      }
    } else {
      sendEvent(socket, 'error', { type: ERR_NO_PERMISSION, name: thisCon.user.nickname, target: targetName, channel: channelName });
    }
  } catch (err) {
    console.error('Kick error:', err);
  }
}

// ----------------------------------------------------------
// BAN
// FunkyChat: { command: "ban", channel: "General", target: "user", reason: "" }
// ----------------------------------------------------------
async function handleBan(socket, data) {
  try {
    const thisCon = findConnectionBySocket(socket);
    if (!thisCon || !thisCon.user) return;

    const targetName = data.target || '';
    const channelName = data.channel || thisCon.user.currentChannel;
    const reason = data.reason || '';

    const reqLevel = thisCon.user.currentChannelUserLevel;
    const ch = findChannelByName(channelName);

    if (
      reqLevel === 4 || reqLevel === 3 ||
      ((reqLevel === 2 || reqLevel === 1 || reqLevel === 5) && ch && ch.creator !== targetName)
    ) {
      const userToBan = findUserByNickname(targetName);
      if (userToBan) {
        if (compareUserLevels(thisCon.user.currentChannelUserLevel, userToBan.currentChannelUserLevel) || thisCon.user.currentChannelUserLevel === 4) {
          if (userToBan.accountType === 3 || userToBan.accountType === 4) {
            sendEvent(socket, 'servermessage', { message: 'Can not ban cyber/admin accounts.' });
            return;
          }

          if (!ch) return;

          // Check if already banned
          const existingBan = ch.banList.find((b) => b && b.nickname === userToBan.nickname);
          if (existingBan) {
            sendEvent(socket, 'servermessage', { message: 'That user is already banned' });
            return;
          }

          await db.addChannelBan(ch.name, userToBan.nickname, thisCon.user.nickname);
          ch.banList.push({ nickname: userToBan.nickname, bannedBy: thisCon.user.nickname });

          // Notify channel
          ch.sendEventToChannel('ban', {
            name: thisCon.user.nickname,
            target: userToBan.nickname,
            channel: ch.name,
            reason: reason,
          });

          if (userToBan.currentChannel === ch.name) {
            ch.removeFromChannel(userToBan);

            // Move banned user to General
            const banCon = findConnectionFromUser(userToBan);
            if (banCon) {
              const generalCh = findChannelByName('General');
              if (generalCh) {
                generalCh.addToChannel(userToBan);
              }
            }

            sendChannelListToAll();
          }
        } else {
          sendEvent(socket, 'error', { type: ERR_NO_PERMISSION, name: thisCon.user.nickname, target: targetName, channel: channelName });
        }
      } else {
        sendEvent(socket, 'servermessage', { message: 'User not found or not online' });
      }
    } else {
      sendEvent(socket, 'error', { type: ERR_NO_PERMISSION, name: thisCon.user.nickname, target: targetName, channel: channelName });
    }
  } catch (err) {
    console.error('Ban error:', err);
  }
}

// ----------------------------------------------------------
// UNBAN
// FunkyChat: { command: "unban", channel: "General", target: "user" }
// ----------------------------------------------------------
async function handleUnban(socket, data) {
  try {
    const thisCon = findConnectionBySocket(socket);
    if (!thisCon || !thisCon.user) return;

    const targetName = data.target || '';
    const channelName = data.channel || thisCon.user.currentChannel;

    const reqLevel = thisCon.user.currentChannelUserLevel;
    if (reqLevel === 4 || reqLevel === 3 || reqLevel === 2 || reqLevel === 1 || reqLevel === 5) {
      const ch = findChannelByName(channelName);
      if (!ch) return;

      const banEntry = ch.banList.find((b) => b && b.nickname === targetName);
      if (!banEntry) {
        sendEvent(socket, 'servermessage', { message: 'Gebruiker is niet verbannen!' });
        return;
      }

      await db.removeChannelBan(channelName, targetName);

      // Remove from in-memory ban list
      for (let i = 0; i < ch.banList.length; i++) {
        if (ch.banList[i] && ch.banList[i].nickname === targetName) {
          ch.banList[i] = null;
        }
      }

      // Notify channel
      ch.sendEventToChannel('unban', {
        name: thisCon.user.nickname,
        target: targetName,
        channel: ch.name,
      });

      // Also notify the target user if they're online
      const targetUser = findUserByNickname(targetName);
      if (targetUser) {
        const targetCon = findConnectionFromUser(targetUser);
        if (targetCon) {
          sendEvent(targetCon.socket, 'servermessage', {
            message: thisCon.user.nickname + ' unbanned ' + targetName + ' from ' + ch.name,
          });
        }
      }
    } else {
      sendEvent(socket, 'error', { type: ERR_NO_PERMISSION, name: thisCon.user.nickname, target: targetName, channel: channelName });
    }
  } catch (err) {
    console.error('Unban error:', err);
  }
}

// ----------------------------------------------------------
// BANLIST
// FunkyChat: { command: "banlist", channel: "General" }
// ----------------------------------------------------------
function handleBanlist(socket, data) {
  try {
    const thisCon = findConnectionBySocket(socket);
    if (!thisCon || !thisCon.user) return;

    const channelName = data.channel || thisCon.user.currentChannel;

    const reqLevel = thisCon.user.currentChannelUserLevel;
    if (reqLevel === 4 || reqLevel === 3 || reqLevel === 2 || reqLevel === 1 || reqLevel === 5) {
      const ch = findChannelByName(channelName);
      if (ch) {
        const bans = [];
        for (const ban of ch.banList) {
          if (ban) {
            bans.push({
              target: ban.nickname,
              banner: ban.bannedBy,
              bantime: 0, // channel bans are permanent in this system
            });
          }
        }
        sendEvent(socket, 'banlist', { channel: ch.name, bans });
      }
    } else {
      sendEvent(socket, 'error', { type: ERR_NO_PERMISSION, name: thisCon.user.nickname, target: '', channel: channelName });
    }
  } catch (err) {
    console.error('Banlist error:', err);
  }
}

// ----------------------------------------------------------
// TOPIC
// FunkyChat: { command: "topic", channel: "General", topic: "new topic" }
// ----------------------------------------------------------
function handleTopic(socket, data) {
  try {
    const thisCon = findConnectionBySocket(socket);
    if (!thisCon || !thisCon.user) return;

    const channelName = data.channel || thisCon.user.currentChannel;
    const topicText = data.topic || '';

    const reqLevel = thisCon.user.currentChannelUserLevel;
    if (reqLevel === 4 || reqLevel === 3 || reqLevel === 2 || reqLevel === 1 || reqLevel === 5) {
      const ch = findChannelByName(channelName);
      if (ch) {
        const parsedTopic = parseColoredText(topicText);
        ch.topic = parsedTopic;

        ch.sendEventToChannel('topic', {
          name: thisCon.user.nickname,
          channel: ch.name,
        });

        ch.sendServerMessage(thisCon.user.nickname + ' heeft de topic verandert');
        ch.sendServerMessage('Nieuw Topic: ' + ch.topic);
      }
    } else {
      sendEvent(socket, 'error', { type: ERR_NO_PERMISSION, name: thisCon.user.nickname, target: '', channel: channelName });
    }
  } catch (err) {
    console.error('Topic error:', err);
  }
}

// ----------------------------------------------------------
// USERLIST
// FunkyChat: { command: "userlist", channel: "General" }
// ----------------------------------------------------------
function handleUserlist(socket, data) {
  try {
    const thisCon = findConnectionBySocket(socket);
    if (!thisCon || !thisCon.user) return;

    const channelName = data.channel || thisCon.user.currentChannel;
    const ch = findChannelByName(channelName);
    if (ch) {
      broadcastUserlistToChannel(ch, thisCon.user);
    }
  } catch (err) {
    console.error('Userlist error:', err);
  }
}

// ----------------------------------------------------------
// CHANNELLIST
// FunkyChat: { command: "channellist" }
// ----------------------------------------------------------
function handleChannelList(socket) {
  try {
    const thisCon = findConnectionBySocket(socket);
    if (!thisCon || !thisCon.user) return;
    sendChannelListToUser(thisCon.user);
  } catch (err) {
    console.error('Channellist error:', err);
  }
}

// ----------------------------------------------------------
// GETUSERINFO
// FunkyChat: { command: "getuserinfo", target: "user" }
// ----------------------------------------------------------
function handleGetUserInfo(socket, data) {
  try {
    const thisCon = findConnectionBySocket(socket);
    if (!thisCon || !thisCon.user) return;

    const targetName = data.target || '';
    const targetUser = findUserByNickname(targetName);
    if (targetUser) {
      const connectTime = Math.floor((Date.now() - targetUser.loggedIn) / 1000);
      const idleTime = Math.floor((Date.now() - targetUser.lastActive) / 1000);

      sendEvent(socket, 'userinfo', {
        name: thisCon.user.nickname,
        target: targetUser.nickname,
        age: String(targetUser.age || ''),
        gender: targetUser.gender || '',
        domicile: targetUser.location || '',
        extra: targetUser.additionalInfo || '',
        profile: targetUser.getServerProfile(),
        connecttime: connectTime,
        idletime: idleTime,
      });
    } else {
      sendEvent(socket, 'servermessage', { message: targetName + ' gebruiker niet ingelogd, of bestaat niet.' });
    }
  } catch (err) {
    console.error('GetUserInfo error:', err);
  }
}

// ----------------------------------------------------------
// GETCHANNELINFO
// FunkyChat: { command: "getchannelinfo", channel: "General" }
// ----------------------------------------------------------
function handleGetChannelInfo(socket, data) {
  try {
    const thisCon = findConnectionBySocket(socket);
    if (!thisCon || !thisCon.user) return;

    const channelName = data.channel || thisCon.user.currentChannel;
    const ch = findChannelByName(channelName);
    if (ch) {
      sendEvent(socket, 'channelinfo', {
        name: thisCon.user.nickname,
        channel: ch.name,
        info: {
          topic: ch.topic,
          creator: ch.creator,
          password: ch.password ? true : false,
          secret: ch.secret,
          welcome_message: ch.welcomeMessage,
        },
      });
    } else {
      sendEvent(socket, 'error', { type: ERR_CHANNEL_NOT_EXIST, name: '', target: '', channel: channelName });
    }
  } catch (err) {
    console.error('GetChannelInfo error:', err);
  }
}

// ----------------------------------------------------------
// SETCHANNELINFO
// FunkyChat: { command: "setchannelinfo", channel: "General", info: { topic: "...", password: "...", secret: false, welcome_message: "" } }
// ----------------------------------------------------------
function handleSetChannelInfo(socket, data) {
  try {
    const thisCon = findConnectionBySocket(socket);
    if (!thisCon || !thisCon.user) return;

    const channelName = data.channel || thisCon.user.currentChannel;
    const info = data.info || {};

    const reqLevel = thisCon.user.currentChannelUserLevel;
    if (reqLevel === 4 || reqLevel === 3 || reqLevel === 5 || reqLevel === 2) {
      const ch = findChannelByName(channelName);
      if (ch) {
        let changed = false;
        if (info.topic !== undefined && parseColoredText(info.topic) !== ch.topic) {
          ch.topic = parseColoredText(info.topic);
          ch.sendEventToChannel('topic', { name: thisCon.user.nickname, channel: ch.name });
          changed = true;
        }
        if (info.password !== undefined && info.password !== ch.password) {
          ch.password = info.password;
          changed = true;
        }
        if (info.secret !== undefined && info.secret !== ch.secret) {
          ch.secret = info.secret;
          changed = true;
        }
        if (info.welcome_message !== undefined && info.welcome_message !== ch.welcomeMessage) {
          ch.welcomeMessage = info.welcome_message;
          changed = true;
        }
        if (!changed) return;

        // Confirm update
        sendEvent(socket, 'channelinfo', {
          name: thisCon.user.nickname,
          channel: ch.name,
          info: {
            topic: ch.topic,
            creator: ch.creator,
            password: ch.password ? true : false,
            secret: ch.secret,
            welcome_message: ch.welcomeMessage,
          },
        });

        sendChannelListToAll();
      }
    } else {
      sendEvent(socket, 'error', { type: ERR_NO_PERMISSION, name: thisCon.user.nickname, target: '', channel: channelName });
    }
  } catch (err) {
    console.error('SetChannelInfo error:', err);
  }
}

// ----------------------------------------------------------
// HIDE
// FunkyChat: { command: "hide", channel: "General" }
// ----------------------------------------------------------
function handleHide(socket, data) {
  try {
    const thisCon = findConnectionBySocket(socket);
    if (!thisCon || !thisCon.user) return;

    if (thisCon.user.accountType === 4 || thisCon.user.accountType === 3) {
      if (!thisCon.user.hidden) {
        const ch = findChannelByName(thisCon.user.currentChannel);
        if (ch) {
          thisCon.user.hidden = true;
          ch.currentUsers--;

          ch.sendEventToChannel('hide', {
            name: thisCon.user.nickname,
            channel: ch.name,
          });

          broadcastUserlistToChannel(ch);
          sendChannelListToAll();
        }
      }
    }
  } catch (err) {
    console.error('Hide error:', err);
  }
}

// ----------------------------------------------------------
// UNHIDE
// FunkyChat: { command: "unhide", channel: "General" }
// ----------------------------------------------------------
function handleUnhide(socket, data) {
  try {
    const thisCon = findConnectionBySocket(socket);
    if (!thisCon || !thisCon.user) return;

    if (thisCon.user.accountType === 4 || thisCon.user.accountType === 3) {
      if (thisCon.user.hidden) {
        const ch = findChannelByName(thisCon.user.currentChannel);
        if (ch) {
          thisCon.user.hidden = false;
          ch.currentUsers++;

          ch.sendEventToChannel('unhide', {
            name: thisCon.user.nickname,
            channel: ch.name,
          });

          broadcastUserlistToChannel(ch);
          sendChannelListToAll();
        }
      }
    }
  } catch (err) {
    console.error('Unhide error:', err);
  }
}

// ----------------------------------------------------------
// SBAN (server ban)
// FunkyChat: { command: "sban", target: "user", reason: "" }
// ----------------------------------------------------------
async function handleSban(socket, data) {
  try {
    const thisCon = findConnectionBySocket(socket);
    if (!thisCon || !thisCon.user) return;

    if (thisCon.user.accountType === 4 || thisCon.user.accountType === 3) {
      const targetName = data.target || '';
      const reason = data.reason || '';
      const duration = data.duration || '72h';

      const userToBan = findUserByNickname(targetName);
      if (userToBan) {
        if (thisCon.user.accountType >= userToBan.accountType) {
          let forTime = duration;
          let forSymbol = 'hour';
          if (forTime[forTime.length - 1] === 'm') {
            forSymbol = 'minute';
          }

          const timeValue = parseInt(forTime.substring(0, forTime.length - 1), 10) || 72;
          const banUntil = dateAdd(Date.now(), forSymbol, timeValue);

          await db.addServerBan(userToBan.nickname, thisCon.user.nickname, Number(banUntil), userToBan.ip);

          sendEventToAllLoggedInUsers('sban', {
            name: thisCon.user.nickname,
            target: userToBan.nickname,
            reason: reason,
          });

          sendServerMessageToAll(
            thisCon.user.nickname + ' heeft ' + userToBan.nickname + ' uitgesloten van de chat server tot ' + banUntil.toString()
          );

          const banCon = findConnectionFromUser(userToBan);
          if (banCon) {
            banCon.socket.disconnect();
          }
        }
      } else {
        sendEvent(socket, 'servermessage', { message: 'Gebruiker niet online.' });
      }
    } else {
      sendEvent(socket, 'error', { type: ERR_NO_PERMISSION, name: thisCon.user.nickname, target: data.target || '', channel: '' });
    }
  } catch (err) {
    console.error('Sban error:', err);
  }
}

// ----------------------------------------------------------
// SUNBAN (server unban)
// FunkyChat: { command: "sunban", target: "user" }
// ----------------------------------------------------------
async function handleSunban(socket, data) {
  try {
    const thisCon = findConnectionBySocket(socket);
    if (!thisCon || !thisCon.user) return;

    if (thisCon.user.accountType === 4 || thisCon.user.accountType === 3) {
      const targetName = data.target || '';
      const bans = await db.checkServerBanByNickname(targetName);
      if (bans.length > 0) {
        await db.removeServerBan(targetName);

        sendEvent(socket, 'sunban', {
          name: thisCon.user.nickname,
          target: targetName,
        });

        sendEvent(socket, 'servermessage', {
          message: 'Gebruiker heeft weer toegang tot de chat server: ' + targetName,
        });
      } else {
        sendEvent(socket, 'servermessage', { message: 'Gebruiker is niet uitgesloten van de chat server' });
      }
    } else {
      sendEvent(socket, 'error', { type: ERR_NO_PERMISSION, name: thisCon.user.nickname, target: data.target || '', channel: '' });
    }
  } catch (err) {
    console.error('Sunban error:', err);
  }
}

// ----------------------------------------------------------
// SKICK (server kick)
// FunkyChat: { command: "skick", target: "user", reason: "" }
// ----------------------------------------------------------
function handleSkick(socket, data) {
  try {
    const thisCon = findConnectionBySocket(socket);
    if (!thisCon || !thisCon.user) return;

    if (thisCon.user.accountType === 4 || thisCon.user.accountType === 3) {
      const targetName = data.target || '';
      const reason = data.reason || '';
      const userToKick = findUserByNickname(targetName);
      if (userToKick) {
        if (thisCon.user.accountType >= userToKick.accountType) {
          sendEventToAllLoggedInUsers('skick', {
            name: thisCon.user.nickname,
            target: userToKick.nickname,
            reason: reason,
          });

          sendServerMessageToAll(
            thisCon.user.nickname + ' heeft ' + userToKick.nickname + ' verwijdert van de chat server.'
          );

          const kickCon = findConnectionFromUser(userToKick);
          if (kickCon) {
            kickCon.socket.disconnect();
          }
        }
      }
    } else {
      sendEvent(socket, 'error', { type: ERR_NO_PERMISSION, name: thisCon.user.nickname, target: data.target || '', channel: '' });
    }
  } catch (err) {
    console.error('Skick error:', err);
  }
}

// ----------------------------------------------------------
// SOP (server op - temporary, sets accountType in memory only)
// FunkyChat: { command: "sop", target: "user", profile: "cyber" }
// ----------------------------------------------------------
async function handleSop(socket, data) {
  try {
    const thisCon = findConnectionBySocket(socket);
    if (!thisCon || !thisCon.user) return;

    if (thisCon.user.accountType === 4) {
      const targetName = data.target || '';
      const profileStr = data.profile || 'cyber';
      const targetLevel = convertStringToLevel(profileStr);

      const userToUpgrade = findUserByNickname(targetName);
      if (userToUpgrade && targetLevel !== null) {
        userToUpgrade.accountType = targetLevel;
        userToUpgrade.currentChannelUserLevel = targetLevel;

        const ch = findChannelByName(userToUpgrade.currentChannel);

        sendEventToAllLoggedInUsers('sop', {
          name: thisCon.user.nickname,
          target: userToUpgrade.nickname,
          profile: numericLevelToProfile(targetLevel),
        });

        if (ch) {
          broadcastUserlistToChannel(ch);
        }
      }
    } else {
      sendEvent(socket, 'error', { type: ERR_NO_PERMISSION, name: thisCon.user.nickname, target: data.target || '', channel: '' });
    }
  } catch (err) {
    console.error('Sop error:', err);
  }
}

// ----------------------------------------------------------
// SDEOP (server deop - temporary, removes server rights in memory only)
// FunkyChat: { command: "sdeop", target: "user" }
// ----------------------------------------------------------
function handleSdeop(socket, data) {
  try {
    const thisCon = findConnectionBySocket(socket);
    if (!thisCon || !thisCon.user) return;

    if (thisCon.user.accountType === 4) {
      const targetName = data.target || '';
      const userToDowngrade = findUserByNickname(targetName);
      if (userToDowngrade && userToDowngrade.accountType === 3) {
        userToDowngrade.accountType = 0;
        userToDowngrade.currentChannelUserLevel = 0;

        const ch = findChannelByName(userToDowngrade.currentChannel);

        sendEventToAllLoggedInUsers('sdeop', {
          name: thisCon.user.nickname,
          target: userToDowngrade.nickname,
        });

        if (ch) {
          ch.sendServerMessage(
            thisCon.user.nickname + ' heeft ' + userToDowngrade.nickname + ' normaal gemaakt op kanaal ' + userToDowngrade.currentChannel + ' en tijdelijk blijvende rechten afgenomen.'
          );
          broadcastUserlistToChannel(ch);
        }
      }
    } else {
      sendEvent(socket, 'error', { type: ERR_NO_PERMISSION, name: thisCon.user.nickname, target: data.target || '', channel: '' });
    }
  } catch (err) {
    console.error('Sdeop error:', err);
  }
}

// ----------------------------------------------------------
// AUTOOP (permanent channel op)
// FunkyChat: { command: "autoop", channel: "General", target: "user", profile: "oper" }
// ----------------------------------------------------------
async function handleAutoOp(socket, data) {
  try {
    const thisCon = findConnectionBySocket(socket);
    if (!thisCon || !thisCon.user) return;

    const targetName = data.target || '';
    const profileStr = data.profile || 'oper';
    const channelName = data.channel || thisCon.user.currentChannel;

    const reqLevel = thisCon.user.currentChannelUserLevel;
    if (reqLevel === 5 || reqLevel === 4 || reqLevel === 3 || reqLevel === 2) {
      const userToUpgrade = findUserByNickname(targetName);
      if (userToUpgrade) {
        if (compareUserLevels(thisCon.user.currentChannelUserLevel, userToUpgrade.currentChannelUserLevel) || thisCon.user.currentChannelUserLevel === 4) {
          if (thisCon.user.currentChannel !== userToUpgrade.currentChannel) {
            sendEvent(socket, 'servermessage', { message: 'The user you specified is not in this channel at present.' });
            return;
          }

          if (profileStr === 'oper' || profileStr === 'super') {
            const levelVal = convertStringToLevel(profileStr);
            userToUpgrade.currentChannelUserLevel = levelVal;
            userToUpgrade.userWhoGave = thisCon.user.nickname;

            const ch = findChannelByName(thisCon.user.currentChannel);

            // Update database
            await db.setChannelRight(
              thisCon.user.currentChannel,
              userToUpgrade.nickname,
              thisCon.user.nickname,
              levelVal
            );

            if (ch) {
              if (profileStr === 'super') {
                ch.permSuperAdmins.push({ nickname: userToUpgrade.nickname, givenBy: thisCon.user.nickname });
              } else if (profileStr === 'oper') {
                ch.permOperators.push({ nickname: userToUpgrade.nickname, givenBy: thisCon.user.nickname });
              }

              ch.sendEventToChannel('autoop', {
                name: thisCon.user.nickname,
                target: userToUpgrade.nickname,
                profile: profileStr,
                channel: ch.name,
              });

              broadcastUserlistToChannel(ch);
            }
          }
        } else {
          sendEvent(socket, 'error', { type: ERR_NO_PERMISSION, name: thisCon.user.nickname, target: targetName, channel: channelName });
        }
      }
    } else {
      sendEvent(socket, 'error', { type: ERR_NO_PERMISSION, name: thisCon.user.nickname, target: targetName, channel: channelName });
    }
  } catch (err) {
    console.error('AutoOp error:', err);
  }
}

// ----------------------------------------------------------
// AUTODEOP (remove permanent channel op)
// FunkyChat: { command: "autodeop", channel: "General", target: "user" }
// ----------------------------------------------------------
async function handleAutoDeop(socket, data) {
  try {
    const thisCon = findConnectionBySocket(socket);
    if (!thisCon || !thisCon.user) return;

    const targetName = data.target || '';
    const channelName = data.channel || thisCon.user.currentChannel;

    const reqLevel = thisCon.user.currentChannelUserLevel;
    if (reqLevel === 5 || reqLevel === 4 || reqLevel === 3 || reqLevel === 2) {
      // Do the DB query first
      await db.removeChannelRight(channelName, targetName);

      const userToDowngrade = findUserByNickname(targetName);
      const ch = findChannelByName(channelName);

      if (userToDowngrade) {
        if (compareUserLevels(thisCon.user.currentChannelUserLevel, userToDowngrade.currentChannelUserLevel) || thisCon.user.currentChannelUserLevel === 4) {
          if (ch) {
            await ch.loadPermissions();
          }

          if (thisCon.user.currentChannel === userToDowngrade.currentChannel) {
            userToDowngrade.currentChannelUserLevel = 0;
          }

          if (ch) {
            ch.sendEventToChannel('autodeop', {
              name: thisCon.user.nickname,
              target: targetName,
              profile: '',
              channel: ch.name,
            });

            broadcastUserlistToChannel(ch);
          }
        } else {
          sendEvent(socket, 'error', { type: ERR_NO_PERMISSION, name: thisCon.user.nickname, target: targetName, channel: channelName });
        }
      }
    } else {
      sendEvent(socket, 'error', { type: ERR_NO_PERMISSION, name: thisCon.user.nickname, target: targetName, channel: channelName });
    }
  } catch (err) {
    console.error('AutoDeop error:', err);
  }
}

// ----------------------------------------------------------
// AUTOOPLIST
// FunkyChat: { command: "autooplist", channel: "General" }
// ----------------------------------------------------------
async function handleAutoOpList(socket, data) {
  try {
    const thisCon = findConnectionBySocket(socket);
    if (!thisCon || !thisCon.user) return;

    const channelName = data.channel || thisCon.user.currentChannel;
    const ch = findChannelByName(channelName);

    const autoops = [];

    if (ch) {
      // Creator
      autoops.push({
        target: ch.creator,
        profile: 'creator',
        giver: 'server',
      });
    }

    try {
      const rights = await db.getChannelRights(channelName);
      for (const row of rights) {
        autoops.push({
          target: row.nickname,
          profile: numericLevelToProfile(row.level),
          giver: row.given_by,
        });
      }
    } catch (err) {
      console.error('Error loading autooplist:', err);
    }

    sendEvent(socket, 'autooplist', {
      channel: channelName,
      autoops,
    });
  } catch (err) {
    console.error('AutoOpList error:', err);
  }
}

// ----------------------------------------------------------
// AUTOSOP (permanent server op - persists to DB)
// FunkyChat: { command: "autosop", target: "user", profile: "cyber" }
// ----------------------------------------------------------
async function handleAutoSop(socket, data) {
  try {
    const thisCon = findConnectionBySocket(socket);
    if (!thisCon || !thisCon.user) return;

    if (thisCon.user.accountType === 4) {
      const targetName = data.target || '';
      const profileStr = data.profile || 'cyber';
      const targetLevel = convertStringToLevel(profileStr);

      const userToUpgrade = findUserByNickname(targetName);
      if (userToUpgrade && targetLevel !== null) {
        if (
          (userToUpgrade.accountType !== 4 && profileStr === 'admin') ||
          (userToUpgrade.accountType !== 3 && userToUpgrade.accountType !== 4 && profileStr === 'cyber') ||
          (userToUpgrade.accountType === 4 && userToUpgrade.nickname === thisCon.user.nickname)
        ) {
          userToUpgrade.accountType = targetLevel;
          userToUpgrade.currentChannelUserLevel = targetLevel;

          await db.updateUser(userToUpgrade.nickname, { accountType: targetLevel });

          const ch = findChannelByName(userToUpgrade.currentChannel);

          sendEventToAllLoggedInUsers('sop', {
            name: thisCon.user.nickname,
            target: userToUpgrade.nickname,
            profile: profileStr,
          });

          if (ch) {
            ch.sendServerMessage(
              thisCon.user.nickname + ' heeft ' + userToUpgrade.nickname + ' ' + profileStr
            );
            broadcastUserlistToChannel(ch);
          }
        }
      }
    } else {
      sendEvent(socket, 'error', { type: ERR_NO_PERMISSION, name: thisCon.user.nickname, target: data.target || '', channel: '' });
    }
  } catch (err) {
    console.error('AutoSop error:', err);
  }
}

// ----------------------------------------------------------
// AUTOSOPLIST
// FunkyChat: { command: "autosoplist" }
// ----------------------------------------------------------
async function handleAutoSopList(socket) {
  try {
    const thisCon = findConnectionBySocket(socket);
    if (!thisCon || !thisCon.user) return;

    if (thisCon.user.accountType === 4 || thisCon.user.accountType === 3) {
      try {
        const result = await db.query('SELECT nickname, account_type, rights_by FROM users WHERE account_type = 3 OR account_type = 4', []);
        const autoops = [];
        for (const row of result.rows) {
          autoops.push({
            target: row.nickname,
            profile: numericLevelToProfile(row.account_type),
            giver: row.rights_by,
          });
        }
        // Use info event for backwards compatibility with rich list data
        let list = 'autosops list: ';
        for (const row of result.rows) {
          list += '<br />' + row.nickname + ' heeft blijvende ' + convertLevelToString(row.account_type) + ' - rechten gegeven door ' + row.rights_by;
        }
        sendEvent(socket, 'info', { message: list });
      } catch (err) {
        console.error('Error loading autosoplist:', err);
      }
    }
  } catch (err) {
    console.error('AutoSopList error:', err);
  }
}

// ----------------------------------------------------------
// AUTOSDEOP (permanent server deop - persists to DB)
// FunkyChat: { command: "autosdeop", target: "user" }
// ----------------------------------------------------------
async function handleAutoSdeop(socket, data) {
  try {
    const thisCon = findConnectionBySocket(socket);
    if (!thisCon || !thisCon.user) return;

    if (thisCon.user.accountType === 4) {
      const targetName = data.target || '';
      const userToDowngrade = findUserByNickname(targetName);
      if (userToDowngrade && (userToDowngrade.accountType === 3 || userToDowngrade.accountType === 4)) {
        userToDowngrade.accountType = 0;
        userToDowngrade.currentChannelUserLevel = 0;

        await db.updateUser(userToDowngrade.nickname, { accountType: 0 });

        const ch = findChannelByName(userToDowngrade.currentChannel);

        sendEventToAllLoggedInUsers('sdeop', {
          name: thisCon.user.nickname,
          target: userToDowngrade.nickname,
        });

        if (ch) {
          ch.sendServerMessage(
            thisCon.user.nickname + ' heeft ' + userToDowngrade.nickname + ' normaal gemaakt op kanaal ' + userToDowngrade.currentChannel + ' en blijvende rechten afgenomen.'
          );
          broadcastUserlistToChannel(ch);
        }
      }
    } else {
      sendEvent(socket, 'error', { type: ERR_NO_PERMISSION, name: thisCon.user.nickname, target: data.target || '', channel: '' });
    }
  } catch (err) {
    console.error('AutoSdeop error:', err);
  }
}

// ----------------------------------------------------------
// FIGNORE
// FunkyChat: { command: "fignore", target: "user" }
// ----------------------------------------------------------
function handleFignore(socket, data) {
  try {
    const thisCon = findConnectionBySocket(socket);
    if (!thisCon || !thisCon.user) return;

    const targetName = data.target || '';
    if (targetName && !thisCon.user.ignoreList.includes(targetName)) {
      thisCon.user.ignoreList.push(targetName);
      sendEvent(socket, 'info', { message: 'You are now ignoring ' + targetName });
    }
  } catch (err) {
    console.error('Fignore error:', err);
  }
}

// ----------------------------------------------------------
// FUNIGNORE
// FunkyChat: { command: "funignore", target: "user" }
// ----------------------------------------------------------
function handleFunignore(socket, data) {
  try {
    const thisCon = findConnectionBySocket(socket);
    if (!thisCon || !thisCon.user) return;

    const targetName = data.target || '';
    const idx = thisCon.user.ignoreList.indexOf(targetName);
    if (idx !== -1) {
      thisCon.user.ignoreList.splice(idx, 1);
      sendEvent(socket, 'info', { message: 'You are no longer ignoring ' + targetName });
    }
  } catch (err) {
    console.error('Funignore error:', err);
  }
}

// ----------------------------------------------------------
// SERVERMESSAGE (admin broadcast / /wall)
// FunkyChat: { command: "servermessage", message: "text", color: "#fff" }
// ----------------------------------------------------------
function handleServerMessageCmd(socket, data) {
  try {
    const thisCon = findConnectionBySocket(socket);
    if (!thisCon || !thisCon.user) return;

    if (thisCon.user.accountType === 3 || thisCon.user.accountType === 4) {
      const messageText = data.message || '';
      const parsedMessage = parseColoredText(messageText);
      sendServerMessageToAll('server message: ' + parsedMessage);
    } else {
      sendEvent(socket, 'error', { type: ERR_NO_PERMISSION, name: thisCon.user.nickname, target: '', channel: '' });
    }
  } catch (err) {
    console.error('ServerMessage error:', err);
  }
}

// ----------------------------------------------------------
// KILLCHANNEL
// FunkyChat: { command: "killchannel", channel: "name" }
// ----------------------------------------------------------
async function handleKillChannel(socket, data) {
  try {
    const thisCon = findConnectionBySocket(socket);
    if (!thisCon || !thisCon.user) return;

    if (thisCon.user.accountType === 4 || thisCon.user.accountType === 3) {
      const channelName = data.channel || thisCon.user.currentChannel;

      if (channelName === 'General') {
        sendEvent(socket, 'servermessage', { message: 'Kan door de server gemaakte kanaal niet sluiten' });
        return;
      }

      const killChannel = findChannelByName(channelName);
      if (!killChannel) {
        sendEvent(socket, 'servermessage', { message: 'Kanaal niet gevonden, of bestaat niet.' });
        return;
      }

      // Move all users out first
      for (const con of connections) {
        if (con && con.user && con.user.currentChannel === channelName) {
          killChannel.removeFromChannel(con.user);
          sendEvent(con.socket, 'channelkilled', { channel: channelName });
          sendEvent(con.socket, 'servermessage', {
            message: channelName + ' is gesloten door ' + thisCon.user.nickname,
          });

          // Move to General
          const generalCh = findChannelByName('General');
          if (generalCh) {
            generalCh.addToChannel(con.user);
          }
        }
      }

      // Remove channel from array
      const idx = channels.indexOf(killChannel);
      if (idx !== -1) {
        channels[idx] = null;
      }

      await db.deleteChannel(channelName);

      sendChannelListToAll();
    } else {
      sendEvent(socket, 'error', { type: ERR_NO_PERMISSION, name: thisCon.user.nickname, target: '', channel: data.channel || '' });
    }
  } catch (err) {
    console.error('KillChannel error:', err);
  }
}

// ----------------------------------------------------------
// SILENT (mute user in channel)
// FunkyChat: { command: "silent", channel: "General", target: "user" }
// ----------------------------------------------------------
function handleSilent(socket, data) {
  try {
    const thisCon = findConnectionBySocket(socket);
    if (!thisCon || !thisCon.user) return;

    const targetName = data.target || '';
    const channelName = data.channel || thisCon.user.currentChannel;

    const reqLevel = thisCon.user.currentChannelUserLevel;
    if (reqLevel === 5 || reqLevel === 4 || reqLevel === 3 || reqLevel === 2) {
      const userToSilence = findUserByNickname(targetName);
      if (userToSilence) {
        if (compareUserLevels(thisCon.user.currentChannelUserLevel, userToSilence.currentChannelUserLevel)) {
          if (userToSilence.currentChannel === thisCon.user.currentChannel) {
            userToSilence.silenced = true;
            const ch = findChannelByName(userToSilence.currentChannel);
            if (ch) {
              ch.sendEventToChannel('op', {
                name: thisCon.user.nickname,
                target: userToSilence.nickname,
                profile: 'silent',
                channel: ch.name,
              });
              ch.sendServerMessage(
                thisCon.user.nickname + ' has silent ' + userToSilence.nickname + ' on channel ' + userToSilence.currentChannel
              );
              broadcastUserlistToChannel(ch);
            }
          }
        } else {
          sendEvent(socket, 'error', { type: ERR_NO_PERMISSION, name: thisCon.user.nickname, target: targetName, channel: channelName });
        }
      }
    } else {
      sendEvent(socket, 'error', { type: ERR_NO_PERMISSION, name: thisCon.user.nickname, target: targetName, channel: channelName });
    }
  } catch (err) {
    console.error('Silent error:', err);
  }
}

// ----------------------------------------------------------
// UNSILENT (unmute user in channel)
// FunkyChat: { command: "unsilent", channel: "General", target: "user" }
// ----------------------------------------------------------
function handleUnsilent(socket, data) {
  try {
    const thisCon = findConnectionBySocket(socket);
    if (!thisCon || !thisCon.user) return;

    const targetName = data.target || '';
    const channelName = data.channel || thisCon.user.currentChannel;

    const reqLevel = thisCon.user.currentChannelUserLevel;
    if (reqLevel === 5 || reqLevel === 4 || reqLevel === 3 || reqLevel === 2) {
      const userToSilence = findUserByNickname(targetName);
      if (userToSilence) {
        if (userToSilence.currentChannel === thisCon.user.currentChannel) {
          userToSilence.silenced = false;
          const ch = findChannelByName(userToSilence.currentChannel);
          if (ch) {
            ch.sendEventToChannel('op', {
              name: thisCon.user.nickname,
              target: userToSilence.nickname,
              profile: userToSilence.getProfile(),
              channel: ch.name,
            });
            ch.sendServerMessage(
              thisCon.user.nickname + ' have unsilenced ' + userToSilence.nickname + ' on ' + userToSilence.currentChannel
            );
            broadcastUserlistToChannel(ch);
          }
        }
      }
    } else {
      sendEvent(socket, 'error', { type: ERR_NO_PERMISSION, name: thisCon.user.nickname, target: targetName, channel: channelName });
    }
  } catch (err) {
    console.error('Unsilent error:', err);
  }
}

// ----------------------------------------------------------
// CREATECHANNEL
// FunkyChat: { command: "createchannel", channel: "name", topic: "text", type: "public" }
// ----------------------------------------------------------
async function handleCreateChannel(socket, data) {
  try {
    const thisCon = findConnectionBySocket(socket);
    if (!thisCon || !thisCon.user) return;

    const channelName = data.channel || '';
    const topic = data.topic || '';
    const typeStr = data.type || 'public';

    if (channelName.indexOf(' ') !== -1) {
      sendEvent(socket, 'servermessage', { message: 'Kanaal naam mag geen spatie bevatten.' });
      return;
    }

    if (channelName.length < 3) {
      sendEvent(socket, 'servermessage', { message: 'Channel name must be 3 characters or more.' });
      return;
    }

    if (findChannelByName(channelName) !== null) {
      sendEvent(socket, 'servermessage', { message: 'Dit kanaal bestaat al.' });
      return;
    }

    let cType = 0;
    if (typeStr === 'admin' || typeStr === 'Admin') {
      cType = 1;
    }

    await db.createChannel(channelName, thisCon.user.nickname, topic, cType);
    await db.createChatLog(channelName);

    const newChannel = new Channel(channelName, thisCon.user.nickname, topic, cType, '', 0);
    channels.push(newChannel);

    sendChannelListToAll();

    thisCon.user.silenced = false;

    // Leave current channel
    if (thisCon.user.currentChannel !== '') {
      const oldCh = findChannelByName(thisCon.user.currentChannel);
      if (oldCh) {
        oldCh.removeFromChannel(thisCon.user);
      }
    }

    // Join the new channel
    newChannel.addToChannel(thisCon.user);
  } catch (err) {
    console.error('CreateChannel error:', err);
  }
}

// ----------------------------------------------------------
// SEARCH
// FunkyChat: { command: "search", scope: "Channel"|"Server", gender: "man"|"both", name: "" }
// ----------------------------------------------------------
function handleSearch(socket, data) {
  try {
    const thisCon = findConnectionBySocket(socket);
    if (!thisCon || !thisCon.user) return;

    const searchOn = data.scope || 'Server';
    const gender = data.gender || 'both';
    const name = data.name || '';

    const searchList = [];

    for (const con of connections) {
      if (con && con.user) {
        let searchOnSatisfied = false;
        let genderSatisfied = false;
        let nameSatisfied = false;

        if (searchOn === 'Channel') {
          if (con.user.currentChannel === thisCon.user.currentChannel) {
            searchOnSatisfied = true;
          }
        } else {
          searchOnSatisfied = true;
        }

        if (gender !== 'both') {
          if (con.user.gender === gender) {
            genderSatisfied = true;
          }
        } else {
          genderSatisfied = true;
        }

        if (name !== '') {
          if (con.user.nickname.includes(name)) {
            nameSatisfied = true;
          }
        } else {
          nameSatisfied = true;
        }

        if (searchOnSatisfied && genderSatisfied && nameSatisfied) {
          searchList.push({
            name: con.user.nickname,
            profile: con.user.getProfile(),
            channel: con.user.currentChannel,
            hidden: con.user.hidden ? 'true' : '',
          });
        }
      }
    }

    sendEvent(socket, 'userlist', { users: searchList, channel: 'search' });
  } catch (err) {
    console.error('Search error:', err);
  }
}

// ----------------------------------------------------------
// WHOIS
// FunkyChat: { command: "whois", target: "user" }
// ----------------------------------------------------------
function handleWhois(socket, data) {
  try {
    const thisCon = findConnectionBySocket(socket);
    if (!thisCon || !thisCon.user) return;

    const targetName = data.target || '';
    const found = findUserByNickname(targetName);
    if (found) {
      sendEvent(socket, 'info', {
        message: found.nickname + ' is in kanaal ' + found.currentChannel,
      });
    } else {
      sendEvent(socket, 'info', {
        message: targetName + ' gebruiker niet ingelogd, of bestaat niet.',
      });
    }
  } catch (err) {
    console.error('Whois error:', err);
  }
}

// ----------------------------------------------------------
// ALLUSERS (cyber/admin only)
// FunkyChat: { command: "allusers" }
// ----------------------------------------------------------
function handleAllUsers(socket) {
  try {
    const thisCon = findConnectionBySocket(socket);
    if (!thisCon || !thisCon.user) return;

    if (thisCon.user.accountType === 4 || thisCon.user.accountType === 3) {
      let list = 'all online users are:';
      for (const con of connections) {
        if (con && con.user) {
          list += '<br />' + con.user.nickname + ' in ' + con.user.currentChannel;
        }
      }
      sendEvent(socket, 'info', { message: list });
    }
  } catch (err) {
    console.error('AllUsers error:', err);
  }
}

// ----------------------------------------------------------
// MAKESTATIC (cyber/admin only)
// FunkyChat: { command: "makestatic", channel: "name" }
// ----------------------------------------------------------
async function handleMakeStatic(socket, data) {
  try {
    const thisCon = findConnectionBySocket(socket);
    if (!thisCon || !thisCon.user) return;

    if (thisCon.user.accountType === 4 || thisCon.user.accountType === 3) {
      const channelName = data.channel || thisCon.user.currentChannel;
      const ch = findChannelByName(channelName);
      if (ch) {
        ch.isStatic = 1;
        await db.query('UPDATE channels SET is_static = 1 WHERE name = $1', [channelName]);
        sendEvent(socket, 'servermessage', { message: 'Made ' + channelName + ' static.' });
      }
    }
  } catch (err) {
    console.error('MakeStatic error:', err);
  }
}

// ----------------------------------------------------------
// SBANLIST (cyber/admin only)
// FunkyChat: { command: "sbanlist" }
// ----------------------------------------------------------
async function handleSbanList(socket) {
  try {
    const thisCon = findConnectionBySocket(socket);
    if (!thisCon || !thisCon.user) return;

    if (thisCon.user.accountType === 4 || thisCon.user.accountType === 3) {
      const serverBans = await db.getServerBans();
      let list = 'Server Ban List:';
      for (const ban of serverBans) {
        list += '<br />' + ban.nickname + ' is uitgesloten door ' + ban.banned_by + ' tot ' + new Date(parseInt(ban.unban_timestamp)).toString();
      }
      sendEvent(socket, 'info', { message: list });
    } else {
      sendEvent(socket, 'error', { type: ERR_NO_PERMISSION, name: thisCon.user.nickname, target: '', channel: '' });
    }
  } catch (err) {
    console.error('SbanList error:', err);
  }
}

// ----------------------------------------------------------
// SERRORLOG (admin only)
// FunkyChat: { command: "serrorlog" }
// ----------------------------------------------------------
async function handleErrorLog(socket) {
  try {
    const thisCon = findConnectionBySocket(socket);
    if (!thisCon || !thisCon.user) return;

    if (thisCon.user.accountType === 4) {
      try {
        const result = await db.query('SELECT timestamp, error, stacktrace FROM errors ORDER BY id DESC', []);
        let elog = 'Error Log: ';
        for (const row of result.rows) {
          elog += '<br /><br />' + row.timestamp + ': ' + row.error + '<br />' + row.stacktrace;
        }
        sendEvent(socket, 'info', { message: elog });
      } catch (err) {
        console.error('Error fetching error log:', err);
      }
    }
  } catch (err) {
    console.error('ErrorLog error:', err);
  }
}

// ----------------------------------------------------------
// CLOG (admin only)
// FunkyChat: { command: "clog" }
// ----------------------------------------------------------
function handleClog(socket) {
  try {
    const thisCon = findConnectionBySocket(socket);
    if (!thisCon || !thisCon.user) return;

    if (thisCon.user.accountType === 4) {
      const ch = findChannelByName(thisCon.user.currentChannel);
      if (ch) {
        sendEvent(socket, 'info', { message: ch.chatLog });
      }
    }
  } catch (err) {
    console.error('Clog error:', err);
  }
}

// ----------------------------------------------------------
// CLEANLOG (admin only)
// FunkyChat: { command: "cleanlog" }
// ----------------------------------------------------------
async function handleCleanLog(socket) {
  try {
    const thisCon = findConnectionBySocket(socket);
    if (!thisCon || !thisCon.user) return;

    if (thisCon.user.accountType === 4) {
      const ch = findChannelByName(thisCon.user.currentChannel);
      if (ch) {
        ch.chatLog = '';
        await db.saveChatLog(thisCon.user.currentChannel, '');
        sendEvent(socket, 'servermessage', { message: 'Log van kanaal geleegd' });
      }
    }
  } catch (err) {
    console.error('CleanLog error:', err);
  }
}

// ============================================================
// ERROR HANDLING
// ============================================================

process.on('uncaughtException', (err) => {
  console.error('Uncaught exception:', err);
  console.error(err.stack);
  db.logError(String(err), err.stack || '').catch(() => {});
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled rejection at:', promise, 'reason:', reason);
  db.logError(String(reason), '').catch(() => {});
});

// ============================================================
// STARTUP
// ============================================================

async function start() {
  console.log('DutchChat v2.0 (FunkyChat Protocol) starting...');

  // Load channels from database
  await loadChannelsFromDatabase();

  // Start listening
  server.listen(PORT, () => {
    console.log(`DutchChat v2.0 (FunkyChat Protocol) listening on port ${PORT}`);
  });
}

start().catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
