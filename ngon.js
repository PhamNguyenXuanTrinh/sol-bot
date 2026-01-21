require("dotenv").config();
const express = require("express");
const axios = require("axios");
const crypto = require("crypto");

/* ================= CẤU HÌNH BOT ================= */
const app = express();
const PORT = process.env.PORT || 3002;

const SYMBOL = "NEARUSDT"; // đồng coin theo backtest
// Thay thành "https://fapi.binance.com" cho môi trường LIVE thật
const BASE_URL = "https://testnet.binancefuture.com";

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const BINANCE_KEY = process.env.BINANCE_KEY;
const BINANCE_SECRET = process.env.BINANCE_SECRET;

// Cấu hình chiến lược (giữ nguyên theo backtest)
const CONFIG = {
  riskPerTrade: 0.01,       // 1% risk per trade (giữ giống backtest)
  leverage: 2,              // Leverage 2x
  atrMultiplier: 2,         // 2 × ATR cho position sizing (giống backtest)
  interval: "15m",          // Khung thời gian 15m như backtest
  FEE: 0.0004               // fee giả định (dùng để tính nội bộ/log nếu cần)
};

/* ================= TRẠNG THÁI BOT ================= */
let hasOpenedTrade = false;
let lastProcessedBarTime = 0; // Thời điểm bar đã xử lý tín hiệu gần nhất
let startBalance = 0;
let lastHourlyReport = null;
let currentPosition = null; // { side: "BUY"/"SELL", entry, qty, openTime }

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

