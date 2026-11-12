// Unit tests for the fast.com algorithm pieces in site/speedtest.js.
// Run: node --test 'test/*.test.mjs'
import test from "node:test";
import assert from "node:assert/strict";
import {
  percentile,
  createStableMovingAverage,
  createStableDeltaStopper,
  rampTarget,
  createSnapshotter,
  loadedLatency,
  unloadedLatency,
} from "../site/speedtest.js";

test("percentile: sort, (n-1)·p, linear interpolation", () => {
  assert.equal(percentile([4, 1, 3, 2], 0.75), 3.25);
  assert.equal(percentile([20, 10], 0.1), 11);
  assert.equal(percentile([5], 0.75), 5);           // fast.com gives NaN here; we don't
  assert.equal(percentile([3, 1, 2], 0), 1);
  assert.equal(percentile([3, 1, 2], 1), 3);
  assert.equal(percentile([1, NaN, "x", 3], 0.5), 2);
  assert.equal(percentile([], 0.5), undefined);
});

test("stableMovingAverage(5): drops the ramp-up, fixes the start on the first slower window", () => {
  const agg = createStableMovingAverage(5);
  const rates = [10, 10, 10, 10, 10, 100, 100, 100, 100, 100, 50];
  const snaps = [];
  const out = [];
  for (const b of rates) {
    snaps.push({ bytes: b, time: 100 });
    out.push(agg(snaps));
  }
  // Under 5 snapshots: the average of all of them (8000 * bytes / ms).
  assert.deepEqual(out.slice(0, 5), [800, 800, 800, 800, 800]);
  // Each window of 5 is faster than the last: adopt it.
  assert.equal(out[5], (8000 * 140) / 500);
  assert.equal(out[9], 8000);
  // [6..10] is slower than [5..9]: the start is fixed at 5, the new snapshot is added.
  assert.ok(Math.abs(out[10] - (8000 * 550) / 600) < 1e-9);
  // From now on every snapshot is added.
  snaps.push({ bytes: 200, time: 100 });
  assert.ok(Math.abs(agg(snaps) - (8000 * 750) / 700) < 1e-9);
});

test("stableMovingAverage: a new attempt (fewer than 5 snapshots) resets", () => {
  const agg = createStableMovingAverage(5);
  const snaps = [];
  for (let i = 0; i < 8; i++) {
    snaps.push({ bytes: 1000, time: 100 });
    agg(snaps);
  }
  assert.equal(agg([{ bytes: 10, time: 100 }]), 800);
});

test("stableMovingAverage: zero time gives 0", () => {
  assert.equal(createStableMovingAverage(5)([{ bytes: 0, time: 0 }]), 0);
});

test("stableDelta stopper (7 s, 30 s, 2 %, 6)", () => {
  const stop = createStableDeltaStopper({ minDuration: 7, maxDuration: 30, stabilityDelta: 2, minStableMeasurements: 6 });
  const m = (...speeds) => speeds.map((speed) => ({ speed }));
  // Max duration always completes.
  assert.equal(stop({ testTime: 30, progressMeasurements: [], speed: 1 }), true);
  // Too few measurements.
  assert.equal(stop({ testTime: 10, progressMeasurements: m(100, 100, 100, 100, 100), speed: 100 }), false);
  // Stable and long enough.
  assert.equal(stop({ testTime: 7, progressMeasurements: m(100, 100, 100, 100, 100, 100), speed: 100 }), true);
  // Stable but too early.
  assert.equal(stop({ testTime: 6.9, progressMeasurements: m(100, 100, 100, 100, 100, 100), speed: 100 }), false);
  // Still rising: the max of the last 3 is the newest.
  assert.equal(stop({ testTime: 10, progressMeasurements: m(100, 100, 100, 100.5, 101, 101.5), speed: 101.5 }), false);
  // Max of the last 3 is the oldest of them, all within 2 %.
  assert.equal(stop({ testTime: 10, progressMeasurements: m(99, 99.5, 100, 101, 100.5, 100), speed: 100 }), true);
  // One of the last 6 is 3 % off.
  assert.equal(stop({ testTime: 10, progressMeasurements: m(103, 100, 100, 100, 100, 100), speed: 100 }), false);
  // Only the last 6 count.
  assert.equal(stop({ testTime: 10, progressMeasurements: m(50, 100, 100, 100, 100, 100, 100), speed: 100 }), true);
});

