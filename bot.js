// ═══════════════════════════════════════════════
//  MOMENTUM SNIPER v4.0
//  Complete rebuild — new data sources,
//  TX acceleration detection, $50 positions,
//  $8 max loss per trade, no boosted coins
// ═══════════════════════════════════════════════

import fetch from "node-fetch";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ─── CONFIG ───────────────────────────────────
const C = {
  TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN || "",
  TELEGRAM_CHAT_IDS:  (process.env.TELEGRAM_CHAT_IDS || process.env.TELEGRAM_CHAT_ID || "")
                        .split(",").map(s => s.trim()).filter(Boolean),
  PAPER_MODE:         process.env.PAPER_MODE !== "false",

  // ── CAPITAL — conservative sizing ────────────
  POSITION_SIZE_USD:  parseFloat(process.env.POSITION_SIZE_USD || "50"),  // $50 max per trade
  STARTING_BALANCE:   parseFloat(process.env.STARTING_BALANCE  || "500"),
  MAX_POSITIONS:      parseInt(process.env.MAX_POSITIONS        || "3"),

  // ── SPEED ────────────────────────────────────
  SCAN_INTERVAL_MS:   parseInt(process.env.SCAN_INTERVAL_MS    || "30000"), // 30s

  // ── ENTRY GATES — all must pass ──────────────
  MIN_LIQ:            30000,   // $30K minimum liquidity
  MAX_LIQ:            500000,  // $500K max — avoid whales who dump on us
  MIN_VOL_LIQ_RATIO:  2,       // vol must be > 2× liquidity (real activity)
  MAX_VOL_LIQ_RATIO:  8,       // < 8× — above this = wash trading
  MIN_BUY_PCT:        0.58,    // 58% buys minimum
  MIN_5M_CHANGE:      2,       // 5m price must be up > 2%
  MIN_1H_CHANGE:      5,       // 1h must be up > 5%
  MAX_1H_CHANGE:      200,     // < 200% — not already topped
  MAX_24H_CHANGE:     400,     // < 400% — very likely topped
  MIN_MCAP:           50000,   // $50K min mcap
  MAX_MCAP:           3000000, // $3M max — room to grow
  MAX_AGE_H:          6,       // pairs under 6h only for scalp entries
  MIN_TX_BUYS_5M:     5,       // at least 5 buy transactions in last 5 min

  // ── TX ACCELERATION (new in v4) ──────────────
  // Coin must show MORE buys this scan vs last scan
  TX_ACCEL_REQUIRED:  true,

  // ── EXIT — strict loss control ────────────────
  HARD_STOP_PCT:      16,      // 16% = $8 loss on $50 position
  TRAIL_PCT_EARLY:    10,      // tight 10% trail while small gain
  TRAIL_PCT_2X:       15,      // loosen at 2×
  TRAIL_PCT_3X:       10,      // tighten again at 3×+
  MAX_HOLD_MS:        4 * 60000,  // 4 min max scalp hold
  FLAT_TIMEOUT_MS:    60000,   // 60s flat = exit
  FLAT_THRESHOLD_PCT: 1.5,     // flat = within ±1.5%

  // Dynamic targets by momentum tier
  // EXPLOSIVE: trail only | STRONG: 20% | MEDIUM: 10% | WEAK: 5%
  TARGET_STRONG:      20,
  TARGET_MEDIUM:      10,
  TARGET_WEAK:        5,

  // ── HOLD FILTER (potential coins) ────────────
  MAX_HOLD_POSITIONS: 1,        // max 1 hold at a time
  HOLD_MIN_LIQ:       80000,
  HOLD_MIN_BUY_PCT:   0.65,
  HOLD_MIN_VOL_X:     5,        // vol5m must be 5× hourly avg
  HOLD_TRAIL_PCT:     20,
  HOLD_STOP_PCT:      15,
  HOLD_MAX_MS:        3 * 3600000, // 3h max hold

  // ── RISK MANAGEMENT ──────────────────────────
  MAX_LOSS_PER_HOUR:  50,       // stop trading if -$50 in any 1h window
  DAILY_LOSS_LIMIT:   150,      // stop for 24h if -$150 total
  LOSS_COOLDOWN_MS:   10 * 60000, // 10 min cooldown per symbol after loss
  CONSEC_LOSS_PAUSE:  3,        // pause 20 min after 3 consecutive losses
  CONSEC_LOSS_PAUSE_MS: 20 * 60000,

  STATE_FILE: path.join(__dirname, "state.json"),
};

