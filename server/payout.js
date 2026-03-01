require('dotenv').config();
const { ethers } = require('ethers');
const { Connection, Keypair, PublicKey } = require('@solana/web3.js');
const { getOrCreateAssociatedTokenAccount, transfer } = require('@solana/spl-token');
const { get, all, run } = require('./db');

const USDC_ABI = ['function transfer(address to, uint256 amount) returns (bool)'];

function getTodayPT() {
  const now = new Date();
  const pt = new Date(now.toLocaleString('en-US', { timeZone: 'America/Los_Angeles' }));
  return pt.toISOString().split('T')[0];
}

async function runPayout() {
  const today = getTodayPT();
  console.log(`[PAYOUT] Running for ${today}`);

  const existingWinner = get('SELECT * FROM winners WHERE date = ?', [today]);
  if (existingWinner) {
    console.log(`[PAYOUT] Already paid for ${today}`);
    return;
  }

  const winner = get(`SELECT walletAddress, chain, MAX(score) as score FROM scores WHERE date = ? GROUP BY walletAddress ORDER BY score DESC LIMIT 1`, [today]);
  if (!winner) {
    console.log(`[PAYOUT] No scores for ${today}`);
    return;
  }

  const { count } = get('SELECT COUNT(*) as count FROM payments WHERE date = ?', [today]) || { count: 0 };
  const totalPot = count * 0.25;
  const prize = totalPot * 0.9;
  const prizeUSDC = Math.floor(prize * 1_000_000);

  console.log(`[PAYOUT] Winner: ${winner.walletAddress} | Score: ${winner.score} | Prize: $${prize.toFixed(2)}`);

  let payoutTxHash = null;
  try {
    if (winner.chain === 'base') payoutTxHash = await payoutBase(winner.walletAddress, prizeUSDC);
    else if (winner.chain === 'solana') payoutTxHash = await payoutSolana(winner.walletAddress, prizeUSDC);

    run('INSERT INTO winners (walletAddress, chain, score, prize, payoutTxHash, date) VALUES (?, ?, ?, ?, ?, ?)',
      [winner.walletAddress, winner.chain, winner.score, prize.toFixed(2), payoutTxHash, today]);

    console.log(`[PAYOUT] ✅ Sent $${prize.toFixed(2)} to ${winner.walletAddress} | tx: ${payoutTxHash}`);
  } catch (err) {
    console.error('[PAYOUT] ❌ Error:', err.message);
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
  const payer = Keypair.fromSecretKey(Buffer.from(process.env.SOLANA_TREASURY_PRIVATE_KEY, 'base64'));
  const mintPubkey = new PublicKey(process.env.USDC_SOLANA_MINT);
  const toPubkey = new PublicKey(toAddress);
  const fromATA = await getOrCreateAssociatedTokenAccount(connection, payer, mintPubkey, payer.publicKey);
  const toATA = await getOrCreateAssociatedTokenAccount(connection, payer, mintPubkey, toPubkey);
  return await transfer(connection, payer, fromATA.address, toATA.address, payer, amountUSDC);
}

module.exports = { runPayout };
