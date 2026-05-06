'use strict';

// ============================================================
// DutchChat v2.0 - Modern IRC-style Chat Server
// Rebuilt from 2014 Node.js + MySQL to Express + Socket.IO 4 + PostgreSQL
// ============================================================

require('dotenv').config();

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');
const validator = require('validator');
const multer = require('multer');
const db = require('./db');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' },
  maxHttpBufferSize: 1e6, // 1MB max
});

const PORT = parseInt(process.env.PORT, 10) || 3100;
const VERSION = 'v2.0';
const BCRYPT_ROUNDS = 10;
const MAX_IMAGE_SIZE = 150 * 1024; // 150KB
const CHAT_LOG_SAVE_INTERVAL = 100; // Save log to DB every 100 messages

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
    // Will be renamed after upload based on nickname
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
// STATIC FILE SERVING
// ============================================================

app.use('/static', express.static(path.join(__dirname, 'public')));
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
    // Remove uploaded file if no nickname
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
      ch.sendEvent('user updated', JSON.stringify(user.toJSON()));
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

// from db - level: 0=normal, 1=oper, 2=superuser, 3=cyber, 4=admin, 5=creator
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
// CLASS: Message
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
    this.accountType = accountType;
    this.age = age;
    this.gender = gender;
    this.location = location;
    this.additionalInfo = additionalInfo;
    this.email = email;
    this.profileImage = profileImage;

    this.ip = '';
    this.guest = isGuest;
    this.hidden = false;    // was xcdrvesl in original
    this.silenced = false;  // was bhdedl in original

    this.currentChannel = '';
    this.currentChannelUserLevel = accountType; // 0 or 4 from DB (normal or admin apply to entire chat)
    this.userWhoGave = '';

    this.lastActive = Date.now();
    this.loggedIn = Date.now();
  }

  toJSON() {
    return {
      nickname: this.nickname,
      accountType: this.accountType,
      age: this.age,
      gender: this.gender,
      location: this.location,
      additionalInfo: this.additionalInfo,
      email: this.email,
      profileImage: this.profileImage,
      guest: this.guest,
      hidden: this.hidden,
      silenced: this.silenced,
      currentChannel: this.currentChannel,
      currentChannelUserLevel: this.currentChannelUserLevel,
      userWhoGave: this.userWhoGave,
      lastActive: this.lastActive,
      loggedIn: this.loggedIn,
    };
  }

  kick(reason) {
    const con = findConnectionFromUser(this);
    if (con) {
      con.socket.emit('kicked', reason);
      con.socket.disconnect();
    }
  }

  sendChannelList() {
    const con = findConnectionFromUser(this);
    if (!con) return;

    const channelArr = [];
    for (const ch of channels) {
      if (ch !== null) {
        channelArr.push({
          name: ch.name,
          creator: ch.creator,
          topic: ch.topic,
          type: ch.type,
          currentUsers: ch.currentUsers,
          isStatic: ch.isStatic,
        });
      }
    }
    con.socket.emit('channel list', JSON.stringify(channelArr));
  }

  sendInitialChannelUsers() {
    const con = findConnectionFromUser(this);
    if (!con) return;

    const usersArr = [];
    for (const c of connections) {
      if (c && c.socket && c.user) {
        if (c.user.currentChannel === this.currentChannel) {
          if (!c.user.hidden) {
            usersArr.push(c.user.toJSON());
          }
        }
      }
    }
    con.socket.emit('channel users list', JSON.stringify(usersArr));
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

    // Permanent permissions loaded from DB
    this.permOperators = [];    // [{nickname, givenBy}]
    this.permSuperAdmins = [];  // [{nickname, givenBy}]
    this.banList = [];           // [{nickname, bannedBy}]

    // Chat log
    this.chatLog = chatLog || '';
    this.chatLogSaveCount = 0;
  }

  // Send an event to all users currently in this channel
  sendEvent(eventName, contents) {
    for (const con of connections) {
      if (con && con.user && con.user.currentChannel === this.name) {
        con.socket.emit(eventName, contents);
      }
    }
  }

  // Send server message to channel
  sendServerMessage(message) {
    this.sendEvent('server message', message);
  }

  // Send a chat message to all users in the channel
  sendMessage(messageToSend) {
    this.chatLog += '<br />' + messageToSend.sender + ' : ' + messageToSend.content;
    this.chatLogSaveCount++;

    if (this.chatLogSaveCount >= CHAT_LOG_SAVE_INTERVAL) {
      db.saveChatLog(this.name, this.chatLog).catch((err) => {
        console.error('Error saving chat log:', err);
      });
      this.chatLogSaveCount = 0;
    }

    this.sendEvent('channel message', JSON.stringify(messageToSend));
  }

  // Add a user to this channel
  addToChannel(user) {
    // Check ban list
    for (const ban of this.banList) {
      if (ban && ban.nickname === user.nickname) {
        const con = findConnectionFromUser(user);
        if (con) {
          con.socket.emit('changed channel', '');
          con.socket.emit('server message', 'Je bent verbannen van dit kanaal.');
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
      this.sendEvent('user joined channel', JSON.stringify(user.toJSON()));
      this.sendEvent('server message', user.nickname + ' komt kanaal (' + user.currentChannel + ') binnen');
    }

    user.sendInitialChannelUsers();
    sendChannelNumbersToAll();

    const con = findConnectionFromUser(user);
    if (con) {
      if (this.isStatic === 0) {
        con.socket.emit('server message',
          user.nickname + ' welkom op kanaal (' + user.currentChannel + ')<br />dit kanaal is aangemaakt door: ' + this.creator
        );
      }
      con.socket.emit('server message', 'Kanaal Topic: ' + this.topic);
    }
  }

  // Remove a user from this channel
  removeFromChannel(user) {
    if (!user.hidden) {
      this.currentUsers--;
    }

    user.currentChannelUserLevel = user.accountType;
    user.currentChannel = '';
    user.lastActive = Date.now();

    if (!user.hidden) {
      this.sendEvent('user left channel', user.nickname);
      this.sendEvent('server message', user.nickname + ' verlaat kanaal (' + this.name + ')');
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

        // Send updated channel list to everyone
        for (const con of connections) {
          if (con && con.user) {
            con.user.sendChannelList();
          }
        }
      }
    } else {
      sendChannelNumbersToAll();
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
  sendChannelNumbersToAll();
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

function sendChannelNumbersToAll() {
  let chanNumberString = '';
  for (const ch of channels) {
    if (ch) {
      chanNumberString += ch.name + ':' + ch.currentUsers + '|';
    }
  }
  if (chanNumberString.length > 0) {
    chanNumberString = chanNumberString.substring(0, chanNumberString.length - 1);
  }
  sendEventToAllLoggedInUsers('channel user numbers update', chanNumberString);
}

function sendEventToAllLoggedInUsers(eventName, contents) {
  for (const con of connections) {
    if (con && con.user) {
      con.socket.emit(eventName, contents);
    }
  }
}

function sendServerMessageToAllLoggedInUsers(message) {
  sendEventToAllLoggedInUsers('server message', message);
}

// ============================================================
// PARSE COLOR TAGS IN TEXT (for /wall and /topic)
// Converts "#FF0000 text #00FF00 more text" to colored spans
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
// SOCKET.IO EVENT HANDLING
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
  // LOGIN REQUEST
  // Format: nickname|password_or_guest|age|gender|location|additionalInfo
  // ----------------------------------------------------------
  socket.on('login request', async (msg) => {
    try {
      msg = validator.escape(msg);
      console.log('Login request');

      const thisCon = findConnectionBySocket(socket);
      if (!thisCon) return;

      // Check IP-based server ban
      const ipBans = await db.checkServerBanByIp(thisCon.ip);
      if (ipBans.length > 0) {
        const ban = ipBans[0];
        if (ban.unban_timestamp > Date.now()) {
          thisCon.socket.emit('login result',
            'banned|Je bent verbannen door ' + ban.banned_by + ' tot ' + new Date(parseInt(ban.unban_timestamp)).toString()
          );
          thisCon.socket.disconnect();
          return;
        } else {
          await db.removeServerBan(ban.nickname);
          thisCon.socket.emit('login result',
            'banned|Je hebt weer toegang tot de chatserver, log opnieuw in.'
          );
          return;
        }
      }

      const msgParts = msg.split('|');
      msgParts[0] = msgParts[0].toLowerCase();

      if (msgParts[0].length < 3) {
        socket.emit('login result', 'fail|too short');
        return;
      }

      if (isUserLoggedIn(msgParts[0])) {
        socket.emit('login result', 'fail|logged in');
        return;
      }

      if (msgParts[1] === 'guest') {
        // Guest login
        const existingUser = await db.findUser(msgParts[0]);
        if (existingUser) {
          // Actual user with that name exists
          socket.emit('login result', 'fail|actual user');
          return;
        }

        const guestNick = '~' + msgParts[0];
        if (isUserLoggedIn(guestNick)) {
          socket.emit('login result', 'fail|guest taken');
          return;
        }

        thisCon.user = new User(
          guestNick, 0,
          msgParts[2] || '', msgParts[3] || '',
          msgParts[4] || '', msgParts[5] || '',
          '', 'none', true
        );
        thisCon.user.ip = thisCon.ip;
        thisCon.socket.emit('login result', JSON.stringify(thisCon.user.toJSON()));
        thisCon.user.sendChannelList();
      } else {
        // Authenticated login
        const dbUser = await db.findUser(msgParts[0]);
        if (!dbUser) {
          socket.emit('login result', 'fail');
          return;
        }

        // bcrypt compare
        const passwordMatch = await bcrypt.compare(msgParts[1], dbUser.password_hash);
        if (!passwordMatch) {
          socket.emit('login result', 'fail');
          return;
        }

        // Check server ban by nickname
        const nickBans = await db.checkServerBanByNickname(msgParts[0]);
        if (nickBans.length > 0) {
          const ban = nickBans[0];
          if (ban.unban_timestamp > Date.now()) {
            thisCon.socket.emit('login result',
              'banned|Je bent verbannen door ' + ban.banned_by + ' tot ' + new Date(parseInt(ban.unban_timestamp)).toString()
            );
            thisCon.socket.disconnect();
            return;
          } else {
            await db.removeServerBan(msgParts[0]);
            thisCon.socket.emit('login result',
              'banned|Je hebt weer toegang tot de chatserver, log opnieuw in.'
            );
            return;
          }
        }

        // Use provided values or fall back to DB values
        let ageN = msgParts[2] || '';
        let genderN = msgParts[3] || '';
        let locationN = msgParts[4] || '';
        let additionalInfoN = msgParts[5] || '';

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
          db.updateUser(msgParts[0], {
            age: parseInt(ageN) || 0,
            gender: genderN,
            location: locationN,
            additionalInfo: additionalInfoN,
          }).catch((err) => console.error('Error updating user on login:', err));
        }

        thisCon.socket.emit('login result', JSON.stringify(thisCon.user.toJSON()));
        thisCon.user.sendChannelList();
      }
    } catch (err) {
      console.error('Login request error:', err);
      socket.emit('login result', 'fail');
    }
  });

  // ----------------------------------------------------------
  // REGISTER REQUEST
  // Format: nickname|password|email
  // ----------------------------------------------------------
  socket.on('register request', async (msg) => {
    try {
      msg = validator.escape(msg);
      const msgParts = msg.split('|');
      const thisCon = findConnectionBySocket(socket);
      if (!thisCon) return;

      let nickname = msgParts[0].toLowerCase();
      const password = msgParts[1];
      const email = msgParts[2];

      console.log('Register request for: ' + nickname);

      // Check filter
      if (containsFilteredWord(nickname)) {
        thisCon.socket.emit('register result', 'forbidden term');
        return;
      }

      // Validate nickname: 3-20 chars, no spaces
      if (!validator.isLength(nickname, { min: 3, max: 20 }) || nickname.indexOf(' ') > -1) {
        thisCon.socket.emit('register result', 'nickname wrong');
        return;
      }

      // Validate password: at least 6 chars
      if (!password || password.length < 6) {
        thisCon.socket.emit('register result', 'password wrong');
        return;
      }

      // Validate email
      if (!validator.isEmail(email)) {
        thisCon.socket.emit('register result', 'email wrong');
        return;
      }

      // Check if nickname taken
      const existing = await db.findUser(nickname);
      if (existing) {
        thisCon.socket.emit('register result', 'nickname taken');
        return;
      }

      // Hash password with bcrypt (NOT md5 like original)
      const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);

      await db.createUser(nickname, passwordHash, email);
      thisCon.socket.emit('register result', 'ok');
    } catch (err) {
      console.error('Register request error:', err);
      socket.emit('register result', 'error');
    }
  });

  // ----------------------------------------------------------
  // SEND CHANNEL MESSAGE
  // JSON: {colour, content}
  // ----------------------------------------------------------
  socket.on('send channel message', (msg) => {
    try {
      const sender = findConnectionBySocket(socket);
      if (!sender || !sender.user) return;

      if (sender.user.silenced) {
        sender.socket.emit('server message',
          'You do not have permission to talk on channel: ' + sender.user.currentChannel
        );
        return;
      }

      const receivedMessage = JSON.parse(msg);

      if (!validator.isHexColor(receivedMessage.colour || '')) {
        receivedMessage.colour = '#000000';
      }

      const newMessage = new Message(
        sender.user.nickname,
        receivedMessage.colour,
        validator.escape(receivedMessage.content)
      );

      // Filter check
      if (containsFilteredWord(newMessage.content)) {
        sender.socket.emit('server message',
          'The message you entered contains a forbidden phrase, please try again.'
        );
        return;
      }

      const ch = findChannelByName(sender.user.currentChannel);
      if (ch) {
        ch.sendMessage(newMessage);
      }
    } catch (err) {
      console.error('Channel message error:', err);
    }
  });

  // ----------------------------------------------------------
  // PRIVATE MESSAGE
  // Format: targetNickname|JSON{colour,content}
  // ----------------------------------------------------------
  socket.on('private message', (msg) => {
    try {
      const msgParts = msg.split('|');
      const sender = findConnectionBySocket(socket);
      if (!sender || !sender.user) return;

      const receivedMessage = JSON.parse(msgParts.slice(1).join('|'));

      if (!validator.isHexColor(receivedMessage.colour || '')) {
        receivedMessage.colour = '#000000';
      }

      const newMessage = new Message(
        sender.user.nickname,
        receivedMessage.colour,
        validator.escape(receivedMessage.content)
      );

      // Filter check
      if (containsFilteredWord(newMessage.content)) {
        sender.socket.emit('server message',
          'The message you entered contains a forbidden phrase, please try again.'
        );
        return;
      }

      const receiver = findUserByNickname(msgParts[0]);
      if (receiver) {
        const receiverCon = findConnectionFromUser(receiver);
        if (receiverCon) {
          receiverCon.socket.emit('private message', JSON.stringify(newMessage));
        }
      }
    } catch (err) {
      console.error('Private message error:', err);
    }
  });

  // ----------------------------------------------------------
  // CHANGE CHANNEL
  // ----------------------------------------------------------
  socket.on('change channel', (msg) => {
    try {
      msg = validator.escape(msg);
      const thisCon = findConnectionBySocket(socket);
      if (!thisCon || !thisCon.user) return;

      thisCon.user.silenced = false;

      socket.emit('changed channel', msg);

      if (thisCon.user.currentChannel !== '') {
        const oldCh = findChannelByName(thisCon.user.currentChannel);
        if (oldCh) {
          oldCh.removeFromChannel(thisCon.user);
        }
      }

      const newCh = findChannelByName(msg);
      if (newCh) {
        newCh.addToChannel(thisCon.user);
      }
    } catch (err) {
      console.error('Change channel error:', err);
    }
  });

  // ----------------------------------------------------------
  // CREATE CHANNEL
  // Format: name|topic|type
  // ----------------------------------------------------------
  socket.on('create channel', async (msg) => {
    try {
      msg = validator.escape(msg);
      const msgParts = msg.split('|');
      const thisCon = findConnectionBySocket(socket);
      if (!thisCon || !thisCon.user) return;

      if (msgParts[0].indexOf(' ') !== -1) {
        thisCon.socket.emit('server message', 'Kanaal naam mag geen spatie bevatten.');
        return;
      }

      if (msgParts[0].length < 3) {
        thisCon.socket.emit('server message', 'Channel name must be 3 characters or more.');
        return;
      }

      if (findChannelByName(msgParts[0]) !== null) {
        thisCon.socket.emit('server message', 'Dit kanaal bestaat al.');
        return;
      }

      let cType = 0;
      if (msgParts[2] === 'Admin') {
        cType = 1;
      }

      // Add to database
      await db.createChannel(msgParts[0], thisCon.user.nickname, msgParts[1] || '', cType);
      await db.createChatLog(msgParts[0]);

      const newChannel = new Channel(msgParts[0], thisCon.user.nickname, msgParts[1] || '', cType, '', 0);
      channels.push(newChannel);

      // Update all users with new channel list
      for (const con of connections) {
        if (con && con.user) {
          con.user.sendChannelList();
        }
      }

      thisCon.user.silenced = false;
      socket.emit('changed channel', msgParts[0]);

      if (thisCon.user.currentChannel !== '') {
        const oldCh = findChannelByName(thisCon.user.currentChannel);
        if (oldCh) {
          oldCh.removeFromChannel(thisCon.user);
        }
      }

      newChannel.addToChannel(thisCon.user);
    } catch (err) {
      console.error('Create channel error:', err);
    }
  });

  // ----------------------------------------------------------
  // SEARCH
  // Format: searchOn|gender|name
  // ----------------------------------------------------------
  socket.on('search', (msg) => {
    try {
      console.log('Search: ' + msg);
      const thisCon = findConnectionBySocket(socket);
      if (!thisCon || !thisCon.user) return;

      const msgParts = msg.split('|');
      const searchOn = msgParts[0];
      const gender = msgParts[1];
      const name = msgParts[2];

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
            searchList.push(con.user.toJSON());
          }
        }
      }

      thisCon.socket.emit('search result', JSON.stringify(searchList));
    } catch (err) {
      console.error('Search error:', err);
    }
  });

  // ----------------------------------------------------------
  // COMMAND
  // Full command string, parse and handle
  // ----------------------------------------------------------
  socket.on('command', async (msg) => {
    try {
      const thisCon = findConnectionBySocket(socket);
      if (!thisCon || !thisCon.user) return;

      const userChannel = findChannelByName(thisCon.user.currentChannel);
      const commandParts = msg.split(' ');
      const command = commandParts[0].toLowerCase();

      // ======================================================
      // /part - Return to General channel
      // ======================================================
      if (command === '/part') {
        thisCon.socket.emit('changed channel', 'General');
        if (userChannel) {
          userChannel.removeFromChannel(thisCon.user);
        }
        const generalCh = findChannelByName('General');
        if (generalCh) {
          generalCh.addToChannel(thisCon.user);
        }
      }

      // ======================================================
      // /wall - Server-wide message (cyber/admin only)
      // ======================================================
      else if (command === '/wall') {
        if (thisCon.user.accountType === 3 || thisCon.user.accountType === 4) {
          const messageText = msg.replace('/wall ', '');
          const parsedMessage = parseColoredText(messageText);
          sendServerMessageToAllLoggedInUsers('server message: ' + parsedMessage);
        } else {
          thisCon.socket.emit('server message', 'Deze actie is niet toegestaan');
        }
      }

      // ======================================================
      // /whois - Find which channel a user is in
      // ======================================================
      else if (command === '/whois') {
        const targetName = msg.replace('/whois ', '');
        const found = findUserByNickname(targetName);
        if (found) {
          thisCon.socket.emit('server message',
            found.nickname + ' is in kanaal ' + found.currentChannel
          );
        } else {
          thisCon.socket.emit('server message',
            targetName + ' gebruiker niet ingelogd, of bestaat niet.'
          );
        }
      }

      // ======================================================
      // /op - Set a user's channel level
      // Format: /op nickname level
      // ======================================================
      else if (command === '/op') {
        const userToUpgrade = findUserByNickname(commandParts[1]);

        if (!userToUpgrade) {
          thisCon.socket.emit('server message', 'That user is not logged in or does not exist');
          return;
        }

        const positionToSet = convertStringToLevel(commandParts[2]);
        const ch = findChannelByName(userToUpgrade.currentChannel);

        if (userToUpgrade.currentChannel !== thisCon.user.currentChannel) {
          thisCon.socket.emit('server message', 'That user is not in the channel currently');
          return;
        }

        if (positionToSet === null) {
          thisCon.socket.emit('server message', 'Account type must be normal, oper, super, cyber or admin');
          return;
        }

        let carryOut = false;

        if (thisCon.user.accountType === 4 || (thisCon.user.accountType === 3 && userToUpgrade.accountType !== 4 && positionToSet !== 4)) {
          // Admin/Cyber can op anyone to anything (as long as not cyber oping to admin)
          carryOut = true;
        } else if (userToUpgrade.nickname === thisCon.user.nickname) {
          // User trying to op themselves
          if (ch && ch.creator === thisCon.user.nickname && positionToSet !== 3 && positionToSet !== 4) {
            carryOut = true;
          } else if (positionToSet === 0 && thisCon.user.currentChannelUserLevel !== 0) {
            carryOut = true;
          } else {
            // Check autoop permissions from DB
            try {
              const rights = await db.getChannelRights(ch ? ch.name : '');
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
              thisCon.socket.emit('server message', 'Deze actie is niet toegestaan.');
              return;
            }
          }
        } else {
          // User trying to op a different user
          if (thisCon.user.currentChannelUserLevel === userToUpgrade.currentChannelUserLevel ||
              compareUserLevels(thisCon.user.currentChannelUserLevel, userToUpgrade.currentChannelUserLevel)) {
            carryOut = true;
          }
        }

        if (carryOut && ch) {
          userToUpgrade.currentChannelUserLevel = positionToSet;
          userToUpgrade.userWhoGave = thisCon.user.nickname;
          ch.sendEvent('user updated', JSON.stringify(userToUpgrade.toJSON()));
          ch.sendEvent('server message',
            thisCon.user.nickname + ' heeft ' + userToUpgrade.nickname + ' ' + commandParts[2] + ' gemaakt op kanaal ' + ch.name
          );
        } else if (!carryOut) {
          thisCon.socket.emit('server message', 'Deze actie is niet toegestaan.');
        }
      }

      // ======================================================
      // /deop - Remove a user's channel level (or self-deop)
      // ======================================================
      else if (command === '/deop') {
        if (commandParts.length === 1) {
          // Self-deop
          const ch = findChannelByName(thisCon.user.currentChannel);
          const lvl = thisCon.user.currentChannelUserLevel;
          if (lvl === 1 || lvl === 2 || lvl === 3 || lvl === 4 || lvl === 5) {
            thisCon.user.currentChannelUserLevel = 0;
            if (ch) {
              ch.sendEvent('user updated', JSON.stringify(thisCon.user.toJSON()));
              ch.sendEvent('server message',
                thisCon.user.nickname + ' heeft ' + thisCon.user.nickname + ' normaal gemaakt op kanaal ' + ch.name
              );
            }
          } else {
            thisCon.socket.emit('server message', 'Deze actie is niet toegestaan.');
          }
        } else {
          // Deop someone else: /deop username
          const reqLevel = thisCon.user.currentChannelUserLevel;
          if (reqLevel === 5 || reqLevel === 4 || reqLevel === 3 || reqLevel === 2) {
            const userToDowngrade = findUserByNickname(commandParts[1]);
            if (userToDowngrade) {
              if (userToDowngrade.currentChannelUserLevel === 1 || userToDowngrade.currentChannelUserLevel === 2) {
                if (compareUserLevels(thisCon.user.currentChannelUserLevel, userToDowngrade.currentChannelUserLevel) || thisCon.user.currentChannelUserLevel === 4) {
                  if (thisCon.user.currentChannel !== userToDowngrade.currentChannel) {
                    thisCon.socket.emit('server message', 'the user you specified is not in this channel at present.');
                    return;
                  }

                  userToDowngrade.currentChannelUserLevel = 0;
                  userToDowngrade.userWhoGave = thisCon.user.nickname;

                  const ch = findChannelByName(userToDowngrade.currentChannel);
                  if (ch) {
                    ch.sendEvent('user updated', JSON.stringify(userToDowngrade.toJSON()));
                    ch.sendEvent('server message',
                      thisCon.user.nickname + ' heeft ' + userToDowngrade.nickname + ' normaal gemaakt op kanaal ' + ch.name
                    );
                  }
                } else {
                  thisCon.socket.emit('server message', 'Deze actie is niet toegestaan.');
                }
              } else {
                thisCon.socket.emit('server message', 'That user is not oper or super, did you mean /sdeop?');
              }
            }
          } else {
            thisCon.socket.emit('server message', 'Deze actie is niet toegestaan.');
          }
        }
      }

      // ======================================================
      // /sdeop - Remove server-level rights temporarily (admin only)
      // ======================================================
      else if (command === '/sdeop') {
        if (thisCon.user.accountType === 4) {
          const userToDowngrade = findUserByNickname(commandParts[1]);
          if (userToDowngrade && userToDowngrade.accountType === 3) {
            userToDowngrade.accountType = 0;
            userToDowngrade.currentChannelUserLevel = 0;

            const ch = findChannelByName(userToDowngrade.currentChannel);
            if (ch) {
              ch.sendEvent('user updated', JSON.stringify(userToDowngrade.toJSON()));
              ch.sendEvent('server message',
                thisCon.user.nickname + ' heeft ' + userToDowngrade.nickname + ' normaal gemaakt op kanaal ' + userToDowngrade.currentChannel + ' en tijdelijk blijvende rechten afgenomen.'
              );
            }
          }
        } else {
          thisCon.socket.emit('server message', 'Deze actie is niet toegestaan.');
        }
      }

      // ======================================================
      // /autosdeop - Permanently remove server rights (admin only, persists to DB)
      // ======================================================
      else if (command === '/autosdeop') {
        if (thisCon.user.accountType === 4) {
          const userToDowngrade = findUserByNickname(commandParts[1]);
          if (userToDowngrade && (userToDowngrade.accountType === 3 || userToDowngrade.accountType === 4)) {
            userToDowngrade.accountType = 0;
            userToDowngrade.currentChannelUserLevel = 0;

            const ch = findChannelByName(userToDowngrade.currentChannel);

            await db.updateUser(userToDowngrade.nickname, { accountType: 0 });

            if (ch) {
              ch.sendEvent('user updated', JSON.stringify(userToDowngrade.toJSON()));
              ch.sendEvent('server message',
                thisCon.user.nickname + ' heeft ' + userToDowngrade.nickname + ' normaal gemaakt op kanaal ' + userToDowngrade.currentChannel + ' en blijvende rechten afgenomen.'
              );
            }
          }
        } else {
          thisCon.socket.emit('server message', 'Deze actie is niet toegestaan.');
        }
      }

      // ======================================================
      // /autosop - Permanently set server-level rights (admin only)
      // Format: /autosop nickname level
      // ======================================================
      else if (command === '/autosop') {
        if (thisCon.user.accountType === 4) {
          const userToUpgrade = findUserByNickname(commandParts[1]);
          if (userToUpgrade) {
            const targetLevel = convertStringToLevel(commandParts[2]);
            if (
              (userToUpgrade.accountType !== 4 && commandParts[2] === 'admin') ||
              (userToUpgrade.accountType !== 3 && userToUpgrade.accountType !== 4 && commandParts[2] === 'cyber') ||
              (userToUpgrade.accountType === 4 && userToUpgrade.nickname === thisCon.user.nickname)
            ) {
              if (targetLevel !== null) {
                userToUpgrade.accountType = targetLevel;
                userToUpgrade.currentChannelUserLevel = targetLevel;

                const ch = findChannelByName(userToUpgrade.currentChannel);

                await db.updateUser(userToUpgrade.nickname, { accountType: targetLevel });

                if (ch) {
                  ch.sendEvent('user updated', JSON.stringify(userToUpgrade.toJSON()));
                  ch.sendEvent('server message',
                    thisCon.user.nickname + ' heeft ' + userToUpgrade.nickname + ' ' + commandParts[2]
                  );
                }
              }
            }
          }
        } else {
          thisCon.socket.emit('server message', 'Deze actie is niet toegestaan.');
        }
      }

      // ======================================================
      // /autoop - Set permanent channel-level rights
      // Format: /autoop nickname level
      // ======================================================
      else if (command === '/autoop') {
        const reqLevel = thisCon.user.currentChannelUserLevel;
        if (reqLevel === 5 || reqLevel === 4 || reqLevel === 3 || reqLevel === 2) {
          const userToUpgrade = findUserByNickname(commandParts[1]);
          if (userToUpgrade) {
            if (compareUserLevels(thisCon.user.currentChannelUserLevel, userToUpgrade.currentChannelUserLevel) || thisCon.user.currentChannelUserLevel === 4) {
              if (thisCon.user.currentChannel !== userToUpgrade.currentChannel) {
                thisCon.socket.emit('server message', 'the user you specified is not in this channel at present.');
                return;
              }

              if (commandParts[2] === 'oper' || commandParts[2] === 'super') {
                const levelVal = convertStringToLevel(commandParts[2]);
                userToUpgrade.currentChannelUserLevel = levelVal;
                userToUpgrade.userWhoGave = thisCon.user.nickname;

                const ch = findChannelByName(userToUpgrade.currentChannel);

                // Update database: delete old, insert new
                await db.setChannelRight(
                  thisCon.user.currentChannel,
                  userToUpgrade.nickname,
                  thisCon.user.nickname,
                  levelVal
                );

                if (ch) {
                  if (commandParts[2] === 'super') {
                    ch.permSuperAdmins.push({ nickname: userToUpgrade.nickname, givenBy: thisCon.user.nickname });
                  } else if (commandParts[2] === 'oper') {
                    ch.permOperators.push({ nickname: userToUpgrade.nickname, givenBy: thisCon.user.nickname });
                  }

                  ch.sendEvent('user updated', JSON.stringify(userToUpgrade.toJSON()));
                  ch.sendEvent('server message',
                    thisCon.user.nickname + ' heeft ' + userToUpgrade.nickname + ' blijvende ' + commandParts[2] + ' rechten gegeven op kanaal  ' + ch.name
                  );
                }
              }
            } else {
              thisCon.socket.emit('server message', 'Permission Denied.');
            }
          }
        } else {
          thisCon.socket.emit('server message', 'Permission Denied.');
        }
      }

      // ======================================================
      // /autodeop - Remove permanent channel-level rights
      // Format: /autodeop nickname
      // ======================================================
      else if (command === '/autodeop') {
        const reqLevel = thisCon.user.currentChannelUserLevel;
        if (reqLevel === 5 || reqLevel === 4 || reqLevel === 3 || reqLevel === 2) {
          // Do the DB query first (in case user isn't logged in)
          await db.removeChannelRight(thisCon.user.currentChannel, commandParts[1]);

          const userToDowngrade = findUserByNickname(commandParts[1]);
          const ch = findChannelByName(thisCon.user.currentChannel);

          if (userToDowngrade) {
            if (compareUserLevels(thisCon.user.currentChannelUserLevel, userToDowngrade.currentChannelUserLevel) || thisCon.user.currentChannelUserLevel === 4) {
              if (ch) {
                await ch.loadPermissions();
              }

              if (thisCon.user.currentChannel === userToDowngrade.currentChannel) {
                userToDowngrade.currentChannelUserLevel = 0;
                if (ch) {
                  ch.sendEvent('user updated', JSON.stringify(userToDowngrade.toJSON()));
                }
              }

              if (ch) {
                ch.sendEvent('server message',
                  thisCon.user.nickname + ' heeft ' + commandParts[1] + ' gemaakt op kanaal ' + ch.name + ' en blijvende rechten afgenomen.'
                );
              }
            } else {
              thisCon.socket.emit('server message', 'Deze actie is niet toegestaan.');
            }
          }
        } else {
          thisCon.socket.emit('server message', 'Deze actie is niet toegestaan.');
        }
      }

      // ======================================================
      // /autooplist - List permanent channel rights
      // ======================================================
      else if (command === '/autooplist') {
        const ch = findChannelByName(thisCon.user.currentChannel);
        let list = 'autoop list for ' + thisCon.user.currentChannel;

        if (ch) {
          list += '<br />' + ch.creator + ' is creator';
        }

        try {
          const rights = await db.getChannelRights(thisCon.user.currentChannel);
          for (const row of rights) {
            list += '<br />' + row.nickname + ' - ' + convertLevelToString(row.level) + ' rechten door ' + row.given_by;
          }
        } catch (err) {
          console.error('Error loading autooplist:', err);
        }

        thisCon.socket.emit('server message', list);
      }

      // ======================================================
      // /autosoplist - List permanent server-level rights (cyber/admin only)
      // ======================================================
      else if (command === '/autosoplist') {
        if (thisCon.user.accountType === 4 || thisCon.user.accountType === 3) {
          try {
            const result = await db.query('SELECT nickname, account_type, rights_by FROM users WHERE account_type = 3 OR account_type = 4', []);
            let list = 'autosops list: ';
            for (const row of result.rows) {
              list += '<br />' + row.nickname + ' heeft blijvende ' + convertLevelToString(row.account_type) + ' - rechten gegeven door ' + row.rights_by;
            }
            thisCon.socket.emit('server message', list);
          } catch (err) {
            console.error('Error loading autosoplist:', err);
          }
        }
      }

      // ======================================================
      // /allusers - List all connected users (cyber/admin only)
      // ======================================================
      else if (command === '/allusers') {
        if (thisCon.user.accountType === 4 || thisCon.user.accountType === 3) {
          let list = 'all online users are:';
          for (const con of connections) {
            if (con && con.user) {
              list += '<br />' + con.user.nickname + ' in ' + con.user.currentChannel;
            }
          }
          thisCon.socket.emit('server message', list);
        }
      }

      // ======================================================
      // /kill - Kill/close a channel (cyber/admin only)
      // Format: /kill [channelname] (defaults to current channel)
      // ======================================================
      else if (command === '/kill') {
        if (thisCon.user.accountType === 4 || thisCon.user.accountType === 3) {
          let roomToKill = thisCon.user.currentChannel;

          if (commandParts.length === 2) {
            const roomToKillT = findChannelByName(commandParts[1]);
            if (!roomToKillT) {
              thisCon.socket.emit('server message', 'Kanaal niet gevonden, of bestaat niet.');
              return;
            }
            roomToKill = roomToKillT.name;
          }

          if (roomToKill === 'General') {
            thisCon.socket.emit('server message', 'Kan doorde server gemaakte kanaal niet sluiten');
            return;
          }

          const killChannel = findChannelByName(roomToKill);
          if (!killChannel) return;

          // Move all users out first
          for (const con of connections) {
            if (con && con.user && con.user.currentChannel === roomToKill) {
              con.socket.emit('changed channel', '');
              killChannel.removeFromChannel(con.user);
              con.socket.emit('server message', roomToKill + ' is gesloten door ' + thisCon.user.nickname);
            }
          }

          // Remove channel from array
          const idx = channels.indexOf(killChannel);
          if (idx !== -1) {
            channels[idx] = null;
          }

          await db.deleteChannel(roomToKill);

          // Send new channel list to everybody
          for (const con of connections) {
            if (con && con.user) {
              con.user.sendChannelList();
            }
          }
        } else {
          thisCon.socket.emit('server message', 'Permission Denied.');
        }
      }

      // ======================================================
      // /kick - Kick user from channel
      // Format: /kick nickname
      // ======================================================
      else if (command === '/kick') {
        const reqLevel = thisCon.user.currentChannelUserLevel;
        if (reqLevel === 4 || reqLevel === 3 || reqLevel === 2 || reqLevel === 1 || reqLevel === 5) {
          const userToKick = findUserByNickname(commandParts[1]);
          if (userToKick) {
            if (userToKick.accountType === 3 || userToKick.accountType === 4) {
              thisCon.socket.emit('server message', 'Can not kick cyber/admin accounts.');
              return;
            }

            const kickCh = findChannelByName(userToKick.currentChannel);
            if (
              (compareUserLevels(thisCon.user.currentChannelUserLevel, userToKick.currentChannelUserLevel) &&
               userToKick.nickname !== (kickCh ? kickCh.creator : '')) ||
              thisCon.user.currentChannelUserLevel === 4
            ) {
              if (userToKick.currentChannel === thisCon.user.currentChannel) {
                const kickCon = findConnectionFromUser(userToKick);
                if (kickCon) {
                  kickCon.socket.emit('changed channel', '');
                }
                if (kickCh) {
                  kickCh.removeFromChannel(userToKick);
                }

                const currentCh = findChannelByName(thisCon.user.currentChannel);
                if (currentCh) {
                  currentCh.sendEvent('server message',
                    thisCon.user.nickname + ' heeft ' + userToKick.nickname + ' verwijdert uit kanaal ' + thisCon.user.currentChannel
                  );
                }
                sendChannelNumbersToAll();
              }
            } else {
              thisCon.socket.emit('server message', 'Deze actie is niet toegestaan.');
            }
          }
        } else {
          thisCon.socket.emit('server message', 'Deze actie is niet toegestaan.');
        }
      }

      // ======================================================
      // /ban - Ban user from channel
      // Format: /ban nickname
      // ======================================================
      else if (command === '/ban') {
        const reqLevel = thisCon.user.currentChannelUserLevel;
        const ch = findChannelByName(thisCon.user.currentChannel);

        if (
          reqLevel === 4 || reqLevel === 3 ||
          ((reqLevel === 2 || reqLevel === 1 || reqLevel === 5) && ch && ch.creator !== commandParts[1])
        ) {
          const userToBan = findUserByNickname(commandParts[1]);
          if (userToBan) {
            if (compareUserLevels(thisCon.user.currentChannelUserLevel, userToBan.currentChannelUserLevel) || thisCon.user.currentChannelUserLevel === 4) {
              if (userToBan.accountType === 3 || userToBan.accountType === 4) {
                thisCon.socket.emit('server message', 'Can not ban cyber/admin accounts.');
                return;
              }

              const chanToBanFrom = findChannelByName(thisCon.user.currentChannel);
              if (!chanToBanFrom) return;

              // Check if already banned
              const existingBan = chanToBanFrom.banList.find((b) => b && b.nickname === userToBan.nickname);
              if (existingBan) {
                thisCon.socket.emit('server message', 'That user is already banned');
                return;
              }

              await db.addChannelBan(chanToBanFrom.name, userToBan.nickname, thisCon.user.nickname);
              chanToBanFrom.banList.push({ nickname: userToBan.nickname, bannedBy: thisCon.user.nickname });

              if (userToBan.currentChannel === chanToBanFrom.name) {
                const banCon = findConnectionFromUser(userToBan);
                if (banCon) {
                  banCon.socket.emit('changed channel', '');
                }
                const banCh = findChannelByName(userToBan.currentChannel);
                if (banCh) {
                  banCh.removeFromChannel(userToBan);
                }
                sendChannelNumbersToAll();
              }

              chanToBanFrom.sendEvent('server message',
                thisCon.user.nickname + ' heeft ' + userToBan.nickname + ' verbannen van kanaal ' + chanToBanFrom.name
              );
            } else {
              thisCon.socket.emit('server message', 'Deze actie is niet toegestaan.');
            }
          } else {
            thisCon.socket.emit('server message', 'Kan niet bannen van general');
          }
        } else {
          thisCon.socket.emit('server message', 'Deze actie is niet toegestaan.');
        }
      }

      // ======================================================
      // /unban - Unban user from channel
      // Format: /unban nickname
      // ======================================================
      else if (command === '/unban') {
        const reqLevel = thisCon.user.currentChannelUserLevel;
        if (reqLevel === 4 || reqLevel === 3 || reqLevel === 2 || reqLevel === 1 || reqLevel === 5) {
          const userToUnBan = findUserByNickname(commandParts[1]);
          if (userToUnBan) {
            const chanToUnBanFrom = findChannelByName(thisCon.user.currentChannel);
            if (!chanToUnBanFrom) return;

            const banEntry = chanToUnBanFrom.banList.find((b) => b && b.nickname === userToUnBan.nickname);
            if (!banEntry) {
              thisCon.socket.emit('server message', 'Gebruiker is niet verbannen!');
              return;
            }

            await db.removeChannelBan(thisCon.user.currentChannel, userToUnBan.nickname);

            // Remove from in-memory ban list
            for (let i = 0; i < chanToUnBanFrom.banList.length; i++) {
              if (chanToUnBanFrom.banList[i] && chanToUnBanFrom.banList[i].nickname === userToUnBan.nickname) {
                chanToUnBanFrom.banList[i] = null;
              }
            }

            const unbanCon = findConnectionFromUser(userToUnBan);
            if (unbanCon) {
              unbanCon.socket.emit('server message',
                thisCon.user.nickname + ' unbanned ' + userToUnBan.nickname + ' from ' + chanToUnBanFrom.name
              );
            }

            chanToUnBanFrom.sendEvent('server message',
              thisCon.user.nickname + ' heeft ' + userToUnBan.nickname + ' toegang gegeven op kanaal ' + chanToUnBanFrom.name
            );
          } else {
            thisCon.socket.emit('server message', 'Gebruiker niet online');
          }
        } else {
          thisCon.socket.emit('server message', 'Deze actie is niet toegestaan.');
        }
      }

      // ======================================================
      // /banlist - Show channel ban list
      // ======================================================
      else if (command === '/banlist') {
        const reqLevel = thisCon.user.currentChannelUserLevel;
        if (reqLevel === 4 || reqLevel === 3 || reqLevel === 2 || reqLevel === 1 || reqLevel === 5) {
          const currentC = findChannelByName(thisCon.user.currentChannel);
          if (currentC) {
            let mess = 'Ban List for : ' + currentC.name;
            for (const ban of currentC.banList) {
              if (ban) {
                mess += '<br />' + ban.nickname + ' verbannen door ' + ban.bannedBy;
              }
            }
            thisCon.socket.emit('server message', mess);
          }
        } else {
          thisCon.socket.emit('server message', 'Deze actie is niet toegestaan.');
        }
      }

      // ======================================================
      // /quit - Disconnect
      // ======================================================
      else if (command === '/quit') {
        socket.disconnect();
      }

      // ======================================================
      // /skick - Server kick (cyber/admin only)
      // Format: /skick nickname
      // ======================================================
      else if (command === '/skick') {
        if (thisCon.user.accountType === 4 || thisCon.user.accountType === 3) {
          const userToKick = findUserByNickname(commandParts[1]);
          if (userToKick) {
            if (thisCon.user.accountType >= userToKick.accountType) {
              sendEventToAllLoggedInUsers('server message',
                thisCon.user.nickname + ' heeft ' + userToKick.nickname + ' verwijdert van de chat server.'
              );
              const kickCon = findConnectionFromUser(userToKick);
              if (kickCon) {
                kickCon.socket.disconnect();
              }
            }
          }
        } else {
          thisCon.socket.emit('server message', 'Deze actie is niet toegestaan.');
        }
      }

      // ======================================================
      // /sban - Server ban (cyber/admin only)
      // Format: /sban nickname [duration]
      // Duration: e.g. 72h, 30m (default 72h)
      // ======================================================
      else if (command === '/sban') {
        if (thisCon.user.accountType === 4 || thisCon.user.accountType === 3) {
          const userToBan = findUserByNickname(commandParts[1]);
          if (userToBan) {
            if (thisCon.user.accountType >= userToBan.accountType) {
              let forTime = '72h';
              if (commandParts.length === 3) {
                forTime = commandParts[2];
              }

              let forSymbol = 'hour';
              if (forTime[forTime.length - 1] === 'm') {
                forSymbol = 'minute';
              }

              const timeValue = parseInt(forTime.substring(0, forTime.length - 1), 10);
              const banUntil = dateAdd(Date.now(), forSymbol, timeValue);

              await db.addServerBan(userToBan.nickname, thisCon.user.nickname, Number(banUntil), userToBan.ip);

              sendEventToAllLoggedInUsers('server message',
                thisCon.user.nickname + ' heeft ' + userToBan.nickname + ' uitgesloten van de chat server tot ' + banUntil.toString()
              );

              const banCon = findConnectionFromUser(userToBan);
              if (banCon) {
                banCon.socket.disconnect();
              }
            }
          } else {
            thisCon.socket.emit('server message', 'Gebruiker niet online.');
          }
        } else {
          thisCon.socket.emit('server message', 'Deze actie is niet toegestaan.');
        }
      }

      // ======================================================
      // /sbanlist - Show server ban list (cyber/admin only)
      // ======================================================
      else if (command === '/sbanlist') {
        if (thisCon.user.accountType === 4 || thisCon.user.accountType === 3) {
          const serverBans = await db.getServerBans();
          let list = 'Server Ban List:';
          for (const ban of serverBans) {
            list += '<br />' + ban.nickname + ' is uitgesloten door ' + ban.banned_by + ' tot ' + new Date(parseInt(ban.unban_timestamp)).toString();
          }
          thisCon.socket.emit('server message', list);
        } else {
          thisCon.socket.emit('server message', 'Permission Denied.');
        }
      }

      // ======================================================
      // /sunban - Remove server ban (cyber/admin only)
      // Format: /sunban nickname
      // ======================================================
      else if (command === '/sunban') {
        if (thisCon.user.accountType === 4 || thisCon.user.accountType === 3) {
          const bans = await db.checkServerBanByNickname(commandParts[1]);
          if (bans.length > 0) {
            await db.removeServerBan(commandParts[1]);
            thisCon.socket.emit('server message', 'Gebruiker heeft weer toegang tot de chat server ' + commandParts[1]);
          } else {
            thisCon.socket.emit('server message', 'Gebruiker is niet uitgesloten van de chat server');
          }
        } else {
          thisCon.socket.emit('server message', 'Deze actie is niet toegestaan.');
        }
      }

      // ======================================================
      // /version
      // ======================================================
      else if (command === '/version') {
        thisCon.socket.emit('server message', 'Current version is: ' + VERSION);
      }

      // ======================================================
      // /info
      // ======================================================
      else if (command === '/info') {
        thisCon.socket.emit('server message', 'Chat Server owned by: Sunto<br />Coded By: joehollo<br />Rebuilt: DutchChat v2.0 (2026)');
      }

      // ======================================================
      // /join - Join or create a channel
      // Format: /join channelname
      // ======================================================
      else if (command === '/join') {
        if (commandParts.length === 2) {
          let chan = findChannelByName(commandParts[1]);

          if (!chan) {
            if (commandParts[1].length < 3) {
              thisCon.socket.emit('server message', 'The channel name must be 3 or more characters in length.');
              return;
            }

            if (commandParts[1].indexOf(' ') !== -1) {
              thisCon.socket.emit('server message', 'The channel name must not contain spaces.');
              return;
            }

            // Create channel
            await db.createChannel(commandParts[1], thisCon.user.nickname, '', 0);
            await db.createChatLog(commandParts[1]);

            const newCh = new Channel(commandParts[1], thisCon.user.nickname, '', 0, '', 0);
            channels.push(newCh);

            // Update all users with new channel list
            for (const con of connections) {
              if (con && con.user) {
                con.user.sendChannelList();
              }
            }

            chan = findChannelByName(commandParts[1]);
          }

          if (chan) {
            thisCon.socket.emit('changed channel', chan.name);

            if (thisCon.user.currentChannel) {
              const oldCh = findChannelByName(thisCon.user.currentChannel);
              if (oldCh) {
                oldCh.removeFromChannel(thisCon.user);
              }
            }
            chan.addToChannel(thisCon.user);
          }
        } else {
          thisCon.socket.emit('server message', 'Format is: /join channelname');
        }
      }

      // ======================================================
      // /topic - Change channel topic
      // Format: /topic text with optional #hex colors
      // ======================================================
      else if (command === '/topic') {
        const reqLevel = thisCon.user.currentChannelUserLevel;
        if (reqLevel === 4 || reqLevel === 3 || reqLevel === 2 || reqLevel === 1 || reqLevel === 5) {
          const thisCh = findChannelByName(thisCon.user.currentChannel);
          if (thisCh) {
            const topicText = msg.replace('/topic ', '');
            const parsedTopic = parseColoredText(topicText);

            thisCh.topic = parsedTopic;

            thisCh.sendEvent('channel topic update', thisCh.topic);
            thisCh.sendEvent('server message', thisCon.user.nickname + ' heeft de topic verandert');
            thisCh.sendEvent('server message', 'Nieuw Topic: ' + thisCh.topic);
          }
        } else {
          thisCon.socket.emit('server message', 'Deze actie is niet toegestaan.');
        }
      }

      // ======================================================
      // /list - List all channels
      // ======================================================
      else if (command === '/list') {
        let list = 'Channels are:';
        for (const ch of channels) {
          if (ch) {
            if (ch.type === 0 || (ch.type === 1 && (thisCon.user.accountType === 4 || thisCon.user.accountType === 3))) {
              list += '<br />' + ch.name;
            }
          }
        }
        thisCon.socket.emit('server message', list);
      }

      // ======================================================
      // /hide - Hide from channel user list (cyber/admin only)
      // ======================================================
      else if (command === '/hide') {
        if (thisCon.user.accountType === 4 || thisCon.user.accountType === 3) {
          if (!thisCon.user.hidden) {
            const ch = findChannelByName(thisCon.user.currentChannel);
            if (ch) {
              ch.sendEvent('user left channel', thisCon.user.nickname);
              thisCon.user.hidden = true;
              ch.currentUsers--;
              sendChannelNumbersToAll();
            }
          }
        }
      }

      // ======================================================
      // /unhide - Show in channel user list again (cyber/admin only)
      // ======================================================
      else if (command === '/unhide') {
        if (thisCon.user.accountType === 4 || thisCon.user.accountType === 3) {
          if (thisCon.user.hidden) {
            const ch = findChannelByName(thisCon.user.currentChannel);
            if (ch) {
              ch.sendEvent('user joined channel', JSON.stringify(thisCon.user.toJSON()));
              thisCon.user.hidden = false;
              ch.currentUsers++;
              sendChannelNumbersToAll();
            }
          }
        }
      }

      // ======================================================
      // /serrorlog - View error log (admin only)
      // ======================================================
      else if (command === '/serrorlog') {
        if (thisCon.user.accountType === 4) {
          try {
            const result = await db.query('SELECT timestamp, error, stacktrace FROM errors ORDER BY id DESC', []);
            let elog = 'Error Log: ';
            for (const row of result.rows) {
              elog += '<br /><br />' + row.timestamp + ': ' + row.error + '<br />' + row.stacktrace;
            }
            socket.emit('clog', elog);
          } catch (err) {
            console.error('Error fetching error log:', err);
          }
        }
      }

      // ======================================================
      // /clog - View channel chat log (admin only)
      // ======================================================
      else if (command === '/clog') {
        if (thisCon.user.accountType === 4) {
          const ch = findChannelByName(thisCon.user.currentChannel);
          if (ch) {
            socket.emit('clog', ch.chatLog);
          }
        }
      }

      // ======================================================
      // /cleanlog - Clear channel chat log (admin only)
      // ======================================================
      else if (command === '/cleanlog') {
        if (thisCon.user.accountType === 4) {
          const ch = findChannelByName(thisCon.user.currentChannel);
          if (ch) {
            ch.chatLog = '';
            await db.saveChatLog(thisCon.user.currentChannel, '');
            socket.emit('server message', 'Log van kanaal geleegd');
          }
        }
      }

      // ======================================================
      // /silent - Silence a user in channel
      // Format: /silent nickname
      // ======================================================
      else if (command === '/silent') {
        const reqLevel = thisCon.user.currentChannelUserLevel;
        if (reqLevel === 5 || reqLevel === 4 || reqLevel === 3 || reqLevel === 2) {
          const userToSilence = findUserByNickname(commandParts[1]);
          if (userToSilence) {
            if (compareUserLevels(thisCon.user.currentChannelUserLevel, userToSilence.currentChannelUserLevel)) {
              if (userToSilence.currentChannel === thisCon.user.currentChannel) {
                userToSilence.silenced = true;
                const ch = findChannelByName(userToSilence.currentChannel);
                if (ch) {
                  ch.sendEvent('server message',
                    thisCon.user.nickname + ' has silent ' + userToSilence.nickname + ' on channel ' + userToSilence.currentChannel
                  );
                  ch.sendEvent('user updated', JSON.stringify(userToSilence.toJSON()));
                }
              }
            } else {
              thisCon.socket.emit('server message', 'Deze actie is niet toegestaan.');
            }
          }
        } else {
          thisCon.socket.emit('server message', 'Deze actie is niet toegestaan.');
        }
      }

      // ======================================================
      // /unsilent - Unsilence a user in channel
      // Format: /unsilent nickname
      // ======================================================
      else if (command === '/unsilent') {
        const reqLevel = thisCon.user.currentChannelUserLevel;
        if (reqLevel === 5 || reqLevel === 4 || reqLevel === 3 || reqLevel === 2) {
          const userToSilence = findUserByNickname(commandParts[1]);
          if (userToSilence) {
            if (userToSilence.currentChannel === thisCon.user.currentChannel) {
              userToSilence.silenced = false;
              const ch = findChannelByName(userToSilence.currentChannel);
              if (ch) {
                ch.sendEvent('server message',
                  thisCon.user.nickname + ' have unsilenced ' + userToSilence.nickname + ' on ' + userToSilence.currentChannel
                );
                ch.sendEvent('user updated', JSON.stringify(userToSilence.toJSON()));
              }
            }
          }
        } else {
          thisCon.socket.emit('server message', 'Deze actie is niet toegestaan.');
        }
      }

      // ======================================================
      // /makestatic - Make current channel static (cyber/admin only)
      // ======================================================
      else if (command === '/makestatic') {
        if (thisCon.user.accountType === 4 || thisCon.user.accountType === 3) {
          const ch = findChannelByName(thisCon.user.currentChannel);
          if (ch) {
            ch.isStatic = 1;
            await db.query('UPDATE channels SET is_static = 1 WHERE name = $1', [thisCon.user.currentChannel]);
            thisCon.socket.emit('server message', 'Made ' + thisCon.user.currentChannel + ' static.');
          }
        }
      }

      // ======================================================
      // UNKNOWN COMMAND
      // ======================================================
      else {
        thisCon.socket.emit('server message', 'Deze actie is niet toegestaan.');
      }

    } catch (err) {
      console.error('Command error:', err);
      db.logError(String(err), err.stack || '').catch(() => {});
    }
  });
});

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
  console.log('DutchChat v2.0 starting...');

  // Load channels from database
  await loadChannelsFromDatabase();

  // Start listening
  server.listen(PORT, () => {
    console.log(`DutchChat v2.0 listening on port ${PORT}`);
  });
}

start().catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
