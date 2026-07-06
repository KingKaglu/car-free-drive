/* PulseTrade — DOM rendering & interactions. */
"use strict";

class UI {
  constructor(market, engine, chart) {
    this.market = market;
    this.engine = engine;
    this.chart = chart;

    this.selected = CONFIG.DEFAULT_PRODUCT;
    this.side = "buy";
    this.orderType = "market";
    this.amountUnit = "usd"; // "usd" | "base"
    this.sparks = {};        // productId -> [{close}...]

    this._buildWatchlist();
    this._bindOrderPanel();
    this._bindTabs();
    this._bindMisc();

    market.on("price", (t) => this._onPrice(t));
    market.on("match", (m) => this._onMatch(m));
    market.on("status", (s) => this._onStatus(s));
    engine.on("change", () => this.renderAccount());
    engine.on("fill", (f) => this._onFill(f));
    engine.on("reject", ({ order, reason }) =>
      this.toast(`Limit ${order.side} cancelled — ${order.productId}`, reason, "error"));

    this.renderAccount();
    // live P&L / equity refresh
    setInterval(() => this.renderAccount(), 2000);
    setInterval(() => { this.engine.recordEquityPoint(); this._drawEquitySpark(); }, 30000);
  }

  get baseCcy() { return this.selected.split("-")[0]; }

  /* ================= Watchlist ================= */

  _buildWatchlist() {
    const ul = document.getElementById("watchlist");
    ul.innerHTML = "";
    for (const p of CONFIG.PRODUCTS) {
      const li = document.createElement("li");
      li.className = "wl-row" + (p.id === this.selected ? " active" : "");
      li.dataset.product = p.id;
      li.setAttribute("role", "option");
      li.innerHTML = `
        <span class="wl-sym"><span class="wl-base">${p.base}</span><span class="wl-quote">-USD</span></span>
        <span class="wl-price" data-f="price">—</span>
        <span class="wl-name">${p.name}</span>
        <span class="wl-change" data-f="change">—</span>
        <canvas class="wl-spark" width="220" height="26" aria-hidden="true"></canvas>`;
      li.addEventListener("click", () => this.selectProduct(p.id));
      ul.appendChild(li);
    }

    document.getElementById("watchlist-filter").addEventListener("input", (e) => {
      const q = e.target.value.trim().toLowerCase();
      for (const li of ul.children) {
        const p = CONFIG.PRODUCTS.find((x) => x.id === li.dataset.product);
        li.style.display = !q || p.id.toLowerCase().includes(q) || p.name.toLowerCase().includes(q) ? "" : "none";
      }
    });

  }

  /* one 24h hourly-candle fetch per product, staggered for rate limits.
     Called from app.js after the watchlist prime finishes so the two
     REST bursts don't overlap. */
  async loadSparks() {
    for (const p of CONFIG.PRODUCTS) {
      try {
        const end = new Date();
        const start = new Date(end - 24 * 3600e3);
        const candles = await this.market.fetchCandles(p.id, 3600, start, end);
        this.sparks[p.id] = candles;
        this._drawSpark(p.id);
      } catch {}
      await new Promise((r) => setTimeout(r, 250));
    }
  }

  _drawSpark(productId) {
    const li = document.querySelector(`.wl-row[data-product="${productId}"]`);
    const candles = this.sparks[productId];
    if (!li || !candles?.length) return;
    const cv = li.querySelector(".wl-spark");
    const ctx = cv.getContext("2d");
    const w = cv.width, h = cv.height;
    ctx.clearRect(0, 0, w, h);

    const vals = candles.map((c) => c.close);
    const live = this.market.price(productId);
    if (live) vals.push(live);
    const min = Math.min(...vals), max = Math.max(...vals);
    const range = max - min || 1;
    const up = vals.at(-1) >= vals[0];
    ctx.strokeStyle = up ? CONFIG.COLORS.up : CONFIG.COLORS.down;
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    vals.forEach((v, i) => {
      const x = (i / (vals.length - 1)) * (w - 2) + 1;
      const y = h - 2 - ((v - min) / range) * (h - 4);
      i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
    });
    ctx.stroke();
  }

  selectProduct(productId) {
    if (this.selected === productId) return;
    this.selected = productId;
    document.querySelectorAll(".wl-row").forEach((li) =>
      li.classList.toggle("active", li.dataset.product === productId));
    document.getElementById("ss-pair").textContent = productId;
    document.getElementById("trades-symbol").textContent = productId;
    document.getElementById("trades-feed").innerHTML = "";
    document.getElementById("order-error").hidden = true;
    this.market.setSelectedProduct(productId);
    this.chart.load(productId, this.chart.granularity);
    this._renderHeader(this.market.tickers[productId]);
    this._syncOrderPanel();
    this._updateEstimates();
  }

