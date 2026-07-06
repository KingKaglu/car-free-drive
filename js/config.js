/* PulseTrade configuration */
"use strict";

const CONFIG = {
  REST_BASE: "https://api.exchange.coinbase.com",
  WS_URL: "wss://ws-feed.exchange.coinbase.com",

  START_CASH: 100000,
  FEE_RATE: 0.001, // 0.10% taker fee simulation

  DEFAULT_PRODUCT: "BTC-USD",
  DEFAULT_GRANULARITY: 900, // 15m

  // Coinbase Exchange supported candle granularities (seconds)
  GRANULARITIES: [60, 300, 900, 3600, 21600, 86400],

  PRODUCTS: [
    { id: "BTC-USD",  base: "BTC",  name: "Bitcoin" },
    { id: "ETH-USD",  base: "ETH",  name: "Ethereum" },
    { id: "SOL-USD",  base: "SOL",  name: "Solana" },
    { id: "XRP-USD",  base: "XRP",  name: "XRP" },
    { id: "DOGE-USD", base: "DOGE", name: "Dogecoin" },
    { id: "ADA-USD",  base: "ADA",  name: "Cardano" },
    { id: "AVAX-USD", base: "AVAX", name: "Avalanche" },
    { id: "LINK-USD", base: "LINK", name: "Chainlink" },
    { id: "DOT-USD",  base: "DOT",  name: "Polkadot" },
    { id: "LTC-USD",  base: "LTC",  name: "Litecoin" },
    { id: "UNI-USD",  base: "UNI",  name: "Uniswap" },
    { id: "AAVE-USD", base: "AAVE", name: "Aave" },
  ],

  STORAGE_KEY: "pulsetrade.account.v1",

  COLORS: {
    up: "#0ca30c",
    upText: "#2fc42f",
    down: "#d03b3b",
    downText: "#ed6a6a",
    accent: "#3987e5",
    grid: "#242422",
    text: "#898781",
    border: "rgba(255,255,255,0.14)",
    volume: "rgba(137,135,129,0.35)",
  },
};

/* ---------- shared formatting helpers ---------- */

function fmtUsd(v, opts = {}) {
  if (v == null || !isFinite(v)) return "—";
  const abs = Math.abs(v);
  const digits = opts.digits ?? (abs >= 1000 ? 2 : abs >= 1 ? 2 : abs >= 0.01 ? 4 : 6);
  return v.toLocaleString("en-US", {
    style: "currency", currency: "USD",
    minimumFractionDigits: digits, maximumFractionDigits: digits,
  });
}

/* price without the $ sign, sensible precision for the magnitude */
function fmtPrice(v) {
  if (v == null || !isFinite(v)) return "—";
  const abs = Math.abs(v);
  const digits = abs >= 1000 ? 2 : abs >= 1 ? 2 : abs >= 0.01 ? 4 : 6;
  return v.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

function fmtQty(v) {
  if (v == null || !isFinite(v)) return "—";
  const abs = Math.abs(v);
  const digits = abs >= 100 ? 2 : abs >= 1 ? 4 : 6;
  return v.toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: digits });
}

function fmtPct(v, signed = true) {
  if (v == null || !isFinite(v)) return "—";
  const s = signed && v > 0 ? "+" : "";
  return s + v.toFixed(2) + "%";
}

function fmtCompact(v) {
  if (v == null || !isFinite(v)) return "—";
  return Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 }).format(v);
}

function signClass(v) { return v > 0 ? "pos" : v < 0 ? "neg" : ""; }