// ─── STATE ────────────────────────────────────
let STATE = {
  balance:          C.STARTING_BALANCE,
  scalpPositions:   [],
  holdPositions:    [],
  txHistory:        {},   // sym → { lastBuys5m, lastSells5m, scanTime }
  watchlist:        {},   // sym → { scans, firstSeen, scores[] }
  cooldowns:        {},   // sym → expiry timestamp
  tradeLog:         [],
  scanCount:        0,
  totalPnl:         0,
  wins: 0, losses: 0,
  consecLosses:     0,
  pausedUntil:      0,
  hourlyLossTracker: [], // [{ time, pnl }]
  startedAt:        Date.now(),
  peakBalance:      C.STARTING_BALANCE,
};

function loadState() {
  try {
    if (fs.existsSync(C.STATE_FILE)) {
      const saved = JSON.parse(fs.readFileSync(C.STATE_FILE, "utf8"));
      STATE = { ...STATE, ...saved };
      ["txHistory","watchlist","cooldowns"].forEach(k => { if (!STATE[k]) STATE[k] = {}; });
      ["scalpPositions","holdPositions","tradeLog","hourlyLossTracker"].forEach(k => { if (!Array.isArray(STATE[k])) STATE[k] = []; });
      log("✅ State loaded");
    }
  } catch(e) { log("⚠️ State load failed: " + e.message); }
}

function saveState() {
  try { fs.writeFileSync(C.STATE_FILE, JSON.stringify(STATE, null, 2)); }
  catch(e) { log("⚠️ Save failed: " + e.message); }
}

function log(msg) { console.log(`[${new Date().toISOString()}] ${msg}`); }

function fmtP(n) {
  if (!n) return "$0";
  if (n >= 1) return `$${n.toFixed(4)}`;
  if (n >= 0.0001) return `$${n.toFixed(6)}`;
  return `$${n.toExponential(3)}`;
}

