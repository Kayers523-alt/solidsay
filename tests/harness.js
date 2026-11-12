/* Minimal zero-dependency test harness (Node ≥ 18). */
"use strict";
const results = { pass: 0, fail: 0, failures: [] };
function test(name, fn) {
  try { fn(); results.pass++; console.log("  ✓ " + name); }
  catch (e) { results.fail++; results.failures.push(name + ": " + (e && e.message)); console.log("  ✗ " + name + "\n      " + (e && e.stack ? e.stack.split("\n").slice(0, 3).join("\n      ") : e)); }
}
function suite(name, fn) { console.log("\n" + name); fn(); }
function ok(cond, msg) { if (!cond) throw new Error(msg || "assertion failed"); }
function near(a, b, tol, msg) { if (!(Math.abs(a - b) <= tol)) throw new Error((msg || "near") + ": " + a + " vs " + b + " (tol " + tol + ")"); }
function rel(a, b, tol, msg) { const r = Math.abs(a - b) / Math.max(1e-12, Math.abs(b)); if (!(r <= tol)) throw new Error((msg || "rel") + ": " + a + " vs " + b + " (rel err " + (r * 100).toFixed(2) + "% > " + (tol * 100) + "%)"); }
function eq(a, b, msg) { if (a !== b) throw new Error((msg || "eq") + ": " + JSON.stringify(a) + " !== " + JSON.stringify(b)); }
function throws(fn, msg) { let t = false; try { fn(); } catch (e) { t = true; } if (!t) throw new Error(msg || "expected throw"); }
module.exports = { test, suite, ok, near, rel, eq, throws, results };
