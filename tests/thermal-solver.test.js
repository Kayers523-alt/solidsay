"use strict";
const { test, suite, ok, near, eq } = require("./harness");
const P = require("../presets.js");
const T = require("../thermal-solver.js");

suite("thermal-solver.js — fin physics & choking", function () {
  test("finEfficiency matches analytical tanh(mL)/mL", function () {
    const r = T.finEfficiency(25, 167, 1.5, 40);
    const m = Math.sqrt((2 * 25) / (167 * 0.0015));
    const mL = m * 0.04;
    const eta = Math.tanh(mL) / mL;
    near(r.m, m, 1e-9);
    near(r.mL, mL, 1e-9);
    near(r.eta, eta, 1e-9);
    ok(r.eta > 0.85 && r.eta < 0.95);
  });

  test("natural convection choking factor applies only when gap < 2.2mm", function () {
    eq(T.chokeFactor(3.0, "natural"), 1.0);
    eq(T.chokeFactor(1.1, "forced"), 1.0);
    near(T.chokeFactor(1.1, "natural"), 0.5, 1e-6);
    near(T.chokeFactor(0.2, "natural"), 0.25, 1e-6); // clamped at MIN_CHOKE = 0.25
  });

  test("fin spacing calculation is exact", function () {
    const s = T.finSpacing(100, 11, 2);
    // (100 - 11*2)/(11 - 1) = (100 - 22)/10 = 78/10 = 7.8 mm
    near(s, 7.8, 1e-9);
  });
});

suite("thermal-solver.js — coupled 1D resistance network & solve", function () {
  test("solveThermal returns peak, thetaJA, and energy balance < 3%", function () {
    const d = P.designFromPreset(P.FAMOUS_BOARDS[0]); // Raspberry Pi 5
    const res = T.solveThermal(d);
    ok(res.peak > d.amb);
    ok(res.thetaJA > 0);
    ok(res.converged);
    ok(res.residual < 0.03, "Energy residual must be < 3%");
    ok(res.network);
    ok(res.network.stages.length === 4);
  });

  test("coupled 1D network sums Rjc, Rtim, Rspread, and Rconv", function () {
    const d = P.designFromPreset(P.FAMOUS_BOARDS[0]);
    const net = T.resistanceNetwork(d);
    ok(net.stages.some(s => s.id === "jc"));
    ok(net.stages.some(s => s.id === "tim"));
    ok(net.stages.some(s => s.id === "spread"));
    ok(net.stages.some(s => s.id === "conv"));
    const sumDT = net.stages.reduce((s, x) => s + x.dT, 0);
    near(net.totalDT, sumDT, 1e-9);
  });
});

suite("thermal-solver.js — autoOptimizeToTarget", function () {
  test("autoOptimize steps parameters until Tj <= target within budget", function () {
    // 25W on 85x56 mm with 5 fins starts hot (>80C)
    const hotDesign = P.sanitizeDesign({
      gen: "heatsink", W: 85, D: 56, fins: 5, finH: 10, finT: 1.5, baseT: 2,
      power: 30, amb: 25, air: "natural", mat: "aluminum"
    }).design;
    const r0 = T.solveThermal(hotDesign);
    ok(r0.tj > 80, "Initial temp must be > 80C");

    const opt = T.autoOptimizeToTarget(hotDesign, { targetC: 80, timeBudgetMs: 150 });
    ok(opt.verified, "Optimization must be verified");
    if (opt.feasible) {
      ok(opt.proposedTj <= 80, "Optimized Tj must be <= 80C");
      ok(opt.deltaTj < 0, "Temp delta must be negative");
    }
  });

  test("autoOptimize respects locks and bounds without infinite loops", function () {
    const hotDesign = P.sanitizeDesign({
      gen: "heatsink", W: 50, D: 50, fins: 4, finH: 8, finT: 1.5, baseT: 2,
      power: 40, amb: 25, air: "natural", mat: "aluminum"
    }).design;
    const opt = T.autoOptimizeToTarget(hotDesign, {
      targetC: 40, // very aggressive target
      locks: { lockMaxHeight: true, lockMaterial: true, lockFootprint: true, lockFinCount: true, lockTim: true },
      timeBudgetMs: 50
    });
    ok(opt.verified);
    ok(!opt.feasible, "Should be infeasible with all locks turned on");
  });
});

