# PulseTrade — Demo Trading with Real Market Data

A paper-trading (demo) crypto exchange that runs entirely in your browser.
You get **$100,000 in virtual cash** and trade against **live market data**
streamed from the Coinbase Exchange public API — real prices, real volatility,
zero risk.

![status](https://img.shields.io/badge/money%20at%20risk-none-0ca30c)

## Features

- **Real-time prices** — WebSocket ticker feed for 29 crypto markets
  (BTC, ETH, SOL, XRP, DOGE, ADA, AVAX, LINK, DOT, LTC, UNI, AAVE, BCH,
  SHIB, PEPE, ATOM, NEAR, ARB, OP, APT, SUI, FIL, ICP, ETC, HBAR, XLM,
  ALGO, CRO, INJ), with an automatic REST-polling fallback and
  exponential-backoff reconnect.
- **Professional charting** — TradingView Lightweight Charts™ candlesticks +
  volume, six timeframes (1m → 1D), ~600 bars of history, live candle rolls
  forward tick-by-tick, OHLC crosshair legend.
- **Full order ticket** — market & limit orders, buy/sell, amount in USD or
  the asset, 25/50/75/Max quick-fill, live cost/fee/total estimates,
  balance validation.
- **Realistic execution** — fills at live prices with a 0.10% fee; resting
  limit orders trigger automatically when the live price crosses them;
  marketable limits fill immediately.
- **Portfolio tracking** — average-cost positions with live unrealized P&L,
  realized P&L on every sale, open orders, full trade history, session
  equity chart, one-click position close.
- **Live trades feed** — the actual match stream for the selected market.
- **Persistence** — your account survives refreshes via `localStorage`;
  reset to a fresh $100k anytime.
- **Zero build step** — plain HTML/CSS/JS, one vendored library, no
  framework, no API keys, no backend. Works from any static host.

## Run it

Serve the folder with any static file server (APIs are HTTPS + CORS-enabled,
but `file://` pages can't open WebSockets reliably):

```bash
# any of these:
npx serve .
python3 -m http.server 8000
```

Then open http://localhost:8000. That's it — no keys, no signup.

Or deploy to GitHub Pages / Netlify / Vercel as a plain static site.

## How it works

| Concern | Source |
|---|---|
| 24h stats & candle history | `https://api.exchange.coinbase.com` REST |
| Live prices, trades | `wss://ws-feed.exchange.coinbase.com` (`ticker` + `matches` channels) |
| Charting | vendored [Lightweight Charts™](https://github.com/tradingview/lightweight-charts) (Apache-2.0) |
| Account state | `localStorage` — nothing ever leaves your browser |

The trading engine (`js/trading.js`) is a long-only spot simulator: buys
average into a position, sells realize P&L against the average entry, and
every fill pays a 0.10% taker fee. Cost basis is **fee-inclusive** (the
Entry column is your break-even price), so the books always reconcile:

```
equity − starting cash ≡ realized P&L + unrealized P&L
```

Resting limit buys reserve cash and resting limit sells reserve coins, so
you can't spend or sell what an open order already claims. Marketable
limit orders fill immediately at the better market price.

## Disclaimer

PulseTrade is an educational demo. It is not a brokerage, the fills are
simulated, and nothing in it is investment advice. Market data courtesy of
Coinbase Exchange's public endpoints.
