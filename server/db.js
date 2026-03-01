const Database = require('better-sqlite3');
const path = require('path');

const db = new Database(path.join(__dirname, 'pacman.db'));

db.exec(`
  CREATE TABLE IF NOT EXISTS payments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    txHash TEXT UNIQUE NOT NULL,
    walletAddress TEXT NOT NULL,
    chain TEXT NOT NULL,
    amount TEXT NOT NULL,
    date TEXT NOT NULL,
    used INTEGER DEFAULT 0,
    createdAt TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS scores (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    walletAddress TEXT NOT NULL,
    chain TEXT NOT NULL,
    score INTEGER NOT NULL,
    signature TEXT NOT NULL,
    date TEXT NOT NULL,
    createdAt TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS winners (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    walletAddress TEXT NOT NULL,
    chain TEXT NOT NULL,
    score INTEGER NOT NULL,
    prize TEXT NOT NULL,
    payoutTxHash TEXT,
    date TEXT NOT NULL,
    createdAt TEXT DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_payments_date ON payments(date);
  CREATE INDEX IF NOT EXISTS idx_payments_wallet ON payments(walletAddress);
  CREATE INDEX IF NOT EXISTS idx_scores_date ON scores(date);
`);

module.exports = db;
