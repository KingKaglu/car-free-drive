/* PulseTrade — bootstrap */
"use strict";

window.addEventListener("DOMContentLoaded", () => {
  const market = new MarketData();
  const engine = new TradingEngine(market);
  const chart = new PriceChart(document.getElementById("chart-host"), market);
  const ui = new UI(market, engine, chart);

  // active timeframe button drives the initial chart load
  const activeTf = document.querySelector("#tf-group button.active");
  chart.load(CONFIG.DEFAULT_PRODUCT, parseInt(activeTf.dataset.tf, 10));

  market.primeAll();   // REST snapshot so the watchlist fills immediately
  market.connect();    // then stream everything live

  // expose for curious devtools users
  window.pulsetrade = { market, engine, chart, ui };
});
