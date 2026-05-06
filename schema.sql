-- DutchChat PostgreSQL Schema
-- Migrated from MySQL (2014) to PostgreSQL (2026)

-- Users table
CREATE TABLE IF NOT EXISTS users (
    nickname        VARCHAR(20) PRIMARY KEY,
    account_type    INT NOT NULL DEFAULT 0,  -- 0=normal, 1=oper, 2=super, 3=cyber, 4=admin
    password_hash   TEXT,
    age             INT DEFAULT 0,
    gender          VARCHAR(10) DEFAULT '',
    location        VARCHAR(100) DEFAULT '',
    additional_info TEXT DEFAULT '',
    email           VARCHAR(100) DEFAULT '',
    profile_image   TEXT DEFAULT 'none',
    rights_by       VARCHAR(20) DEFAULT 'server',
    created_at      TIMESTAMP DEFAULT NOW()
);

-- Channels table
CREATE TABLE IF NOT EXISTS channels (
    name            VARCHAR(25) PRIMARY KEY,
    owner           VARCHAR(20) NOT NULL,
    topic           TEXT DEFAULT '',
    type            INT NOT NULL DEFAULT 0,  -- 0=normal, 1=admin
    is_static       INT DEFAULT 0
);

-- Channel rights (permanent operator/super permissions per channel)
CREATE TABLE IF NOT EXISTS channel_rights (
    channel_name    VARCHAR(25) NOT NULL,
    nickname        VARCHAR(20) NOT NULL,
    given_by        VARCHAR(20) DEFAULT '',
    level           INT DEFAULT 0,
    PRIMARY KEY (channel_name, nickname)
);

-- Channel bans
CREATE TABLE IF NOT EXISTS channel_bans (
    channel_name    VARCHAR(25) NOT NULL,
    nickname        VARCHAR(20) NOT NULL,
    banned_by       VARCHAR(20) DEFAULT '',
    PRIMARY KEY (channel_name, nickname)
);

-- Server bans
CREATE TABLE IF NOT EXISTS server_bans (
    nickname        VARCHAR(20) PRIMARY KEY,
    banned_by       VARCHAR(20) NOT NULL,
    unban_timestamp BIGINT NOT NULL,
    ip              TEXT NOT NULL
);

-- Chat logs (one row per channel)
CREATE TABLE IF NOT EXISTS chat_logs (
    channel_name    VARCHAR(25) PRIMARY KEY,
    text            TEXT DEFAULT ''
);

-- Error log
CREATE TABLE IF NOT EXISTS errors (
    id              SERIAL PRIMARY KEY,
    timestamp       TIMESTAMP DEFAULT NOW(),
    error           TEXT,
    stacktrace      TEXT
);

-- Default channels
INSERT INTO channels (name, owner, topic, type, is_static)
VALUES ('General', 'system', 'General Chat', 0, 1)
ON CONFLICT (name) DO NOTHING;

INSERT INTO channels (name, owner, topic, type, is_static)
VALUES ('Help', 'system', 'Help with the chat :)', 0, 1)
ON CONFLICT (name) DO NOTHING;

-- Default chat logs for static channels
INSERT INTO chat_logs (channel_name, text)
VALUES ('General', '')
ON CONFLICT (channel_name) DO NOTHING;

INSERT INTO chat_logs (channel_name, text)
VALUES ('Help', '')
ON CONFLICT (channel_name) DO NOTHING;

-- Default admin user (password: admin123, bcrypt hashed)
-- Hash generated with bcryptjs, 10 rounds
INSERT INTO users (nickname, account_type, password_hash, age, gender, location, additional_info, email, profile_image, rights_by)
VALUES ('admin', 4, '$2a$10$uJCZeKEfrH0fXZpT6bOg2.I/SRgWUXMPbIhKRHCQPKPDUTGv7lFbi', 0, '', '', '', 'admin@dutchchat.nl', 'none', 'server')
ON CONFLICT (nickname) DO NOTHING;
