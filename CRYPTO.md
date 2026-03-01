# Pac-Man Daily Jackpot — Crypto Payments

## Overview
- $0.25 USDC per play on Base or Solana
- Daily high scorer wins 90% of the pot at midnight PT
- 10% stays in the treasury
- Score signed with wallet to prevent spoofing

## Setup

### 1. Generate Treasury Wallets
**Base (EVM):**
```bash
node -e "const {ethers}=require('ethers'); const w=ethers.Wallet.createRandom(); console.log('Address:',w.address); console.log('Key:',w.privateKey)"
```

**Solana:**
```bash
solana-keygen new --outfile treasury.json
# Base64 encode the private key for the .env
node -e "const k=require('./treasury.json'); console.log(Buffer.from(k).toString('base64'))"
```

### 2. Configure Server
```bash
cd server
cp .env.example .env
# Fill in all values in .env
npm install
node index.js
```

### 3. Configure Frontend
Edit `crypto/index.html` — update the three config values at the top:
```js
window.PACMAN_API_BASE = 'https://your-api-server.com';
window.PACMAN_BASE_TREASURY = '0xYourBaseTreasuryWallet';
window.PACMAN_SOLANA_TREASURY = 'YourSolanaTreasuryWallet';
```

### 4. Wire Up Score Submission in the Game
The game needs to post a message to the parent window when the game ends:
```js
// Add to pacman.js at game over:
if (window.parent !== window) {
  window.parent.postMessage({ type: 'PACMAN_GAME_OVER', score: this.score }, '*');
}
```

### 5. Deploy
- **Frontend**: Deploy `crypto/` to its own domain (e.g. play.pacman.xyz or cryptopacman.com)
- **Server**: Deploy `server/` to any Node.js host (Railway, Render, Fly.io, VPS)
- The main `index.html` (GitHub Pages) remains completely untouched

## Architecture
```
Player → crypto/index.html → pays 0.25 USDC → treasury wallet
                           → POST /api/verify-payment (backend confirms tx)
                           → game loads in iframe
                           → game over → wallet signs score
                           → POST /api/score
                           → midnight PT cron → sends 90% to winner
```

## Future: Per-Region Pots
The `chain` field in the DB supports this already. To add regions:
- Add a `region` field to payments + scores tables
- Add geo-detection to the frontend (Cloudflare CF-IPCountry header)
- Filter leaderboard and payout by region

## Treasury Management
- 10% of every pot stays in the treasury wallets
- Monitor balances and sweep periodically
- Keep enough ETH/SOL for gas
