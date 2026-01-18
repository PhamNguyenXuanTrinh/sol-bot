require("dotenv").config();  // Phải để ở đầu file

const express = require("express");
const axios = require("axios");
const crypto = require("crypto");

/* ================= SERVER ================= */
const app = express();
const PORT = process.env.PORT || 3002;

/* ================= BINANCE ================= */
const SYMBOL = "SOLUSDT";
const BASE_URL = "https://testnet.binancefuture.com";

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const BINANCE_KEY = process.env.BINANCE_KEY;
const BINANCE_SECRET = process.env.BINANCE_SECRET;

/* ================= CONFIG ================= */
const CONFIG = {
  riskPerTrade: 0.006,
  leverage: 10,

  emaFast: 50,
  emaSlow: 200,

  atrPeriod: 14,
  slATR: 1.6,
  rr2: 2.2,

  adxPeriod: 14,
  adxMin: 20
};

const RESAMPLE_FACTOR = 3;

/* ================= STATE ================= */
let hasOpenedTrade = false;
let lastCheck = 0;
let startBalance = 0;
let lastHourlyReport = null;

/* ================= UTILS ================= */
function sign(query) {
  return crypto.createHmac("sha256", BINANCE_SECRET).update(query).digest("hex");
}

function vnTime(ts = Date.now()) {
  return new Date(ts + 7 * 60 * 60 * 1000)
    .toISOString()
    .replace("T", " ")
    .slice(0, 19);
}

async function sendTelegram(msg) {
  try {
    await axios.post(
      `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`,
      { chat_id: TELEGRAM_CHAT_ID, text: msg, parse_mode: "HTML" }
    );
  } catch (err) {
    console.error("Telegram send error:", err.message);
  }
}

async function binanceRequest(method, path, params = {}, signed = false) {
  let query = new URLSearchParams(params).toString();
  if (signed) {
    query += (query ? "&" : "") + `timestamp=${Date.now()}`;
    query += `&signature=${sign(query)}`;
  }

  const url = `${BASE_URL}${path}?${query}`;

  try {
    const res = await axios({
      method,
      url,
      headers: { "X-MBX-APIKEY": BINANCE_KEY }
    });
    return res.data;
  } catch (err) {
    console.error(`Binance ${method} ${path} error:`, err.response?.data || err.message);
    throw err;
  }
}

/* ================= DATA ================= */
async function getBalance() {
  const data = await binanceRequest("GET", "/fapi/v2/balance", {}, true);
  const usdt = data.find(x => x.asset === "USDT");
  return usdt ? parseFloat(usdt.availableBalance) : 0;
}

async function getSOLPrice() {
  const res = await axios.get(`${BASE_URL}/fapi/v1/ticker/price?symbol=${SYMBOL}`);
  return parseFloat(res.data.price);
}

async function fetchKlines5m(limit = 300) {
  const res = await axios.get(
    `${BASE_URL}/fapi/v1/klines?symbol=${SYMBOL}&interval=5m&limit=${limit}`
  );
  return res.data.map(k => ({
    time: k[0],
    open: +k[1],
    high: +k[2],
    low: +k[3],
    close: +k[4]
  }));
}

/* ================= RESAMPLE ================= */
function resampleTo15m(c5) {
  const out = [];
  for (let i = 0; i < c5.length; i += RESAMPLE_FACTOR) {
    const chunk = c5.slice(i, i + RESAMPLE_FACTOR);
    if (chunk.length < RESAMPLE_FACTOR) break;
    out.push({
      time: chunk[chunk.length - 1].time,
      open: chunk[0].open,
      high: Math.max(...chunk.map(x => x.high)),
      low: Math.min(...chunk.map(x => x.low)),
      close: chunk[chunk.length - 1].close
    });
  }
  return out;
}

/* ================= INDICATORS ================= */
function EMA(arr, period) {
  const k = 2 / (period + 1);
  const out = Array(arr.length).fill(null);
  let sum = 0;
  for (let i = 0; i < arr.length; i++) {
    sum += arr[i];
    if (i === period - 1) out[i] = sum / period;
    else if (i >= period) out[i] = arr[i] * k + out[i - 1] * (1 - k);
  }
  return out;
}

