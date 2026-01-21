require("dotenv").config();
const express = require("express");
const axios = require("axios");
const crypto = require("crypto");

/* ================= CẤU HÌNH BOT ================= */
const app = express();
const PORT = process.env.PORT || 3002;

const SYMBOL = "SOLUSDT"; // đồng coin theo backtest
// Thay thành "https://fapi.binance.com" cho môi trường LIVE thật
const BASE_URL = "https://testnet.binancefuture.com";

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const BINANCE_KEY = process.env.BINANCE_KEY;
const BINANCE_SECRET = process.env.BINANCE_SECRET;

// Cấu hình chiến lược (giữ nguyên theo backtest)
const CONFIG = {
  leverage: 10,                  // Đổi số này để test: 10, 15, 20, 30, 50...
  marginPercentPerTrade: 0.25,   // % vốn tự do dùng làm margin mỗi lệnh (0.1 → conservative, 0.3+ → aggressive)
  maxRiskPercentAllowed: 0.05,   // Max rủi ro ước tính / vốn (skip nếu vượt)
  takerFee: 0.0004,              // 0.04%
  slippageRate: 0.00025,         // 0.025%
  slMultiplier: 1,
  trailingTrigger: 1.8,
  trailingOffset: 0.8,
  tpMultiplier: 6.0,
  maxHoldBars: 60,
  interval: "15m"                // Khung thời gian 15m như backtest
};

// Maintenance margin tiered (gần giống Binance SOLUSDT 2025)
function getMaintenanceRate(notional) {
  if (notional <= 50000) return 0.004;    // ~0.4%
  if (notional <= 250000) return 0.005;
  if (notional <= 1000000) return 0.01;
  if (notional <= 5000000) return 0.025;
  return 0.05;
}

/* ================= TRẠNG THÁI BOT ================= */
let hasOpenedTrade = false;
let lastProcessedBarTime = 0; // Thời điểm bar đã xử lý tín hiệu gần nhất
let startBalance = 0;
let lastHourlyReportHour = -1;
let currentPosition = null; // { entryPrice, stopLossPrice, trailingStop, notional, margin, entryIndex, barsHeld, openTime }

let SYMBOL_INFO = null; // Thông tin precision, stepSize, minQty, minNotional

/* ================= HÀM TIỆN ÍCH ================= */
function sign(query) {
  return crypto
    .createHmac("sha256", BINANCE_SECRET)
    .update(query)
    .digest("hex");
}

function vnTime(ts = Date.now()) {
  return new Date(ts + 7 * 3600000)
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
  const url = `${BASE_URL}${path}${query ? `?${query}` : ""}`;
  const res = await axios({ method, url, headers: { "X-MBX-APIKEY": BINANCE_KEY } });
  return res.data;
}

/* ================= LẤY THÔNG TIN SYMBOL ================= */
async function getSymbolInfo() {
  const res = await axios.get(`${BASE_URL}/fapi/v1/exchangeInfo`);
  const sym = res.data.symbols.find(s => s.symbol === SYMBOL);
  if (!sym) throw new Error("Symbol not found in exchangeInfo");
  const lotSize = sym.filters.find(f => f.filterType === "LOT_SIZE");
  const minNotional = sym.filters.find(f => f.filterType === "MIN_NOTIONAL")?.minNotional || "5";
  return {
    quantityPrecision: sym.quantityPrecision,
    stepSize: parseFloat(lotSize.stepSize),
    minQty: parseFloat(lotSize.minQty),
    minNotional: parseFloat(minNotional)
  };
}

/* ================= LẤY DỮ LIỆU THỊ TRƯỜNG ================= */
async function getBalance() {
  const data = await binanceRequest("GET", "/fapi/v2/balance", {}, true);
  const usdt = data.find(x => x.asset === "USDT");
  return usdt ? +usdt.availableBalance : 0;
}

async function getPrice() {
  const res = await axios.get(`${BASE_URL}/fapi/v1/ticker/price?symbol=${SYMBOL}`);
  return +res.data.price;
}

async function fetchKlines(interval, limit = 1000) {
  const res = await axios.get(
    `${BASE_URL}/fapi/v1/klines?symbol=${SYMBOL}&interval=${interval}&limit=${limit}`
  );
  return res.data.map(k => ({
    time: k[0],
    o: +k[1],
    h: +k[2],
    l: +k[3],
    c: +k[4],
    v: +k[5]
  }));
}

