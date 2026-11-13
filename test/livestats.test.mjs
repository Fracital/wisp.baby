// Live stats maths (site/livestats.js): formatting, the series window, the stacked geometry.
// Run: node --test 'test/*.test.mjs'
import { test } from "node:test";
import assert from "node:assert/strict";
import * as ls from "../site/livestats.js";

const SITES = ["iev", "mia", "jnb", "ams", "mnz"];

test("fmtRate: decimal units, three significant figures, no trailing zeros", () => {
  assert.deepEqual(ls.fmtRate(0), { value: "0", units: "bps" });
  assert.deepEqual(ls.fmtRate(999), { value: "999", units: "bps" });
  assert.deepEqual(ls.fmtRate(1500), { value: "1.5", units: "Kbps" });
  assert.deepEqual(ls.fmtRate(123456789), { value: "123", units: "Mbps" });
  assert.deepEqual(ls.fmtRate(8.42e9), { value: "8.42", units: "Gbps" });
  assert.deepEqual(ls.fmtRate(10e9), { value: "10", units: "Gbps" });
  assert.deepEqual(ls.fmtRate(999.7e6), { value: "1", units: "Gbps" });
  assert.deepEqual(ls.fmtRate(-5), { value: "0", units: "bps" });
  assert.deepEqual(ls.fmtRate("nope"), { value: "0", units: "bps" });
});

test("fmtBytes and fmtCount", () => {
  assert.deepEqual(ls.fmtBytes(5.463e12), { value: "5.46", units: "TB" });
  assert.deepEqual(ls.fmtBytes(220.3e9), { value: "220", units: "GB" });
  assert.deepEqual(ls.fmtBytes(12.5e15), { value: "12.5", units: "PB" });
  assert.equal(ls.fmtCount(47672), "47,672");
  assert.equal(ls.fmtCount(1688441), "1.69M");
  assert.equal(ls.fmtCount(2.5e9), "2.5B");
  assert.equal(ls.fmtCount(undefined), "0");
  assert.equal(ls.fmtMs(3.14), "3.1");
  assert.equal(ls.fmtMs(39.4), "39");
  assert.equal(ls.fmtMs(NaN), "–");
});

test("niceScale: clean ticks from 0 that cover the maximum", () => {
  assert.deepEqual(ls.niceScale(5.57e9), { max: 6e9, ticks: [0, 2e9, 4e9, 6e9] });
  assert.deepEqual(ls.niceScale(0).ticks[0], 0);
  const s = ls.niceScale(123);
  assert.ok(s.max >= 123);
  assert.ok(s.ticks.length >= 3 && s.ticks.length <= 7);
  const r = ls.rateTicks([0, 2e9, 4e9, 6e9]);
  assert.deepEqual(r, { units: "Gbps", labels: ["0", "2", "4", "6"] });
});

test("windowFrom takes the newest points and keeps their times", () => {
  const block = { step: 2000, t0: 1_000_000, sites: Object.fromEntries(SITES.map((s, i) => [s, [1, 2, 3, 4].map((v) => v * (i + 1))])) };
  const w = ls.windowFrom(block, 3, SITES);
  assert.equal(w.points, 3);
  assert.equal(w.t0, 1_000_000 + 2000);
  assert.deepEqual(w.values.iev, [2, 3, 4]);
  assert.deepEqual(w.values.mnz, [10, 15, 20]);
  const short = ls.windowFrom(block, 6, SITES);
  assert.deepEqual(short.values.iev, [null, null, 1, 2, 3, 4]);
  assert.equal(short.t0 + 5 * 2000, 1_000_000 + 3 * 2000);
  assert.equal(ls.windowFrom({ step: 0 }, 3, SITES), null);
});

test("mergeTail slides the window by whole steps and fills the overlap", () => {
  const w = ls.emptyWindow(2000, 5, 10_000, ["a"]);
  assert.equal(w.t0, 2000);
  assert.equal(ls.mergeTail(w, { step: 2000, t0: 6000, sites: { a: [1, 2, 3] } }), 0);
  assert.deepEqual(w.values.a, [null, null, 1, 2, 3]);
  // Two newer samples: slides by 2, and the overlapping one is overwritten.
  assert.equal(ls.mergeTail(w, { step: 2000, t0: 10_000, sites: { a: [9, 4, 5] } }), 2);
  assert.equal(w.t0, 6000);
  assert.deepEqual(w.values.a, [1, 2, 9, 4, 5]);
  // A tail far in the future empties the window and keeps only what fits.
  assert.equal(ls.mergeTail(w, { step: 2000, t0: 100_000, sites: { a: [7] } }), 5);
  assert.deepEqual(w.values.a, [null, null, null, null, 7]);
  // Another step is ignored.
  assert.equal(ls.mergeTail(w, { step: 300000, t0: 0, sites: { a: [1] } }), 0);
  assert.equal(ls.lastFilled(w), 4);
});

test("totalAt sums the sites and tells no data from zero", () => {
  const w = ls.emptyWindow(2000, 3, 4000, ["a", "b"]);
  w.values.a = [null, 0, 5];
  w.values.b = [null, null, 7];
  assert.equal(ls.totalAt(w, 0), null);
  assert.equal(ls.totalAt(w, 1), 0);
  assert.equal(ls.totalAt(w, 2), 12);
});

