const express = require("express");
const axios = require("axios");
const { EMA, ATR, ADX } = require("technicalindicators");

const app = express();

// ================= ENV =================
const PORT = process.env.PORT || 3002;
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

// ================= CONFIG =================
const SYMBOL = "SOLUSDT";
const BASE_INTERVAL = "5m";
const RESAMPLE_FACTOR = 3; // 5m → 15m

const CONFIG = {
  initialBalance: 100,
  riskPerTrade: 0.006,
  leverage: 10,
  takerFee: 0.0004,

  emaFast: 50,
  emaSlow: 200,

  atrPeriod: 14,
  slATR: 1.6,
  rr2: 2.2,

  adxPeriod: 14,
  adxMin: 20,

  cooldownBars: 30,
  dailyLossLimit: 0.03
};

// ================= STATE =================
let balance = CONFIG.initialBalance;
let peakBalance = balance;

let openTrade = null;
let cooldownCount = 0;

let lastProcessedCandleTime = 0;
let currentDay = "";
let dayStartBalance = balance;

let startupSent = false;
let lastSentHour = null;

// ================= TELEGRAM =================
async function sendTelegram(msg) {
  if (!TELEGRAM_TOKEN || !TELEGRAM_CHAT_ID) return;

  try {
    await axios.post(
      `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`,
      { chat_id: TELEGRAM_CHAT_ID, text: msg }
    );
  } catch (e) {
    console.error("Telegram error:", e.message);
  }
}

// ================= BINANCE =================
async function getKlines(symbol, interval, limit = 1000) {
  const url = `https://fapi.binance.com/fapi/v1/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`;
  const res = await axios.get(url);
  return res.data.map(k => ({
    time: k[0],
    open: +k[1],
    high: +k[2],
    low: +k[3],
    close: +k[4],
    volume: +k[5]
  }));
}

async function getPrice(symbol) {
  try {
    const res = await axios.get(
      `https://fapi.binance.com/fapi/v1/ticker/price?symbol=${symbol}`
    );
    return +res.data.price;
  } catch (e) {
    console.error("Get price error:", e.message);
    return null;
  }
}

// ================= RESAMPLE =================
function resampleTo15m(candles5m) {
  const out = [];
  for (let i = 0; i + RESAMPLE_FACTOR <= candles5m.length; i += RESAMPLE_FACTOR) {
    const chunk = candles5m.slice(i, i + RESAMPLE_FACTOR);
    out.push({
      time: chunk[chunk.length - 1].time,
      open: chunk[0].open,
      high: Math.max(...chunk.map(x => x.high)),
      low: Math.min(...chunk.map(x => x.low)),
      close: chunk[chunk.length - 1].close,
      volume: chunk.reduce((s, x) => s + x.volume, 0)
    });
  }
  return out;
}

// ================= STARTUP =================
async function startupReport() {
  const price = await getPrice(SYMBOL) || "???";
  await sendTelegram(
    `🚀 BOT STARTED\n` +
    `Strategy: EMA50/200 + ADX (15m)\n\n` +
    `${SYMBOL}: ${price.toFixed(4)}\n` +
    `Balance: ${balance.toFixed(2)}`
  );
  startupSent = true;
}

// ================= HEARTBEAT =================
async function heartbeat() {
  const now = new Date();
  const hour = now.getHours();
  const minute = now.getMinutes();

  if (minute !== 0) return;
  if (hour === lastSentHour) return;
  lastSentHour = hour;

  const price = await getPrice(SYMBOL) || "???";

  let msg =
    `🕒 ${hour.toString().padStart(2, "0")}:00 STATUS\n\n` +
    `${SYMBOL}: ${price.toFixed(4)}\n` +
    `Balance: ${balance.toFixed(2)}\n`;

  if (openTrade) {
    msg +=
      `\n🟡 OPEN ${openTrade.direction}\n` +
      `Entry: ${openTrade.entry.toFixed(4)}\n` +
      `SL: ${openTrade.sl.toFixed(4)}`;
  } else {
    msg += `\nNo open trade`;
  }

  await sendTelegram(msg);
}

// ================= CORE LOGIC =================
function calculateIndicators(candles) {
  const closes = candles.map(c => c.close);
  const highs = candles.map(c => c.high);
  const lows = candles.map(c => c.low);

  const ema50 = EMA.calculate({ period: CONFIG.emaFast, values: closes });
  const ema200 = EMA.calculate({ period: CONFIG.emaSlow, values: closes });
  const atr = ATR.calculate({ period: CONFIG.atrPeriod, high: highs, low: lows, close: closes });
  const adx = ADX.calculate({ period: CONFIG.adxPeriod, high: highs, low: lows, close: closes });

  const i = ema200.length - 1;

  return {
    ema50: ema50[i],
    ema200: ema200[i],
    atr: atr[i],
    adx: adx[i]?.adx,
    close: closes[i],
    high: highs[i],
    low: lows[i]
  };
}