async function getPosition() {
  const positions = await binanceRequest("GET", "/fapi/v2/positionRisk", { symbol: SYMBOL }, true);
  const pos = positions.find(p => p.symbol === SYMBOL && Math.abs(+p.positionAmt) > 0);
  if (!pos) return null;
  return {
    side: +pos.positionAmt > 0 ? "BUY" : "SELL",
    quantity: Math.abs(+pos.positionAmt),
    entryPrice: +pos.entryPrice
  };
}

async function getRecentTrades(limit = 20) {
  const trades = await binanceRequest("GET", "/fapi/v1/userTrades", { symbol: SYMBOL, limit }, true);
  return trades;
}

/* ================= INDICATORS (exact from backtest, implemented manually) ================= */
function ema(arr, p) {
  const k = 2 / (p + 1);
  const out = [];
  if (arr.length === 0) return out;
  let prev = arr[0];
  out.push(prev);

  for (let i = 1; i < arr.length; i++) {
    prev = arr[i] * k + prev * (1 - k);
    out.push(prev);
  }
  return out;
}

function atr(klines, p = 14) {
  const out = Array(klines.length).fill(null);
  if (klines.length <= p) return out;

  let trSum = 0;
  for (let i = 1; i <= p; i++) {
    const h = klines[i].h;
    const l = klines[i].l;
    const pc = klines[i - 1].c;
    trSum += Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc));
  }

  let prevATR = trSum / p;
  out[p] = prevATR;

  for (let i = p + 1; i < klines.length; i++) {
    const h = klines[i].h;
    const l = klines[i].l;
    const pc = klines[i - 1].c;
    const tr = Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc));
    prevATR = (prevATR * (p - 1) + tr) / p;
    out[i] = prevATR;
  }

  return out;
}

function rsi(closes, p = 14) {
  const out = Array(closes.length).fill(null);
  if (closes.length < p + 1) return out;

  let upSum = 0, downSum = 0;
  for (let i = 1; i <= p; i++) {
    const delta = closes[i] - closes[i - 1];
    if (delta > 0) upSum += delta;
    else downSum -= delta;
  }

  let avgUp = upSum / p;
  let avgDown = downSum / p;
  out[p] = 100 - 100 / (1 + avgUp / avgDown);

  for (let i = p + 1; i < closes.length; i++) {
    const delta = closes[i] - closes[i - 1];
    const up = delta > 0 ? delta : 0;
    const down = delta < 0 ? -delta : 0;
    avgUp = (avgUp * (p - 1) + up) / p;
    avgDown = (avgDown * (p - 1) + down) / p;
    out[i] = 100 - 100 / (1 + avgUp / avgDown);
  }

  return out;
}

function sma(arr, p) {
  const out = [];
  for (let i = 0; i < arr.length; i++) {
    if (i < p - 1) out.push(null);
    else {
      let sum = 0;
      for (let j = 0; j < p; j++) sum += arr[i - j];
      out.push(sum / p);
    }
  }
  return out;
}

function stdDev(closes, p = 20) {
  const out = [];
  const mean = sma(closes, p);
  for (let i = 0; i < closes.length; i++) {
    if (i < p - 1) out.push(null);
    else {
      let sumSq = 0;
      for (let j = 0; j < p; j++) {
        const diff = closes[i - j] - mean[i];
        sumSq += diff * diff;
      }
      out.push(Math.sqrt(sumSq / p));
    }
  }
  return out;
}

function bbUpper(closes, p = 20, dev = 2) {
  const mid = sma(closes, p);
  const sd = stdDev(closes, p);
  const out = [];
  for (let i = 0; i < closes.length; i++) {
    if (mid[i] === null) out.push(null);
    else out.push(mid[i] + sd[i] * dev);
  }
  return out;
}

