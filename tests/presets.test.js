"use strict";
const { test, suite, ok, near, eq, throws } = require("./harness");
const P = require("../presets.js");

suite("presets.js — catalog & presets", function () {
  test("50 presets = 46 legacy + 4 ProtoFlow", function () {
    eq(P.PRESETS.length, 50);
    eq(P.PRESETS.filter(function (p) { return p.cat === 6; }).length, 4);
  });
  test("ProtoFlow boards have the specified ids, sizes and power", function () {
    const want = {
      preset_eth_gateway: { W: 100, D: 80, power: 8.5, peak: 8.5, layers: 6, oz: 2, holes: 4 },
      preset_robot_io_24v: { W: 100, D: 80, power: 14.0, peak: 14.0, layers: 4 },
      preset_robot_joint_foc: { W: 55, D: 55, power: 28.0, peak: 65.0, outline: "annulus" },
      preset_drone_fc_305: { W: 36, D: 36, power: 35.0, peak: 110.0 }
    };
    Object.keys(want).forEach(function (id) {
      const b = P.FAMOUS_BOARDS.find(function (x) { return x.id === id; });
      ok(b, id + " missing");
      const w = want[id];
      eq(b.W, w.W, id + " W"); eq(b.D, w.D, id + " D"); eq(b.power, w.power, id + " power"); eq(b.powerPeak, w.peak, id + " peak");
      if (w.layers) eq(b.pcb.layers, w.layers, id + " layers");
      if (w.oz) eq(b.pcb.copperOz, w.oz, id + " oz");
      if (w.holes) eq(b.pcb.holes.length, w.holes, id + " holes");
      if (w.outline) eq(b.pcb.outline, w.outline, id + " outline");
      const sum = b.pcb.components.reduce(function (s, c) { return s + c.power; }, 0);
      near(sum, b.power, 1e-6, id + " component powers must sum to board power");
    });
  });
  test("drone FC uses the 30.5 mm M3 pattern", function () {
    const b = P.FAMOUS_BOARDS.find(function (x) { return x.id === "preset_drone_fc_305"; });
    b.pcb.holes.forEach(function (h) { near(Math.abs(h.x) * 2, 30.5, 1e-9); near(Math.abs(h.z) * 2, 30.5, 1e-9); eq(h.d, 3.2); });
  });
  test("MI300X is 750 W everywhere", function () {
    eq(P.MI300X_OAM_POWER_W, 750);
    P.FAMOUS_BOARDS.concat(P.PRESETS).forEach(function (p) { if (/mi300/i.test(p.name)) eq(p.power, 750, p.name); });
  });
  test("PARTS_CATALOG has ≥ 20 items with MPNs and prices", function () {
    ok(P.PARTS_CATALOG.length >= 20);
    P.PARTS_CATALOG.forEach(function (p) {
      ok(p.mpn && p.mfr && typeof p.priceUSD === "number", p.id);
      if (p.kind === "tim") ok(p.k > 0 && p.tMm > 0, p.id);
    });
    ok(P.getPart("tim_3m_8810").k === 0.6 && P.getPart("tim_laird_hd90000").k === 7.5);
  });
  test("PCB in-plane conductivity: 6L 2oz ≫ bare FR4", function () {
    const k = P.pcbInPlaneK({ boardT: 1.6, planeCount: 4, copperOz: 2, coverage: 1 });
    near(k, (385 * 0.28 + 0.3 * 1.32) / 1.6, 1e-9);
    ok(P.pcbInPlaneK({ planeCount: 0 }) < 0.31);
  });
});

suite("presets.js — sanitising & edge cases", function () {
  test("negative / NaN / huge inputs are clamped, never NaN", function () {
    const r = P.sanitizeDesign({ W: -5, D: "x", fins: 1e6, finH: -3, power: -10, amb: NaN });
    ["W", "D", "fins", "finH", "power", "amb"].forEach(function (k) { ok(isFinite(r.design[k]), k); });
    ok(r.design.W >= 10 && r.design.fins <= 100 && r.design.power >= 0);
    ok(r.warnings.length >= 3);
  });
  test("fin count is capped by the minimum manufacturable gap", function () {
    const d = P.sanitizeDesign({ W: 50, finT: 2, fins: 100 }).design;
    eq(d.fins, P.maxFinsFor(50, 2));
    const s = (50 - d.fins * 2) / (d.fins - 1);
    ok(s >= P.MIN_FIN_GAP_MM - 1e-9, "gap " + s);
  });
});

