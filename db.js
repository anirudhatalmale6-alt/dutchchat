'use strict';

const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 50,
});

pool.on('error', (err) => {
  console.error('Unexpected PostgreSQL pool error:', err);
});

/**
 * Execute a parameterized query
 * @param {string} text - SQL query with $1, $2, ... placeholders
 * @param {Array} params - Parameter values
 * @returns {Promise<Object>} Query result
 */
async function query(text, params) {
  const start = Date.now();
  try {
    const result = await pool.query(text, params);
    const duration = Date.now() - start;
    if (duration > 1000) {
      console.log('Slow query:', { text, duration, rows: result.rowCount });
    }
    return result;
  } catch (err) {
    console.error('Database query error:', { text, error: err.message });
    throw err;
  }
}

// ============================================================
// USER OPERATIONS
// ============================================================

async function findUser(nickname) {
  const result = await query(
    'SELECT nickname, account_type, password_hash, age, gender, location, additional_info, email, profile_image, rights_by, created_at FROM users WHERE nickname = $1',
    [nickname]
  );
  return result.rows[0] || null;
}

async function createUser(nickname, passwordHash, email) {
  const result = await query(
    `INSERT INTO users (nickname, account_type, password_hash, age, gender, location, additional_info, email, profile_image, rights_by)
     VALUES ($1, 0, $2, 0, '', '', '', $3, 'none', 'server') RETURNING *`,
    [nickname, passwordHash, email]
  );
  return result.rows[0];
}

async function updateUser(nickname, fields) {
  // Build dynamic SET clause from fields object
  const keys = Object.keys(fields);
  if (keys.length === 0) return null;

  // Map camelCase field names to snake_case column names
  const columnMap = {
    age: 'age',
    gender: 'gender',
    location: 'location',
    additionalInfo: 'additional_info',
    additional_info: 'additional_info',
    email: 'email',
    profileImage: 'profile_image',
    profile_image: 'profile_image',
    accountType: 'account_type',
    account_type: 'account_type',
    rightsBy: 'rights_by',
    rights_by: 'rights_by',
  };

  const setClauses = [];
  const values = [];
  let paramIndex = 1;

  for (const key of keys) {
    const column = columnMap[key] || key;
    setClauses.push(`${column} = $${paramIndex}`);
    values.push(fields[key]);
    paramIndex++;
  }

  values.push(nickname);
  const result = await query(
    `UPDATE users SET ${setClauses.join(', ')} WHERE nickname = $${paramIndex}`,
    values
  );
  return result.rowCount;
}

// ============================================================
// CHANNEL OPERATIONS
// ============================================================

async function getChannels() {
  const result = await query('SELECT name, owner, topic, type, is_static FROM channels', []);
  return result.rows;
}

async function createChannel(name, owner, topic, type) {
  const result = await query(
    'INSERT INTO channels (name, owner, topic, type, is_static) VALUES ($1, $2, $3, $4, 0)',
    [name, owner, topic, type]
  );
  return result.rowCount;
}

async function deleteChannel(name) {
  const result = await query('DELETE FROM channels WHERE name = $1', [name]);
  return result.rowCount;
}

// ============================================================
// CHANNEL RIGHTS OPERATIONS
// ============================================================

async function getChannelRights(channelName) {
  const result = await query(
    'SELECT channel_name, nickname, given_by, level FROM channel_rights WHERE channel_name = $1',
    [channelName]
  );
  return result.rows;
}

async function setChannelRight(channelName, nickname, givenBy, level) {
  // Upsert: delete then insert to handle both new and existing
  await query(
    'DELETE FROM channel_rights WHERE channel_name = $1 AND nickname = $2',
    [channelName, nickname]
  );
  const result = await query(
    'INSERT INTO channel_rights (channel_name, nickname, given_by, level) VALUES ($1, $2, $3, $4)',
    [channelName, nickname, givenBy, level]
  );
  return result.rowCount;
}