function macdHist(closes, fast = 12, slow = 26, signal = 9) {
  let emaFast = ema(closes, fast);
  let emaSlow = ema(closes, slow);
  let line = [];
  for (let i = 0; i < closes.length; i++) {
    if (emaFast[i] && emaSlow[i]) line.push(emaFast[i] - emaSlow[i]);
    else line.push(null);
  }
  let sigLine = ema(line.filter(x => x !== null), signal);
  let hist = [];
  let sigIdx = 0;
  for (let i = 0; i < line.length; i++) {
    if (line[i] === null) hist.push(null);
    else {
      hist.push(line[i] - sigLine[sigIdx]);
      sigIdx++;
    }
  }
  return hist;
}

function prepare(klines) {
  const closes = klines.map(k => k.c);
  const highs = klines.map(k => k.h);
  const lows = klines.map(k => k.l);
  const volumes = klines.map(k => k.v);

  return {
    rsi: rsi(closes, 14),
    atr: atr(klines, 14),
    ema50: ema(closes, 50),
    ema200: ema(closes, 200),
    macdHist: macdHist(closes, 12, 26, 9),
    bbUpper: bbUpper(closes, 20, 2),
    volumes
  };
}

/* ================= MỞ / ĐÓNG LỆNH (MATCH BACKTEST) ================= */
async function openTrade(klines, lastClosedIndex) {
  try {
    // Entry price approx = current price + slippage (similar to backtest nextOpen * (1+slip))
    const currentPrice = await getPrice();
    const entryPrice = currentPrice * (1 + CONFIG.slippageRate);

    const balance = await getBalance();
    const marginUsed = balance * CONFIG.marginPercentPerTrade;
    const notional = marginUsed * CONFIG.leverage;

    // ATR from the last closed bar
    const data = prepare(klines);
    const atrValue = data.atr[lastClosedIndex] || (klines[lastClosedIndex].c * 0.001);
    const stopLossPrice = entryPrice - atrValue * CONFIG.slMultiplier;

    // Ước tính rủi ro
    const slDistance = (entryPrice - stopLossPrice) / entryPrice;
    const estRisk = notional * slDistance;
    if (estRisk > balance * CONFIG.maxRiskPercentAllowed) {
      await sendTelegram(`⚠️ SKIP ENTRY: estRisk ${estRisk.toFixed(2)} > allowed ${(balance * CONFIG.maxRiskPercentAllowed).toFixed(2)}`);
      return;
    }

    // Calculate qty
    let rawQty = notional / entryPrice;
    let qty = Math.floor(rawQty / SYMBOL_INFO.stepSize) * SYMBOL_INFO.stepSize;
    qty = parseFloat(qty.toFixed(SYMBOL_INFO.quantityPrecision));

    if (qty < SYMBOL_INFO.minQty || qty * entryPrice < SYMBOL_INFO.minNotional) {
      await sendTelegram(`⚠️ Qty quá nhỏ (${qty}), không đạt minNotional`);
      return;
    }

    // Set leverage
    await binanceRequest("POST", "/fapi/v1/leverage", {
      symbol: SYMBOL,
      leverage: CONFIG.leverage
    }, true);

    // Place MARKET order to open LONG
    await binanceRequest("POST", "/fapi/v1/order", {
      symbol: SYMBOL,
      side: "BUY",
      type: "MARKET",
      quantity: qty
    }, true);

    // Get actual entry from position
    const pos = await getPosition();
    const actualEntry = pos ? pos.entryPrice : entryPrice; // fallback to est if fail

    hasOpenedTrade = true;
    currentPosition = {
      entryPrice: actualEntry,
      stopLossPrice,
      trailingStop: stopLossPrice,
      notional,
      margin: marginUsed,
      entryIndex: lastClosedIndex + 1,
      barsHeld: 0,
      openTime: Date.now(),
      maintenanceMargin: notional * getMaintenanceRate(notional)
    };

    const msg =
      `🚀 <b>OPEN LONG (BB Breakout Trend-Following)</b>\n` +
      `⏰ ${vnTime()}\n` +
      `────────────────────\n` +
      `Entry ≈ <b>${actualEntry.toFixed(4)}</b>\n` +
      `Virtual SL: <b>${stopLossPrice.toFixed(4)}</b> (${CONFIG.slMultiplier}×ATR)\n` +
      `Risk est: <b>${estRisk.toFixed(2)} USDT</b> (${(CONFIG.maxRiskPercentAllowed * 100)}% max)\n` +
      `Quantity: <b>${qty}</b>\n` +
      `Notional: <b>${notional.toFixed(2)}</b>\n` +
      `Leverage: <b>${CONFIG.leverage}x</b>\n` +
      `────────────────────`;
    await sendTelegram(msg);

  } catch (err) {
    console.error("openTrade error:", err.message);
    await sendTelegram(`⚠️ Lỗi mở lệnh: ${err.message}`);
  }
}

