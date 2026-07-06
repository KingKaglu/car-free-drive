/* PulseTrade — candlestick chart (TradingView Lightweight Charts).
   Loads history over REST, then rolls the live candle forward from
   real-time ticker prices.
*/
"use strict";

class PriceChart {
  constructor(host, market) {
    this.host = host;
    this.market = market;
    this.granularity = CONFIG.DEFAULT_GRANULARITY;
    this.productId = CONFIG.DEFAULT_PRODUCT;
    this.lastCandle = null;
    this.loadToken = 0;

    const C = CONFIG.COLORS;
    // Lightweight Charts renders epoch times as UTC; shifting intraday
    // timestamps by the local offset makes the axis read in local time.
    this.tzOffsetSec = -new Date().getTimezoneOffset() * 60;
    this.chart = LightweightCharts.createChart(host, {
      layout: {
        background: { type: "solid", color: "transparent" },
        textColor: C.text,
        fontFamily: "system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif",
        fontSize: 11,
      },
      grid: {
        vertLines: { color: C.grid },
        horzLines: { color: C.grid },
      },
      crosshair: {
        mode: LightweightCharts.CrosshairMode.Normal,
        vertLine: { color: C.border, labelBackgroundColor: "#3a3a38" },
        horzLine: { color: C.border, labelBackgroundColor: "#3a3a38" },
      },
      rightPriceScale: { borderColor: "rgba(255,255,255,0.08)" },
      timeScale: {
        borderColor: "rgba(255,255,255,0.08)",
        timeVisible: true,
        secondsVisible: false,
        rightOffset: 4,
      },
      autoSize: true,
    });

    this.candles = this.chart.addCandlestickSeries({
      upColor: C.up,
      downColor: C.down,
      borderUpColor: C.up,
      borderDownColor: C.down,
      wickUpColor: C.up,
      wickDownColor: C.down,
      priceLineColor: C.accent,
    });

    this.volume = this.chart.addHistogramSeries({
      priceFormat: { type: "volume" },
      priceScaleId: "vol",
      color: C.volume,
      lastValueVisible: false,
      priceLineVisible: false,
    });
    this.chart.priceScale("vol").applyOptions({
      scaleMargins: { top: 0.82, bottom: 0 },
    });

    this.chart.subscribeCrosshairMove((param) => this._onCrosshair(param));

    market.on("price", ({ productId, price, time }) => {
      if (productId === this.productId) this._tick(price, time, 0);
    });
    market.on("match", ({ productId, price, size, time }) => {
      if (productId === this.productId) this._tick(price, time, size);
    });
  }

  async load(productId, granularity) {
    this.productId = productId;
    this.granularity = granularity;
    this.lastCandle = null;
    const token = ++this.loadToken;
    const loadingEl = document.getElementById("chart-loading");
    loadingEl.style.display = "flex";
    loadingEl.textContent = "Loading chart…";

    try {
      const data = await this.market.fetchCandleHistory(productId, granularity);
      if (token !== this.loadToken) return; // superseded by a newer load
      this.candles.setData(data.map((c) => ({
        time: this._displayTime(c.time), open: c.open, high: c.high, low: c.low, close: c.close,
      })));
      this.volume.setData(data.map((c) => ({
        time: this._displayTime(c.time),
        value: c.volume,
        color: c.close >= c.open ? "rgba(12,163,12,0.35)" : "rgba(208,59,59,0.35)",
      })));
      this.lastCandle = data.at(-1) ?? null;
      this.chart.timeScale().scrollToRealTime();
      loadingEl.style.display = "none";
      this._renderLegend(this.lastCandle);
    } catch (err) {
      if (token !== this.loadToken) return;
      loadingEl.textContent = "Couldn't load chart data — check your connection.";
      console.error("chart load failed", err);
    }
  }

  /* Roll the live candle forward from a real-time price */
  _tick(price, isoTime, size) {
    if (!this.lastCandle || !(price > 0)) return;
    const ts = isoTime ? Math.floor(Date.parse(isoTime) / 1000) : Math.floor(Date.now() / 1000);
    const bucket = ts - (ts % this.granularity);
    const c = this.lastCandle;

    if (bucket > c.time) {
      this.lastCandle = { time: bucket, open: price, high: price, low: price, close: price, volume: size };
    } else if (bucket === c.time) {
      c.high = Math.max(c.high, price);
      c.low = Math.min(c.low, price);
      c.close = price;
      c.volume += size;
    } else {
      return; // stale tick from before the current candle
    }

    const lc = this.lastCandle;
    this.candles.update({ time: this._displayTime(lc.time), open: lc.open, high: lc.high, low: lc.low, close: lc.close });
    this.volume.update({
      time: this._displayTime(lc.time),
      value: lc.volume,
      color: lc.close >= lc.open ? "rgba(12,163,12,0.35)" : "rgba(208,59,59,0.35)",
    });
    if (!this._hovering) this._renderLegend(lc);
  }

  /* daily candles stay on their UTC date; intraday shifts to local time */
  _displayTime(t) {
    return this.granularity >= 86400 ? t : t + this.tzOffsetSec;
  }

  _onCrosshair(param) {
    if (!param?.time || !param.seriesData?.size) {
      this._hovering = false;
      this._renderLegend(this.lastCandle);
      return;
    }
    this._hovering = true;
    const c = param.seriesData.get(this.candles);
    if (c) this._renderLegend(c);
  }

  _renderLegend(c) {
    const el = document.getElementById("chart-legend");
    if (!c) { el.innerHTML = ""; return; }
    const dirCls = c.close >= c.open ? "lg-up" : "lg-down";
    el.innerHTML =
      `<span>O <b class="${dirCls}">${fmtPrice(c.open)}</b></span>` +
      `<span>H <b class="${dirCls}">${fmtPrice(c.high)}</b></span>` +
      `<span>L <b class="${dirCls}">${fmtPrice(c.low)}</b></span>` +
      `<span>C <b class="${dirCls}">${fmtPrice(c.close)}</b></span>`;
  }
}
