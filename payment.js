// Pac-Man Crypto Payment Module
// Handles wallet connection, payment, score signing, and leaderboard

const API_BASE = window.PACMAN_API_BASE || 'http://localhost:3001';
const USDC_BASE_CONTRACT = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const USDC_SOLANA_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const TREASURY_BASE = window.PACMAN_BASE_TREASURY || '';
const TREASURY_SOLANA = window.PACMAN_SOLANA_TREASURY || '';
const PLAY_COST_USDC = 250000n; // $0.25 in 6 decimals

const USDC_ABI = [
  'function transfer(address to, uint256 amount) returns (bool)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function approve(address spender, uint256 amount) returns (bool)',
  'function balanceOf(address) view returns (uint256)'
];

let selectedChain = null;
let connectedWallet = null;
let provider = null;
let signer = null;

// ─── CHAIN SELECTION ────────────────────────────────────────────────────────

async function selectChain(chain) {
  selectedChain = chain;
  document.getElementById('chain-select').style.display = 'none';
  if (selectedChain === 'base') {
    await connectEVM();
  } else {
    await connectSolana();
  }
}

// ─── WALLET CONNECTION ───────────────────────────────────────────────────────

async function connectWallet() {
  if (selectedChain === 'base') {
    await connectEVM();
  } else {
    await connectSolana();
  }
}

async function connectEVM() {
  if (!window.ethereum) {
    alert('Please install MetaMask or a Base-compatible wallet');
    return;
  }
  provider = new ethers.BrowserProvider(window.ethereum);
  const accounts = await provider.send('eth_requestAccounts', []);
  signer = await provider.getSigner();
  connectedWallet = accounts[0];

  // Switch to Base mainnet
  try {
    await window.ethereum.request({
      method: 'wallet_switchEthereumChain',
      params: [{ chainId: '0x2105' }] // Base mainnet
    });
  } catch (e) {
    if (e.code === 4902) {
      await window.ethereum.request({
        method: 'wallet_addEthereumChain',
        params: [{
          chainId: '0x2105',
          chainName: 'Base',
          nativeCurrency: { name: 'ETH', symbol: 'ETH', decimals: 18 },
          rpcUrls: ['https://mainnet.base.org'],
          blockExplorerUrls: ['https://basescan.org']
        }]
      });
    }
  }

  showPaymentScreen();
}

async function connectSolana() {
  if (!window.solana?.isPhantom) {
    alert('Please install Phantom wallet');
    return;
  }
  const resp = await window.solana.connect();
  connectedWallet = resp.publicKey.toString();
  showPaymentScreen();
}

// ─── PAYMENT ─────────────────────────────────────────────────────────────────

function showPaymentScreen() {
  document.getElementById('chain-select').style.display = 'none';
  document.getElementById('payment-screen').style.display = 'block';
  document.getElementById('wallet-address').textContent =
    connectedWallet.slice(0, 6) + '...' + connectedWallet.slice(-4);
}

async function pay() {
  const btn = document.getElementById('pay-btn');
  btn.disabled = true;
  btn.textContent = 'Processing...';

  try {
    let txHash;
    if (selectedChain === 'base') {
      txHash = await payBase();
    } else {
      txHash = await paySolana();
    }

    btn.textContent = 'Verifying...';
    const result = await fetch(`${API_BASE}/api/verify-payment`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ txHash, walletAddress: connectedWallet, chain: selectedChain })
    }).then(r => r.json());

    if (!result.ok) throw new Error(result.error);

    // Launch game
    launchGame();
  } catch (err) {
    alert('Payment failed: ' + err.message);
    btn.disabled = false;
    btn.textContent = 'Pay $0.25 USDC to Play';
  }
}

async function payBase() {
  const usdc = new ethers.Contract(USDC_BASE_CONTRACT, USDC_ABI, signer);
  const tx = await usdc.transfer(TREASURY_BASE, PLAY_COST_USDC);
  await tx.wait();
  return tx.hash;
}

async function paySolana() {
  const { Connection, PublicKey, Transaction } = solanaWeb3;
  const { getAssociatedTokenAddress, createTransferCheckedInstruction } = splToken;

  const connection = new Connection('https://api.mainnet-beta.solana.com', 'confirmed');
  const fromPubkey = new PublicKey(connectedWallet);
  const toPubkey = new PublicKey(TREASURY_SOLANA);
  const mintPubkey = new PublicKey(USDC_SOLANA_MINT);

  const fromATA = await getAssociatedTokenAddress(mintPubkey, fromPubkey);
  const toATA = await getAssociatedTokenAddress(mintPubkey, toPubkey);

  const tx = new Transaction().add(
    createTransferCheckedInstruction(fromATA, mintPubkey, toATA, fromPubkey, 250000n, 6)
  );
  const { blockhash } = await connection.getLatestBlockhash();
  tx.recentBlockhash = blockhash;
  tx.feePayer = fromPubkey;

  const signed = await window.solana.signTransaction(tx);
  const sig = await connection.sendRawTransaction(signed.serialize());
  await connection.confirmTransaction(sig, 'confirmed');
  return sig;
}

// ─── SCORE SUBMISSION ─────────────────────────────────────────────────────────

async function submitScore(score) {
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });
  const message = `PACMAN:${score}:${connectedWallet}:${today}`;

  let signature;
  if (selectedChain === 'base') {
    signature = await signer.signMessage(message);
  } else {
    const encoded = new TextEncoder().encode(message);
    const signed = await window.solana.signMessage(encoded, 'utf8');
    signature = btoa(String.fromCharCode(...signed.signature));
  }

  const result = await fetch(`${API_BASE}/api/score`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ score, signature, walletAddress: connectedWallet, chain: selectedChain })
  }).then(r => r.json());

  return result;
}

// ─── LEADERBOARD ─────────────────────────────────────────────────────────────

async function loadLeaderboard() {
  try {
    const data = await fetch(`${API_BASE}/api/leaderboard`).then(r => r.json());
    const lb = document.getElementById('leaderboard-list');
    if (!lb) return;

    document.getElementById('pot-amount').textContent = '$' + data.prize;
    document.getElementById('entry-count').textContent = data.entries;

    lb.innerHTML = data.scores.length === 0
      ? '<li style="color:#888">No scores yet today</li>'
      : data.scores.map((s, i) =>
          `<li><span class="lb-rank">#${i + 1}</span> <span class="lb-wallet">${s.wallet}</span> <span class="lb-score">${s.score.toLocaleString()}</span> <span class="lb-chain">${s.chain}</span></li>`
        ).join('');
  } catch (e) {
    console.log('Leaderboard load failed:', e.message);
  }
}

// ─── GAME LAUNCH ─────────────────────────────────────────────────────────────

function launchGame() {
  document.getElementById('payment-screen').style.display = 'none';
  document.getElementById('game-container').style.display = 'block';
  loadLeaderboard();
  setInterval(loadLeaderboard, 30000); // refresh every 30s

  // Load Pac-Man in iframe
  const iframe = document.getElementById('pacman-frame');
  iframe.src = '../index.html';

  // Listen for score from game iframe
  window.addEventListener('message', async (e) => {
    if (e.data?.type === 'PACMAN_GAME_OVER') {
      const score = e.data.score;
      const result = await submitScore(score);
      if (result.rank) {
        document.getElementById('score-display').textContent =
          `Score: ${score.toLocaleString()} — Rank #${result.rank} today`;
      }
      loadLeaderboard();
    }
  });
}

// Export for use in HTML
window.PacmanCrypto = {
  selectChain, connectWallet, pay, loadLeaderboard
};