async function closePosition(reason) {
  try {
    const pos = await getPosition();
    if (!pos) return;

    await binanceRequest("POST", "/fapi/v1/order", {
      symbol: SYMBOL,
      side: "SELL",
      type: "MARKET",
      quantity: pos.quantity.toFixed(SYMBOL_INFO.quantityPrecision)
    }, true);

    // Get realized PnL from recent trades
    const trades = await getRecentTrades(30);
    let realizedPnl = 0;
    for (const trade of trades.reverse()) {
      if (trade.time >= currentPosition.openTime) {
        realizedPnl += +trade.realizedPnl;
      }
    }

    const balance = await getBalance();
    const pnlText = realizedPnl >= 0
      ? `🟢 LÃI: <b>${realizedPnl.toFixed(2)} USDT</b>`
      : `🔴 LỖ: <b>${realizedPnl.toFixed(2)} USDT</b>`;

    const closeMsg =
      `🔒 <b>CLOSE LONG (${reason})</b>\n` +
      `⏰ ${vnTime()}\n` +
      `────────────────────\n` +
      `${pnlText}\n` +
      `Balance mới: <b>${balance.toFixed(2)} USDT</b>\n` +
      `────────────────────\n` +
      `Bot sẵn sàng giao dịch lệnh mới.`;

    await sendTelegram(closeMsg);

    hasOpenedTrade = false;
    currentPosition = null;
  } catch (err) {
    console.error("closePosition error:", err.message);
    await sendTelegram(`⚠️ Lỗi đóng lệnh: ${err.message}`);
  }
}

/* ================= KIỂM TRA VỊ THẾ & BÁO CÁO ================= */
async function checkPositionAndReport() {
  try {
    const pos = await getPosition();

    if (!pos && hasOpenedTrade && currentPosition) {
      // Position closed externally (manual or liq)
      const trades = await getRecentTrades(30);
      let realizedPnl = 0;
      for (const trade of trades.reverse()) {
        if (trade.time >= currentPosition.openTime) {
          realizedPnl += +trade.realizedPnl;
        }
      }

      const balance = await getBalance();
      const pnlText = realizedPnl >= 0
        ? `🟢 LÃI: <b>${realizedPnl.toFixed(2)} USDT</b>`
        : `🔴 LỖ: <b>${realizedPnl.toFixed(2)} USDT</b>`;

      const closeMsg =
        `🔒 <b>CLOSE LONG (External)</b>\n` +
        `⏰ ${vnTime()}\n` +
        `────────────────────\n` +
        `${pnlText}\n` +
        `Balance mới: <b>${balance.toFixed(2)} USDT</b>\n` +
        `────────────────────\n` +
        `Bot sẵn sàng giao dịch lệnh mới.`;

      await sendTelegram(closeMsg);

      hasOpenedTrade = false;
      currentPosition = null;
    }
  } catch (err) {
    console.error("checkPositionAndReport error:", err.message);
  }
}