  /* ================= price stream ================= */

  _onPrice(t) {
    const li = document.querySelector(`.wl-row[data-product="${t.productId}"]`);
    if (li) {
      const priceEl = li.querySelector('[data-f="price"]');
      priceEl.textContent = fmtPrice(t.price);
      if (t.price !== t.prevPrice) {
        priceEl.classList.remove("tick-up", "tick-down");
        void priceEl.offsetWidth; // restart transition
        priceEl.classList.add(t.price > t.prevPrice ? "tick-up" : "tick-down");
      }
      const chg = t.open24h ? ((t.price - t.open24h) / t.open24h) * 100 : null;
      const chgEl = li.querySelector('[data-f="change"]');
      chgEl.textContent = fmtPct(chg);
      chgEl.className = "wl-change " + signClass(chg);
    }
    if (t.productId === this.selected) {
      this._renderHeader(t);
      this._updateEstimates();
    }
  }

  _renderHeader(t) {
    if (!t) {
      for (const id of ["ss-price", "ss-high", "ss-low", "ss-vol", "ss-spread"])
        document.getElementById(id).textContent = "—";
      document.getElementById("ss-change").textContent = "—";
      return;
    }
    const priceEl = document.getElementById("ss-price");
    priceEl.textContent = fmtUsd(t.price);
    if (t.price !== t.prevPrice) {
      priceEl.classList.remove("tick-up", "tick-down");
      void priceEl.offsetWidth;
      priceEl.classList.add(t.price > t.prevPrice ? "tick-up" : "tick-down");
    }
    const chg = t.open24h ? ((t.price - t.open24h) / t.open24h) * 100 : null;
    const chgEl = document.getElementById("ss-change");
    chgEl.textContent = fmtPct(chg);
    chgEl.className = "ss-change badge " + signClass(chg);
    document.getElementById("ss-high").textContent = fmtPrice(t.high24h);
    document.getElementById("ss-low").textContent = fmtPrice(t.low24h);
    document.getElementById("ss-vol").textContent = t.volume24h ? `${fmtCompact(t.volume24h)} ${this.baseCcy}` : "—";
    document.getElementById("ss-spread").textContent =
      t.bid && t.ask ? `${fmtPrice(t.bid)} / ${fmtPrice(t.ask)}` : "—";
    document.title = `${fmtPrice(t.price)} ${this.selected} · PulseTrade`;
  }

  _onMatch(m) {
    const feed = document.getElementById("trades-feed");
    const li = document.createElement("li");
    // maker side "buy" means an aggressive sell hit the bid → downtick
    const dir = m.side === "buy" ? "down" : "up";
    const time = new Date(m.time ?? Date.now()).toLocaleTimeString("en-US", { hour12: false });
    li.innerHTML = `
      <span class="t-price ${dir}">${fmtPrice(m.price)}</span>
      <span class="t-size">${fmtQty(m.size)}</span>
      <span class="t-time">${time}</span>`;
    feed.prepend(li);
    while (feed.children.length > 60) feed.lastChild.remove();
  }

  _onStatus(state) {
    const conn = document.getElementById("conn");
    conn.dataset.state = state;
    conn.querySelector(".conn-label").textContent =
      state === "live" ? "Live" : state === "connecting" ? "Connecting" : "Reconnecting…";
  }

  /* ================= Order panel ================= */