async function removeChannelRight(channelName, nickname) {
  const result = await query(
    'DELETE FROM channel_rights WHERE channel_name = $1 AND nickname = $2',
    [channelName, nickname]
  );
  return result.rowCount;
}

// ============================================================
// CHANNEL BAN OPERATIONS
// ============================================================

async function getChannelBans(channelName) {
  const result = await query(
    'SELECT channel_name, nickname, banned_by FROM channel_bans WHERE channel_name = $1',
    [channelName]
  );
  return result.rows;
}

async function addChannelBan(channelName, nickname, bannedBy) {
  const result = await query(
    'INSERT INTO channel_bans (channel_name, nickname, banned_by) VALUES ($1, $2, $3) ON CONFLICT (channel_name, nickname) DO NOTHING',
    [channelName, nickname, bannedBy]
  );
  return result.rowCount;
}

async function removeChannelBan(channelName, nickname) {
  const result = await query(
    'DELETE FROM channel_bans WHERE channel_name = $1 AND nickname = $2',
    [channelName, nickname]
  );
  return result.rowCount;
}

// ============================================================
// SERVER BAN OPERATIONS
// ============================================================

async function getServerBans() {
  const result = await query(
    'SELECT nickname, banned_by, unban_timestamp, ip FROM server_bans',
    []
  );
  return result.rows;
}

async function addServerBan(nickname, bannedBy, unbanTimestamp, ip) {
  const result = await query(
    'INSERT INTO server_bans (nickname, banned_by, unban_timestamp, ip) VALUES ($1, $2, $3, $4) ON CONFLICT (nickname) DO UPDATE SET banned_by = $2, unban_timestamp = $3, ip = $4',
    [nickname, bannedBy, unbanTimestamp, ip]
  );
  return result.rowCount;
}

async function removeServerBan(nickname) {
  const result = await query(
    'DELETE FROM server_bans WHERE nickname = $1',
    [nickname]
  );
  return result.rowCount;
}

async function checkServerBanByIp(ip) {
  const result = await query(
    'SELECT nickname, banned_by, unban_timestamp, ip FROM server_bans WHERE ip = $1',
    [ip]
  );
  return result.rows;
}

async function checkServerBanByNickname(nickname) {
  const result = await query(
    'SELECT nickname, banned_by, unban_timestamp, ip FROM server_bans WHERE nickname = $1',
    [nickname]
  );
  return result.rows;
}

// ============================================================
// CHAT LOG OPERATIONS
// ============================================================

async function getChatLog(channelName) {
  const result = await query(
    'SELECT channel_name, text FROM chat_logs WHERE channel_name = $1',
    [channelName]
  );
  return result.rows[0] || null;
}

async function saveChatLog(channelName, text) {
  const result = await query(
    'UPDATE chat_logs SET text = $1 WHERE channel_name = $2',
    [text, channelName]
  );
  return result.rowCount;
}

async function createChatLog(channelName) {
  const result = await query(
    'INSERT INTO chat_logs (channel_name, text) VALUES ($1, $2) ON CONFLICT (channel_name) DO NOTHING',
    [channelName, '']
  );
  return result.rowCount;
}

// ============================================================
// ERROR LOG OPERATIONS
// ============================================================

async function logError(error, stacktrace) {
  const result = await query(
    'INSERT INTO errors (error, stacktrace) VALUES ($1, $2)',
    [error, stacktrace]
  );
  return result.rowCount;
}

// ============================================================
// EXPORTS
// ============================================================

module.exports = {
  pool,
  query,
  // User
  findUser,
  createUser,
  updateUser,
  // Channel
  getChannels,
  createChannel,
  deleteChannel,
  // Channel Rights
  getChannelRights,
  setChannelRight,
  removeChannelRight,
  // Channel Bans
  getChannelBans,
  addChannelBan,
  removeChannelBan,
  // Server Bans
  getServerBans,
  addServerBan,
  removeServerBan,
  checkServerBanByIp,
  checkServerBanByNickname,
  // Chat Logs
  getChatLog,
  saveChatLog,
  createChatLog,
  // Errors
  logError,
};