/* ================= VÒNG LẶP CHÍNH ================= */
async function botLoop() {
  try {
    const klines = await fetchKlines(CONFIG.interval, 1000);
    if (klines.length < 202) return;

    const lastClosedIndex = klines.length - 2;
    const barTime = klines[lastClosedIndex].time;

    if (barTime <= lastProcessedBarTime) return;
    lastProcessedBarTime = barTime;

    const data = prepare(klines);

    const close = klines[lastClosedIndex].c;
    const high = klines[lastClosedIndex].h;
    const low = klines[lastClosedIndex].l;
    const volume = data.volumes[lastClosedIndex];

    const atrVal = data.atr[lastClosedIndex] || (close * 0.001);
    const rsiVal = data.rsi[lastClosedIndex] || 0;
    const macdHistVal = data.macdHist[lastClosedIndex] || 0;
    const bbUpperVal = data.bbUpper[lastClosedIndex] || null;
    const ema200Val = data.ema200[lastClosedIndex];
    const ema50Val = data.ema50[lastClosedIndex];

    let volAvg = lastClosedIndex >= 20 ? data.volumes.slice(lastClosedIndex - 19, lastClosedIndex + 1).reduce((a, b) => a + b, 0) / 20 : volume;

    // Đồng bộ nếu có position nhưng bot chưa biết (restart)
    const pos = await getPosition();
    if (pos && !hasOpenedTrade) {
      hasOpenedTrade = true;
      currentPosition = {
        entryPrice: pos.entryPrice,
        stopLossPrice: pos.entryPrice - atrVal * CONFIG.slMultiplier, // approx
        trailingStop: pos.entryPrice - atrVal * CONFIG.slMultiplier,
        notional: pos.quantity * pos.entryPrice,
        margin: (pos.quantity * pos.entryPrice) / CONFIG.leverage, // approx
        entryIndex: lastClosedIndex, // approx
        barsHeld: 0, // reset
        openTime: Date.now() - 3600000, // ước lượng
        maintenanceMargin: (pos.quantity * pos.entryPrice) * getMaintenanceRate(pos.quantity * pos.entryPrice)
      };
      await sendTelegram(`⚠️ Phát hiện position đang mở (restart). Entry: ${pos.entryPrice}`);
    }

    // ---------- ENTRY ----------
    if (!hasOpenedTrade && bbUpperVal !== null) {
      const entryTriggered =
        close > bbUpperVal &&
        (close - bbUpperVal) > atrVal * 0.5 &&
        close > ema200Val &&
        volume > volAvg * 2.0 &&
        macdHistVal > 0 &&
        rsiVal > 55;

      if (entryTriggered) {
        await openTrade(klines, lastClosedIndex);
      }
    }

    // ---------- MANAGE / EXIT ----------
    if (hasOpenedTrade && currentPosition) {
      currentPosition.barsHeld++;

      // Trailing stop update
      if (high - currentPosition.entryPrice > atrVal * CONFIG.trailingTrigger) {
        currentPosition.trailingStop = Math.max(currentPosition.trailingStop, high - atrVal * CONFIG.trailingOffset);
      }

      // Check exits (approx using current closed bar's data, as proxy for next)
      let reason = null;
      let exitPriceEst = await getPrice() * (1 - CONFIG.slippageRate); // current approx

      // Trailing stop hit if low <= trailing
      if (low <= currentPosition.trailingStop) {
        reason = "Trailing Stop";
        exitPriceEst = Math.max(klines[lastClosedIndex].o * (1 - CONFIG.slippageRate), currentPosition.trailingStop);
      }
      // TP if high >= tp
      else if (high >= currentPosition.entryPrice + atrVal * CONFIG.tpMultiplier) {
        reason = "Take Profit";
        exitPriceEst = Math.min(klines[lastClosedIndex].o * (1 + CONFIG.slippageRate), currentPosition.entryPrice + atrVal * CONFIG.tpMultiplier);
      }
      // Time / trend
      else if (currentPosition.barsHeld >= CONFIG.maxHoldBars || close < ema50Val) {
        reason = currentPosition.barsHeld >= CONFIG.maxHoldBars ? "Max Hold Time" : "Trend Break (below EMA50)";
        exitPriceEst = klines[lastClosedIndex].o * (1 - CONFIG.slippageRate);
      }

      if (reason) {
        // Log est PnL before close
        const pnlEst = (exitPriceEst - currentPosition.entryPrice) / currentPosition.entryPrice * currentPosition.notional;
        const pnlText = pnlEst >= 0
          ? `🟢 LÃI ước tính: <b>${pnlEst.toFixed(2)} USDT</b>`
          : `🔴 LỖ ước tính: <b>${pnlEst.toFixed(2)} USDT</b>`;

        const closeMsg =
          `🔒 <b>CLOSE LONG (${reason})</b>\n` +
          `⏰ ${vnTime()}\n` +
          `────────────────────\n` +
          `Exit ≈ <b>${exitPriceEst.toFixed(4)}</b>\n` +
          `${pnlText}\n` +
          `────────────────────`;
        await sendTelegram(closeMsg);

        // Close
        await closePosition(reason);
      }
    }
  } catch (err) {
    console.error("Bot loop error:", err.message);
  }
}

