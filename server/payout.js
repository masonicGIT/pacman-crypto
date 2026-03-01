require('dotenv').config();
const { ethers } = require('ethers');
const { Connection, Keypair, PublicKey } = require('@solana/web3.js');
const { getOrCreateAssociatedTokenAccount, transfer } = require('@solana/spl-token');
const db = require('./db');

const USDC_ABI = [
  'function transfer(address to, uint256 amount) returns (bool)',
  'function balanceOf(address) view returns (uint256)'
];

// Get today's date in PT (UTC-8 standard, UTC-7 daylight)
function getTodayPT() {
  const now = new Date();
  const pt = new Date(now.toLocaleString('en-US', { timeZone: 'America/Los_Angeles' }));
  return pt.toISOString().split('T')[0];
}

async function runPayout() {
  const today = getTodayPT();
  console.log(`[PAYOUT] Running payout for ${today}`);

  // Check if already paid out today
  const existingWinner = db.prepare('SELECT * FROM winners WHERE date = ?').get(today);
  if (existingWinner) {
    console.log(`[PAYOUT] Already paid out for ${today}: ${existingWinner.walletAddress}`);
    return;
  }

  // Get today's highest scorer
  const winner = db.prepare(`
    SELECT walletAddress, chain, MAX(score) as score
    FROM scores
    WHERE date = ?
    GROUP BY walletAddress
    ORDER BY score DESC
    LIMIT 1
  `).get(today);

  if (!winner) {
    console.log(`[PAYOUT] No scores for ${today}, skipping`);
    return;
  }

  // Count today's payments for prize calculation
  const paymentCount = db.prepare(`
    SELECT COUNT(*) as count FROM payments WHERE date = ?
  `).get(today).count;

  const totalPot = paymentCount * 0.25; // $0.25 per play
  const prize = totalPot * 0.9; // 90% to winner
  const prizeUSDC = Math.floor(prize * 1_000_000); // 6 decimals

  console.log(`[PAYOUT] Winner: ${winner.walletAddress} on ${winner.chain}`);
  console.log(`[PAYOUT] Score: ${winner.score} | Pot: $${totalPot.toFixed(2)} | Prize: $${prize.toFixed(2)}`);

  let payoutTxHash = null;

  try {
    if (winner.chain === 'base') {
      payoutTxHash = await payoutBase(winner.walletAddress, prizeUSDC);
    } else if (winner.chain === 'solana') {
      payoutTxHash = await payoutSolana(winner.walletAddress, prizeUSDC);
    }

    db.prepare(`
      INSERT INTO winners (walletAddress, chain, score, prize, payoutTxHash, date)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(winner.walletAddress, winner.chain, winner.score, prize.toFixed(2), payoutTxHash, today);

    console.log(`[PAYOUT] ✅ Sent $${prize.toFixed(2)} USDC to ${winner.walletAddress} | tx: ${payoutTxHash}`);
  } catch (err) {
    console.error('[PAYOUT] ❌ Error sending payout:', err.message);
  }
}

async function payoutBase(toAddress, amountUSDC) {
  const provider = new ethers.JsonRpcProvider(process.env.BASE_RPC_URL);
  const wallet = new ethers.Wallet(process.env.BASE_TREASURY_PRIVATE_KEY, provider);
  const usdc = new ethers.Contract(process.env.USDC_BASE_CONTRACT, USDC_ABI, wallet);
  const tx = await usdc.transfer(toAddress, amountUSDC);
  await tx.wait();
  return tx.hash;
}

async function payoutSolana(toAddress, amountUSDC) {
  const connection = new Connection(process.env.SOLANA_RPC_URL, 'confirmed');
  const payer = Keypair.fromSecretKey(
    Buffer.from(process.env.SOLANA_TREASURY_PRIVATE_KEY, 'base64')
  );
  const mintPubkey = new PublicKey(process.env.USDC_SOLANA_MINT);
  const toPubkey = new PublicKey(toAddress);

  const fromATA = await getOrCreateAssociatedTokenAccount(connection, payer, mintPubkey, payer.publicKey);
  const toATA = await getOrCreateAssociatedTokenAccount(connection, payer, mintPubkey, toPubkey);

  const sig = await transfer(connection, payer, fromATA.address, toATA.address, payer, amountUSDC);
  return sig;
}

module.exports = { runPayout };