function ATR(candles, period) {
  const out = Array(candles.length).fill(null);
  let trSum = 0;
  for (let i = 1; i < candles.length; i++) {
    const tr = Math.max(
      candles[i].high - candles[i].low,
      Math.abs(candles[i].high - candles[i - 1].close),
      Math.abs(candles[i].low - candles[i - 1].close)
    );
    if (i <= period) trSum += tr;
    if (i === period) out[i] = trSum / period;
    if (i > period) out[i] = (out[i - 1] * (period - 1) + tr) / period;
  }
  return out;
}

function ADX(candles, period) {
  const adx = Array(candles.length).fill(null);
  let tr = [], plusDM = [], minusDM = [];

  for (let i = 1; i < candles.length; i++) {
    const up = candles[i].high - candles[i - 1].high;
    const dn = candles[i - 1].low - candles[i].low;
    plusDM.push(up > dn && up > 0 ? up : 0);
    minusDM.push(dn > up && dn > 0 ? dn : 0);
    tr.push(Math.max(
      candles[i].high - candles[i].low,
      Math.abs(candles[i].high - candles[i - 1].close),
      Math.abs(candles[i].low - candles[i - 1].close)
    ));
  }

  let atr = tr.slice(0, period).reduce((a, b) => a + b, 0) / period;
  let pDI = plusDM.slice(0, period).reduce((a, b) => a + b, 0) / period;
  let mDI = minusDM.slice(0, period).reduce((a, b) => a + b, 0) / period;

  const dx = [];
  for (let i = period; i < tr.length; i++) {
    atr = (atr * (period - 1) + tr[i]) / period;
    pDI = (pDI * (period - 1) + plusDM[i]) / period;
    mDI = (mDI * (period - 1) + minusDM[i]) / period;
    const diSum = pDI + mDI;
    dx.push(diSum === 0 ? 0 : 100 * Math.abs(pDI - mDI) / diSum);
  }

  if (dx.length < period) return adx;
  adx[period * 2 - 1] = dx.slice(0, period).reduce((a, b) => a + b, 0) / period;

  for (let i = period * 2; i < candles.length; i++) {
    adx[i] = (adx[i - 1] * (period - 1) + dx[i - period]) / period;
  }

  return adx;
}

/* ================= SIGNAL ================= */
function getSignal(c15, ema50, ema200, atr, adx) {
  const i = c15.length - 1;
  if (!ema50[i] || !ema200[i] || !atr[i] || !adx[i]) return null;
  if (adx[i] <= CONFIG.adxMin) return null;

  const close = c15[i].close;

  // Long signal
  if (close > ema200[i] && c15[i].low <= ema50[i] && close > ema50[i]) {
    return {
      side: "BUY",
      entry: close,
      sl: close - atr[i] * CONFIG.slATR,
      tp: close + atr[i] * CONFIG.slATR * CONFIG.rr2
    };
  }

  // Short signal
  if (close < ema200[i] && c15[i].high >= ema50[i] && close < ema50[i]) {
    return {
      side: "SELL",
      entry: close,
      sl: close + atr[i] * CONFIG.slATR,
      tp: close - atr[i] * CONFIG.slATR * CONFIG.rr2
    };
  }

  return null;
}