suite("presets.js — geometry", function () {
  test("every preset builds a watertight, outward-oriented mesh", function () {
    P.PRESETS.forEach(function (p) {
      const m = P.buildDesignMesh(P.designFromPreset(p));
      const c = P.checkMesh(m);
      ok(c.watertight && c.consistent, p.name + " bad=" + c.badEdges + " flips=" + c.orientationErrors);
      c.perShell.forEach(function (s, i) { ok(!s.empty && s.volumeMm3 > 0, p.name + " shell " + i + " (" + m.shells[i].role + ") empty"); });
    });
  });
  test("heatsink is ONE continuous solid whose volume matches base + fins", function () {
    [[100, 80, 14, 20, 1.5, 3], [40, 40, 1, 10, 2, 2], [60, 50, 0, 10, 1.5, 4], [120, 90, 30, 25, 0.8, 5]].forEach(function (a) {
      const d = P.sanitizeDesign({ W: a[0], D: a[1], fins: a[2], finH: a[3], finT: a[4], baseT: a[5] }).design;
      const sh = P.buildHeatsink(d);
      const c = P.checkShell(sh);
      ok(c.watertight && c.orientationErrors === 0 && c.outward, JSON.stringify(a));
      near(c.volumeMm3, P.heatsinkVolumeMm3(d), 1e-3 * c.volumeMm3, "volume " + JSON.stringify(a));
    });
  });
  test("mounting boss is a ring with a counterbore (volume < solid cylinder)", function () {
    const b = P.buildMountingBossRing({ height: 6, holeD: 3.2, outerD: 6.5, cbD: 5.6, cbDepth: 1.5, segs: 64 });
    const c = P.checkShell(b);
    ok(c.watertight && c.outward);
    const ring = Math.PI * (3.25 * 3.25 - 1.6 * 1.6) * 6 - Math.PI * (2.8 * 2.8 - 1.6 * 1.6) * 1.5;
    near(c.volumeMm3, ring, ring * 0.01, "ring volume");
    ok(c.volumeMm3 < Math.PI * 3.25 * 3.25 * 6 * 0.8, "not a solid cylinder");
  });
  test("plate with holes removes hole volume", function () {
    const r = P.plateWithHoles("board", 100, 80, [{ x: -46, z: -36, d: 3.2 }, { x: 46, z: -36, d: 3.2 }, { x: -46, z: 36, d: 3.2 }, { x: 46, z: 36, d: 3.2 }], 0, 1.6, []);
    const c = P.checkShell(r.shell);
    ok(c.watertight && c.outward);
    eq(r.holes.length, 4);
    // each hole is a 16-gon of circumradius 1.6 mm: area = 8·r²·sin(π/8)·… = 2·16·r²·sin(2π/16)/2
    const holeArea = 0.5 * 16 * 1.6 * 1.6 * Math.sin(2 * Math.PI / 16);
    near(c.volumeMm3, (100 * 80 - 4 * holeArea) * 1.6, 1e-3, "plate volume");
    const plain = P.checkShell(P.plateWithHoles("board", 100, 80, [], 0, 1.6, []).shell);
    ok(plain.watertight, "plate without holes"); near(plain.volumeMm3, 12800, 1e-2);
  });
  test("enclosure has real port cut-outs and keep-out warning", function () {
    const e = P.buildEnclosure({ gen: "enclosure", W: 100, D: 70, encH: 25, finH: 24 });
    ok(e.ports.length >= 2, "ports");
    ok(!e.keepout.ok && /Keep-out/.test(e.keepout.message));
    ok(e.warnings.some(function (w) { return /Keep-out/.test(w); }));
    const solid = P.buildEnclosure({ gen: "enclosure", W: 100, D: 70, encH: 25, finH: 10, ports: [] });
    const cut = P.buildEnclosure({ gen: "enclosure", W: 100, D: 70, encH: 25, finH: 10 });
    ok(P.checkShell(cut.shells[0]).volumeMm3 < P.checkShell(solid.shells[0]).volumeMm3 - 100, "cut-outs remove material");
    ok(P.enclosureKeepout(P.sanitizeDesign({ encH: 25, finH: 23 }).design).ok, "23 mm fins clear 25 mm − 2 mm");
    ok(!P.enclosureKeepout(P.sanitizeDesign({ encH: 25, finH: 23.5 }).design).ok);
    P.checkMesh({ shells: cut.shells }).perShell.forEach(function (s) { ok(s.watertight && s.outward); });
  });
  test("bracket keeps NEMA-17 pilot + 4 screw holes", function () {
    const w = [];
    const m = P.buildDesignMesh(P.sanitizeDesign({ gen: "bracket", W: 56, D: 56 }).design);
    eq(m.warnings.length, 0, "no skipped holes: " + m.warnings.join(";") + w.join(";"));
  });
});