test("stackGeometry stacks bands bottom to top and skips the empty start", () => {
  const w = ls.emptyWindow(2000, 4, 6000, ["a", "b"]);
  w.values.a = [null, 1e9, 1e9, 2e9];
  w.values.b = [null, 1e9, 2e9, 2e9];
  const g = ls.stackGeometry(w, ["a", "b"], 300, 100);
  assert.equal(g.yMax, 4e9);
  assert.equal(g.from, 1);
  assert.equal(g.bands.length, 2);
  // a's top at slot 3 is 2 Gbps (y 50); b's top is 4 Gbps (y 0); both start at slot 1 (x 100).
  assert.match(g.bands[0].line, /^M100 75L200 75L300 50$/);
  assert.match(g.bands[1].line, /^M100 50L200 25L300 0$/);
  assert.ok(g.bands[1].area.endsWith("L100 75Z"));
  assert.equal(ls.slotAt(160, 300, 4), 2);
  assert.equal(ls.slotAt(-50, 300, 4), 0);
  assert.equal(ls.slotAt(999, 300, 4), 3);
});

test("timeTicks: relative labels for 10 min, local hours and days for the long views", () => {
  const m10 = ls.timeTicks("m10", ls.emptyWindow(2000, 300, Date.now(), ["a"]), () => "x");
  assert.deepEqual(m10.map((t) => t.label), ["10 min ago", "5 min ago", "now"]);
  const h24w = ls.emptyWindow(300000, 288, Date.now(), ["a"]);
  const h24 = ls.timeTicks("h24", h24w, (t) => new Date(t).getHours());
  assert.ok(h24.length >= 3 && h24.length <= 5);
  for (const t of h24) assert.equal(t.label % 6, 0);
  const d7 = ls.timeTicks("d7", ls.emptyWindow(3600000, 168, Date.now(), ["a"]), (t) => new Date(t).getHours());
  assert.ok(d7.length >= 6 && d7.length <= 8);
  for (const t of d7) assert.equal(t.label, 0);
});

test("liveSites keeps only well-formed sites and adds the directions", () => {
  const sites = ls.liveSites({
    sites: [
      { site: "mia", city: "Miami", country: "US", up: true, downBps: 9, upBps: 1, sessionsActive: 3 },
      { site: "<img>", city: "x" },
      null,
      { site: "jnb", up: "yes" },
    ],
  });
  assert.deepEqual(sites, [
    { site: "mia", city: "Miami", country: "US", up: true, bps: 10, sessionsActive: 3 },
    { site: "jnb", city: "", country: "", up: false, bps: 0, sessionsActive: 0 },
  ]);
  assert.deepEqual(ls.liveSites({}), []);
  assert.equal(ls.liveAge({ served: 5000, ts: 2000 }), 3000);
  assert.equal(ls.liveAge({}), Infinity);
});

test("liveDomains cleans keys and labels, folds past five into other, other last", () => {
  const doms = ls.liveDomains({
    domains: [
      { key: "other", label: "Other", downBps: 1, upBps: 0, sessionsActive: 1 },
      { key: "wispbaby", label: " wisp.baby ", downBps: 8, upBps: 2, sessionsActive: 3 },
      { key: "Bad Key", label: "x" },
      { key: "a", label: "" }, { key: "b" }, { key: "c" }, { key: "d" },
      { key: "e", downBps: 5, sessionsActive: 2 },
      { key: "wispbaby", label: "dup" },
      null,
    ],
  });
  assert.deepEqual(doms.map((d) => d.key), ["wispbaby", "a", "b", "c", "d", "other"]);
  assert.equal(doms[0].label, "wisp.baby");
  assert.equal(doms[0].bps, 10);
  assert.equal(doms[1].label, "a");
  assert.deepEqual(doms[5], { key: "other", label: "Other", bps: 6, sessionsActive: 3 });
  assert.deepEqual(ls.liveDomains({}), []);
  assert.equal(ls.liveDomains({ domains: [{ key: "x" }] }).length, 1);
});

test("seriesBlock reshapes a field and adds unlisted domains to other", () => {
  const block = { step: 2000, t0: 10, domains: { a: [1, 2], z: [5, 5], other: [1, 1] }, sites: { mia: [3, 4] } };
  assert.deepEqual(ls.seriesBlock(block, "domains", ["a", "other"]), { step: 2000, t0: 10, sites: { a: [1, 2], other: [6, 6] } });
  assert.deepEqual(ls.seriesBlock(block, "domains", ["a"]).sites, { a: [1, 2] });
  assert.deepEqual(ls.seriesBlock(block, "sites", ["mia"]).sites, { mia: [3, 4] });
  assert.equal(ls.seriesBlock({ step: 2000, t0: 0, sites: {} }, "domains", ["a"]), null);
  assert.equal(ls.seriesBlock(null, "domains", ["a"]), null);
  // Feeds mergeTail like a v1 tail.
  const w = ls.emptyWindow(2000, 3, 2010, ["a", "other"]);
  ls.mergeTail(w, ls.seriesBlock(block, "domains", ["a", "other"]));
  assert.deepEqual(w.values.other, [null, 6, 6]);
});

test("domainTotals sums bytes per window and folds unknown domains into other", () => {
  const live = { domainTotals: {
    a: { h5: { bytes: 10 }, d30: { bytes: 100 }, all: { bytes: 1000 } },
    zz: { h5: { bytes: 1 }, d30: { bytes: 2 }, all: { bytes: 3 } },
    other: { h5: { bytes: 4 } },
  } };
  const t = ls.domainTotals(live, ["a", "b", "other"]);
  assert.deepEqual(t.a, { h5: 10, d30: 100, all: 1000 });
  assert.deepEqual(t.b, { h5: null, d30: null, all: null });
  assert.deepEqual(t.other, { h5: 5, d30: 2, all: 3 });
  assert.deepEqual(ls.domainTotals({}, ["a"]).a, { h5: null, d30: null, all: null });
});