function checkForEntry(candles) {
  if (candles.length < 250) return null;

  const last = candles[candles.length - 1];
  const ind = calculateIndicators(candles);

  if (!ind.ema50 || !ind.ema200 || !ind.atr || !ind.adx) return null;
  if (ind.adx <= CONFIG.adxMin) return null;

  let signal = null;

  if (ind.close > ind.ema200 && last.low <= ind.ema50 && ind.close > ind.ema50)
    signal = "LONG";

  if (ind.close < ind.ema200 && last.high >= ind.ema50 && ind.close < ind.ema50)
    signal = "SHORT";

  if (!signal) return null;

  const entry = ind.close;
  const slDist = ind.atr * CONFIG.slATR;

  const sl = signal === "LONG" ? entry - slDist : entry + slDist;
  const tp1 = signal === "LONG" ? entry + slDist : entry - slDist;
  const tp2 = signal === "LONG" ? entry + slDist * CONFIG.rr2 : entry - slDist * CONFIG.rr2;

  const riskUSD = balance * CONFIG.riskPerTrade;
  const qty = (riskUSD / slDist) * CONFIG.leverage;

  const fee = entry * qty * CONFIG.takerFee;
  if (balance <= fee) return null;

  return { direction: signal, entry, sl, tp1, tp2, qty };
}

// ================= MAIN LOOP =================
async function botLoop() {
  try {
    if (!startupSent) await startupReport();
    await heartbeat();

    const data5m = await getKlines(SYMBOL, BASE_INTERVAL);
    const candles15m = resampleTo15m(data5m);

    if (candles15m.length < 250) return;

    const lastCandle = candles15m[candles15m.length - 1];
    if (lastCandle.time === lastProcessedCandleTime) return;
    lastProcessedCandleTime = lastCandle.time;

    const day = new Date(lastCandle.time).toISOString().slice(0, 10);
    if (day !== currentDay) {
      currentDay = day;
      dayStartBalance = balance;
    }

    if ((dayStartBalance - balance) / dayStartBalance > CONFIG.dailyLossLimit)
      return;

    if (openTrade) {
      const c = lastCandle;

      if (!openTrade.tp1Hit) {
        const hitTP1 = openTrade.direction === "LONG"
          ? c.high >= openTrade.tp1
          : c.low <= openTrade.tp1;

        if (hitTP1) {
          const qtyHalf = openTrade.qty / 2;
          const pnl = (openTrade.tp1 - openTrade.entry) * qtyHalf *
            (openTrade.direction === "LONG" ? 1 : -1);
          const fee = openTrade.tp1 * qtyHalf * CONFIG.takerFee;

          balance += pnl - fee;
          openTrade.tp1Hit = true;
          openTrade.sl = openTrade.entry;

          await sendTelegram(`🎯 TP1 HIT | Balance: ${balance.toFixed(2)}`);
        }
      }

      const hitSL = openTrade.direction === "LONG"
        ? c.low <= openTrade.sl
        : c.high >= openTrade.sl;

      const hitTP2 = openTrade.direction === "LONG"
        ? c.high >= openTrade.tp2
        : c.low <= openTrade.tp2;

      if (hitSL || hitTP2) {
        const exit = hitSL ? openTrade.sl : openTrade.tp2;
        const pnl = (exit - openTrade.entry) * openTrade.qty *
          (openTrade.direction === "LONG" ? 1 : -1);
        const fee = exit * openTrade.qty * CONFIG.takerFee;

        balance += pnl - fee;
        openTrade = null;
        cooldownCount = CONFIG.cooldownBars;

        await sendTelegram(`🔴 CLOSE ${hitSL ? "SL" : "TP2"} | Balance: ${balance.toFixed(2)}`);
      }
    }

    if (!openTrade && cooldownCount === 0) {
      const signal = checkForEntry(candles15m);

      if (signal) {
        balance -= signal.entry * signal.qty * CONFIG.takerFee;
        openTrade = { ...signal, tp1Hit: false };

        await sendTelegram(
          `🟢 OPEN ${signal.direction}\n` +
          `Entry: ${signal.entry.toFixed(4)}\n` +
          `SL: ${signal.sl.toFixed(4)}\n` +
          `Balance: ${balance.toFixed(2)}`
        );
      }
    }

    if (cooldownCount > 0) cooldownCount--;
    peakBalance = Math.max(peakBalance, balance);

  } catch (e) {
    console.error("Bot error:", e.message);
    await sendTelegram(`❌ BOT ERROR: ${e.message}`);
  }
}

// ================= EXPRESS =================
app.get("/", (req, res) => {
  res.json({ balance, peakBalance, openTrade, cooldownCount });
});

app.listen(PORT, async () => {
  console.log(`🚀 BOT RUNNING → PORT ${PORT}`);
  await botLoop();
});

setInterval(botLoop, 30 * 1000);