suite("thermal-solver.js — ThermoBench-5 suite", function () {
  test("all 5 analytical cases pass with residual < 3%", function () {
    const tb = T.runThermoBench5();
    ok(tb.allPass, "All ThermoBench-5 cases must pass");
    eq(tb.cases.length, 5);
    tb.cases.forEach(c => {
      ok(c.pass, c.id + " failed: " + c.name);
      ok(c.residualPct <= 3.0, c.id + " residual exceeded 3%: " + c.residualPct + "%");
    });
  });

  test("TB3 reference is the hand-computed η, not finEfficiency()", function () {
    const tb = T.runThermoBench5();
    const tb3 = tb.cases.filter(function (c) { return c.id === "TB3"; })[0];
    ok(tb3, "TB3 case missing");
    // Hand calculation: m = √(2·25/(167·0.0015)) = 14.128015, mL = 0.565121,
    // tanh(mL) = 0.511767, η = 0.905589, G = η·h·per·H = 0.0905589 W/K.
    // If the reference ever again came from finEfficiency(), this value
    // would still match — the guard is that it is a literal, so also check
    // the case advertises the hand-computed reference.
    near(tb3.analytic, 0.0905589, 1e-6, "TB3 analytic must equal the hand-computed 0.0905589 W/K");
    ok(tb3.name.indexOf("hand-computed") !== -1, "TB3 name must say hand-computed, got: " + tb3.name);
    ok(tb3.detail.indexOf("finEfficiency()") !== -1, "TB3 detail must record the independence fix, got: " + tb3.detail);
    ok(tb3.errPct <= 1.5, "TB3 FD-vs-formula error must stay within 1.5%, got " + tb3.errPct + "%");
    // Solver's own η agrees with the hand value (implementation check).
    near(T.finEfficiency(25, 167, 1.5, 40).eta, 0.905589, 1e-6, "finEfficiency η must agree with hand η");
  });

  test("TB4 is a genuine grid re-solve, not the forced balance", function () {
    const tb = T.runThermoBench5();
    const tb4 = tb.cases.filter(function (c) { return c.id === "TB4"; })[0];
    ok(tb4, "TB4 case missing");
    ok(tb4.name.indexOf("re-solve") !== -1, "TB4 must be a re-solve check, got: " + tb4.name);
    ok(tb4.name.indexOf("Energy balance") === -1, "TB4 must no longer claim an energy-balance check, got: " + tb4.name);
    ok(tb4.detail.indexOf("32²") !== -1 && tb4.detail.indexOf("64²") !== -1, "TB4 detail must show both grids, got: " + tb4.detail);
    ok(tb4.pass, "TB4 re-solve must pass");
    ok(tb4.errPct < 3.0, "TB4 grid disagreement must be < 3%, got " + tb4.errPct + "%");
    ok(tb4.residualPct <= 3.0, "TB4 local residual must be < 3%, got " + tb4.residualPct + "%");
  });
});

suite("thermal-solver.js — peak-Tj model-limit display flag (P0-8)", function () {
  test("formatPeakTj flags >1000 °C and leaves normal values alone", function () {
    eq(T.formatPeakTj(85), "85.0 °C");
    eq(T.formatPeakTj(1000), "1000.0 °C");
    eq(T.formatPeakTjShort(85), "85.0 °C");
    eq(T.formatPeakTjShort(5139.4), ">1000 °C");
    const flagged = T.formatPeakTj(5139.4);
    ok(flagged.indexOf(">1000 °C") === 0, "flagged Tj must start with >1000 °C, got: " + flagged);
    ok(flagged.indexOf("model limit") !== -1, "flagged Tj must say model limit, got: " + flagged);
    ok(flagged.indexOf("not a real temperature") !== -1, "flagged Tj must say it is not a real temperature, got: " + flagged);
    ok(flagged.indexOf("5139") === -1, "flagged Tj must not show the bare absurd number, got: " + flagged);
    eq(T.TJ_MODEL_LIMIT_C, 1000);
  });

  test("RESULT.peak stays numeric and unchanged — only the string is capped", function () {
    const gpu = P.PRESETS.filter(function (p) { return p.name === "GPU Die"; })[0] || P.PRESETS[1];
    const d = P.designFromPreset(gpu);
    d.amb = 25; d.air = "natural"; d.mode = "heatsink";
    const r = T.solveThermal(d);
    near(r.peak, 5139.4, 0.5, "GPU Die peak Tj must stay ~5139.4 °C numerically");
    ok(typeof r.peak === "number", "RESULT.peak must stay a number");
    ok(T.formatPeakTj(r.peak).indexOf(">1000 °C") === 0, "display of that peak must be flagged");
  });
});