/* ================= SET INTERVALS ================= */
// Run every minute to sync with 15m candles
setInterval(botLoop, 60000);
setInterval(checkPositionAndReport, 30000);

// Hourly report (chỉ gửi khi chuyển giờ mới, approx đúng giờ :00, :01,...)
setInterval(async () => {
  try {
    const now = Date.now() + 7 * 3600000; // VN time
    const currentHour = new Date(now).getHours();

    if (currentHour === lastHourlyReportHour) return;
    lastHourlyReportHour = currentHour;

    const balance = await getBalance();
    const price = await getPrice();
    const pos = await getPosition();
    let unrealized = "";
    let positionDetails = "";
    if (pos && currentPosition) {
      const pnl = (price - currentPosition.entryPrice) * pos.quantity;
      unrealized = pnl >= 0
        ? `Unrealized P&L: 🟢 <b>+${pnl.toFixed(2)} USDT</b>\n`
        : `Unrealized P&L: 🔴 <b>${pnl.toFixed(2)} USDT</b>\n`;

      positionDetails =
        `Entry: <b>${currentPosition.entryPrice.toFixed(4)}</b>\n` +
        `Trailing Stop: <b>${currentPosition.trailingStop.toFixed(4)}</b>\n` +
        `Bars Held: <b>${currentPosition.barsHeld}</b>\n` +
        `Notional: <b>${currentPosition.notional.toFixed(2)}</b>\n`;
    }

    const status = hasOpenedTrade ? "🟢 ĐANG CÓ LỆNH MỞ (LONG)" : "⚪ KHÔNG CÓ LỆNH";
    await sendTelegram(
      `📊 <b>BÁO CÁO GIỜ</b> (${vnTime()})\n` +
      `Balance: <b>${balance.toFixed(2)} USDT</b>\n` +
      `${unrealized}` +
      `${positionDetails}` +
      `${SYMBOL} Price: <b>${price.toFixed(4)}</b>\n` +
      `Status: ${status}\n` +
      `Bot vẫn chạy ổn định ✓\n` +
      `────────────────────\n` +
      `Leverage: ${CONFIG.leverage}x | Margin %: ${CONFIG.marginPercentPerTrade * 100}% | Max Risk: ${CONFIG.maxRiskPercentAllowed * 100}%`
    );
  } catch (err) {
    console.error("Hourly report error:", err.message);
  }
}, 60000);

/* ================= KHỞI ĐỘNG BOT ================= */
app.listen(PORT, async () => {
  try {
    SYMBOL_INFO = await getSymbolInfo();
    startBalance = await getBalance();
    const currentPrice = await getPrice();
    const balance = await getBalance();

    await checkPositionAndReport(); // kiểm tra position có sẵn

    const status = hasOpenedTrade ? "🟢 ĐANG CÓ LỆNH MỞ" : "⚪ KHÔNG CÓ LỆNH";
    const startupMsg =
      `🤖 <b>BOT ĐÃ KHỞI ĐỘNG (BB Breakout Trend-Following Long Only)</b>\n` +
      `⏰ ${vnTime()}\n` +
      `────────────────────\n` +
      `Balance: <b>${balance.toFixed(2)}</b> USDT\n` +
      `${SYMBOL}: <b>${currentPrice.toFixed(4)}</b>\n` +
      `Leverage: <b>${CONFIG.leverage}x</b>\n` +
      `Margin/Trade: <b>${(CONFIG.marginPercentPerTrade * 100).toFixed(2)}%</b>\n` +
      `Max Risk: <b>${(CONFIG.maxRiskPercentAllowed * 100).toFixed(2)}%</b>\n` +
      `Status: ${status}\n` +
      `────────────────────\n` +
      `<i>Bot chạy trên ${BASE_URL.includes('testnet') ? 'TESTNET' : 'LIVE'}</i>`;

    await sendTelegram(startupMsg);
    console.log("Bot started & Telegram notification sent");
  } catch (err) {
    console.error("Error during startup:", err.message);
    await sendTelegram(`⚠️ <b>BOT KHỞI ĐỘNG LỖI</b>\n⏰ ${vnTime()}\n${err.message}`);
  }
});