// ─── TELEGRAM ─────────────────────────────────
async function tg(msg) {
  if (!C.TELEGRAM_BOT_TOKEN || !C.TELEGRAM_CHAT_IDS.length) {
    log("📵 TG: " + msg.slice(0, 80)); return;
  }
  for (const id of C.TELEGRAM_CHAT_IDS) {
    try {
      await fetch(`https://api.telegram.org/bot${C.TELEGRAM_BOT_TOKEN}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: id, text: msg, parse_mode: "HTML" }),
      });
    } catch(e) { log("⚠️ TG: " + e.message); }
  }
}

// ═══════════════════════════════════════════════
//  RISK CIRCUIT BREAKERS
// ═══════════════════════════════════════════════
function isTradingPaused() {
  const now = Date.now();

  // Consecutive loss pause
  if (STATE.pausedUntil > now) {
    const remaining = Math.round((STATE.pausedUntil - now) / 60000);
    log(`⛔ Trading paused — ${remaining}min remaining`);
    return true;
  }

  // Daily loss limit
  if (STATE.totalPnl <= -C.DAILY_LOSS_LIMIT) {
    log(`⛔ Daily loss limit hit (-$${Math.abs(STATE.totalPnl).toFixed(2)})`);
    return true;
  }

  // Hourly loss limit — clean old entries first
  STATE.hourlyLossTracker = STATE.hourlyLossTracker.filter(e => now - e.time < 3600000);
  const hourlyLoss = STATE.hourlyLossTracker.filter(e => e.pnl < 0).reduce((s, e) => s + e.pnl, 0);
  if (hourlyLoss <= -C.MAX_LOSS_PER_HOUR) {
    log(`⛔ Hourly loss limit hit (-$${Math.abs(hourlyLoss).toFixed(2)})`);
    return true;
  }

  return false;
}

function recordTrade(pnl) {
  STATE.hourlyLossTracker.push({ time: Date.now(), pnl });

  if (pnl < 0) {
    STATE.consecLosses++;
    if (STATE.consecLosses >= C.CONSEC_LOSS_PAUSE) {
      STATE.pausedUntil = Date.now() + C.CONSEC_LOSS_PAUSE_MS;
      log(`⚠️ ${C.CONSEC_LOSS_PAUSE} consecutive losses — pausing ${C.CONSEC_LOSS_PAUSE_MS/60000}min`);
      tg(`⚠️ <b>3 CONSECUTIVE LOSSES</b>\nBot paused for 20 minutes to prevent further drawdown.\nResumes at ${new Date(STATE.pausedUntil).toLocaleTimeString()}`);
      STATE.consecLosses = 0;
    }
  } else {
    STATE.consecLosses = 0; // reset on any win
  }
}

function inCooldown(sym) {
  const exp = STATE.cooldowns[sym];
  if (!exp) return false;
  if (Date.now() > exp) { delete STATE.cooldowns[sym]; return false; }
  return true;
}

function setCooldown(sym) {
  STATE.cooldowns[sym] = Date.now() + C.LOSS_COOLDOWN_MS;
  log(`⏳ Cooldown set for ${sym} — ${C.LOSS_COOLDOWN_MS/60000}min`);
}

// ═══════════════════════════════════════════════
//  TX ACCELERATION DETECTOR (new in v4)
//  Detects if buys are INCREASING scan over scan
// ═══════════════════════════════════════════════
function checkTxAcceleration(coin) {
  const sym    = coin.baseToken?.symbol;
  const buys5m = coin.txns?.m5?.buys  || 0;
  const now    = Date.now();
  const prev   = STATE.txHistory[sym];

  // Update history
  STATE.txHistory[sym] = { buys5m, time: now };

  if (!prev) return false; // no history yet

  // Stale data (> 2 min old) — not useful
  if (now - prev.time > 2 * 60000) return false;

  // Acceleration = more buys now than last scan
  return buys5m >= prev.buys5m && buys5m >= C.MIN_TX_BUYS_5M;
}

// ═══════════════════════════════════════════════
//  MOMENTUM ANALYZER v4
// ═══════════════════════════════════════════════
function analyze(coin) {
  const liq    = coin.liquidity?.usd  || 0;
  const vol5m  = coin.volume?.m5      || 0;
  const vol1h  = coin.volume?.h1      || 0;
  const ch5m   = coin.priceChange?.m5 || 0;
  const ch1h   = coin.priceChange?.h1 || 0;
  const ch24h  = coin.priceChange?.h24|| 0;
  const mc     = coin.marketCap       || 0;
  const buys5m = coin.txns?.m5?.buys  || 0;
  const sels5m = coin.txns?.m5?.sells || 0;
  const buys1h = coin.txns?.h1?.buys  || 0;
  const sels1h = coin.txns?.h1?.sells || 0;
  const txTotal5m = buys5m + sels5m;
  const txTotal1h = buys1h + sels1h;
  const buyPct5m  = txTotal5m > 0 ? buys5m / txTotal5m : 0.5;
  const buyPct1h  = txTotal1h > 0 ? buys1h / txTotal1h : 0.5;
  const buyPct    = txTotal5m > 5 ? buyPct5m : buyPct1h; // prefer 5m if enough data
  const ageMs     = coin.pairCreatedAt ? Date.now() - coin.pairCreatedAt : Infinity;
  const ageH      = ageMs / 3600000;
  const volLiqRatio = liq > 0 ? vol5m / liq : 0;
  const avg1mVol    = vol1h / 60;
  const volExplosion= avg1mVol > 0 ? (vol5m / 5) / avg1mVol : 0;

  // ── HARD GATES — any fail = blocked ──────────
  const gates = [
    { name: "Liq range",       pass: liq >= C.MIN_LIQ && liq <= C.MAX_LIQ },
    { name: "Vol/Liq ratio",   pass: volLiqRatio >= C.MIN_VOL_LIQ_RATIO && volLiqRatio <= C.MAX_VOL_LIQ_RATIO },
    { name: "Buy pressure",    pass: buyPct >= C.MIN_BUY_PCT },
    { name: "5m pumping",      pass: ch5m >= C.MIN_5M_CHANGE },
    { name: "1h trend",        pass: ch1h >= C.MIN_1H_CHANGE && ch1h <= C.MAX_1H_CHANGE },
    { name: "24h not topped",  pass: ch24h <= C.MAX_24H_CHANGE },
    { name: "MCap range",      pass: mc >= C.MIN_MCAP && mc <= C.MAX_MCAP },
    { name: "Pair age",        pass: ageH <= C.MAX_AGE_H },
    { name: "Min TX 5m",       pass: buys5m >= C.MIN_TX_BUYS_5M },
  ];

  const blocked = gates.some(g => !g.pass);

  // ── MOMENTUM SCORE ────────────────────────────
  let score = 0;

  // 5m price action — core signal
  if (ch5m >= 15)      score += 30;
  else if (ch5m >= 8)  score += 22;
  else if (ch5m >= 4)  score += 14;
  else if (ch5m >= 2)  score += 8;

  // Buy pressure strength
  if (buyPct >= 0.80)       score += 25;
  else if (buyPct >= 0.70)  score += 18;
  else if (buyPct >= 0.60)  score += 11;

  // Volume explosion vs hourly average
  if (volExplosion >= 8)    score += 20;
  else if (volExplosion >= 4) score += 14;
  else if (volExplosion >= 2) score += 7;

  // 1h confirmation
  if (ch1h >= 50)       score += 12;
  else if (ch1h >= 20)  score += 8;
  else if (ch1h >= 10)  score += 4;

  // Freshness
  if (ageH < 1)    score += 8;
  else if (ageH < 2) score += 5;
  else if (ageH < 4) score += 2;

  // Liquidity health bonus
  if (liq >= 100000 && liq <= 300000) score += 5;

  score = Math.max(0, Math.min(100, score));

  const tier = score >= 85 ? "EXPLOSIVE"
    : score >= 70 ? "STRONG"
    : score >= 55 ? "MEDIUM"
    : score >= 40 ? "WEAK"
    : "SKIP";

  const profitTarget = tier === "EXPLOSIVE" ? null
    : tier === "STRONG"  ? C.TARGET_STRONG
    : tier === "MEDIUM"  ? C.TARGET_MEDIUM
    : C.TARGET_WEAK;

  return {
    score, tier, blocked, profitTarget, gates,
    m: {
      liq, vol5m, vol1h, ch5m, ch1h, ch24h, mc, ageH: parseFloat(ageH.toFixed(2)),
      buyPct: parseFloat(buyPct.toFixed(3)),
      buyPct100: Math.round(buyPct * 100),
      buys5m, volExplosion: parseFloat(volExplosion.toFixed(1)),
      volLiqRatio: parseFloat(volLiqRatio.toFixed(1)),
    },
  };
}

// ─── IS POTENTIAL HOLD? ───────────────────────
function isPotentialHold(coin, m, score) {
  return (
    score >= 75 &&
    m.liq >= C.HOLD_MIN_LIQ &&
    m.buyPct >= C.HOLD_MIN_BUY_PCT &&
    m.volExplosion >= C.HOLD_MIN_VOL_X &&
    m.ch1h >= 20
  );
}

// ═══════════════════════════════════════════════
//  DATA FETCH v4 — better sources
// ═══════════════════════════════════════════════
async function fetchCoins() {
  const all = [];

  // Source 1: New pairs (organic, not paid)
  try {
    const r = await fetch("https://api.dexscreener.com/token-profiles/latest/v1",
      { headers: { accept: "application/json" } });
    const profiles = await r.json();
    if (Array.isArray(profiles)) {
      const addrs = profiles.filter(p => p.chainId === "solana").slice(0, 25).map(p => p.tokenAddress);
      if (addrs.length) {
        const r2 = await fetch(`https://api.dexscreener.com/tokens/v1/solana/${addrs.join(",")}`,
          { headers: { accept: "application/json" } });
        const pairs = await r2.json();
        if (Array.isArray(pairs)) all.push(...pairs);
      }
    }
  } catch(e) { log("⚠️ Source1: " + e.message); }

  // Source 2: Search trending Solana pairs by volume
  try {
    const r = await fetch("https://api.dexscreener.com/latest/dex/search?q=solana",
      { headers: { accept: "application/json" } });
    const data = await r.json();
    if (data?.pairs) all.push(...data.pairs.filter(p => p.chainId === "solana").slice(0, 20));
  } catch(e) { log("⚠️ Source2: " + e.message); }

  // Deduplicate by address
  const seen = {};
  for (const p of all) {
    const a = p.baseToken?.address;
    if (!a || !p.baseToken?.symbol) continue;
    if (!seen[a] || (p.liquidity?.usd || 0) > (seen[a].liquidity?.usd || 0)) seen[a] = p;
  }
  return Object.values(seen);
}

