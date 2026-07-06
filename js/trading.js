/* PulseTrade — paper trading engine.
   Long-only spot simulation: $100k starting cash, market + limit orders,
   average-cost positions, 0.10% fee, realized/unrealized P&L, localStorage
   persistence. Emits: "change" (state mutated), "fill" (order executed),
   "reject" (a resting order could not fill and was cancelled).

   Accounting model: cost basis is fee-inclusive. avgEntry is the true
   break-even price (buy price + buy fee amortized), sells realize
   (proceeds - fee) - basis. This makes the identity hold exactly:
     equity - startingCash === realizedPnl + totalUnrealizedPnl
*/
"use strict";

class TradingEngine {
  constructor(market) {
    this.market = market;
    this.listeners = {};
    this.state = this._load() ?? this._freshState();
    // fill resting limit orders as live prices tick
    market.on("price", ({ productId, price }) => this._checkLimitOrders(productId, price));
  }

  on(event, fn) { (this.listeners[event] ??= []).push(fn); }
  emit(event, payload) { for (const fn of this.listeners[event] ?? []) fn(payload); }

  _freshState() {
    return {
      cash: CONFIG.START_CASH,
      realizedPnl: 0,
      positions: {},   // productId -> {qty, avgEntry}
      openOrders: [],  // {id, productId, side, type, limitPrice, qty, created}
      history: [],     // fills, newest first
      equityCurve: [], // [ts, equity]
      startedAt: Date.now(),
    };
  }

  reset() {
    this.state = this._freshState();
    this._save();
    this.emit("change");
  }

  _load() {
    try {
      const raw = localStorage.getItem(CONFIG.STORAGE_KEY);
      if (!raw) return null;
      const s = JSON.parse(raw);
      if (typeof s.cash !== "number") return null;
      return s;
    } catch { return null; }
  }

  _save() {
    try { localStorage.setItem(CONFIG.STORAGE_KEY, JSON.stringify(this.state)); } catch {}
  }

  /* ---------- derived values ---------- */

  position(productId) { return this.state.positions[productId] ?? null; }

  positionValue(productId) {
    const pos = this.position(productId);
    const price = this.market.price(productId);
    return pos && price ? pos.qty * price : 0;
  }

  unrealizedPnl(productId) {
    const pos = this.position(productId);
    const price = this.market.price(productId);
    if (!pos || !price) return 0;
    return (price - pos.avgEntry) * pos.qty;
  }

  totalUnrealizedPnl() {
    return Object.keys(this.state.positions).reduce((s, id) => s + this.unrealizedPnl(id), 0);
  }

  equity() {
    const holdings = Object.keys(this.state.positions).reduce((s, id) => s + this.positionValue(id), 0);
    return this.state.cash + holdings;
  }

  /* cash committed to resting limit BUY orders (fee included) */
  reservedCash(excludeId) {
    return this.state.openOrders
      .filter((o) => o.side === "buy" && o.id !== excludeId)
      .reduce((s, o) => s + o.qty * o.limitPrice * (1 + CONFIG.FEE_RATE), 0);
  }

  /* cash actually free to spend on a new order */
  availableCash() {
    return Math.max(0, this.state.cash - this.reservedCash());
  }

  /* qty free to sell: held minus qty committed to resting limit sells */
  availableQty(productId) {
    const held = this.position(productId)?.qty ?? 0;
    return Math.max(0, held - this._reservedQty(productId));
  }

  recordEquityPoint() {
    const eq = this.equity();
    const curve = this.state.equityCurve;
    curve.push([Date.now(), Math.round(eq * 100) / 100]);
    if (curve.length > 720) curve.splice(0, curve.length - 720);
    this._save();
  }

  /* ---------- order placement ---------- */

