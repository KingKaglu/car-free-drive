/* PulseTrade — live market data via Coinbase Exchange public API.
   REST for history/stats, WebSocket (ticker + matches channels) for
   real-time updates. Emits:
     "price"   {productId, price, bid, ask, open24h, high24h, low24h, volume24h, time}
     "match"   {productId, price, size, side, time}
     "status"  "connecting" | "live" | "offline"
*/
"use strict";

class MarketData {
  constructor() {
    this.listeners = {};
    this.tickers = {};          // productId -> latest ticker snapshot
    this.ws = null;
    this.wsAttempts = 0;
    this.selectedProduct = CONFIG.DEFAULT_PRODUCT;
    this.pollTimer = null;      // REST fallback when WS is unavailable
    this._closedByUs = false;
  }

  on(event, fn) {
    (this.listeners[event] ??= []).push(fn);
  }

  emit(event, payload) {
    for (const fn of this.listeners[event] ?? []) fn(payload);
  }

  price(productId) {
    return this.tickers[productId]?.price ?? null;
  }

  /* ---------- REST ---------- */

  async fetchJson(path) {
    const res = await fetch(CONFIG.REST_BASE + path, { headers: { Accept: "application/json" } });
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${path}`);
    return res.json();
  }

  /* Candles: returns ascending [{time, open, high, low, close, volume}] */
  async fetchCandles(productId, granularity, start, end) {
    let path = `/products/${productId}/candles?granularity=${granularity}`;
    if (start && end) path += `&start=${start.toISOString()}&end=${end.toISOString()}`;
    const raw = await this.fetchJson(path); // [[time, low, high, open, close, volume]] newest first
    return raw
      .map((c) => ({ time: c[0], open: c[3], high: c[2], low: c[1], close: c[4], volume: c[5] }))
      .sort((a, b) => a.time - b.time);
  }

  /* Two pages of candles (~600 bars) for a fuller chart */
  async fetchCandleHistory(productId, granularity) {
    const now = new Date();
    const span = granularity * 300 * 1000;
    const page1 = this.fetchCandles(productId, granularity, new Date(now - span), now);
    const page2 = this.fetchCandles(productId, granularity, new Date(now - 2 * span), new Date(now - span));
    const [a, b] = await Promise.all([page1, page2.catch(() => [])]);
    const seen = new Set();
    return [...b, ...a]
      .filter((c) => (seen.has(c.time) ? false : seen.add(c.time)))
      .sort((x, y) => x.time - y.time);
  }

  async fetchStats(productId) {
    const [stats, ticker] = await Promise.all([
      this.fetchJson(`/products/${productId}/stats`),
      this.fetchJson(`/products/${productId}/ticker`),
    ]);
    return this._applyTicker(productId, {
      price: parseFloat(ticker.price),
      bid: parseFloat(ticker.bid),
      ask: parseFloat(ticker.ask),
      open24h: parseFloat(stats.open),
      high24h: parseFloat(stats.high),
      low24h: parseFloat(stats.low),
      volume24h: parseFloat(stats.volume),
      time: ticker.time,
    });
  }

  /* Prime the watchlist via REST (staggered to respect rate limits) */
  async primeAll() {
    for (const p of CONFIG.PRODUCTS) {
      this.fetchStats(p.id).catch(() => {});
      await new Promise((r) => setTimeout(r, 120));
    }
  }

  _applyTicker(productId, snap) {
    const prev = this.tickers[productId];
    snap.prevPrice = prev?.price ?? snap.price;
    this.tickers[productId] = snap;
    this.emit("price", { productId, ...snap });
    return snap;
  }

  /* ---------- WebSocket ---------- */

  connect() {
    this._closedByUs = false;
    this.emit("status", "connecting");
    try {
      this.ws = new WebSocket(CONFIG.WS_URL);
    } catch {
      return this._scheduleReconnect();
    }

    this.ws.onopen = () => {
      this.wsAttempts = 0;
      this._stopPolling();
      this.emit("status", "live");
      this._subscribe();
    };

    this.ws.onmessage = (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }

      if (msg.type === "ticker" && msg.price) {
        this._applyTicker(msg.product_id, {
          price: parseFloat(msg.price),
          bid: parseFloat(msg.best_bid),
          ask: parseFloat(msg.best_ask),
          open24h: parseFloat(msg.open_24h),
          high24h: parseFloat(msg.high_24h),
          low24h: parseFloat(msg.low_24h),
          volume24h: parseFloat(msg.volume_24h),
          time: msg.time,
        });
      } else if ((msg.type === "match" || msg.type === "last_match") && msg.product_id === this.selectedProduct) {
        this.emit("match", {
          productId: msg.product_id,
          price: parseFloat(msg.price),
          size: parseFloat(msg.size),
          side: msg.side, // side of the maker order: "buy" maker = downtick sell aggression
          time: msg.time,
        });
      }
    };

    this.ws.onclose = () => {
      if (!this._closedByUs) this._scheduleReconnect();
    };
    this.ws.onerror = () => { try { this.ws.close(); } catch {} };
  }

  _subscribe() {
    if (this.ws?.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify({
      type: "subscribe",
      product_ids: CONFIG.PRODUCTS.map((p) => p.id),
      channels: ["ticker", { name: "matches", product_ids: [this.selectedProduct] }],
    }));
  }

  setSelectedProduct(productId) {
    const prev = this.selectedProduct;
    if (prev === productId) return;
    this.selectedProduct = productId;
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: "unsubscribe", channels: [{ name: "matches", product_ids: [prev] }] }));
      this.ws.send(JSON.stringify({ type: "subscribe", channels: [{ name: "matches", product_ids: [productId] }] }));
    }
  }

  _scheduleReconnect() {
    this.emit("status", "offline");
    this._startPolling();
    const delay = Math.min(30000, 1000 * 2 ** this.wsAttempts++);
    setTimeout(() => this.connect(), delay);
  }

  /* REST polling fallback so the demo still moves without WS */
  _startPolling() {
    if (this.pollTimer) return;
    const poll = async () => {
      try {
        const t = await this.fetchJson(`/products/${this.selectedProduct}/ticker`);
        const prev = this.tickers[this.selectedProduct] ?? {};
        this._applyTicker(this.selectedProduct, {
          ...prev,
          price: parseFloat(t.price),
          bid: parseFloat(t.bid),
          ask: parseFloat(t.ask),
          time: t.time,
        });
      } catch {}
    };
    this.pollTimer = setInterval(poll, 4000);
    poll();
  }

  _stopPolling() {
    clearInterval(this.pollTimer);
    this.pollTimer = null;
  }
}