// ═══════════════════════════════════════════════
//  EXIT MANAGER v4
// ═══════════════════════════════════════════════
async function doExit(posArr, idx, coin, reason, posType) {
  const pos   = posArr[idx];
  const price = coin ? parseFloat(coin.priceUsd) : pos.entryPrice * 0.3;
  const pct   = ((price - pos.entryPrice) / pos.entryPrice) * 100;
  const mult  = price / pos.entryPrice;
  const held  = Date.now() - pos.entryTime;
  const size  = pos.remainingSize || pos.size;
  const pnl   = (size * mult) - size;

  STATE.balance  += size * mult;
  STATE.totalPnl += pnl;
  STATE.peakBalance = Math.max(STATE.peakBalance, STATE.balance);

  if (pnl >= 0) STATE.wins++; else { STATE.losses++; setCooldown(pos.symbol); }
  recordTrade(pnl);

  STATE.tradeLog.unshift({
    type: "EXIT", mode: posType, symbol: pos.symbol,
    entryPrice: pos.entryPrice, exitPrice: price,
    size, pnl: parseFloat(pnl.toFixed(2)),
    pnlPct: parseFloat(pct.toFixed(1)),
    mult: parseFloat(mult.toFixed(2)),
    reason, holdSec: Math.round(held / 1000),
    time: Date.now(), score: pos.entryScore, tier: pos.tier,
  });
  if (STATE.tradeLog.length > 300) STATE.tradeLog.length = 300;

  const wr    = STATE.wins + STATE.losses > 0 ? Math.round(STATE.wins / (STATE.wins + STATE.losses) * 100) : 0;
  const emoji = pnl >= 0 ? "🟢" : "🔴";

  await tg(
`${emoji} <b>${posType.toUpperCase()} EXIT — ${pos.symbol}</b> ${C.PAPER_MODE ? "📝" : "💰"}

💵 P&amp;L: ${pnl >= 0 ? "+" : ""}$${pnl.toFixed(2)} (${pct >= 0 ? "+" : ""}${pct.toFixed(1)}%)
📈 ${mult.toFixed(2)}× | ⏱ ${Math.round(held/1000)}s
📌 ${reason}

💰 Bal: $${STATE.balance.toFixed(2)} | WR: ${wr}% | P&amp;L: ${STATE.totalPnl >= 0 ? "+" : ""}$${STATE.totalPnl.toFixed(2)}`
  );

  log(`${posType.toUpperCase()} EXIT ${pos.symbol} | ${pct >= 0 ? "+" : ""}${pct.toFixed(1)}% ($${pnl.toFixed(2)}) | ${mult.toFixed(2)}× | ${Math.round(held/1000)}s | ${reason}`);
  posArr.splice(idx, 1);
}