  /** Place an order. Returns {ok:true, fill?} or {ok:false, error}. */
  placeOrder({ productId, side, type, qty, limitPrice }) {
    const mark = this.market.price(productId);
    if (!mark) return { ok: false, error: "No live price yet for this market — try again in a moment." };
    if (!(qty > 0)) return { ok: false, error: "Enter an amount greater than zero." };

    if (type === "limit") {
      if (!(limitPrice > 0)) return { ok: false, error: "Enter a valid limit price." };
      // Marketable limit orders execute immediately, at the (better) market price
      const marketable = side === "buy" ? mark <= limitPrice : mark >= limitPrice;
      if (marketable) return this._execute({ productId, side, type: "limit", qty, price: mark });

      if (side === "buy") {
        const cost = qty * limitPrice * (1 + CONFIG.FEE_RATE);
        const free = this.availableCash();
        if (cost > free + 1e-9) {
          return { ok: false, error: `Insufficient cash: need ${fmtUsd(cost)}, ${fmtUsd(free)} free (open buy orders reserve the rest).` };
        }
      } else {
        const free = this.availableQty(productId);
        if (qty > free + 1e-12) {
          return { ok: false, error: `Insufficient ${productId.split("-")[0]}: ${fmtQty(free)} available (open sell orders reserve the rest).` };
        }
      }
      this.state.openOrders.push({
        id: crypto.randomUUID(), productId, side, type, limitPrice, qty, created: Date.now(),
      });
      this._save();
      this.emit("change");
      return { ok: true, resting: true };
    }

    // market orders may not touch cash/qty reserved by resting limit orders
    if (side === "sell") {
      const free = this.availableQty(productId);
      if (qty > free + 1e-12) {
        return { ok: false, error: `Insufficient ${productId.split("-")[0]}: ${fmtQty(free)} available (open sell orders reserve the rest).` };
      }
    } else {
      const cost = qty * mark * (1 + CONFIG.FEE_RATE);
      const free = this.availableCash();
      if (cost > free + 1e-9) {
        return { ok: false, error: `Insufficient cash: need ${fmtUsd(cost)}, ${fmtUsd(free)} free (open buy orders reserve the rest).` };
      }
    }
    return this._execute({ productId, side, type: "market", qty, price: mark });
  }

  /* qty already committed to resting sell orders for this product */
  _reservedQty(productId) {
    return this.state.openOrders
      .filter((o) => o.productId === productId && o.side === "sell")
      .reduce((s, o) => s + o.qty, 0);
  }

  cancelOrder(id) {
    const i = this.state.openOrders.findIndex((o) => o.id === id);
    if (i === -1) return;
    this.state.openOrders.splice(i, 1);
    this._save();
    this.emit("change");
  }

  closePosition(productId) {
    const pos = this.position(productId);
    if (!pos) return { ok: false, error: "No position." };
    // closing means selling everything: resting sells on this market are cancelled first
    this.state.openOrders = this.state.openOrders.filter(
      (o) => !(o.productId === productId && o.side === "sell"));
    return this._execute({ productId, side: "sell", type: "market", qty: pos.qty, price: this.market.price(productId) });
  }

  _checkLimitOrders(productId, price) {
    const due = this.state.openOrders.filter(
      (o) => o.productId === productId &&
        (o.side === "buy" ? price <= o.limitPrice : price >= o.limitPrice)
    );
    for (const o of due) {
      this.state.openOrders = this.state.openOrders.filter((x) => x.id !== o.id);
      const res = this._execute({ productId: o.productId, side: o.side, type: "limit", qty: o.qty, price: o.limitPrice });
      if (!res.ok) {
        // couldn't honor the resting order (e.g. balance changed) — surface it
        this.emit("reject", { order: o, reason: res.error });
        this.emit("change");
      }
    }
  }

  /* ---------- execution ---------- */

  _execute({ productId, side, type, qty, price }) {
    if (!(price > 0)) return { ok: false, error: "No live price for this market." };
    const value = qty * price;
    const fee = value * CONFIG.FEE_RATE;
    const s = this.state;
    let realized = 0;

    if (side === "buy") {
      const cost = value + fee;
      if (cost > s.cash + 1e-9) {
        return { ok: false, error: `Insufficient cash: need ${fmtUsd(cost)}, have ${fmtUsd(s.cash)}.` };
      }
      s.cash -= cost;
      const pos = s.positions[productId];
      if (pos) {
        // fee-inclusive average cost: avgEntry is the break-even price
        pos.avgEntry = (pos.avgEntry * pos.qty + cost) / (pos.qty + qty);
        pos.qty += qty;
      } else {
        s.positions[productId] = { qty, avgEntry: cost / qty };
      }
    } else {
      const pos = s.positions[productId];
      if (!pos || qty > pos.qty + 1e-12) {
        return { ok: false, error: `Insufficient ${productId.split("-")[0]} to sell.` };
      }
      qty = Math.min(qty, pos.qty);
      realized = (value - fee) - pos.avgEntry * qty; // proceeds minus fee-inclusive basis
      s.cash += value - fee;
      s.realizedPnl += realized;
      pos.qty -= qty;
      if (pos.qty <= 1e-12) delete s.positions[productId];
    }

    const fill = {
      id: crypto.randomUUID(),
      time: Date.now(),
      productId, side, type, price, qty,
      value, fee,
      realized: side === "sell" ? realized : null,
    };
    s.history.unshift(fill);
    if (s.history.length > 200) s.history.length = 200;

    this.recordEquityPoint();
    this._save();
    this.emit("fill", fill);
    this.emit("change");
    return { ok: true, fill };
  }
}
