"use strict";
const fs = require("fs");
const path = require("path");
const { test, suite, ok, near, eq } = require("./harness");
const P = require("../presets.js");
const T = require("../thermal-solver.js");
const EL = require("../electrical-solver.js");

suite("electrical-solver.js — unit tests (resistivity, thickness table, 2-resistor divider, model limits)", function () {
  test("copperResistivity(tempC): 20 °C = 1.68e-8 Ω·m, 100 °C = 1.68e-8 × 1.3144", function () {
    near(EL.copperResistivity(20), 1.68e-8, 1e-18, "ρ(20 °C)");
    near(EL.copperResistivity(100), 1.68e-8 * 1.3144, 1e-18, "ρ(100 °C) = 1.68e-8 * (1 + 0.00393 * 80)");
  });

  test("copper thickness table is locked: 0.5 oz = 17.5 µm, 1 oz = 35 µm, 2 oz = 70 µm", function () {
    eq(EL.copperThicknessUm(0.5), 17.5);
    eq(EL.copperThicknessUm(1), 35.0);
    eq(EL.copperThicknessUm(2), 70.0);
    near(EL.copperThicknessM(0.5), 17.5e-6, 1e-15);
    near(EL.copperThicknessM(1), 35.0e-6, 1e-15);
    near(EL.copperThicknessM(2), 70.0e-6, 1e-15);
    // Cross-sectional area A = W * t_copper: 5 mm trace at 1 oz = 5 * 0.035 = 0.175 mm²
    near(EL.traceCrossSectionMm2(5, 1), 0.175, 1e-12);
    near(EL.traceCrossSectionMm2(5, 0.5), 0.0875, 1e-12);
    near(EL.traceCrossSectionMm2(5, 2), 0.35, 1e-12);
    // Sheet resistance ρ / t halves each time copper weight doubles
    const rsh05 = EL.sheetResistance(0.5, 20);
    const rsh10 = EL.sheetResistance(1, 20);
    const rsh20 = EL.sheetResistance(2, 20);
    near(rsh05 / rsh10, 2.0, 1e-12);
    near(rsh10 / rsh20, 2.0, 1e-12);
  });

  test("2-resistor voltage divider on solveNodalGrid matches exact KCL", function () {
    // 3 nodes in series: node 0 fixed at V_rail = 10.0 V, node 1 (midpoint), node 2 drawing I = 2.0 A
    // Link 0->1 has R1 = 1 Ω (G1 = 1 S); link 1->2 has R2 = 3 Ω (G2 = 1/3 S).
    // Hand calculation:
    //   V[0] = 10.0 V
    //   V[1] = 10.0 - 2.0 * 1.0 = 8.0 V (drop 2.0 V)
    //   V[2] = 8.0 - 2.0 * 3.0  = 2.0 V (total drop 8.0 V; midpoint divides drop 1:3)
    const gx = new Float64Array([1.0, 1.0 / 3.0, 0]);
    const gy = new Float64Array(3);
    const fixed = new Uint8Array([1, 0, 0]);
    const iLoad = new Float64Array([0, 0, 2.0]);
    const sol = EL.solveNodalGrid({ nx: 3, ny: 1, gx: gx, gy: gy, fixed: fixed, iLoad: iLoad, railV: 10.0, tol: 1e-12 });
    ok(sol.converged, "2-resistor divider converged");
    near(sol.V[0], 10.0, 1e-9, "V[0]");
    near(sol.V[1], 8.0, 1e-9, "V[1] midpoint");
    near(sol.V[2], 2.0, 1e-9, "V[2] load");
    ok(sol.localResidual < 1e-10, "localResidual=" + sol.localResidual);
  });

  test("copper: null presets return 'no power delivery in this part' and never invent copper", function () {
    const coldPlate = P.PRESETS.find(function (p) { return p.name === "Cold Plate"; });
    ok(coldPlate && coldPlate.copper === null, "Cold Plate must have copper: null");
    const d = P.designFromPreset(coldPlate);
    eq(d.copper, null);
    const er = EL.solveElectrical(d);
    eq(er.hasPowerDelivery, false);
    eq(er.message, "no power delivery in this part");
    eq(er.worstIrDropDisplay, "no power delivery in this part");
  });

  test("model-limit display flags cap IR drop > railV and current density > 500 A/mm²", function () {
    eq(EL.formatIrDrop(120, 5.0), "120.0 mV");
    ok(/model limit/.test(EL.formatIrDrop(5500, 5.0)), "IR drop > 5000 mV on 5 V rail must show model limit");
    eq(EL.formatCurrentDensity(18.5), "18.50 A/mm²");
    ok(/model limit/.test(EL.formatCurrentDensity(620)), "J > 500 A/mm² must show model limit");
  });
});