async function checkExits(coins) {
  const now = Date.now();

  // ── SCALP EXITS ───────────────────────────────
  for (let i = STATE.scalpPositions.length - 1; i >= 0; i--) {
    const pos   = STATE.scalpPositions[i];
    const coin  = coins.find(c => c.baseToken?.address === pos.address || c.baseToken?.symbol === pos.symbol);
    const price = coin ? parseFloat(coin.priceUsd) : pos.entryPrice * 0.3;
    const pct   = ((price - pos.entryPrice) / pos.entryPrice) * 100;
    const mult  = price / pos.entryPrice;
    const held  = now - pos.entryTime;
    const peak  = Math.max(pos.peak || pos.entryPrice, price);

    STATE.scalpPositions[i].peak = peak;
    STATE.scalpPositions[i].pct  = parseFloat(pct.toFixed(2));

    // Adaptive trail
    const trailPct = mult >= 3 ? C.TRAIL_PCT_3X
      : mult >= 2 ? C.TRAIL_PCT_2X
      : C.TRAIL_PCT_EARLY;
    const trailStop = peak * (1 - trailPct / 100);

    // Flat detector
    if (!pos.flatBase || Math.abs((price - pos.flatBase) / pos.flatBase * 100) > C.FLAT_THRESHOLD_PCT) {
      STATE.scalpPositions[i].flatBase  = price;
      STATE.scalpPositions[i].flatSince = now;
    }
    const flatMs = now - (STATE.scalpPositions[i].flatSince || now);

    let reason = null;

    if (!coin)
      reason = "🚨 Vanished from feed";
    else if (pct <= -C.HARD_STOP_PCT)
      reason = `🛑 Hard stop ${pct.toFixed(1)}% (-$${Math.abs((pos.size * pct/100)).toFixed(2)})`;
    else if (held >= C.MAX_HOLD_MS)
      reason = `⏱ ${Math.round(held/60000)}min max hold at ${pct.toFixed(1)}%`;
    else if (flatMs >= C.FLAT_TIMEOUT_MS && Math.abs(pct) < C.FLAT_THRESHOLD_PCT * 2)
      reason = `⏸ Flat ${Math.round(flatMs/1000)}s — no momentum`;
    else if (price <= trailStop && pct > 0)
      reason = `📉 Trail stop ${trailPct}% from ${(peak/pos.entryPrice).toFixed(2)}× peak`;
    else if (pos.profitTarget && pct >= pos.profitTarget)
      reason = `🎯 ${pos.profitTarget}% target hit`;
    // Re-check momentum — if buy pressure collapsed, exit
    else if (coin) {
      const a = analyze(coin);
      if (a.m.buyPct < 0.40 && held > 60000)
        reason = `📉 Buy pressure collapsed (${a.m.buyPct100}%)`;
      else if (a.m.ch5m < -5 && held > 30000 && pct < 5)
        reason = `⚡ 5m dumping (${a.m.ch5m.toFixed(1)}%) before target`;
    }

    if (reason) {
      // Check potential hold candidate before full exit
      if (coin && pct > 5 && STATE.holdPositions.length < C.MAX_HOLD_POSITIONS) {
        const a = analyze(coin);
        if (isPotentialHold(coin, a.m, a.score)) {
          const holdSize = Math.min((pos.remainingSize || pos.size) * 0.25, 25); // max $25 in hold
          STATE.balance -= holdSize;
          STATE.holdPositions.push({
            symbol: pos.symbol, name: pos.name, address: pos.address,
            entryPrice: price, peak: price, size: holdSize, remainingSize: holdSize,
            entryTime: now, entryScore: a.score, tier: a.tier, fromScalp: true,
          });
          await tg(`🔄 <b>${pos.symbol}</b> scalp closed +${pct.toFixed(1)}%\n📦 Keeping $${holdSize} as potential HOLD (score ${a.score})`);
          log(`HOLD KEPT: ${pos.symbol} $${holdSize} after scalp win`);
        }
      }
      await doExit(STATE.scalpPositions, i, coin, reason, "scalp");
    }
  }

  // ── HOLD EXITS ────────────────────────────────
  for (let i = STATE.holdPositions.length - 1; i >= 0; i--) {
    const pos   = STATE.holdPositions[i];
    const coin  = coins.find(c => c.baseToken?.address === pos.address || c.baseToken?.symbol === pos.symbol);
    const price = coin ? parseFloat(coin.priceUsd) : pos.entryPrice * 0.3;
    const pct   = ((price - pos.entryPrice) / pos.entryPrice) * 100;
    const mult  = price / pos.entryPrice;
    const held  = now - pos.entryTime;
    const peak  = Math.max(pos.peak || pos.entryPrice, price);
    const trail = peak * (1 - C.HOLD_TRAIL_PCT / 100);

    STATE.holdPositions[i].peak = peak;
    STATE.holdPositions[i].pct  = parseFloat(pct.toFixed(2));

    let reason = null;

    if (!coin)                              reason = "🚨 Vanished";
    else if (pct <= -C.HOLD_STOP_PCT)      reason = `🛑 Stop ${pct.toFixed(1)}%`;
    else if (held >= C.HOLD_MAX_MS)        reason = `⏱ 3h max hold at ${pct.toFixed(1)}%`;
    else if (price <= trail && mult > 1.15) reason = `📉 Hold trail (${C.HOLD_TRAIL_PCT}% from ${(peak/pos.entryPrice).toFixed(2)}×)`;
    else if (coin) {
      const a = analyze(coin);
      if (a.m.buyPct < 0.38 && held > 5 * 60000) reason = `📉 Buy pressure died (${a.m.buyPct100}%)`;
    }

    if (reason) await doExit(STATE.holdPositions, i, coin, reason, "hold");
  }
}