  _bindOrderPanel() {
    document.querySelectorAll(".side-btn").forEach((btn) =>
      btn.addEventListener("click", () => {
        this.side = btn.dataset.side;
        document.getElementById("order-error").hidden = true;
        document.querySelectorAll(".side-btn").forEach((b) => {
          b.classList.toggle("active", b === btn);
          b.setAttribute("aria-selected", b === btn);
        });
        this._syncOrderPanel();
        this._updateEstimates();
      }));

    document.querySelectorAll(".type-btn").forEach((btn) =>
      btn.addEventListener("click", () => {
        this.orderType = btn.dataset.type;
        document.getElementById("order-error").hidden = true;
        document.querySelectorAll(".type-btn").forEach((b) => {
          b.classList.toggle("active", b === btn);
          b.setAttribute("aria-selected", b === btn);
        });
        document.getElementById("limit-field").hidden = this.orderType !== "limit";
        if (this.orderType === "limit" && !document.getElementById("limit-price").value) {
          const p = this.market.price(this.selected);
          if (p) document.getElementById("limit-price").value = fmtPrice(p).replaceAll(",", "");
        }
        this._updateEstimates();
      }));

    document.getElementById("unit-swap").addEventListener("click", () => {
      this.amountUnit = this.amountUnit === "usd" ? "base" : "usd";
      document.getElementById("order-amount").value = "";
      this._syncOrderPanel();
      this._updateEstimates();
    });

    document.querySelectorAll(".pct-row button").forEach((btn) =>
      btn.addEventListener("click", () => {
        const pct = parseFloat(btn.dataset.pct);
        const input = document.getElementById("order-amount");
        if (this.side === "buy") {
          // spend pct of free cash (fee-adjusted so Max actually fits)
          const spend = (this.engine.availableCash() * pct) / (1 + CONFIG.FEE_RATE);
          if (this.amountUnit === "usd") input.value = spend > 0 ? spend.toFixed(2) : "";
          else {
            const p = this._workingPrice();
            input.value = p ? (spend / p).toFixed(6) : "";
          }
        } else {
          const qty = this.engine.availableQty(this.selected) * pct;
          if (this.amountUnit === "base") input.value = qty ? qty.toFixed(8).replace(/\.?0+$/, "") : "";
          else {
            const p = this._workingPrice();
            input.value = p && qty ? (qty * p).toFixed(2) : "";
          }
        }
        this._updateEstimates();
      }));

    for (const id of ["order-amount", "limit-price"])
      document.getElementById(id).addEventListener("input", () => {
        document.getElementById("order-error").hidden = true;
        this._updateEstimates();
      });

    document.getElementById("submit-order").addEventListener("click", () => this._submitOrder());
    this._syncOrderPanel();
  }

  _workingPrice() {
    if (this.orderType === "limit") {
      const lp = parseFloat(document.getElementById("limit-price").value);
      if (lp > 0) return lp;
    }
    return this.market.price(this.selected);
  }

  _orderQty() {
    const amt = parseFloat(document.getElementById("order-amount").value);
    if (!(amt > 0)) return null;
    if (this.amountUnit === "base") return amt;
    const p = this._workingPrice();
    return p ? amt / p : null;
  }

  _syncOrderPanel() {
    const base = this.baseCcy;
    document.getElementById("amount-unit").textContent = this.amountUnit === "usd" ? "USD" : base;
    document.getElementById("unit-swap-label").textContent = this.amountUnit === "usd" ? `use ${base}` : "use USD";
    document.getElementById("est-qty-label").textContent = this.amountUnit === "usd" ? "qty" : "value";
    const btn = document.getElementById("submit-order");
    btn.textContent = `${this.side === "buy" ? "Buy" : "Sell"} ${base}`;
    btn.className = `submit-btn ${this.side}`;
    const avail = this.side === "buy"
      ? fmtUsd(this.engine.availableCash())
      : `${fmtQty(this.engine.availableQty(this.selected))} ${base}`;
    document.getElementById("avail-note").textContent = avail;
  }

  _updateEstimates() {
    const p = this._workingPrice();
    const qty = this._orderQty();
    const value = p && qty ? p * qty : null;
    const fee = value ? value * CONFIG.FEE_RATE : null;
    document.getElementById("est-price").textContent =
      p ? (this.orderType === "limit" ? `${fmtUsd(p)} limit` : `~${fmtUsd(p)}`) : "—";
    document.getElementById("est-qty").textContent =
      qty ? (this.amountUnit === "usd" ? `${fmtQty(qty)} ${this.baseCcy}` : fmtUsd(value)) : "—";
    document.getElementById("est-fee").textContent = fee != null ? fmtUsd(fee) : "—";
    document.getElementById("est-total").textContent =
      value != null ? fmtUsd(this.side === "buy" ? value + fee : value - fee) : "—";
    this._syncOrderPanel();
  }

  _submitOrder() {
    const qty = this._orderQty();
    const res = this.engine.placeOrder({
      productId: this.selected,
      side: this.side,
      type: this.orderType,
      qty,
      limitPrice: this.orderType === "limit" ? parseFloat(document.getElementById("limit-price").value) : undefined,
    });
    const errEl = document.getElementById("order-error");
    if (!res.ok) {
      errEl.textContent = res.error;
      errEl.hidden = false;
      return;
    }
    errEl.hidden = true;
    document.getElementById("order-amount").value = "";
    if (res.resting) {
      this.toast(`Limit order placed`, `${this.side.toUpperCase()} ${fmtQty(qty)} ${this.baseCcy} @ ${fmtUsd(parseFloat(document.getElementById("limit-price").value))}`, this.side);
      this._activateTab("orders");
    }
    this._updateEstimates();
  }