/* ================= INDICATORS (exact from backtest) ================= */
function ema(arr, p) {
  const k = 2 / (p + 1);
  const out = [];
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

function prepare(klines) {
  const closes = klines.map(k => k.c);
  return {
    ema9: ema(closes, 9),
    ema21: ema(closes, 21),
    ema200: ema(closes, 200),
    atr: atr(klines, 14)
  };
}

function getSignal(i, data, klines) {
  if (i < 200) return null;

  const price = klines[i].c;
  const ema200 = data.ema200[i];

  const ema9_prev = data.ema9[i - 1];
  const ema21_prev = data.ema21[i - 1];
  const ema9 = data.ema9[i];
  const ema21 = data.ema21[i];

  if (ema9_prev <= ema21_prev && ema9 > ema21 && price > ema200) {
    return "BUY";
  }

  if (ema9_prev >= ema21_prev && ema9 < ema21 && price < ema200) {
    return "SELL";
  }

  return null;
}

/* ================= MỞ / ĐÓNG LỆNH (MATCH BACKTEST) ================= */

/*
  NOTE:
  - Entry price is taken as next.o (open of the next candle) exactly like backtest.
  - No STOP_MARKET or TAKE_PROFIT_MARKET orders are placed (to remain identical to backtest).
  - Exit occurs only when reverse signal appears -> we close with MARKET.
*/

async function openTrade(sig, klines, lastClosedIndex) {
  try {
    // Entry price = open of the next candle (same as backtest's next.o)
    const nextCandle = klines[lastClosedIndex + 1];
    if (!nextCandle) {
      await sendTelegram("⚠️ Không tìm thấy next candle để entry (sai index).");
      return;
    }
    const entry = nextCandle.o;

    const balance = await getBalance();
    const riskAmount = balance * CONFIG.riskPerTrade;

    // ATR from the last closed bar (index = lastClosedIndex)
    const data = prepare(klines);
    const atrValue = data.atr[lastClosedIndex];
    if (!atrValue || atrValue <= 0) {
      await sendTelegram(`⚠️ Không thể tính ATR để sizing vị thế`);
      return;
    }

    const slDist = atrValue * CONFIG.atrMultiplier;
    let rawQty = (riskAmount / slDist) * CONFIG.leverage;

    // Round according to exchange stepSize/precision
    let qty = Math.floor(rawQty / SYMBOL_INFO.stepSize) * SYMBOL_INFO.stepSize;
    qty = parseFloat(qty.toFixed(SYMBOL_INFO.quantityPrecision));

    if (qty < SYMBOL_INFO.minQty || qty * entry < SYMBOL_INFO.minNotional) {
      await sendTelegram(`⚠️ Qty quá nhỏ (${qty}), không đạt minNotional`);
      return;
    }

    // Set leverage (idempotent)
    await binanceRequest("POST", "/fapi/v1/leverage", {
      symbol: SYMBOL,
      leverage: CONFIG.leverage
    }, true);

    // Place MARKET order to open (side = sig)
    await binanceRequest("POST", "/fapi/v1/order", {
      symbol: SYMBOL,
      side: sig,
      type: "MARKET",
      quantity: qty
    }, true);

    hasOpenedTrade = true;
    currentPosition = {
      side: sig,
      entry: entry, // use backtest-style entry (next.o)
      qty: qty,
      openTime: Date.now()
    };

    const msg =
      `🚀 <b>OPEN ${sig === "BUY" ? "LONG" : "SHORT"} (EMA9/21 + EMA200)</b>\n` +
      `⏰ ${vnTime()}\n` +
      `────────────────────\n` +
      `Entry ≈ <b>${entry.toFixed(4)}</b>\n` +
      `Virtual SL distance: <b>${slDist.toFixed(4)}</b> (${CONFIG.atrMultiplier}×ATR)\n` +
      `Risk: ≈ <b>${riskAmount.toFixed(2)} USDT</b> (${(CONFIG.riskPerTrade * 100)}%)\n` +
      `Quantity: <b>${qty}</b>\n` +
      `Leverage: <b>${CONFIG.leverage}x</b>\n` +
      `────────────────────`;
    await sendTelegram(msg);

  } catch (err) {
    console.error("openTrade error:", err.message);
    await sendTelegram(`⚠️ Lỗi mở lệnh: ${err.message}`);
  }
}

async function closePosition() {
  try {
    const pos = await getPosition();
    if (!pos) return;

    const closeSide = pos.side === "BUY" ? "SELL" : "BUY";
    await binanceRequest("POST", "/fapi/v1/order", {
      symbol: SYMBOL,
      side: closeSide,
      type: "MARKET",
      quantity: pos.quantity.toFixed(SYMBOL_INFO.quantityPrecision)
    }, true);
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
      // Lệnh đã đóng (manual hoặc closed by us)
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
        `🔒 <b>CLOSE ${currentPosition.side === "BUY" ? "LONG" : "SHORT"} (External)</b>\n` +
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

    // lastClosedIndex giống backtest: index của nến vừa đóng trước nến cuối
    const lastClosedIndex = klines.length - 2;
    const barTime = klines[lastClosedIndex].time;

    if (barTime <= lastProcessedBarTime) return;
    lastProcessedBarTime = barTime;

    const data = prepare(klines);
    const sig = getSignal(lastClosedIndex, data, klines);

    const pos = await getPosition();

    // Đồng bộ nếu có position nhưng bot chưa biết (restart)
    if (pos && !hasOpenedTrade) {
      hasOpenedTrade = true;
      currentPosition = {
        side: pos.side,
        entry: pos.entryPrice,
        qty: pos.quantity,
        openTime: Date.now() - 3600000 // ước lượng (giữ giống bản trước)
      };
      await sendTelegram(`⚠️ Phát hiện position đang mở (restart). Side: ${pos.side}, Entry: ${pos.entryPrice}`);
    }

    if (sig) {
      if (hasOpenedTrade && pos && sig !== pos.side) {
        // Reverse signal → close cũ + mở mới (giống backtest: close market, then open at next.o)
        // Tính PnL ước lượng để log (giữ nguyên format)
        const price = klines[klines.length - 1].o; // sử dụng open của candle cuối hiện có làm approx price
        const pnlEst = pos.side === "BUY"
          ? (price - currentPosition.entry) * currentPosition.qty
          : (currentPosition.entry - price) * currentPosition.qty;

        const pnlText = pnlEst >= 0
          ? `🟢 LÃI ước tính: <b>${pnlEst.toFixed(2)} USDT</b>`
          : `🔴 LỖ ước tính: <b>${pnlEst.toFixed(2)} USDT</b>`;

        const closeMsg =
          `🔒 <b>CLOSE ${pos.side === "BUY" ? "LONG" : "SHORT"} (Reverse Signal)</b>\n` +
          `⏰ ${vnTime()}\n` +
          `────────────────────\n` +
          `Exit ≈ <b>${price.toFixed(4)}</b>\n` +
          `${pnlText}\n` +
          `────────────────────`;
        await sendTelegram(closeMsg);

        // Close old position by MARKET
        await closePosition();
        hasOpenedTrade = false;
        currentPosition = null;

        // Mở lệnh mới ngay theo backtest: entry = next.o (bởi vì chúng ta đã lấy klines)
        await openTrade(sig, klines, lastClosedIndex);

      } else if (!hasOpenedTrade) {
        // No open -> open trade according to backtest logic
        await openTrade(sig, klines, lastClosedIndex);
      }
    }
  } catch (err) {
    console.error("Bot loop error:", err.message);
  }
}

/* ================= SET INTERVALS ================= */
// Run every minute to sync with 15m candles (we process closed candles via klines)
setInterval(botLoop, 60000);
setInterval(checkPositionAndReport, 30000);

// Hourly report (giữ nguyên format)
setInterval(async () => {
  try {
    const now = Date.now();
    if (lastHourlyReport && now - lastHourlyReport < 3600000) return;
    lastHourlyReport = now;

    const balance = await getBalance();
    const price = await getPrice();
    const pos = await getPosition();
    let unrealized = "";
    if (pos && currentPosition) {
      const pnl = pos.side === "BUY"
        ? (price - currentPosition.entry) * currentPosition.qty
        : (currentPosition.entry - price) * currentPosition.qty;
      unrealized = pnl >= 0
        ? `Unrealized P&L: 🟢 <b>+${pnl.toFixed(2)} USDT</b>\n`
        : `Unrealized P&L: 🔴 <b>${pnl.toFixed(2)} USDT</b>\n`;
    }

    const status = hasOpenedTrade ? "🟢 ĐANG CÓ LỆNH MỞ" : "⚪ KHÔNG CÓ LỆNH";
    await sendTelegram(
      `📊 <b>BÁO CÁO GIỜ</b> (${vnTime()})\n` +
      `Balance: <b>${balance.toFixed(2)} USDT</b>\n` +
      `${unrealized}` +
      `NEAR Price: <b>${price.toFixed(4)}</b>\n` +
      `Status: ${status}\n` +
      `Bot vẫn chạy ổn định ✓`
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
      `🤖 <b>BOT ĐÃ KHỞI ĐỘNG (EMA9/21 + EMA200)</b>\n` +
      `⏰ ${vnTime()}\n` +
      `────────────────────\n` +
      `Balance: <b>${balance.toFixed(2)}</b> USDT\n` +
      `NEAR/USDT: <b>${currentPrice.toFixed(4)}</b>\n` +
      `Leverage: <b>${CONFIG.leverage}x</b>\n` +
      `Risk/Trade: <b>${(CONFIG.riskPerTrade * 100).toFixed(2)}%</b>\n` +
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
