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
});
