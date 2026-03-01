require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { ethers } = require('ethers');
const { Connection } = require('@solana/web3.js');
const cron = require('node-cron');
const { getDb, run, get, all } = require('./db');
const { runPayout } = require('./payout');

const app = express();
app.use(cors());
app.use(express.json());

const USDC_ABI = [
  'event Transfer(address indexed from, address indexed to, uint256 value)'
];
const PLAY_COST = 250_000;

function getTodayPT() {
  const now = new Date();
  const pt = new Date(now.toLocaleString('en-US', { timeZone: 'America/Los_Angeles' }));
  return pt.toISOString().split('T')[0];
}

// ─── VERIFY PAYMENT ────────────────────────────────────────────────────────

app.post('/api/verify-payment', async (req, res) => {
  const { txHash, walletAddress, chain } = req.body;
  if (!txHash || !walletAddress || !chain) return res.status(400).json({ error: 'Missing fields' });

  const existing = get('SELECT * FROM payments WHERE txHash = ?', [txHash]);
  if (existing) return res.status(400).json({ error: 'Transaction already used' });

  const today = getTodayPT();
  try {
    if (chain === 'base') await verifyBasePayment(txHash, walletAddress);
    else if (chain === 'solana') await verifySolanaPayment(txHash, walletAddress);
    else return res.status(400).json({ error: 'Invalid chain' });

    run('INSERT INTO payments (txHash, walletAddress, chain, amount, date) VALUES (?, ?, ?, ?, ?)',
      [txHash, walletAddress.toLowerCase(), chain, '0.25', today]);

    res.json({ ok: true, date: today });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

async function verifyBasePayment(txHash, walletAddress) {
  const provider = new ethers.JsonRpcProvider(process.env.BASE_RPC_URL);
  const receipt = await provider.getTransactionReceipt(txHash);
  if (!receipt) throw new Error('Transaction not found');
  if (receipt.status !== 1) throw new Error('Transaction failed');
  const usdc = new ethers.Contract(process.env.USDC_BASE_CONTRACT, USDC_ABI, provider);
  const logs = await usdc.queryFilter(usdc.filters.Transfer(walletAddress, process.env.BASE_TREASURY_WALLET), receipt.blockNumber, receipt.blockNumber);
  const valid = logs.find(l => l.transactionHash.toLowerCase() === txHash.toLowerCase() && BigInt(l.args.value) >= BigInt(PLAY_COST));
  if (!valid) throw new Error('No valid USDC transfer found');
}

async function verifySolanaPayment(txHash, walletAddress) {
  const connection = new Connection(process.env.SOLANA_RPC_URL, 'confirmed');
  const tx = await connection.getParsedTransaction(txHash, { maxSupportedTransactionVersion: 0 });
  if (!tx) throw new Error('Transaction not found');
  if (tx.meta?.err) throw new Error('Transaction failed');
  const instructions = tx.transaction.message.instructions;
  const valid = instructions.find(ix =>
    ix.program === 'spl-token' &&
    ix.parsed?.type === 'transferChecked' &&
    ix.parsed?.info?.mint === process.env.USDC_SOLANA_MINT &&
    ix.parsed?.info?.destination === process.env.SOLANA_TREASURY_WALLET &&
    Number(ix.parsed?.info?.tokenAmount?.amount) >= PLAY_COST
  );
  if (!valid) throw new Error('No valid USDC transfer found');
}

// ─── SUBMIT SCORE ──────────────────────────────────────────────────────────

app.post('/api/score', async (req, res) => {
  const { score, signature, walletAddress, chain } = req.body;
  if (!score || !signature || !walletAddress || !chain) return res.status(400).json({ error: 'Missing fields' });

  const today = getTodayPT();
  const wallet = walletAddress.toLowerCase();

  const payment = get('SELECT * FROM payments WHERE walletAddress = ? AND chain = ? AND date = ? AND used = 0', [wallet, chain, today]);
  if (!payment) return res.status(400).json({ error: 'No valid payment found for today' });

  const message = `PACMAN:${score}:${walletAddress}:${today}`;
  try {
    if (chain === 'base') {
      const recovered = ethers.verifyMessage(message, signature);
      if (recovered.toLowerCase() !== wallet) throw new Error('Invalid signature');
    } else {
      const nacl = require('tweetnacl');
      const { PublicKey } = require('@solana/web3.js');
      const msgBytes = new TextEncoder().encode(message);
      const sigBytes = Buffer.from(signature, 'base64');
      const pubkey = new PublicKey(walletAddress).toBytes();
      if (!nacl.sign.detached.verify(msgBytes, sigBytes, pubkey)) throw new Error('Invalid signature');
    }
  } catch (err) {
    return res.status(400).json({ error: `Signature failed: ${err.message}` });
  }

  if (score < 0 || score > 3_333_360) return res.status(400).json({ error: 'Invalid score' });

  run('UPDATE payments SET used = 1 WHERE id = ?', [payment.id]);
  run('INSERT INTO scores (walletAddress, chain, score, signature, date) VALUES (?, ?, ?, ?, ?)',
    [wallet, chain, score, signature, today]);

  const scores = all('SELECT score FROM scores WHERE date = ? ORDER BY score DESC', [today]);
  const rank = scores.findIndex(s => s.score <= score) + 1;

  res.json({ ok: true, score, rank });
});

// ─── LEADERBOARD ──────────────────────────────────────────────────────────

app.get('/api/leaderboard', (req, res) => {
  const today = getTodayPT();
  const scores = all(`SELECT walletAddress, chain, MAX(score) as score FROM scores WHERE date = ? GROUP BY walletAddress ORDER BY score DESC LIMIT 10`, [today]);
  const { count } = get('SELECT COUNT(*) as count FROM payments WHERE date = ?', [today]) || { count: 0 };
  const pot = (count * 0.25).toFixed(2);
  const prize = (count * 0.25 * 0.9).toFixed(2);
  res.json({
    date: today, pot, prize, entries: count,
    scores: scores.map(s => ({
      wallet: s.walletAddress.slice(0, 6) + '...' + s.walletAddress.slice(-4),
      chain: s.chain, score: s.score
    }))
  });
});

app.get('/api/history', (req, res) => {
  const winners = all('SELECT * FROM winners ORDER BY date DESC LIMIT 30');
  res.json(winners.map(w => ({
    date: w.date,
    wallet: w.walletAddress.slice(0, 6) + '...' + w.walletAddress.slice(-4),
    chain: w.chain, score: w.score, prize: '$' + w.prize
  })));
});

app.get('/api/health', (req, res) => res.json({ ok: true }));

// ─── CRON: midnight PT = 08:00 UTC ────────────────────────────────────────

cron.schedule('0 8 * * *', async () => {
  console.log('[CRON] Midnight PT — running payout');
  await runPayout();
}, { timezone: 'UTC' });

// ─── START ─────────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3001;
getDb().then(() => {
  app.listen(PORT, '0.0.0.0', () => console.log(`Pac-Man crypto server running on port ${PORT}`));
}).catch(err => {
  console.error('DB init failed:', err);
  process.exit(1);
});
