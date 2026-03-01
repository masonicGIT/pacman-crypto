require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { ethers } = require('ethers');
const { Connection, PublicKey } = require('@solana/web3.js');
const cron = require('node-cron');
const db = require('./db');
const { runPayout } = require('./payout');

const app = express();
app.use(cors());
app.use(express.json());

const USDC_ABI = [
  'event Transfer(address indexed from, address indexed to, uint256 value)',
  'function decimals() view returns (uint8)'
];
const USDC_DECIMALS = 6;
const PLAY_COST = 250_000; // $0.25 in USDC (6 decimals)

// Get today in PT
function getTodayPT() {
  const now = new Date();
  const pt = new Date(now.toLocaleString('en-US', { timeZone: 'America/Los_Angeles' }));
  return pt.toISOString().split('T')[0];
}

// ─── VERIFY PAYMENT ────────────────────────────────────────────────────────

app.post('/api/verify-payment', async (req, res) => {
  const { txHash, walletAddress, chain } = req.body;
  if (!txHash || !walletAddress || !chain) return res.status(400).json({ error: 'Missing fields' });

  // Check if txHash already used
  const existing = db.prepare('SELECT * FROM payments WHERE txHash = ?').get(txHash);
  if (existing) return res.status(400).json({ error: 'Transaction already used' });

  const today = getTodayPT();

  try {
    if (chain === 'base') {
      await verifyBasePayment(txHash, walletAddress);
    } else if (chain === 'solana') {
      await verifySolanaPayment(txHash, walletAddress);
    } else {
      return res.status(400).json({ error: 'Invalid chain' });
    }

    db.prepare(`
      INSERT INTO payments (txHash, walletAddress, chain, amount, date)
      VALUES (?, ?, ?, ?, ?)
    `).run(txHash, walletAddress.toLowerCase(), chain, '0.25', today);

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
  const filter = usdc.filters.Transfer(walletAddress, process.env.BASE_TREASURY_WALLET);
  const logs = await usdc.queryFilter(filter, receipt.blockNumber, receipt.blockNumber);

  const validTransfer = logs.find(log =>
    log.transactionHash.toLowerCase() === txHash.toLowerCase() &&
    BigInt(log.args.value) >= BigInt(PLAY_COST)
  );
  if (!validTransfer) throw new Error('No valid USDC transfer found');
}

async function verifySolanaPayment(txHash, walletAddress) {
  const connection = new Connection(process.env.SOLANA_RPC_URL, 'confirmed');
  const tx = await connection.getParsedTransaction(txHash, { maxSupportedTransactionVersion: 0 });
  if (!tx) throw new Error('Transaction not found');
  if (tx.meta?.err) throw new Error('Transaction failed');

  const instructions = tx.transaction.message.instructions;
  const tokenTransfer = instructions.find(ix =>
    ix.program === 'spl-token' &&
    ix.parsed?.type === 'transferChecked' &&
    ix.parsed?.info?.mint === process.env.USDC_SOLANA_MINT &&
    ix.parsed?.info?.destination === process.env.SOLANA_TREASURY_WALLET &&
    Number(ix.parsed?.info?.tokenAmount?.amount) >= PLAY_COST
  );
  if (!tokenTransfer) throw new Error('No valid USDC transfer found');
}

// ─── SUBMIT SCORE ──────────────────────────────────────────────────────────

app.post('/api/score', async (req, res) => {
  const { score, signature, walletAddress, chain } = req.body;
  if (!score || !signature || !walletAddress || !chain) return res.status(400).json({ error: 'Missing fields' });

  const today = getTodayPT();
  const wallet = walletAddress.toLowerCase();

  // Check player paid today and hasn't submitted a score yet
  const payment = db.prepare(`
    SELECT * FROM payments WHERE walletAddress = ? AND chain = ? AND date = ? AND used = 0
    ORDER BY createdAt DESC LIMIT 1
  `).get(wallet, chain, today);

  if (!payment) return res.status(400).json({ error: 'No valid payment found for today' });

  // Verify signature
  const message = `PACMAN:${score}:${walletAddress}:${today}`;
  try {
    if (chain === 'base') {
      const recovered = ethers.verifyMessage(message, signature);
      if (recovered.toLowerCase() !== wallet) throw new Error('Invalid signature');
    } else if (chain === 'solana') {
      // For Solana: signature verification using nacl
      const { PublicKey } = require('@solana/web3.js');
      const nacl = require('tweetnacl');
      const msgBytes = Buffer.from(message);
      const sigBytes = Buffer.from(signature, 'base64');
      const pubkey = new PublicKey(walletAddress).toBytes();
      if (!nacl.sign.detached.verify(msgBytes, sigBytes, pubkey)) throw new Error('Invalid signature');
    }
  } catch (err) {
    return res.status(400).json({ error: `Signature verification failed: ${err.message}` });
  }

  // Sanity check score (Pac-Man max per level ~3000 pts, top human scores ~3.3M)
  if (score < 0 || score > 3_333_360) return res.status(400).json({ error: 'Invalid score' });

  // Mark payment as used and store score
  db.prepare('UPDATE payments SET used = 1 WHERE id = ?').run(payment.id);
  db.prepare(`
    INSERT INTO scores (walletAddress, chain, score, signature, date)
    VALUES (?, ?, ?, ?, ?)
  `).run(wallet, chain, score, signature, today);

  res.json({ ok: true, score, rank: getRank(score, today) });
});

function getRank(score, date) {
  const scores = db.prepare('SELECT score FROM scores WHERE date = ? ORDER BY score DESC').all(date);
  return scores.findIndex(s => s.score <= score) + 1;
}

// ─── LEADERBOARD ──────────────────────────────────────────────────────────

app.get('/api/leaderboard', (req, res) => {
  const today = getTodayPT();
  const scores = db.prepare(`
    SELECT walletAddress, chain, MAX(score) as score
    FROM scores
    WHERE date = ?
    GROUP BY walletAddress
    ORDER BY score DESC
    LIMIT 10
  `).all(today);

  const paymentCount = db.prepare('SELECT COUNT(*) as count FROM payments WHERE date = ?').get(today).count;
  const pot = (paymentCount * 0.25).toFixed(2);
  const prize = (paymentCount * 0.25 * 0.9).toFixed(2);

  res.json({
    date: today,
    pot,
    prize,
    entries: paymentCount,
    scores: scores.map(s => ({
      wallet: s.walletAddress.slice(0, 6) + '...' + s.walletAddress.slice(-4),
      chain: s.chain,
      score: s.score
    }))
  });
});

app.get('/api/history', (req, res) => {
  const winners = db.prepare('SELECT * FROM winners ORDER BY date DESC LIMIT 30').all();
  res.json(winners.map(w => ({
    date: w.date,
    wallet: w.walletAddress.slice(0, 6) + '...' + w.walletAddress.slice(-4),
    chain: w.chain,
    score: w.score,
    prize: '$' + w.prize
  })));
});

// ─── CRON: midnight PT = 08:00 UTC ────────────────────────────────────────

cron.schedule('0 8 * * *', async () => {
  console.log('[CRON] Midnight PT — running payout');
  await runPayout();
}, { timezone: 'UTC' });

// ─── START ─────────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`Pac-Man crypto server running on port ${PORT}`));