// ═══════════════════════════════════════════════
//  ENTRY MANAGER v4
// ═══════════════════════════════════════════════
async function checkEntries(coins) {
  if (isTradingPaused()) return;
  if (STATE.balance < C.POSITION_SIZE_USD) {
    log("⚠️ Insufficient balance");
    return;
  }

  // Score and rank all candidates
  const candidates = coins
    .map(c => ({ coin: c, a: analyze(c) }))
    .filter(({ a }) => !a.blocked && a.tier !== "SKIP")
    .sort((x, y) => y.a.score - x.a.score);

  log(`   ${candidates.length} candidates passed gates`);

  for (const { coin, a } of candidates) {
    if (STATE.scalpPositions.length >= C.MAX_POSITIONS) break;
    if (STATE.balance < C.POSITION_SIZE_USD) break;

    const sym  = coin.baseToken?.symbol;
    const addr = coin.baseToken?.address;
    if (!sym || !addr) continue;

    const allPos = [...STATE.scalpPositions, ...STATE.holdPositions];
    if (allPos.some(p => p.address === addr || p.symbol === sym)) continue;
    if (inCooldown(sym)) { log(`⏳ Cooldown: ${sym}`); continue; }

    // ── TX ACCELERATION CHECK (v4 key feature) ──
    const accel = checkTxAcceleration(coin);
    if (C.TX_ACCEL_REQUIRED && !accel) {
      log(`📊 ${sym}: no TX acceleration yet (${a.m.buys5m} buys 5m)`);
      continue;
    }

    // ── WATCHLIST CONFIRMATION ────────────────
    // EXPLOSIVE: enter after 1 scan confirmation
    // STRONG: 2 scans | MEDIUM/WEAK: 3 scans
    const needed = a.tier === "EXPLOSIVE" ? 1 : a.tier === "STRONG" ? 2 : 3;

    if (!STATE.watchlist[sym]) {
      STATE.watchlist[sym] = { count: 1, firstSeen: Date.now(), scores: [a.score] };
      log(`👁 Watching ${sym} — ${a.tier} ${a.score} (${needed} confirm needed)`);
      continue;
    }

    STATE.watchlist[sym].count++;
    STATE.watchlist[sym].scores.push(a.score);

    // Score must be CONSISTENT — not just a one-time spike
    const avgScore = STATE.watchlist[sym].scores.reduce((s, v) => s + v, 0) / STATE.watchlist[sym].scores.length;
    if (STATE.watchlist[sym].count < needed) {
      log(`👁 ${sym} ${STATE.watchlist[sym].count}/${needed} (avg score ${avgScore.toFixed(0)})`);
      continue;
    }

    // Score degrading between scans? Skip
    const scores = STATE.watchlist[sym].scores;
    if (scores.length >= 2 && scores[scores.length - 1] < scores[scores.length - 2] - 15) {
      log(`📉 ${sym} score degrading (${scores[scores.length-2]} → ${scores[scores.length-1]}) — skip`);
      delete STATE.watchlist[sym];
      continue;
    }

    // ── ALL CHECKS PASSED — ENTER ─────────────
    const price = parseFloat(coin.priceUsd);
    if (!price || isNaN(price)) continue;

    delete STATE.watchlist[sym];

    const size = C.POSITION_SIZE_USD;
    STATE.balance -= size;

    STATE.scalpPositions.push({
      symbol: sym, name: coin.baseToken?.name || sym, address: addr,
      entryPrice: price, peak: price, pct: 0,
      size, remainingSize: size,
      entryTime: Date.now(), entryScore: a.score, tier: a.tier,
      profitTarget: a.profitTarget,
      flatBase: price, flatSince: Date.now(),
    });

    STATE.tradeLog.unshift({
      type: "ENTRY", mode: "scalp", symbol: sym,
      entryPrice: price, size,
      time: Date.now(), score: a.score, tier: a.tier,
      profitTarget: a.profitTarget, metrics: a.m,
    });

    const m = a.m;
    const stopUSD = (size * C.HARD_STOP_PCT / 100).toFixed(2);
    const targetStr = a.profitTarget ? `+${a.profitTarget}%` : "trail only";

    await tg(
`⚡ <b>SCALP ENTRY — ${sym}</b> ${C.PAPER_MODE ? "📝" : "💰"}

🎯 ${a.tier} | Score: ${a.score}/100
💲 ${fmtP(price)} | 💵 $${size}
🎯 Target: ${targetStr} | 🛑 Stop: -${C.HARD_STOP_PCT}% (-$${stopUSD})

📊 Live Momentum:
  5m: ${m.ch5m >= 0 ? "+" : ""}${m.ch5m.toFixed(1)}%  1h: ${m.ch1h >= 0 ? "+" : ""}${m.ch1h.toFixed(1)}%
  Buys: ${m.buyPct100}%  Vol×: ${m.volExplosion}×
  TX 5m: ${m.buys5m} buys  Age: ${m.ageH.toFixed(1)}h

💰 Balance: $${STATE.balance.toFixed(2)}`
    );

    log(`ENTRY ${sym} | ${a.tier} ${a.score} | 5m=${m.ch5m.toFixed(1)}% | buy=${m.buyPct100}% | volX=${m.volExplosion}× | target=${targetStr} | stop=-$${stopUSD}`);
  }

  // Clean stale watchlist (> 2 min = momentum gone)
  const now = Date.now();
  for (const sym of Object.keys(STATE.watchlist)) {
    if (now - STATE.watchlist[sym].firstSeen > 2 * 60000) {
      log(`🗑 Watchlist stale: ${sym}`);
      delete STATE.watchlist[sym];
    }
  }
}

