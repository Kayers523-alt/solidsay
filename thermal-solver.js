/* =====================================================================
   SolidSay v2 · thermal-solver.js
   Steady-state design screener: 32×32 finite-difference plate solver,
   analytical fin efficiency + natural-convection choking, coupled 1-D
   resistance network (Rjc → TIM → spreading → convection), deterministic
   auto-optimizer and the ThermoBench-5 analytical verification suite.

   Honesty note: this is a real-time (< 50 ms) steady-state SCREENER for
   early design decisions. It is not Ansys Icepak / Simcenter Flotherm 3-D
   CFD or FEA sign-off. Modelling assumptions are listed in ASSUMPTIONS.

   Depends on presets.js (window.SolidSayPresets / require).
   ===================================================================== */
(function (root, factory) {
  "use strict";
  if (typeof module === "object" && module.exports) module.exports = factory(require("./presets.js"));
  else root.SolidSayThermal = factory(root.SolidSayPresets);
})(typeof self !== "undefined" ? self : this, function (P) {
  "use strict";
  if (!P) throw new Error("thermal-solver.js needs presets.js loaded first");

  const GRID = 32;
  const NAT_CHOKE_GAP_MM = 2.2;
  const MIN_CHOKE = 0.25;
  const RESIDUAL_LIMIT = 0.03;          // energy balance acceptance (3 %)
  const now = (typeof performance !== "undefined" && performance.now) ? function () { return performance.now(); } : function () { return Date.now(); };

  const ASSUMPTIONS = [
    "Steady state only — no transient / thermal-capacitance effects (CTM export carries C values for downstream tools).",
    "Spreader / board is a thin 2-D plate (32×32 cells). Through-thickness gradient is added as a 1-D term t/(k·A_source); 3-D effects under very thick bases are approximated.",
    "Convection uses a constant film coefficient h per mode (natural default 9 W/m²K, forced default 55 W/m²K), distributed uniformly over the plate. Real h varies with ΔT, orientation and flow development.",
    "Fins: straight rectangular fins, adiabatic tip, η = tanh(mH)/(mH) with m = √(2h / (k·t)). Natural convection choking below 2.2 mm clear gap: factor max(0.25, s/2.2).",
    "Radiation is neglected (conservative for anodised parts by ~10–25 % in natural convection).",
    "Spreading resistance (network view) uses the Lee–Song–Au–Moran closed form for a centred source on a convectively cooled plate.",
    "TIM resistance = t / (k·A_source); contact resistance beyond the bond line is not modelled.",
    "Enclosure and bracket generators use a lumped exposed-surface model; they are screening estimates only."
  ];

  /* ------------------------------------------------------------------ */
  /* Fin physics                                                        */
  /* ------------------------------------------------------------------ */
  // h [W/m²K], kFin [W/mK], tFinMm, HFinMm -> { m [1/m], mL, eta }
  function finEfficiency(h, kFin, tFinMm, HFinMm) {
    const t = Math.max(1e-6, tFinMm / 1000), H = Math.max(0, HFinMm / 1000);
    const m = Math.sqrt((2 * Math.max(0, h)) / (Math.max(1e-9, kFin) * t));
    const mL = m * H;
    const eta = mL < 1e-6 ? 1 : Math.tanh(mL) / mL;
    return { m: m, mL: mL, eta: eta };
  }
  // Clear gap between fins, mm. Infinity when there is no neighbouring fin.
  function finSpacing(Wmm, N, tMm) {
    if (!(N >= 2)) return Infinity;
    return (Wmm - N * tMm) / (N - 1);
  }
  function chokeFactor(sMm, air) {
    if (air !== "natural" || !(sMm < NAT_CHOKE_GAP_MM)) return 1;
    return Math.max(MIN_CHOKE, sMm / NAT_CHOKE_GAP_MM);
  }
  function filmCoefficient(d) { return d.air === "forced" ? d.hForced : d.hNat; }

  function hasHeatsink(d) {
    return d.mode !== "bare" && d.fins > 0 && d.finH > 0 && (d.gen === "heatsink" || d.gen === "chiplet");
  }

  // Annulus / KiCad outline support: 1 = cell takes part in the solve.
  function activeMask(d, nx, ny) {
    const a = new Uint8Array(nx * ny).fill(1);
    if (d.gen === "pcb" && d.pcb && d.pcb.outline === "annulus") {
      const rO = Math.min(d.W, d.D) / 2, rI = Math.max(1, Math.min((d.pcb.innerD || 20) / 2, rO - 3));
      for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
        const x = (-0.5 + (i + 0.5) / nx) * d.W, z = (-0.5 + (j + 0.5) / ny) * d.D, r = Math.hypot(x, z);
        if (r > rO || r < rI) a[j * nx + i] = 0;
      }
    } else if (d.gen === "pcb" && d.pcb && Array.isArray(d.pcb.polygon) && d.pcb.polygon.length >= 3) {
      const poly = d.pcb.polygon;
      for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
        const x = (-0.5 + (i + 0.5) / nx) * d.W, z = (-0.5 + (j + 0.5) / ny) * d.D;
        if (!pointInPolygon(x, z, poly)) a[j * nx + i] = 0;
      }
    }
    return a;
  }
  function pointInPolygon(x, z, poly) {
    let inside = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const xi = poly[i][0], zi = poly[i][1], xj = poly[j][0], zj = poly[j][1];
      if ((zi > z) !== (zj > z) && x < (xj - xi) * (z - zi) / ((zj - zi) || 1e-12) + xi) inside = !inside;
    }
    return inside;
  }

  // Exposed convective surface and spreader properties for a design.
  function convectionModel(design) {
    const d = P.sanitizeDesign(design).design;
    const h = filmCoefficient(d);
    const Wm = d.W / 1000, Dm = d.D / 1000;
    const plate = Wm * Dm;
    const out = { h: h, Abase: 0, AfinRaw: 0, AfinEff: 0, eta: 1, mL: 0, choke: 1, s: Infinity, Aeff: 0, kPlate: 0, tPlateMm: 0, notes: [] };
    const bare = d.mode === "bare" && (d.gen === "heatsink" || d.gen === "chiplet");
    if (bare) {
      // Bare die soldered to a typical 4-layer board: both faces convect.
      out.kPlate = P.pcbInPlaneK(P.DEFAULT_PCB); out.tPlateMm = 1.6;
      out.Abase = 2 * plate; out.Aeff = out.Abase;
      out.notes.push("Bare die on a 4-layer PCB (k_in-plane " + out.kPlate.toFixed(1) + " W/mK), both faces convecting.");
      return out;
    }
    if (d.gen === "heatsink" || d.gen === "chiplet") {
      const mat = P.MATERIALS[d.mat];
      out.kPlate = mat.k;
      out.tPlateMm = d.gen === "heatsink" ? d.baseT : 3 + (hasHeatsink(d) ? d.baseT : 0);
      if (hasHeatsink(d)) {
        const fe = finEfficiency(h, mat.k, d.finT, d.finH);
        out.eta = fe.eta; out.mL = fe.mL;
        out.s = finSpacing(d.W, d.fins, d.finT);
        out.choke = chokeFactor(out.s, d.air);
        out.Abase = Math.max(0, (d.W - d.fins * d.finT) / 1000) * Dm;
        out.AfinRaw = d.fins * 2 * (d.finH / 1000) * Dm;
        out.AfinEff = out.AfinRaw * out.eta * out.choke;
        out.Aeff = out.Abase + out.AfinEff;
        if (out.choke < 1) out.notes.push("Fin gap " + out.s.toFixed(2) + " mm < 2.2 mm in natural convection: boundary layers merge, fin area derated ×" + out.choke.toFixed(2) + ".");
      } else {
        out.Abase = plate * (d.gen === "chiplet" ? 1.35 : 1);
        out.Aeff = out.Abase;
        if (d.gen === "chiplet") out.notes.push("Package lid + substrate spread approximated as 1.35 × footprint.");
      }
      return out;
    }
    if (d.gen === "enclosure") {
      const H = (P.ENCLOSURE.floor + P.enclosureInteriorH(d)) / 1000;
      out.kPlate = P.MATERIALS[d.mat].k; out.tPlateMm = P.ENCLOSURE.floor;
      out.Abase = 2 * (plate + Wm * H + Dm * H);
      out.Aeff = out.Abase;
      out.notes.push("Sealed enclosure: lumped full-box outer surface.");
      return out;
    }
    if (d.gen === "bracket") {
      out.kPlate = P.MATERIALS[d.mat].k; out.tPlateMm = 5;
      out.Abase = plate + Wm * (Math.max(24, d.finH * 2.4) / 1000) * 2;
      out.Aeff = out.Abase;
      return out;
    }
    // pcb
    const pcb = Object.assign({}, P.DEFAULT_PCB, d.pcb || {});
    out.kPlate = P.pcbInPlaneK(pcb); out.tPlateMm = pcb.boardT;
    let area = plate;
    if (pcb.outline === "annulus") {
      const rO = Math.min(d.W, d.D) / 2000, rI = Math.max(0.001, Math.min((pcb.innerD || 20) / 2000, rO - 0.003));
      area = Math.PI * (rO * rO - rI * rI);
    } else if (Array.isArray(pcb.polygon) && pcb.polygon.length >= 3) {
      area = Math.abs(polygonArea(pcb.polygon)) / 1e6;
    }
    out.Abase = 2 * area; out.Aeff = out.Abase;
    out.notes.push(pcb.layers + "-layer board, " + pcb.copperOz + " oz planes → in-plane k ≈ " + out.kPlate.toFixed(1) + " W/mK; both faces convecting.");
    return out;
  }
  function polygonArea(poly) {
    let a = 0;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) a += (poly[j][0] + poly[i][0]) * (poly[j][1] - poly[i][1]);
    return a / 2;
  }

  /* ------------------------------------------------------------------ */
  /* Generic finite-difference core                                     */
  /* ------------------------------------------------------------------ */
  // o: { nx, ny, gx, gy (W/K between x- / y-neighbours), gc (Float64Array,
  //      W/K to ambient per cell), q (Float64Array, W per cell), active
  //      (Uint8Array|null), tAmb, tol, maxSweeps, T0? }
  // Gauss-Seidel SOR + a two-level additive (mean-mode) correction, which
  // removes the slow global-level error that makes plain SOR crawl on
  // stiff metal plates. Converged when the L1 norm of the local energy
  // residuals falls below tol × total power.
  function solveGrid(o) {
    const nx = o.nx, ny = o.ny, n = nx * ny;
    const gx = o.gx, gy = o.gy, gc = o.gc, q = o.q, tAmb = o.tAmb;
    const act = o.active || new Uint8Array(n).fill(1);
    const T = o.T0 ? Float64Array.from(o.T0) : new Float64Array(n).fill(tAmb);
    let Ptot = 0, Gsum = 0;
    for (let i = 0; i < n; i++) if (act[i]) { Ptot += q[i]; Gsum += gc[i]; }
    if (!(Ptot > 0)) { for (let i = 0; i < n; i++) T[i] = tAmb; return { T: T, sweeps: 0, residual: 0, balanceErr: 0, heatOut: 0, converged: true }; }
    if (!(Gsum > 0)) return { T: T, sweeps: 0, residual: Infinity, balanceErr: 1, heatOut: 0, converged: false, error: "no convective path to ambient" };
    // Jacobi spectral-radius estimate -> near-optimal SOR factor.
    const gcMean = Gsum / Math.max(1, act.reduce(function (s, v) { return s + v; }, 0));
    const lam = 2 * gx * (1 - Math.cos(Math.PI / Math.max(2, nx))) + 2 * gy * (1 - Math.cos(Math.PI / Math.max(2, ny)));
    const diag = 2 * gx * (nx > 1 ? 1 : 0) + 2 * gy * (ny > 1 ? 1 : 0) + gcMean;
    const rho = Math.min(0.99999, Math.max(0, 1 - (lam + gcMean) / diag));
    const omega = o.omega || Math.min(1.97, 2 / (1 + Math.sqrt(1 - rho * rho)));
    const tol = o.tol || 1e-5, maxSweeps = o.maxSweeps || 20000;
    let sweeps = 0, residual = Infinity;
    const block = 25;
    while (sweeps < maxSweeps) {
      for (let s = 0; s < block; s++) {
        for (let j = 0; j < ny; j++) {
          const row = j * nx;
          for (let i = 0; i < nx; i++) {
            const c = row + i;
            if (!act[c]) continue;
            let sum = gc[c] * tAmb + q[c], den = gc[c];
            if (i > 0 && act[c - 1]) { sum += gx * T[c - 1]; den += gx; }
            if (i < nx - 1 && act[c + 1]) { sum += gx * T[c + 1]; den += gx; }
            if (j > 0 && act[c - nx]) { sum += gy * T[c - nx]; den += gy; }
            if (j < ny - 1 && act[c + nx]) { sum += gy * T[c + nx]; den += gy; }
            if (den > 0) T[c] += omega * (sum / den - T[c]);
          }
        }
      }
      sweeps += block;
      // mean-mode correction: shifting every cell by δ changes no conduction
      // term and changes total convection by Gsum·δ.
      let out = 0;
      for (let c = 0; c < n; c++) if (act[c]) out += gc[c] * (T[c] - tAmb);
      const delta = (Ptot - out) / Gsum;
      for (let c = 0; c < n; c++) if (act[c]) T[c] += delta;
      residual = localResidual(o, T, act) / Ptot;
      if (residual < tol) break;
    }
    let heatOut = 0;
    for (let c = 0; c < n; c++) if (act[c]) heatOut += gc[c] * (T[c] - tAmb);
    for (let c = 0; c < n; c++) if (!act[c]) T[c] = tAmb;
    const balanceErr = Math.abs(heatOut - Ptot) / Ptot;
    return { T: T, sweeps: sweeps, residual: residual, balanceErr: balanceErr, heatOut: heatOut, converged: residual < Math.max(tol * 10, 1e-3) && balanceErr < RESIDUAL_LIMIT, omega: omega };
  }
  function localResidual(o, T, act) {
    const nx = o.nx, ny = o.ny;
    let r = 0;
    for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
      const c = j * nx + i;
      if (!act[c]) continue;
      let f = o.q[c] - o.gc[c] * (T[c] - o.tAmb);
      if (i > 0 && act[c - 1]) f += o.gx * (T[c - 1] - T[c]);
      if (i < nx - 1 && act[c + 1]) f += o.gx * (T[c + 1] - T[c]);
      if (j > 0 && act[c - nx]) f += o.gy * (T[c - nx] - T[c]);
      if (j < ny - 1 && act[c + nx]) f += o.gy * (T[c + nx] - T[c]);
      r += Math.abs(f);
    }
    return r;
  }
  // Coarse-to-fine wrapper: solve on halved grids first (gc and q are
  // summed over children; gx, gy are invariant under uniform coarsening),
  // then inject the coarse field as the fine initial guess.
  function solveGridMultilevel(o) {
    if (o.nx % 2 || o.ny % 2 || o.nx < 16 || o.ny < 16) return solveGrid(o);
    const cx = o.nx / 2, cy = o.ny / 2, cn = cx * cy;
    const cgc = new Float64Array(cn), cq = new Float64Array(cn), cact = new Uint8Array(cn);
    const act = o.active || new Uint8Array(o.nx * o.ny).fill(1);
    for (let j = 0; j < o.ny; j++) for (let i = 0; i < o.nx; i++) {
      const f = j * o.nx + i, c = (j >> 1) * cx + (i >> 1);
      if (!act[f]) continue;
      cgc[c] += o.gc[f]; cq[c] += o.q[f]; cact[c] = 1;
    }
    const coarse = solveGridMultilevel(Object.assign({}, o, { nx: cx, ny: cy, gc: cgc, q: cq, active: cact, T0: null, tol: Math.max(o.tol || 1e-5, 1e-4) }));
    const T0 = new Float64Array(o.nx * o.ny);
    for (let j = 0; j < o.ny; j++) for (let i = 0; i < o.nx; i++) T0[j * o.nx + i] = coarse.T[(j >> 1) * cx + (i >> 1)];
    const fine = solveGrid(Object.assign({}, o, { T0: T0 }));
    fine.sweeps += coarse.sweeps / 4;   // coarse sweeps cost ¼ of a fine sweep
    return fine;
  }

  /* ------------------------------------------------------------------ */
  /* Design -> grid problem                                             */
  /* ------------------------------------------------------------------ */
  function overlap1D(a0, a1, b0, b1) { return Math.max(0, Math.min(a1, b1) - Math.max(a0, b0)); }
  function timResistance(d, src) {
    if (d.mode === "bare" || !(d.gen === "heatsink" || d.gen === "chiplet")) return 0;
    const tim = P.getPart(d.timId);
    if (!tim) return 0;
    const A = (src.w / 1000) * (src.d / 1000);
    return (tim.tMm / 1000) / (tim.k * Math.max(1e-8, A));
  }
  function baseThroughResistance(d, conv, src) {
    const A = (src.w / 1000) * (src.d / 1000);
    return (conv.tPlateMm / 1000) / (Math.max(1e-6, conv.kPlate) * Math.max(1e-8, A));
  }
  function buildProblem(d, nx, ny) {
    const conv = convectionModel(d);
    const dx = d.W / nx, dy = d.D / ny;                 // mm
    const kt = conv.kPlate * (conv.tPlateMm / 1000);    // W/K for a square cell
    const gx = kt * (dy / dx), gy = kt * (dx / dy);     // aspect-ratio-correct cell conductances
    const active = activeMask(d, nx, ny);
    let nAct = 0;
    for (let i = 0; i < active.length; i++) nAct += active[i];
    const gcCell = conv.h * conv.Aeff / Math.max(1, nAct);
    const gc = new Float64Array(nx * ny), q = new Float64Array(nx * ny);
    for (let i = 0; i < gc.length; i++) gc[i] = active[i] ? Math.max(1e-12, gcCell) : 0;
    const sources = P.heatSources(d);
    const footprints = [];
    sources.forEach(function (s) {
      const x0 = s.x - s.w / 2, x1 = s.x + s.w / 2, z0 = s.z - s.d / 2, z1 = s.z + s.d / 2;
      const cells = [];
      let covered = 0;
      for (let j = 0; j < ny; j++) {
        const cz0 = -d.D / 2 + j * dy, oz = overlap1D(z0, z1, cz0, cz0 + dy);
        if (!oz) continue;
        for (let i = 0; i < nx; i++) {
          const c = j * nx + i;
          if (!active[c]) continue;
          const cx0 = -d.W / 2 + i * dx, ox = overlap1D(x0, x1, cx0, cx0 + dx);
          if (!ox) continue;
          cells.push([c, ox * oz]); covered += ox * oz;
        }
      }
      if (!cells.length) {   // source entirely outside the active board: snap to the nearest active cell
        let best = -1, bd = Infinity;
        for (let c = 0; c < active.length; c++) if (active[c]) {
          const ci = c % nx, cj = (c / nx) | 0;
          const dd = Math.hypot(-d.W / 2 + (ci + 0.5) * dx - s.x, -d.D / 2 + (cj + 0.5) * dy - s.z);
          if (dd < bd) { bd = dd; best = c; }
        }
        if (best >= 0) { cells.push([best, 1]); covered = 1; }
      }
      cells.forEach(function (cw) { q[cw[0]] += s.power * cw[1] / covered; });   // fractional, power-exact rasterisation
      footprints.push({ src: s, cells: cells.map(function (cw) { return cw[0]; }) });
    });
    return { conv: conv, gx: gx, gy: gy, gc: gc, q: q, active: active, footprints: footprints, sources: sources, dx: dx, dy: dy };
  }

  /* ------------------------------------------------------------------ */
  /* Public solve                                                       */
  /* ------------------------------------------------------------------ */
  function solveThermal(design, opts) {
    const t0 = now();
    const sd = P.sanitizeDesign(design);
    const d = sd.design;
    const N = (opts && opts.grid) || GRID;
    const pr = buildProblem(d, N, N);
    const sol = solveGridMultilevel({ nx: N, ny: N, gx: pr.gx, gy: pr.gy, gc: pr.gc, q: pr.q, active: pr.active, tAmb: d.amb, tol: (opts && opts.tol) || 2e-5 });
    const grid = new Float32Array(N * N);
    let plateMax = d.amb;
    for (let i = 0; i < grid.length; i++) { grid[i] = sol.T[i]; if (pr.active[i] && sol.T[i] > plateMax) plateMax = sol.T[i]; }
    const comps = pr.footprints.map(function (fp) {
      const s = fp.src;
      let tMax = d.amb, tAvg = 0;
      fp.cells.forEach(function (c) { tMax = Math.max(tMax, sol.T[c]); tAvg += sol.T[c]; });
      tAvg = fp.cells.length ? tAvg / fp.cells.length : d.amb;
      const rTim = timResistance(d, s);
      const rBase = (d.gen === "pcb") ? 0 : baseThroughResistance(d, pr.conv, s);
      const tj = tMax + s.power * (s.rjc + rTim + rBase);
      return { ref: s.ref, name: s.name, x: s.x, z: s.z, power: s.power, rjc: s.rjc, rTim: rTim, rBase: rBase, tPlate: tMax, tPlateAvg: tAvg, tj: tj };
    });
    let hottest = comps[0] || null;
    comps.forEach(function (c) { if (!hottest || c.tj > hottest.tj) hottest = c; });
    const Ptot = pr.sources.reduce(function (s, x) { return s + x.power; }, 0);
    const tj = hottest ? Math.max(hottest.tj, d.amb) : d.amb;
    const warnings = sd.warnings.slice();
    if (!sol.converged) warnings.push("Solver did not reach the 3 % energy-balance criterion (residual " + (sol.balanceErr * 100).toFixed(1) + " %). Treat this result as indicative only.");
    if (sol.error) warnings.push(sol.error);
    const res = {
      grid: grid, nx: N, ny: N, design: d,
      peak: tj, tj: tj, plateMax: plateMax, hottest: hottest, components: comps,
      power: Ptot, thetaJA: Ptot > 0 ? (tj - d.amb) / Ptot : 0,
      balance: sol.heatOut, residual: sol.balanceErr, localResidual: sol.residual, converged: sol.converged,
      iterations: Math.round(sol.sweeps), omega: sol.omega,
      conv: pr.conv, warnings: warnings, active: pr.active
    };
    res.network = resistanceNetwork(d, res);
    res.ms = now() - t0;
    return res;
  }

  /* ------------------------------------------------------------------ */
  /* Coupled 1-D resistance network                                     */
  /* ------------------------------------------------------------------ */
  // Lee, Song, Au & Moran (1995) closed form for the spreading resistance
  // of a centred circular-equivalent source on a convectively cooled plate.
  function spreadingResistance(Asrc, Aplate, tPlate, k, hEff) {
    const a = Math.sqrt(Asrc / Math.PI), b = Math.sqrt(Aplate / Math.PI);
    if (a >= b) return 0;
    const eps = a / b, tau = tPlate / b, Bi = Math.max(1e-9, hEff * b / k);
    const lam = Math.PI + 1 / (Math.sqrt(Math.PI) * eps);
    const th = Math.tanh(lam * tau);
    const phi = (th + lam / Bi) / (1 + (lam / Bi) * th);
    const psiMax = (1 - eps) * phi / Math.sqrt(Math.PI);
    return psiMax / (Math.sqrt(Math.PI) * k * a);
  }
  function resistanceNetwork(design, result) {
    const d = P.sanitizeDesign(design).design;
    const conv = (result && result.conv) || convectionModel(d);
    const srcs = P.heatSources(d);
    const Ptot = srcs.reduce(function (s, x) { return s + x.power; }, 0);
    let src = srcs[0] || { w: d.W, d: d.D, power: 0, rjc: d.rjc, ref: "U1" };
    if (result && result.hottest) src = srcs.find(function (s) { return s.ref === result.hottest.ref; }) || src;
    else srcs.forEach(function (s) { if (s.power > src.power) src = s; });
    const Asrc = (src.w / 1000) * (src.d / 1000);
    let Aplate = (d.W / 1000) * (d.D / 1000);
    if (result && result.active) { let n = 0; for (let i = 0; i < result.active.length; i++) n += result.active[i]; Aplate *= n / result.active.length; }
    const t = conv.tPlateMm / 1000, k = Math.max(1e-6, conv.kPlate);
    const Rconv = 1 / Math.max(1e-12, conv.h * conv.Aeff);
    const hEff = 1 / (Rconv * Aplate);
    // Per-source resistances (W of THIS source) vs. shared plate/convection path (all W).
    const Rjc = src.rjc;
    const Rtim = timResistance(d, src);
    const Rspread = (srcs.length === 1 ? spreadingResistance(Asrc, Aplate, t, k, hEff) : spreadingResistance(Asrc, Aplate / Math.max(1, srcs.length), t, k, hEff)) + t / (k * Math.max(1e-8, Asrc));
    const stages = [
      { id: "jc", label: "Junction → case (R_JC)", R: Rjc, W: src.power },
      { id: "tim", label: "TIM interface (R_TIM)", R: Rtim, W: src.power },
      { id: "spread", label: "Base conduction + spreading (R_spread)", R: Rspread, W: src.power },
      { id: "conv", label: "Fins/surface → ambient (R_conv)", R: Rconv, W: Ptot }
    ];
    stages.forEach(function (s) { s.dT = s.R * s.W; });
    const dTsum = stages.reduce(function (s, x) { return s + x.dT; }, 0);
    stages.forEach(function (s) { s.frac = dTsum > 0 ? s.dT / dTsum : 0; });
    const out = { ref: src.ref, stages: stages, totalDT: dTsum, tjNetwork: d.amb + dTsum, Rtotal: Ptot > 0 ? dTsum / Ptot : 0, power: Ptot, sourcePower: src.power };
    if (result && isFinite(result.tj)) {
      out.tjFD = result.tj;
      out.agreementPct = dTsum > 0 ? 100 * ((result.tj - d.amb) - dTsum) / dTsum : 0;
    }
    return out;
  }
  // Fast analytic Tj estimate used inside the optimizer search loop.
  function quickTj(d) {
    const net = resistanceNetwork(d, null);
    return net.tjNetwork;
  }

  /* ------------------------------------------------------------------ */
  /* Deterministic auto-optimizer                                       */
  /* ------------------------------------------------------------------ */
  const OPT_KEYS = ["W", "D", "fins", "finH", "finT", "baseT", "mat", "timId", "air", "pcb.coverage", "pcb.copperOz"];
  function pick(d) {
    const o = {};
    OPT_KEYS.forEach(function (k) {
      if (k.indexOf("pcb.") === 0) { if (d.pcb) o[k] = d.pcb[k.slice(4)]; }
      else o[k] = d[k];
    });
    return o;
  }
  function massG(d) {
    if (d.gen === "pcb") return 0;
    return P.heatsinkBodyMassG(d);
  }
  function candidateMoves(d, cfg, d0) {
    const L = cfg.locks, B = cfg.bounds, mv = [];
    const add = function (label, patch) { mv.push({ label: label, patch: patch }); };
    if (d.gen === "heatsink" || d.gen === "chiplet") {
      const maxF = Math.min(B.finsMax, P.maxFinsFor(d.W, d.finT));
      if (!L.lockFinCount) {
        if (d.fins < maxF) add("fins → " + (d.fins + 1), { fins: d.fins + 1 });
        if (d.fins > 2) add("fins → " + (d.fins - 1), { fins: d.fins - 1 });
      }
      const hMax = L.lockMaxHeight ? Math.min(B.finHMax, d0.finH) : B.finHMax;
      if (d.finH + 2 <= hMax) add("fin height → " + (d.finH + 2) + " mm", { finH: d.finH + 2 });
      if (!L.lockMaxHeight && d.baseT + 0.5 <= B.baseTMax) add("base → " + (d.baseT + 0.5) + " mm", { baseT: d.baseT + 0.5 });
      if (!L.lockMaterial && d.mat !== "copper") add("material → Cu C110 (k = 385)", { mat: "copper" });
      if (!L.lockTim) {
        const order = P.TIM_UPGRADE_ORDER, i = order.indexOf(d.timId);
        if (i >= 0 && i < order.length - 1) { const nt = P.getPart(order[i + 1]); add("TIM → " + nt.mfr + " " + nt.mpn, { timId: nt.id }); }
      }
      if (!L.lockFootprint) {
        if (d.W + 5 <= B.WMax) add("width → " + (d.W + 5) + " mm", { W: d.W + 5 });
        if (d.D + 5 <= B.DMax) add("depth → " + (d.D + 5) + " mm", { D: d.D + 5 });
      }
    } else if (d.gen === "pcb" && d.pcb) {
      if (!L.lockMaterial) {
        if (d.pcb.coverage < 0.9) add("copper fill → " + Math.round((d.pcb.coverage + 0.1) * 100) + " %", { "pcb.coverage": +(d.pcb.coverage + 0.1).toFixed(2) });
        if (d.pcb.copperOz < 3) add("plane copper → " + (d.pcb.copperOz + 1) + " oz", { "pcb.copperOz": d.pcb.copperOz + 1 });
      }
    }
    if (cfg.allowForcedAir && d.air !== "forced") add("forced air (fan)", { air: "forced" });
    return mv;
  }
  function applyPatch(d, patch) {
    const n = P.clone(d);
    Object.keys(patch).forEach(function (k) {
      if (k.indexOf("pcb.") === 0) { n.pcb = n.pcb || {}; n.pcb[k.slice(4)] = patch[k]; }
      else n[k] = patch[k];
    });
    if (patch.mat) { n.heatsinkPartId = null; }
    if (patch.fins || patch.finH || patch.W || patch.D || patch.baseT) n.heatsinkPartId = null;
    return P.sanitizeDesign(n).design;
  }
  // opts: { targetC=80, locks{lockMaxHeight,lockMaterial,lockFootprint,lockFinCount,lockTim},
  //         bounds{finsMax,finHMax,baseTMax,WMax,DMax}, allowForcedAir, timeBudgetMs=90, maxIterations=300 }
  function autoOptimizeToTarget(design, opts) {
    const t0 = now();
    const o = opts || {};
    const target = isFinite(o.targetC) ? +o.targetC : 80;
    const locks = Object.assign({ lockMaxHeight: false, lockMaterial: false, lockFootprint: false, lockFinCount: false, lockTim: false }, o.locks || {});
    const bounds = Object.assign({ finsMax: 100, finHMax: 60, baseTMax: 12, WMax: 200, DMax: 200 }, o.bounds || {});
    const cfg = { locks: locks, bounds: bounds, allowForcedAir: !!o.allowForcedAir };
    const budget = isFinite(o.timeBudgetMs) ? o.timeBudgetMs : 90;
    const maxIt = isFinite(o.maxIterations) ? o.maxIterations : 300;
    let d0 = P.sanitizeDesign(design).design;
    const conflicts = [];
    if (d0.mode === "bare") { d0 = P.sanitizeDesign(Object.assign({}, d0, { mode: "heatsink" })).design; }
    if (d0.gen !== "heatsink" && d0.gen !== "chiplet" && d0.gen !== "pcb") {
      conflicts.push("Auto-optimize sizes heatsinks and PCB copper; the " + d0.gen + " generator has no free thermal parameters.");
    }
    if (bounds.WMax < d0.W || bounds.DMax < d0.D) conflicts.push("Footprint bounds are smaller than the current footprint.");
    const r0 = solveThermal(d0, { tol: 5e-5 });
    const base = { beforeParams: pick(d0), beforeTj: r0.tj, targetC: target, locks: locks };
    const finish = function (extra) {
      return Object.assign(base, extra, { ms: now() - t0 });
    };
    if (target <= d0.amb) {
      conflicts.push("Target " + target + " °C is at or below ambient " + d0.amb + " °C — physically unreachable.");
    }
    if (conflicts.length) return finish({ feasible: false, proposedParams: pick(d0), proposedTj: r0.tj, deltaTj: 0, deltaMassG: 0, deltaCostUSD: 0, steps: [], iterations: 0, verified: true, reason: conflicts.join(" "), conflicts: conflicts, design: d0 });
    if (r0.tj <= target) return finish({ feasible: true, proposedParams: pick(d0), proposedTj: r0.tj, deltaTj: 0, deltaMassG: 0, deltaCostUSD: 0, steps: [], iterations: 0, verified: true, reason: "Already meets target.", conflicts: [], design: d0 });

    // FD-calibrated search: the network estimate is scaled so it reproduces
    // the FD rise, re-calibrated after every FD verification.
    let cur = d0, iterations = 0, verifyRounds = 0;
    let calib = (r0.tj - d0.amb) / Math.max(1e-9, quickTj(d0) - d0.amb);
    const est = function (d) { return d.amb + (quickTj(d) - d.amb) * calib; };
    let curEst = est(cur), last = r0, steps = [];
    let reason = "";
    while (true) {
      while (curEst > target && iterations < maxIt && now() - t0 < budget) {
        iterations++;
        const moves = candidateMoves(cur, cfg, d0);
        if (!moves.length) { reason = "No unlocked parameter can move further (check locks and bounds)."; break; }
        const cost0 = P.estimateBomUSD(cur).totalUSD, m0 = massG(cur);
        let best = null;
        moves.forEach(function (mv) {
          const nd = applyPatch(cur, mv.patch);
          const e = est(nd);
          const gain = curEst - e;
          if (!(gain > 0.01)) return;
          const dc = Math.max(0, P.estimateBomUSD(nd).totalUSD - cost0), dm = Math.max(0, massG(nd) - m0);
          const score = gain / (1 + dc + dm / 50);
          if (!best || score > best.score + 1e-12) best = { mv: mv, d: nd, e: e, score: score };
        });
        if (!best) { reason = "Remaining moves no longer lower Tj (diminishing returns / choking)."; break; }
        cur = best.d; curEst = best.e; steps.push(best.mv.label);
      }
      last = solveThermal(cur, { tol: 5e-5 });
      verifyRounds++;
      if (last.tj <= target || reason || iterations >= maxIt || now() - t0 >= budget || verifyRounds >= 6) break;
      calib = (last.tj - cur.amb) / Math.max(1e-9, quickTj(cur) - cur.amb);
      curEst = est(cur);
    }
    const feasible = last.tj <= target;
    if (!feasible && !reason) reason = iterations >= maxIt ? "Iteration cap reached." : (now() - t0 >= budget ? "Time budget reached." : "Verification above target after calibration rounds.");
    return finish({
      feasible: feasible,
      proposedParams: pick(cur), proposedTj: last.tj,
      deltaTj: last.tj - r0.tj,
      deltaMassG: massG(cur) - massG(d0),
      deltaCostUSD: P.estimateBomUSD(cur).totalUSD - P.estimateBomUSD(d0).totalUSD,
      steps: steps, iterations: iterations, verifyRounds: verifyRounds, verified: true,
      reason: feasible ? "Target met (FD-verified)." : reason, conflicts: [], design: cur
    });
  }

  /* ------------------------------------------------------------------ */
  /* ThermoBench-5                                                      */
  /* ------------------------------------------------------------------ */
  function bench(id, name, analytic, numeric, tolPct, residual, detail) {
    const err = Math.abs(numeric - analytic) / Math.max(1e-12, Math.abs(analytic)) * 100;
    const resOk = !(residual > RESIDUAL_LIMIT);
    return { id: id, name: name, analytic: analytic, numeric: numeric, errPct: err, tolPct: tolPct, residualPct: (residual || 0) * 100, pass: err <= tolPct && resOk, detail: detail };
  }
  function runThermoBench5() {
    const t0 = now();
    const cases = [];
    const tAmb = 25;
    // TB1 — isothermal plate: k → very large spreader, centred source.
    (function () {
      const n = 32, Pw = 20, h = 10, A = 0.1 * 0.1;
      const gc = new Float64Array(n * n).fill(h * A / (n * n)), q = new Float64Array(n * n);
      for (let j = 12; j < 20; j++) for (let i = 12; i < 20; i++) q[j * n + i] = Pw / 64;
      const g = 1e5 * 0.003;
      const s = solveGridMultilevel({ nx: n, ny: n, gx: g, gy: g, gc: gc, q: q, tAmb: tAmb, tol: 1e-7 });
      let mx = -1e9, mn = 1e9, mean = 0;
      for (let i = 0; i < n * n; i++) { mx = Math.max(mx, s.T[i]); mn = Math.min(mn, s.T[i]); mean += s.T[i] / (n * n); }
      cases.push(bench("TB1", "Isothermal plate: T = T∞ + P/(hA)", tAmb + Pw / (h * A), mean, 0.5, s.balanceErr, "spread " + (mx - mn).toFixed(4) + " K"));
    })();
    // TB2 — 1-D Fourier slab: heat in at x = 0, convective sink at x = L.
    (function () {
      const nx = 32, ny = 4, Pw = 10, k = 167, t = 0.003, L = 0.1, Dm = 0.04, Gend = 50;
      const dx = L / nx, dy = Dm / ny;
      const gx = k * t * dy / dx, gy = k * t * dx / dy;
      const gc = new Float64Array(nx * ny), q = new Float64Array(nx * ny);
      for (let j = 0; j < ny; j++) { q[j * nx] = Pw / ny; gc[j * nx + nx - 1] = Gend / ny; }
      const s = solveGrid({ nx: nx, ny: ny, gx: gx, gy: gy, gc: gc, q: q, tAmb: tAmb, tol: 1e-9, maxSweeps: 200000 });
      const analytic = tAmb + Pw / Gend + Pw * (L - dx) / (k * t * Dm);
      cases.push(bench("TB2", "1-D Fourier slab: ΔT = P·L/(k·t·D)", analytic, s.T[0], 0.5, s.balanceErr));
    })();
    // TB3 — straight fin: FD fin conductance vs η·h·A_fin from finEfficiency().
    (function () {
      const n = 256, h = 25, k = 167, tMm = 1.5, Hmm = 40, Dm = 0.05, Q = 5;
      const fe = finEfficiency(h, k, tMm, Hmm);
      const dx = (Hmm / 1000) / n, Ac = (tMm / 1000) * Dm, per = 2 * Dm;
      const gx = k * Ac / dx;
      const gc = new Float64Array(n).fill(h * per * dx), q = new Float64Array(n);
      q[0] = Q;
      gc[0] = h * per * dx / 2;  // base cell: half-length exposed so the fin spans exactly H
      // Node-centred cell 0 sits at the base: shift so that node 0 is x = 0.
      const s = solveGrid({ nx: n, ny: 1, gx: gx, gy: 0, gc: gc, q: q, tAmb: tAmb, tol: 1e-10, maxSweeps: 400000 });
      const Gfd = Q / (s.T[0] - tAmb);
      const Gan = fe.eta * h * per * (Hmm / 1000);
      cases.push(bench("TB3", "Fin equation: Q/θb = η·h·A_fin, η = tanh(mH)/mH (mH = " + fe.mL.toFixed(2) + ", η = " + fe.eta.toFixed(3) + ")", Gan, Gfd, 1.5, s.balanceErr));
    })();
    // TB4 — energy balance on the four ProtoFlow boards + Pi 5 + MI300X.
    (function () {
      let worst = 0, worstName = "";
      const list = P.PROTOFLOW_BOARDS.concat(P.FAMOUS_BOARDS.filter(function (b) { return b.id === "pi5" || b.id === "mi300x"; }));
      list.forEach(function (b) {
        const r = solveThermal(P.designFromPreset(b));
        if (r.residual >= worst) { worst = r.residual; worstName = b.short || b.name; }
      });
      cases.push(bench("TB4", "Energy balance Σ h·A·(T−T∞) = P on 6 reference boards", 1, 1 - worst, RESIDUAL_LIMIT * 100, worst, "worst: " + worstName + " " + (worst * 100).toFixed(3) + " %"));
    })();
    // TB5 — grid independence: 32×32 vs 64×64 plate rise on the Pi 5 heatsink.
    (function () {
      const d = P.designFromPreset(P.FAMOUS_BOARDS[0]);
      const r32 = solveThermal(d, { grid: 32, tol: 1e-6 }), r64 = solveThermal(d, { grid: 64, tol: 1e-6 });
      cases.push(bench("TB5", "Grid independence: plate rise 32×32 vs 64×64", r64.plateMax - d.amb, r32.plateMax - d.amb, 3, Math.max(r32.residual, r64.residual)));
    })();
    return { cases: cases, allPass: cases.every(function (c) { return c.pass; }), ms: now() - t0 };
  }

  /* ------------------------------------------------------------------ */
  /* Helpers for the viewport                                           */
  /* ------------------------------------------------------------------ */
  function tempColor(t, lo, hi) {
    let f = (t - lo) / Math.max(1e-6, hi - lo);
    f = Math.min(1, Math.max(0, isFinite(f) ? f : 0));
    const stops = [[37, 99, 235], [6, 182, 212], [34, 197, 94], [234, 179, 8], [249, 115, 22], [220, 38, 38]];
    const p = f * (stops.length - 1), i = Math.min(stops.length - 2, Math.floor(p)), u = p - i;
    const a = stops[i], b = stops[i + 1];
    return [(a[0] + (b[0] - a[0]) * u) / 255, (a[1] + (b[1] - a[1]) * u) / 255, (a[2] + (b[2] - a[2]) * u) / 255];
  }
  // Bilinear temperature at plate coordinates (mm). null outside the board.
  function sampleTemperature(result, xMm, zMm) {
    const d = result.design, n = result.nx;
    const fx = (xMm / d.W + 0.5) * n - 0.5, fz = (zMm / d.D + 0.5) * result.ny - 0.5;
    if (fx < -0.5 || fz < -0.5 || fx > n - 0.5 || fz > result.ny - 0.5) return null;
    const ci = Math.min(n - 1, Math.max(0, Math.round(fx))), cj = Math.min(result.ny - 1, Math.max(0, Math.round(fz)));
    if (result.active && !result.active[cj * n + ci]) return null;
    const x0 = Math.max(0, Math.min(n - 2, Math.floor(fx))), z0 = Math.max(0, Math.min(result.ny - 2, Math.floor(fz)));
    const ux = Math.min(1, Math.max(0, fx - x0)), uz = Math.min(1, Math.max(0, fz - z0));
    const g = result.grid, at = function (i, j) { const c = j * n + i; return (result.active && !result.active[c]) ? g[cj * n + ci] : g[c]; };
    return (at(x0, z0) * (1 - ux) + at(x0 + 1, z0) * ux) * (1 - uz) + (at(x0, z0 + 1) * (1 - ux) + at(x0 + 1, z0 + 1) * ux) * uz;
  }

  return {
    VERSION: "2.0.0", GRID: GRID, NAT_CHOKE_GAP_MM: NAT_CHOKE_GAP_MM, RESIDUAL_LIMIT: RESIDUAL_LIMIT, ASSUMPTIONS: ASSUMPTIONS,
    finEfficiency: finEfficiency, finSpacing: finSpacing, chokeFactor: chokeFactor, convectionModel: convectionModel,
    solveGrid: solveGrid, solveGridMultilevel: solveGridMultilevel, solveThermal: solveThermal,
    spreadingResistance: spreadingResistance, resistanceNetwork: resistanceNetwork, quickTj: quickTj,
    autoOptimizeToTarget: autoOptimizeToTarget, runThermoBench5: runThermoBench5,
    tempColor: tempColor, sampleTemperature: sampleTemperature, pointInPolygon: pointInPolygon, polygonArea: polygonArea, activeMask: activeMask
  };
});