/* ================= OPEN TRADE ================= */
async function openTrade(signal) {
  if (hasOpenedTrade) return;

  try {
    const balance = await getBalance();
    const slDist = Math.abs(signal.entry - signal.sl);
    const riskAmount = balance * CONFIG.riskPerTrade;
    const qty = Math.floor((riskAmount / slDist) * CONFIG.leverage);

    if (qty <= 0) {
      console.log("Quantity too small:", qty);
      return;
    }

    // Set leverage
    await binanceRequest("POST", "/fapi/v1/leverage", {
      symbol: SYMBOL,
      leverage: CONFIG.leverage
    }, true);

    // Market entry
    await binanceRequest("POST", "/fapi/v1/order", {
      symbol: SYMBOL,
      side: signal.side,
      type: "MARKET",
      quantity: qty
    }, true);

    // Stop Loss
    await binanceRequest("POST", "/fapi/v1/order", {
      symbol: SYMBOL,
      side: signal.side === "BUY" ? "SELL" : "BUY",
      type: "STOP_MARKET",
      stopPrice: signal.sl.toFixed(2),
      closePosition: true
    }, true);

    // Take Profit
    await binanceRequest("POST", "/fapi/v1/order", {
      symbol: SYMBOL,
      side: signal.side === "BUY" ? "SELL" : "BUY",
      type: "TAKE_PROFIT_MARKET",
      stopPrice: signal.tp.toFixed(2),
      closePosition: true
    }, true);

    hasOpenedTrade = true;

    await sendTelegram(
      `🚀 <b>OPEN ${signal.side}</b>\n` +
      `⏰ ${vnTime()}\n` +
      `Balance: ${balance.toFixed(2)} USDT\n` +
      `Entry: ${signal.entry.toFixed(2)}\n` +
      `SL: ${signal.sl.toFixed(2)}\n` +
      `TP: ${signal.tp.toFixed(2)}\n` +
      `Status: ĐANG VÀO LỆNH`
    );
  } catch (err) {
    console.error("Open trade failed:", err);
    await sendTelegram(`❌ Lỗi mở lệnh: ${err.message}`);
  }
}

/* ================= HOURLY REPORT ================= */
async function hourlyReport() {
  const now = new Date(Date.now() + 7 * 3600000);
  const hourKey = `${now.getFullYear()}-${now.getMonth() + 1}-${now.getDate()}-${now.getHours()}`;

  if (lastHourlyReport === hourKey) return;
  lastHourlyReport = hourKey;

  try {
    const balance = await getBalance();
    const price = await getSOLPrice();
    const pnl = balance - startBalance;

    await sendTelegram(
      `🕐 <b>HOURLY REPORT</b>\n` +
      `⏰ ${vnTime()}\n` +
      `Balance: ${balance.toFixed(2)} USDT\n` +
      `PnL: ${pnl.toFixed(2)} USDT\n` +
      `SOL Price: ${price}\n` +
      `Status: ${hasOpenedTrade ? "🟢 ĐANG CÓ LỆNH" : "⚪ KHÔNG CÓ LỆNH"}`
    );
  } catch (err) {
    console.error("Hourly report error:", err);
  }
}

/* ================= LOOP ================= */
async function botLoop() {
  await hourlyReport();

  if (Date.now() - lastCheck < 30000) return;
  lastCheck = Date.now();

  if (hasOpenedTrade) return;

  try {
    const c5 = await fetchKlines5m(300);
    const c15 = resampleTo15m(c5);

    const closes = c15.map(x => x.close);
    const ema50 = EMA(closes, CONFIG.emaFast);
    const ema200 = EMA(closes, CONFIG.emaSlow);
    const atr = ATR(c15, CONFIG.atrPeriod);
    const adx = ADX(c15, CONFIG.adxPeriod);

    const signal = getSignal(c15, ema50, ema200, atr, adx);
    if (signal) await openTrade(signal);
  } catch (err) {
    console.error("Bot loop error:", err);
  }
}

setInterval(botLoop, 30000);

/* ================= START ================= */
app.listen(PORT, async () => {
  try {
    startBalance = await getBalance();
    const price = await getSOLPrice();

    await sendTelegram(
      `🤖 <b>BOT STARTED</b>\n` +
      `⏰ ${vnTime()}\n` +
      `Start Balance: ${startBalance.toFixed(2)} USDT\n` +
      `SOL Price: ${price}\n` +
      `Status: KHÔNG CÓ LỆNH`
    );

    console.log(`BOT RUNNING on port ${PORT}`);
  } catch (err) {
    console.error("Startup error:", err);
  }
});