test("ramp decisions", () => {
  // With one worker the separate "> 0.5 Mb/s and active < 2 → 3" rule wins (fast.com order).
  assert.equal(rampTarget(6e7, 1, 8), 3);
  assert.equal(rampTarget(2e7, 1, 8), 3);
  assert.equal(rampTarget(6e7, 2, 8), 8);
  assert.equal(rampTarget(2e7, 2, 8), 5);
  assert.equal(rampTarget(2e7, 5, 8), 5);
  assert.equal(rampTarget(2e7, 6, 8), 6);
  assert.equal(rampTarget(2e6, 1, 8), 3);
  assert.equal(rampTarget(2e6, 3, 8), 3);
  assert.equal(rampTarget(6e5, 1, 8), 3);   // the separate > 0.5 Mb/s rule
  assert.equal(rampTarget(4e5, 1, 8), 1);
  assert.equal(rampTarget(undefined, 1, 8), 1);
  assert.equal(rampTarget(6e7, 8, 8), 8);
  assert.equal(rampTarget(2e6, 1, 2), 2);    // clamped to max
  assert.equal(rampTarget(6e7, 3, 1), 3);    // already at or over max: no change
});

test("snapshots: wait for every worker, split at the earliest end, union of time", () => {
  const s = createSnapshotter();
  const wm = { a: [{ start: 0, end: 100, bytes: 1000 }], b: [] };
  assert.equal(s.compute(wm), undefined);  // b has nothing yet
  wm.b.push({ start: 0, end: 50, bytes: 500 });
  let snap = s.compute(wm);
  assert.deepEqual(snap, { bytes: 1000, time: 50, start: 0, end: 50 });
  // a carries 50-100 (500 bytes); b's 50-120 is split at 100.
  wm.b.push({ start: 50, end: 120, bytes: 700 });
  snap = s.compute(wm);
  assert.equal(snap.start, 50);
  assert.equal(snap.end, 100);
  assert.equal(snap.time, 50);
  assert.ok(Math.abs(snap.bytes - 1000) < 1e-9);
  // a has nothing new and nothing carried: no snapshot.
  assert.equal(s.compute(wm), undefined);
  // a catches up: the snapshot includes b's carried 100-120.
  wm.a.push({ start: 100, end: 130, bytes: 300 });
  snap = s.compute(wm);
  assert.equal(snap.end, 120);
  assert.ok(Math.abs(snap.bytes - (200 + 200)) < 1e-9);
  assert.equal(s.length(), 3);
  s.reset();
  assert.equal(s.length(), 0);
});

test("snapshots: gaps between measurements are not time", () => {
  const s = createSnapshotter();
  const snap = s.compute({ a: [{ start: 0, end: 10, bytes: 10 }, { start: 20, end: 30, bytes: 10 }] });
  assert.deepEqual(snap, { bytes: 20, time: 20, start: 0, end: 30 });
});

test("loaded latency: min over workers with > 4 samples of their p75", () => {
  assert.deepEqual(loadedLatency({ a: [10, 20, 30, 40, 50], b: [1, 2] }), { value: 40, count: 7 });
  assert.deepEqual(loadedLatency({ a: [10, 20], b: [1, 3] }), { value: 2.5, count: 4 });
  assert.deepEqual(loadedLatency({ a: [] }), { value: null, count: 0 });
});

test("unloaded latency: min over workers of their p10", () => {
  assert.deepEqual(unloadedLatency({ a: [10, 20], b: [30, 40] }), { value: 11, count: 4 });
  assert.deepEqual(unloadedLatency({}), { value: null, count: 0 });
});