// ═══════════════════════════════════════════════
//  MAIN LOOP
// ═══════════════════════════════════════════════
async function scan() {
  STATE.scanCount++;
  const now = Date.now();
  log(`\n⚡ SCAN #${STATE.scanCount} | Scalps: ${STATE.scalpPositions.length}/${C.MAX_POSITIONS} | Holds: ${STATE.holdPositions.length} | $${STATE.balance.toFixed(2)} | P&L: ${STATE.totalPnl >= 0 ? "+" : ""}$${STATE.totalPnl.toFixed(2)}`);

  const coins = await fetchCoins();
  log(`   Fetched ${coins.length} pairs`);

  if (coins.length > 0) {
    await checkExits(coins);
    await checkEntries(coins);
  }

  // Log open positions
  for (const p of STATE.scalpPositions) {
    log(`   ⚡ SCALP ${p.symbol} | ${p.pct >= 0 ? "+" : ""}${p.pct?.toFixed(1)}% | ${Math.round((now-p.entryTime)/1000)}s | ${p.tier}`);
  }
  for (const p of STATE.holdPositions) {
    log(`   📦 HOLD ${p.symbol} | ${p.pct >= 0 ? "+" : ""}${p.pct?.toFixed(1)}% | ${Math.round((now-p.entryTime)/60000)}min`);
  }

  // Every 20 scans = 10 min summary
  if (STATE.scanCount % 20 === 0) {
    const wr  = STATE.wins + STATE.losses > 0 ? Math.round(STATE.wins / (STATE.wins + STATE.losses) * 100) : 0;
    const drawdown = STATE.peakBalance > 0 ? ((STATE.balance - STATE.peakBalance) / STATE.peakBalance * 100).toFixed(1) : "0";
    await tg(
`📊 <b>10-MIN UPDATE</b> — Scan #${STATE.scanCount}

💰 Balance: $${STATE.balance.toFixed(2)}
📈 P&amp;L: ${STATE.totalPnl >= 0 ? "+" : ""}$${STATE.totalPnl.toFixed(2)}
🏆 Win rate: ${wr}% (${STATE.wins}W / ${STATE.losses}L)
📉 Drawdown: ${drawdown}%
📂 Open: ${STATE.scalpPositions.length} scalp, ${STATE.holdPositions.length} hold
👁 Watching: ${Object.keys(STATE.watchlist).length} coins
⏰ Running: ${((now-STATE.startedAt)/3600000).toFixed(1)}h`
    );
  }

  saveState();
}