suite("presets.js — part swap & undo", function () {
  const fakeEval = function (d) { return { tj: 25 + d.power * (0.5 + P.getPart(d.timId).tMm / P.getPart(d.timId).k) }; };
  test("previewSwap reports New Tj / ΔT / BOM delta text", function () {
    const d = P.sanitizeDesign({ gen: "heatsink", power: 20, timId: "tim_3m_8810" }).design;
    const r = P.previewSwap(d, "tim_laird_hd90000", fakeEval);
    ok(r.deltaTj < 0);
    ok(/^New Tj: \d+\.\d°C \(ΔT: [−+]\d+\.\d°C, [−+]\$\d+\.\d\d BOM\)$/.test(r.text), r.text);
    near(r.deltaBomUSD, 4.80 - 0.45, 1e-9);
  });
  test("single-step undo restores the exact previous design", function () {
    const h = new P.SwapHistory();
    const d0 = P.sanitizeDesign({ gen: "heatsink", power: 20 }).design;
    const d1 = h.commit(d0, P.applyPart(d0, "hs_c110_skived"));
    ok(d1.mat === "copper" && h.canUndo());
    const back = h.undo();
    eq(JSON.stringify(back), JSON.stringify(d0));
    ok(!h.canUndo() && h.undo() === null);
  });
  test("parts that don't apply to the generator are rejected", function () {
    const pcb = P.designFromPreset(P.FAMOUS_BOARDS.find(function (b) { return b.id === "preset_eth_gateway"; }));
    throws(function () { P.applyPart(pcb, "hs_fischer_sk89"); });
    ok(P.applyPart(pcb, "fan_noctua_nfa4x10_5v").air === "forced");
    // Copper weight swap is rejected on passive (copper: null) parts
    const bracket = P.designFromPreset(P.FAMOUS_BOARDS.find(function (b) { return b.id === "nema17"; }));
    throws(function () { P.applyPart(bracket, "cu_weight_2oz"); });
    // Copper weight swap succeeds on active copper boards
    const pcb2oz = P.applyPart(pcb, "cu_weight_2oz");
    eq(pcb2oz.copper.copperOz, 2);
  });
  test("every preset has explicit copper (object or null) and locked COPPER_OZ_TABLE", function () {
    eq(P.COPPER_OZ_TABLE[0.5].thicknessUm, 17.5);
    eq(P.COPPER_OZ_TABLE[1].thicknessUm, 35.0);
    eq(P.COPPER_OZ_TABLE[2].thicknessUm, 70.0);
    P.PRESETS.forEach(function (p) {
      ok(Object.prototype.hasOwnProperty.call(p, "copper"), p.name + " must have explicit copper key");
      if (p.copper !== null) {
        ok(p.copper.traceWidthMm > 0 && P.COPPER_OZ_TABLE[p.copper.copperOz] && p.copper.layers >= 1 && p.copper.vias >= 1, p.name);
        ok(typeof p.railV === "number" && p.railV > 0, p.name + " railV");
      } else {
        eq(p.railV, null, p.name + " passive railV must be null");
      }
    });
  });
});