  _onFill(f) {
    this.toast(
      `${f.side === "buy" ? "Bought" : "Sold"} ${fmtQty(f.qty)} ${f.productId.split("-")[0]}`,
      `@ ${fmtUsd(f.price)} · total ${fmtUsd(f.value)}${f.realized != null ? ` · P&L ${fmtUsd(f.realized)}` : ""}`,
      f.side
    );
  }

  /* ================= Tabs & tables ================= */

  _bindTabs() {
    document.querySelectorAll(".tab").forEach((tab) =>
      tab.addEventListener("click", () => this._activateTab(tab.dataset.tab)));
  }

  _activateTab(name) {
    document.querySelectorAll(".tab").forEach((t) => {
      const on = t.dataset.tab === name;
      t.classList.toggle("active", on);
      t.setAttribute("aria-selected", on);
    });
    document.querySelectorAll(".tab-pane").forEach((p) =>
      p.classList.toggle("active", p.id === `pane-${name}`));
    if (name === "account") this._drawEquitySpark();
  }

  renderAccount() {
    const s = this.engine.state;
    const equity = this.engine.equity();
    const upnl = this.engine.totalUnrealizedPnl();
    const delta = equity - CONFIG.START_CASH;

    document.getElementById("equity-value").textContent = fmtUsd(equity);
    const deltaEl = document.getElementById("equity-delta");
    deltaEl.textContent = delta === 0 ? "" : `${delta > 0 ? "+" : ""}${fmtUsd(delta)}`;
    deltaEl.className = "equity-delta " + signClass(delta);

    // account tab tiles
    document.getElementById("acct-equity").textContent = fmtUsd(equity);
    const eqd = document.getElementById("acct-equity-delta");
    eqd.textContent = `${delta >= 0 ? "+" : ""}${fmtUsd(delta)} (${fmtPct((delta / CONFIG.START_CASH) * 100)}) all-time`;
    eqd.className = "stat-sub " + signClass(delta);
    document.getElementById("acct-cash").textContent = fmtUsd(s.cash);
    const upnlEl = document.getElementById("acct-upnl");
    upnlEl.textContent = fmtUsd(upnl);
    upnlEl.className = "stat-value " + signClass(upnl);
    const rpnlEl = document.getElementById("acct-rpnl");
    rpnlEl.textContent = fmtUsd(s.realizedPnl);
    rpnlEl.className = "stat-value " + signClass(s.realizedPnl);
    document.getElementById("acct-trades").textContent = `${s.history.length} trade${s.history.length === 1 ? "" : "s"}`;

    this._renderPositions();
    this._renderOrders();
    this._renderHistory();
    this._syncOrderPanel();
  }

  _renderPositions() {
    const body = document.getElementById("positions-body");
    const ids = Object.keys(this.engine.state.positions);
    document.getElementById("count-positions").textContent = ids.length;
    document.getElementById("positions-empty").style.display = ids.length ? "none" : "";
    body.innerHTML = "";
    for (const id of ids) {
      const pos = this.engine.state.positions[id];
      const mark = this.market.price(id);
      const value = mark ? pos.qty * mark : null;
      const pnl = mark ? (mark - pos.avgEntry) * pos.qty : null;
      const pnlPct = mark ? ((mark - pos.avgEntry) / pos.avgEntry) * 100 : null;
      const tr = document.createElement("tr");
      tr.innerHTML = `
        <td class="sym">${id}</td>
        <td class="num">${fmtQty(pos.qty)} ${id.split("-")[0]}</td>
        <td class="num">${fmtUsd(pos.avgEntry)}</td>
        <td class="num">${fmtUsd(mark)}</td>
        <td class="num">${fmtUsd(value)}</td>
        <td class="num ${signClass(pnl)}">${pnl != null ? `${pnl >= 0 ? "+" : ""}${fmtUsd(pnl)} (${fmtPct(pnlPct)})` : "—"}</td>
        <td class="num"><button class="row-btn danger" data-close="${id}">Close</button></td>`;
      tr.querySelector("[data-close]").addEventListener("click", () => {
        const res = this.engine.closePosition(id);
        if (!res.ok) this.toast("Couldn't close position", res.error, "error");
      });
      body.appendChild(tr);
    }
  }