suite("electrical-solver.js — ElectroBench-3 independent analytical suite", function () {
  test("all 3 ElectroBench cases pass within < 0.5% of hand-computed reference and < 3% local KCL residual", function () {
    const eb = EL.runElectroBench3();
    ok(eb.allPass, JSON.stringify(eb.cases));
    eq(eb.cases.length, 3);
    eb.cases.forEach(function (c) {
      ok(c.errPct < 0.5, c.id + " errPct=" + c.errPct);
      ok(c.residualPct < 3.0, c.id + " residualPct=" + c.residualPct);
    });
    // EB2 branch current split check: I_A = 2.0 A, I_B = 4.0 A
    const eb2 = eb.cases[1];
    near(eb2.iA, 2.0, 1e-3, "EB2 branch A current");
    near(eb2.iB, 4.0, 1e-3, "EB2 branch B current");
  });

  test("ElectroBench-3 references are hand-computed literals, never calling solver helpers", function () {
    const src = fs.readFileSync(path.join(__dirname, "..", "electrical-solver.js"), "utf8");
    const fnStart = src.indexOf("function runElectroBench3()");
    ok(fnStart > 0, "runElectroBench3 found");
    const fnBody = src.slice(fnStart);
    ok(/ANALYTIC_DROP_MV\s*=\s*48\.0/.test(fnBody), "EB1 literal 48.0 mV present");
    ok(/ANALYTIC_DROP_MV\s*=\s*25\.6/.test(fnBody), "EB2 literal 25.6 mV present");
    ok(/ANALYTIC_DROP_MV\s*=\s*1\.2445338/.test(fnBody), "EB3 literal 1.2445338 mV present");
    // Ensure runElectroBench3 never calls solver helpers to compute its references
    ok(!/copperResistivity\s*\(/.test(fnBody), "runElectroBench3 must not call copperResistivity()");
    ok(!/singleViaConductance\s*\(/.test(fnBody), "runElectroBench3 must not call singleViaConductance()");
    ok(!/sheetResistance\s*\(/.test(fnBody), "runElectroBench3 must not call sheetResistance()");
  });
});

suite("electrical-solver.js — temperature coupling, copper-weight swap + Undo, and 50-preset sweep", function () {
  test("raising ambient temperature increases copper resistivity and IR drop (+0.393%/°C)", function () {
    const d25 = P.designFromPreset(P.FAMOUS_BOARDS[0]); // Raspberry Pi 5 at 25 °C ambient
    d25.amb = 25;
    const d85 = P.clone(d25);
    d85.amb = 85; // +60 °C ambient shift raises every cell temperature by exactly +60 °C

    const tr25 = T.solveThermal(d25);
    const er25 = EL.solveElectrical(d25, tr25);
    const tr85 = T.solveThermal(d85);
    const er85 = EL.solveElectrical(d85, tr85);

    near(tr85.peak - tr25.peak, 60.0, 1e-2, "Peak Tj shifts by +60 °C");
    // Check cell-0 resistivity ratio and IR drop ratio against exact +0.393%/°C formula
    const t0_25 = tr25.grid[0], t0_85 = tr85.grid[0];
    const expectedRatio = (1 + 0.00393 * (t0_85 - 20)) / (1 + 0.00393 * (t0_25 - 20));
    near(er85.rhoGrid[0] / er25.rhoGrid[0], expectedRatio, 1e-6, "Per-cell resistivity ratio matches +0.393%/°C");
    near(er85.worstIrDropMv / er25.worstIrDropMv, expectedRatio, 0.02, "IR drop scales with temperature-coupled resistivity");
  });

  test("copper weight swap (0.5 oz -> 1 oz -> 2 oz) updates IR drop & J, and Undo restores exact state", function () {
    const evalBoth = function (d) {
      const tr = T.solveThermal(d);
      const er = EL.solveElectrical(d, tr);
      return { tj: tr.peak, worstIrDropMv: er.worstIrDropMv, worstCurrentDensityAmm2: er.worstCurrentDensityAmm2 };
    };
    const hist = new P.SwapHistory();
    const d0 = P.designFromPreset(P.FAMOUS_BOARDS[0]); // Pi 5 (1 oz default)
    const er0 = EL.solveElectrical(d0);

    // Swap 1 oz -> 0.5 oz
    const p05 = P.previewSwap(d0, "cu_weight_05oz", evalBoth);
    ok(p05.deltaIrDropMv > 0, "0.5 oz has higher IR drop than 1 oz");
    ok(p05.deltaCurrentDensityAmm2 > 0, "0.5 oz has higher current density than 1 oz");
    const d05 = hist.commit(d0, p05.design);
    eq(d05.copper.copperOz, 0.5);

    // Swap 0.5 oz -> 2 oz
    const p20 = P.previewSwap(d05, "cu_weight_2oz", evalBoth);
    ok(p20.deltaIrDropMv < 0, "2 oz has lower IR drop than 0.5 oz");
    ok(p20.deltaCurrentDensityAmm2 < 0, "2 oz has lower current density than 0.5 oz");
    const d20 = hist.commit(d05, p20.design);
    eq(d20.copper.copperOz, 2.0);
    const er20 = EL.solveElectrical(d20);
    near(er0.worstCurrentDensityAmm2 / er20.worstCurrentDensityAmm2, 2.0, 0.05, "2 oz halves J relative to 1 oz");

    // Undo restores d05
    ok(hist.canUndo());
    const restored = hist.undo();
    eq(restored.copper.copperOz, 0.5);
    eq(JSON.stringify(restored), JSON.stringify(d05));
  });

  test("all 50 presets solve cleanly (25 active with <3% KCL residual, 25 passive with copper: null)", function () {
    let activeCount = 0, nullCount = 0;
    P.PRESETS.forEach(function (p) {
      const d = P.designFromPreset(p);
      const tr = T.solveThermal(d);
      const er = EL.solveElectrical(d, tr);
      ok(tr.converged && tr.localResidual < 0.03, p.name + " thermal convergence");
      if (d.copper) {
        activeCount++;
        ok(er.hasPowerDelivery, p.name + " should have power delivery");
        ok(er.converged && er.localResidual < 0.03, p.name + " electrical local KCL residual=" + er.localResidual);
        ok(isFinite(er.worstIrDropMv) && er.worstIrDropMv > 0, p.name + " worstIrDropMv");
        ok(isFinite(er.worstCurrentDensityAmm2) && er.worstCurrentDensityAmm2 > 0, p.name + " worstCurrentDensityAmm2");
      } else {
        nullCount++;
        eq(er.hasPowerDelivery, false, p.name + " passive");
        eq(er.message, "no power delivery in this part", p.name + " message");
      }
    });
    eq(activeCount, 25, "25 active power-delivery presets");
    eq(nullCount, 25, "25 passive presets with copper: null");
  });

  test("GPU Die previewSwap flags >1000 °C and extreme IR drop does not leak raw >100% percentage", function () {
    const E = require("../exporters.js");
    const gpuPreset = P.PRESETS.find(function (p) { return p.name === "GPU Die"; });
    ok(gpuPreset, "GPU Die preset exists");
    const dGpu = P.designFromPreset(gpuPreset);
    const evalBoth = function (d) {
      const tr = T.solveThermal(d);
      const er = EL.solveElectrical(d, tr);
      return { tj: tr.peak, worstIrDropMv: er.worstIrDropMv, worstCurrentDensityAmm2: er.worstCurrentDensityAmm2 };
    };
    const preview = P.previewSwap(dGpu, "cu_weight_05oz", evalBoth);
    ok(!/5139/.test(preview.text), "GPU Die previewSwap must not print raw 5139°C, got: " + preview.text);
    ok(/>1000 °C/.test(preview.text), "GPU Die previewSwap must flag >1000 °C, got: " + preview.text);
    ok(/model limit/.test(preview.text), "GPU Die previewSwap must note model limit, got: " + preview.text);

    // Extreme IR drop case (> 100% of rail)
    const dExtreme = P.clone(dGpu);
    dExtreme.railV = 0.8;
    dExtreme.copper = { traceWidthMm: 0.2, copperOz: 0.5, layers: 2, vias: 16 };
    const trEx = T.solveThermal(dExtreme);
    const erEx = EL.solveElectrical(dExtreme, trEx);
    ok(erEx.worstIrDropMv > erEx.railV * 1000, "Extreme narrow 0.5oz 0.8V GPU Die triggers >100% rail drop");
    const ctm = E.exportCTM(dExtreme, trEx, erEx);
    ok(ctm.electrical.worstIrDropPct <= 100, "CTM worstIrDropPct must be clamped <= 100");
    ok(/>100% of rail/.test(ctm.electrical.worstIrDropPctDisplay), "CTM worstIrDropPctDisplay flags >100% of rail");
    const gist = E.exportGistSnapshot(dExtreme, trEx, erEx);
    ok(/>1000 °C/.test(gist.result.peakTjDisplay), "Gist peakTjDisplay flags >1000 °C");
    ok(/>100% of rail/.test(gist.result.electrical.worstIrDropPctDisplay), "Gist worstIrDropPctDisplay flags >100% of rail");
    const pdf = E.generatePDFReport(dExtreme, trEx, null, erEx);
    ok(pdf.pdfArrayBuffer, "PDF generated for extreme GPU Die case");
  });
});