// ─── BOOT ─────────────────────────────────────
async function main() {
  console.log(`
╔══════════════════════════════════════════╗
║   MOMENTUM SNIPER v4.0                   ║
║   Rebuilt from scratch — loss control    ║
╚══════════════════════════════════════════╝
Mode:           ${C.PAPER_MODE ? "📝 PAPER" : "💰 LIVE"}
Position size:  $${C.POSITION_SIZE_USD} (was $100)
Hard stop:      ${C.HARD_STOP_PCT}% = max $${(C.POSITION_SIZE_USD * C.HARD_STOP_PCT/100).toFixed(0)} loss per trade
Max hold:       ${C.MAX_HOLD_MS/60000}min scalp / ${C.HOLD_MAX_MS/3600000}h hold
Circuit breakers:
  - Hourly loss limit:    -$${C.MAX_LOSS_PER_HOUR}
  - Daily loss limit:     -$${C.DAILY_LOSS_LIMIT}
  - 3 consec losses:      pause ${C.CONSEC_LOSS_PAUSE_MS/60000}min
  - Per symbol cooldown:  ${C.LOSS_COOLDOWN_MS/60000}min after loss
  `);

  loadState();

  await tg(
`🚀 <b>SNIPER v4.0 STARTED</b>
Mode: ${C.PAPER_MODE ? "📝 Paper" : "💰 LIVE"}
Balance: $${STATE.balance.toFixed(2)}

What's new vs v3:
• $50 positions (was $100)
• 16% stop = $8 max loss per trade
• TX acceleration detector
• Score consistency check
• 3 circuit breakers
• Hourly + daily loss limits
• 3 consec losses = 20min pause
• No boosted coins`
  );

  await scan();
  setInterval(scan, C.SCAN_INTERVAL_MS);
}

main().catch(e => { log("💥 Fatal: " + e.message); process.exit(1); });