  _renderOrders() {
    const body = document.getElementById("orders-body");
    const orders = this.engine.state.openOrders;
    document.getElementById("count-orders").textContent = orders.length;
    document.getElementById("orders-empty").style.display = orders.length ? "none" : "";
    body.innerHTML = "";
    for (const o of orders) {
      const tr = document.createElement("tr");
      tr.innerHTML = `
        <td class="sym">${o.productId}</td>
        <td class="side-${o.side}">${o.side.toUpperCase()}</td>
        <td class="muted">Limit</td>
        <td class="num">${fmtUsd(o.limitPrice)}</td>
        <td class="num">${fmtQty(o.qty)}</td>
        <td class="num">${fmtUsd(o.qty * o.limitPrice)}</td>
        <td class="muted">${new Date(o.created).toLocaleTimeString("en-US", { hour12: false })}</td>
        <td class="num"><button class="row-btn" data-cancel="${o.id}">Cancel</button></td>`;
      tr.querySelector("[data-cancel]").addEventListener("click", () => this.engine.cancelOrder(o.id));
      body.appendChild(tr);
    }
  }

  _renderHistory() {
    const body = document.getElementById("history-body");
    const fills = this.engine.state.history.slice(0, 50);
    document.getElementById("history-empty").style.display = fills.length ? "none" : "";
    body.innerHTML = "";
    for (const f of fills) {
      const tr = document.createElement("tr");
      tr.innerHTML = `
        <td class="muted">${new Date(f.time).toLocaleString("en-US", { hour12: false, month: "short", day: "numeric" })}</td>
        <td class="sym">${f.productId}</td>
        <td class="side-${f.side}">${f.side.toUpperCase()}</td>
        <td class="muted">${f.type === "limit" ? "Limit" : "Market"}</td>
        <td class="num">${fmtUsd(f.price)}</td>
        <td class="num">${fmtQty(f.qty)}</td>
        <td class="num">${fmtUsd(f.value)}</td>
        <td class="num muted">${fmtUsd(f.fee)}</td>
        <td class="num ${f.realized != null ? signClass(f.realized) : "muted"}">${f.realized != null ? `${f.realized >= 0 ? "+" : ""}${fmtUsd(f.realized)}` : "—"}</td>`;
      body.appendChild(tr);
    }
  }

  _drawEquitySpark() {
    const cv = document.getElementById("equity-spark");
    const ctx = cv.getContext("2d");
    const curve = this.engine.state.equityCurve;
    const w = cv.width, h = cv.height;
    ctx.clearRect(0, 0, w, h);
    const vals = curve.map((p) => p[1]);
    vals.push(this.engine.equity());
    if (vals.length < 2) vals.unshift(CONFIG.START_CASH);
    const min = Math.min(...vals, CONFIG.START_CASH);
    const max = Math.max(...vals, CONFIG.START_CASH);
    const range = max - min || 1;
    const y = (v) => h - 4 - ((v - min) / range) * (h - 8);

    // baseline at starting cash
    ctx.strokeStyle = "rgba(255,255,255,0.15)";
    ctx.setLineDash([3, 4]);
    ctx.beginPath();
    ctx.moveTo(0, y(CONFIG.START_CASH));
    ctx.lineTo(w, y(CONFIG.START_CASH));
    ctx.stroke();
    ctx.setLineDash([]);

    const up = vals.at(-1) >= CONFIG.START_CASH;
    ctx.strokeStyle = up ? CONFIG.COLORS.up : CONFIG.COLORS.down;
    ctx.lineWidth = 2;
    ctx.beginPath();
    vals.forEach((v, i) => {
      const x = (i / (vals.length - 1)) * (w - 4) + 2;
      i ? ctx.lineTo(x, y(v)) : ctx.moveTo(x, y(v));
    });
    ctx.stroke();
  }

  /* ================= misc ================= */

  _bindMisc() {
    document.getElementById("reset-account").addEventListener("click", () => {
      if (confirm("Reset your demo account to $100,000? All positions, orders and history will be cleared.")) {
        this.engine.reset();
        this.toast("Account reset", "Fresh start: $100,000.00 virtual cash.", "buy");
        this._drawEquitySpark();
      }
    });

    document.querySelectorAll("#tf-group button").forEach((btn) =>
      btn.addEventListener("click", () => {
        document.querySelectorAll("#tf-group button").forEach((b) => {
          b.classList.toggle("active", b === btn);
          b.setAttribute("aria-selected", b === btn);
        });
        this.chart.load(this.selected, parseInt(btn.dataset.tf, 10));
      }));
  }

  toast(title, sub, kind = "") {
    const stack = document.getElementById("toast-stack");
    const el = document.createElement("div");
    el.className = `toast ${kind}`;
    el.innerHTML = `<b>${title}</b><span class="toast-sub">${sub}</span>`;
    stack.appendChild(el);
    setTimeout(() => { el.classList.add("out"); setTimeout(() => el.remove(), 350); }, 4200);
  }
}
