/* =====================================================================
   SolidSay v3 · electrical-solver.js
   Fast 2-D DC resistive power-integrity screener:
   - 32×32 nodal KCL IR-drop solver on the same 2-D grid as thermal-solver.js
   - Temperature-coupled copper resistivity ρ(T) = 1.68e-8 · (1 + 0.00393·(T − 20)) Ω·m
     computed per cell from the thermal solve's 2-D temperature field
   - 2-D current-density map jGrid [A/mm²] for Thermal / Electrical / Both view
   - Honest pass/flag thresholds: IR drop > 5% of railV, J > 20 A/mm²
   - Model-limit display flags for unscaled/extreme outputs (> railV, > 500 A/mm²)
   - ElectroBench-3 independent hand-computed analytical benchmark suite

   Honesty note: this is a fast DC resistive screener (2-D nodal analysis
   on the copper geometry). It is NOT an Ansys SIwave or HyperLynx PDN
   sign-off tool (no AC impedance, decoupling resonances, or 3-D field
   extraction).

   Depends on presets.js and thermal-solver.js.
   ===================================================================== */
(function (root, factory) {
  "use strict";
  if (typeof module === "object" && module.exports) {
    module.exports = factory(require("./presets.js"), require("./thermal-solver.js"));
  } else {
    root.SolidSayElectrical = factory(root.SolidSayPresets, root.SolidSayThermal);
  }
})(typeof self !== "undefined" ? self : this, function (P, T) {
  "use strict";
  if (!P) throw new Error("electrical-solver.js needs presets.js loaded first");
  if (!T) throw new Error("electrical-solver.js needs thermal-solver.js loaded first");

  const GRID = T.GRID || 32;
  const RHO_CU_20C = 1.68e-8;            // Copper resistivity at 20 °C [Ω·m]
  const TEMP_COEFF_PER_C = 0.00393;      // +0.393 %/°C temperature coefficient
  // Locked copper thickness table (do not guess):
  // 0.5 oz = 17.5 µm, 1 oz = 35 µm, 2 oz = 70 µm.
  const COPPER_THICKNESS_UM = { 0.5: 17.5, 1: 35.0, 2: 70.0 };
  const COPPER_THICKNESS_MM = { 0.5: 0.0175, 1: 0.0350, 2: 0.0700 };
  const COPPER_THICKNESS_M  = { 0.5: 17.5e-6, 1: 35.0e-6, 2: 70.0e-6 };

  const IR_DROP_LIMIT_PCT = 5.0;         // > 5% of railV = flag
  const CURRENT_DENSITY_LIMIT_AMM2 = 20.0; // > 20 A/mm² = flag
  const J_MODEL_LIMIT_AMM2 = 500.0;      // Display cap for absurd current density
  const RESIDUAL_LIMIT = 0.03;           // Local KCL residual acceptance (3 %)

  const DISCLAIMER = "Fast DC resistive screener (2D nodal analysis on copper geometry, temperature-coupled +0.393%/°C) — not an Ansys SIwave / HyperLynx PDN sign-off tool.";
  const NO_POWER_MESSAGE = "no power delivery in this part";

  const ELECTRICAL_ASSUMPTIONS = [
    "DC resistive nodal analysis only — no AC PDN impedance Z(f), plane-cavity resonance, or decoupling capacitor loop inductance.",
    "Copper resistivity ρ(T) = 1.68e-8 × (1 + 0.00393 × (T − 20)) Ω·m per cell, coupled sequentially from the 32×32 thermal solve.",
    "Copper weight thickness table: 0.5 oz = 17.5 µm, 1 oz = 35 µm, 2 oz = 70 µm; trace cross-sectional area A = W × t_copper.",
    "Pass/Flag screening thresholds: worst IR drop > 5.0% of preset supply rail V_rail, or worst current density > 20.0 A/mm²."
  ];

  const now = (typeof performance !== "undefined" && performance.now)
    ? function () { return performance.now(); }
    : function () { return Date.now(); };

  /* ------------------------------------------------------------------ */
  /* Physical helper functions & model-limit formatters                 */
  /* ------------------------------------------------------------------ */
  function copperResistivity(tempC) {
    const t = (typeof tempC === "number" && isFinite(tempC)) ? tempC : 20;
    return RHO_CU_20C * (1 + TEMP_COEFF_PER_C * (t - 20));
  }

  function copperThicknessUm(oz) {
    if (COPPER_THICKNESS_UM[oz] !== undefined) return COPPER_THICKNESS_UM[oz];
    const w = (typeof oz === "number" && isFinite(oz) && oz > 0) ? oz : 1;
    return w * 35.0;
  }

  function copperThicknessMm(oz) {
    if (COPPER_THICKNESS_MM[oz] !== undefined) return COPPER_THICKNESS_MM[oz];
    return copperThicknessUm(oz) / 1000;
  }

  function copperThicknessM(oz) {
    if (COPPER_THICKNESS_M[oz] !== undefined) return COPPER_THICKNESS_M[oz];
    return copperThicknessUm(oz) * 1e-6;
  }

  function traceCrossSectionMm2(traceWidthMm, oz) {
    const w = Math.max(0, +traceWidthMm || 0);
    return w * copperThicknessMm(oz);
  }

  function traceCrossSectionM2(traceWidthMm, oz) {
    const w = Math.max(0, +traceWidthMm || 0);
    return (w / 1000) * copperThicknessM(oz);
  }

  function sheetResistance(oz, tempC) {
    return copperResistivity(tempC) / copperThicknessM(oz);
  }

  // Model-limit display formatters (Section 2, Rule 5):
  // Never print physically absurd IR drop (> railV) or current density (> 500 A/mm²) bare.
  function formatIrDrop(irDropMv, railV) {
    if (typeof irDropMv !== "number" || !isFinite(irDropMv)) return "—";
    const maxMv = (typeof railV === "number" && isFinite(railV) && railV > 0) ? railV * 1000 : 1000;
    if (irDropMv > maxMv) {
      return ">" + maxMv.toFixed(0) + " mV — model limit, unscaled rail collapse output, not a real voltage drop";
    }
    return irDropMv.toFixed(1) + " mV";
  }

  function formatIrDropShort(irDropMv, railV) {
    if (typeof irDropMv !== "number" || !isFinite(irDropMv)) return "—";
    const maxMv = (typeof railV === "number" && isFinite(railV) && railV > 0) ? railV * 1000 : 1000;
    if (irDropMv > maxMv) {
      return ">" + maxMv.toFixed(0) + " mV (model limit)";
    }
    return irDropMv.toFixed(1) + " mV";
  }

  function formatCurrentDensity(jAmm2) {
    if (typeof jAmm2 !== "number" || !isFinite(jAmm2)) return "—";
    if (jAmm2 > J_MODEL_LIMIT_AMM2) {
      return ">" + J_MODEL_LIMIT_AMM2.toFixed(0) + " A/mm² — model limit, uncooled trace output, not a real current density";
    }
    return jAmm2.toFixed(2) + " A/mm²";
  }

  function formatCurrentDensityShort(jAmm2) {
    if (typeof jAmm2 !== "number" || !isFinite(jAmm2)) return "—";
    if (jAmm2 > J_MODEL_LIMIT_AMM2) {
      return ">" + J_MODEL_LIMIT_AMM2.toFixed(0) + " A/mm²";
    }
    return jAmm2.toFixed(2) + " A/mm²";
  }

  /* ------------------------------------------------------------------ */
  /* 2-D Variable-Conductance Nodal KCL Solver                          */
  /* ------------------------------------------------------------------ */
  // Computes the L1 norm of per-node KCL residuals at all free active nodes:
  //   f_c = gFeed[c]·(railV − V_c) − iLoad[c] + Σ_{nb ∈ N(c)} G_{c,nb}·(V_nb − V_c)
  // No global balance shift is ever applied.
  function localKclResidual(o, V, act) {
    const nx = o.nx, ny = o.ny;
    const gxIsArr = typeof o.gx === "object" && o.gx !== null;
    const gyIsArr = typeof o.gy === "object" && o.gy !== null;
    const gFeed = o.gFeed;
    const fixed = o.fixed;
    const iLoad = o.iLoad;
    const railV = o.railV;
    let r = 0;
    for (let j = 0; j < ny; j++) {
      const row = j * nx;
      for (let i = 0; i < nx; i++) {
        const c = row + i;
        if (!act[c] || (fixed && fixed[c])) continue;
        const gf = gFeed ? gFeed[c] : 0;
        const il = iLoad ? iLoad[c] : 0;
        let f = gf * (railV - V[c]) - il;
        if (i > 0 && act[c - 1]) {
          const g = gxIsArr ? o.gx[c - 1] : o.gx;
          f += g * (V[c - 1] - V[c]);
        }
        if (i < nx - 1 && act[c + 1]) {
          const g = gxIsArr ? o.gx[c] : o.gx;
          f += g * (V[c + 1] - V[c]);
        }
        if (j > 0 && act[c - nx]) {
          const g = gyIsArr ? o.gy[c - nx] : o.gy;
          f += g * (V[c - nx] - V[c]);
        }
        if (j < ny - 1 && act[c + nx]) {
          const g = gyIsArr ? o.gy[c] : o.gy;
          f += g * (V[c + nx] - V[c]);
        }
        r += Math.abs(f);
      }
    }
    return r;
  }

  // o: { nx, ny, gx (Float64Array|Number), gy (Float64Array|Number),
  //      gFeed (Float64Array|null), fixed (Uint8Array|null),
  //      iLoad (Float64Array), active (Uint8Array|null),
  //      railV (Number), tol (Number), maxSweeps (Number) }
  // Solves the SPD nodal KCL system G·u = iLoad (where u_c = railV - V_c)
  // via Jacobi-preconditioned Conjugate Gradient + Gauss-Seidel polishing.
  function solveNodalGrid(o) {
    const nx = o.nx, ny = o.ny, n = nx * ny;
    const railV = (typeof o.railV === "number" && isFinite(o.railV)) ? o.railV : 5.0;
    const act = o.active || new Uint8Array(n).fill(1);
    const fixed = o.fixed || null;
    const gFeed = o.gFeed || null;
    const iLoad = o.iLoad || new Float64Array(n);
    const gxIsArr = typeof o.gx === "object" && o.gx !== null;
    const gyIsArr = typeof o.gy === "object" && o.gy !== null;
    const V = new Float64Array(n).fill(railV);

    let Itot = 0;
    let hasReference = false;
    for (let c = 0; c < n; c++) {
      if (!act[c]) continue;
      if (fixed && fixed[c]) {
        hasReference = true;
      } else {
        Itot += Math.max(0, iLoad[c]);
        if (gFeed && gFeed[c] > 0) hasReference = true;
      }
    }
    if (!(Itot > 0)) {
      return { V: V, sweeps: 0, residual: 0, localResidual: 0, totalCurrentA: 0, converged: true };
    }
    if (!hasReference) {
      return { V: V, sweeps: 0, residual: Infinity, localResidual: Infinity, totalCurrentA: Itot, converged: false, error: "no supply reference node" };
    }

    // Build diagonal D[c] for free active nodes
    const diag = new Float64Array(n);
    const freeMask = new Uint8Array(n);
    for (let j = 0; j < ny; j++) {
      const row = j * nx;
      for (let i = 0; i < nx; i++) {
        const c = row + i;
        if (!act[c] || (fixed && fixed[c])) continue;
        freeMask[c] = 1;
        let d = gFeed ? gFeed[c] : 0;
        if (i > 0 && act[c - 1]) d += gxIsArr ? o.gx[c - 1] : o.gx;
        if (i < nx - 1 && act[c + 1]) d += gxIsArr ? o.gx[c] : o.gx;
        if (j > 0 && act[c - nx]) d += gyIsArr ? o.gy[c - nx] : o.gy;
        if (j < ny - 1 && act[c + nx]) d += gyIsArr ? o.gy[c] : o.gy;
        diag[c] = d;
      }
    }

    // Matrix-vector product y = A * u on free active nodes
    function applyA(u, y) {
      for (let j = 0; j < ny; j++) {
        const row = j * nx;
        for (let i = 0; i < nx; i++) {
          const c = row + i;
          if (!freeMask[c]) { y[c] = 0; continue; }
          let s = diag[c] * u[c];
          if (i > 0 && freeMask[c - 1]) s -= (gxIsArr ? o.gx[c - 1] : o.gx) * u[c - 1];
          if (i < nx - 1 && freeMask[c + 1]) s -= (gxIsArr ? o.gx[c] : o.gx) * u[c + 1];
          if (j > 0 && freeMask[c - nx]) s -= (gyIsArr ? o.gy[c - nx] : o.gy) * u[c - nx];
          if (j < ny - 1 && freeMask[c + nx]) s -= (gyIsArr ? o.gy[c] : o.gy) * u[c + nx];
          y[c] = s;
        }
      }
    }

    const tol = o.tol || 1e-7;
    const maxIter = o.maxSweeps || Math.max(400, n * 4);
    const u = new Float64Array(n);
    const r = new Float64Array(n);
    const z = new Float64Array(n);
    const p = new Float64Array(n);
    const Ap = new Float64Array(n);

    let rz = 0;
    for (let c = 0; c < n; c++) {
      if (!freeMask[c]) continue;
      r[c] = iLoad[c];
      z[c] = diag[c] > 0 ? r[c] / diag[c] : 0;
      p[c] = z[c];
      rz += r[c] * z[c];
    }

    let iter = 0;
    let residual = Infinity;
    while (iter < maxIter) {
      iter++;
      applyA(p, Ap);
      let pAp = 0;
      let rL1 = 0;
      for (let c = 0; c < n; c++) {
        if (!freeMask[c]) continue;
        pAp += p[c] * Ap[c];
      }
      if (pAp <= 1e-30) break;
      const alpha = rz / pAp;
      let rzNext = 0;
      for (let c = 0; c < n; c++) {
        if (!freeMask[c]) continue;
        u[c] += alpha * p[c];
        r[c] -= alpha * Ap[c];
        rL1 += Math.abs(r[c]);
        z[c] = diag[c] > 0 ? r[c] / diag[c] : 0;
        rzNext += r[c] * z[c];
      }
      residual = rL1 / Itot;
      if (residual < tol) break;
      if (rzNext <= 1e-30) break;
      const beta = rzNext / rz;
      rz = rzNext;
      for (let c = 0; c < n; c++) {
        if (!freeMask[c]) continue;
        p[c] = z[c] + beta * p[c];
      }
    }

    for (let c = 0; c < n; c++) {
      V[c] = freeMask[c] ? (railV - u[c]) : railV;
    }

    // Gauss-Seidel SOR polishing if needed
    if (residual >= tol) {
      const omega = 1.65;
      const extraMax = 2000;
      for (let s = 0; s < extraMax; s++) {
        for (let j = 0; j < ny; j++) {
          const row = j * nx;
          for (let i = 0; i < nx; i++) {
            const c = row + i;
            if (!freeMask[c] || !(diag[c] > 0)) continue;
            let sum = (gFeed ? gFeed[c] * railV : 0) - iLoad[c];
            if (i > 0 && act[c - 1]) sum += (gxIsArr ? o.gx[c - 1] : o.gx) * V[c - 1];
            if (i < nx - 1 && act[c + 1]) sum += (gxIsArr ? o.gx[c] : o.gx) * V[c + 1];
            if (j > 0 && act[c - nx]) sum += (gyIsArr ? o.gy[c - nx] : o.gy) * V[c - nx];
            if (j < ny - 1 && act[c + nx]) sum += (gyIsArr ? o.gy[c] : o.gy) * V[c + nx];
            V[c] += omega * (sum / diag[c] - V[c]);
          }
        }
        iter++;
        if ((s & 15) === 15) {
          residual = localKclResidual(o, V, act) / Itot;
          if (residual < tol) break;
        }
      }
    }

    residual = localKclResidual(o, V, act) / Itot;
    return {
      V: V,
      sweeps: iter,
      residual: residual,
      localResidual: residual,
      totalCurrentA: Itot,
      converged: residual < Math.max(tol * 10, 1e-3)
    };
  }

  /* ------------------------------------------------------------------ */
  /* Design -> 2-D Resistive Network & Public Solve                     */
  /* ------------------------------------------------------------------ */
  function overlap1D(a0, a1, b0, b1) {
    return Math.max(0, Math.min(a1, b1) - Math.max(a0, b0));
  }

  // Plated through-hole via barrel resistance at temperature tempC:
  // Outer drill diameter 0.30 mm (r_o = 0.15 mm = 1.5e-4 m),
  // 25 µm copper barrel plating (r_i = 0.125 mm = 1.25e-4 m),
  // barrel length h_via = 1.6 mm = 1.6e-3 m.
  // Annulus area A_via = π·(r_o² − r_i²) = π·6.875e-9 = 2.15984495e-8 m².
  function singleViaConductance(tempC, boardThicknessMm) {
    const rho = copperResistivity(tempC);
    const hViaM = Math.max(0.2, +boardThicknessMm || 1.6) * 1e-3;
    const rOuterM = 1.5e-4, rInnerM = 1.25e-4;
    const areaViaM2 = Math.PI * (rOuterM * rOuterM - rInnerM * rInnerM);
    return areaViaM2 / (rho * hViaM);
  }

  function solveElectrical(design, thermalResult, opts) {
    const t0 = now();
    const sd = P.sanitizeDesign(design);
    const d = sd.design;
    const N = (opts && opts.grid) || (thermalResult && thermalResult.nx) || GRID;

    // Sequential solve rule (Section 3.1): thermal runs first, then electrical,
    // and both solvers agree on the 2-D temperature field.
    const tRes = (thermalResult && thermalResult.grid && thermalResult.grid.length === N * N)
      ? thermalResult
      : T.solveThermal(d, { grid: N });

    // Handle passive / non-power-delivery parts (copper: null)
    if (!d.copper) {
      const msNull = now() - t0;
      return {
        hasCopper: false,
        hasPowerDelivery: false,
        applicable: false,
        status: NO_POWER_MESSAGE,
        message: NO_POWER_MESSAGE,
        disclaimer: DISCLAIMER,
        design: d,
        railV: null,
        copper: null,
        vGrid: null,
        dropGridMv: null,
        jGrid: null,
        rhoGrid: null,
        nx: N,
        ny: N,
        active: tRes.active || T.activeMask(d, N, N),
        totalCurrentA: 0,
        minVoltageV: 0,
        worstIrDropMv: 0,
        worstIrDropPct: 0,
        worstIrDropDisplay: NO_POWER_MESSAGE,
        worstIrDropShort: NO_POWER_MESSAGE,
        worstCurrentDensityAmm2: 0,
        worstCurrentDensityDisplay: NO_POWER_MESSAGE,
        worstCurrentDensityShort: NO_POWER_MESSAGE,
        irDropLimitPct: IR_DROP_LIMIT_PCT,
        irDropLimitMv: 0,
        currentDensityLimitAmm2: CURRENT_DENSITY_LIMIT_AMM2,
        irDropFlag: false,
        currentDensityFlag: false,
        overModelLimit: false,
        pass: true,
        converged: true,
        localResidual: 0,
        iterations: 0,
        ms: msNull,
        assumptions: ELECTRICAL_ASSUMPTIONS,
        warnings: []
      };
    }

    const cu = d.copper;
    const railV = Math.max(0.3, +d.railV || 5.0);
    const oz = cu.copperOz;
    const tUm = copperThicknessUm(oz);
    const tMm = copperThicknessMm(oz);
    const tM  = copperThicknessM(oz);
    const traceWidthMm = Math.max(0.1, +cu.traceWidthMm || 5.0);
    const layers = Math.max(1, Math.round(+cu.layers || 4));
    const vias = Math.max(1, Math.round(+cu.vias || 64));
    const crossSectionMm2 = traceCrossSectionMm2(traceWidthMm, oz);

    const nx = N, ny = N, n = nx * ny;
    const dxMm = d.W / nx, dyMm = d.D / ny;
    const active = tRes.active || T.activeMask(d, nx, ny);

    // 1. Temperature-coupled copper resistivity ρ(T_c) per cell from thermal solve
    const rhoGrid = new Float32Array(n);
    const sigmaSheet = new Float64Array(n);
    // Number of parallel power/ground return plane pairs and trace routing fill
    const nPowerLayers = Math.max(1, Math.floor(layers / 2));
    const traceFill = Math.min(1.0, Math.max(0.12, traceWidthMm / Math.max(2.0, 0.28 * Math.min(d.W, d.D))));
    for (let c = 0; c < n; c++) {
      const tempC = tRes.grid ? tRes.grid[c] : d.amb;
      const rho = copperResistivity(tempC);
      rhoGrid[c] = rho;
      // Sheet conductance [S·□] = (t_copper * nPowerLayers * traceFill) / ρ(T_c)
      sigmaSheet[c] = active[c] ? (tM * nPowerLayers * traceFill) / rho : 0;
    }

    // 2. Build 2-D harmonic-mean link conductances gx[c], gy[c]
    const gx = new Float64Array(n);
    const gy = new Float64Array(n);
    const aspectX = dyMm / dxMm;
    const aspectY = dxMm / dyMm;
    for (let j = 0; j < ny; j++) {
      const row = j * nx;
      for (let i = 0; i < nx; i++) {
        const c = row + i;
        if (!active[c]) continue;
        if (i < nx - 1 && active[c + 1]) {
          const s0 = sigmaSheet[c], s1 = sigmaSheet[c + 1];
          gx[c] = (s0 > 0 && s1 > 0) ? (2 * s0 * s1 / (s0 + s1)) * aspectX : 0;
        }
        if (j < ny - 1 && active[c + nx]) {
          const s0 = sigmaSheet[c], s1 = sigmaSheet[c + nx];
          gy[c] = (s0 > 0 && s1 > 0) ? (2 * s0 * s1 / (s0 + s1)) * aspectY : 0;
        }
      }
    }

    // 3. Rasterise heat/power sources onto active cells and compute current load I_c = q_c / railV
    const sources = P.heatSources(d);
    const iLoad = new Float64Array(n);
    sources.forEach(function (s) {
      const x0 = s.x - s.w / 2, x1 = s.x + s.w / 2;
      const z0 = s.z - s.d / 2, z1 = s.z + s.d / 2;
      const cells = [];
      let covered = 0;
      for (let j = 0; j < ny; j++) {
        const cz0 = -d.D / 2 + j * dyMm, ozLap = overlap1D(z0, z1, cz0, cz0 + dyMm);
        if (!ozLap) continue;
        for (let i = 0; i < nx; i++) {
          const c = j * nx + i;
          if (!active[c]) continue;
          const cx0 = -d.W / 2 + i * dxMm, oxLap = overlap1D(x0, x1, cx0, cx0 + dxMm);
          if (!oxLap) continue;
          cells.push([c, oxLap * ozLap]);
          covered += oxLap * ozLap;
        }
      }
      if (!cells.length) {
        let best = -1, bd = Infinity;
        for (let c = 0; c < n; c++) if (active[c]) {
          const ci = c % nx, cj = (c / nx) | 0;
          const dd = Math.hypot(-d.W / 2 + (ci + 0.5) * dxMm - s.x, -d.D / 2 + (cj + 0.5) * dyMm - s.z);
          if (dd < bd) { bd = dd; best = c; }
        }
        if (best >= 0) { cells.push([best, 1]); covered = 1; }
      }
      const iSrc = Math.max(0, s.power) / railV;
      cells.forEach(function (cw) { iLoad[cw[0]] += iSrc * cw[1] / covered; });
    });

    // 4. Supply feed nodes (VRM / input connector + via stitch field along input edge)
    // Locate the leftmost active cell in the central rows (or any active row)
    const feedCells = [];
    const jStart = Math.max(0, Math.floor(ny * 0.25));
    const jEnd = Math.min(ny - 1, Math.ceil(ny * 0.75));
    for (let j = jStart; j <= jEnd; j++) {
      for (let i = 0; i < nx; i++) {
        const c = j * nx + i;
        if (active[c]) { feedCells.push(c); break; }
      }
    }
    if (!feedCells.length) {
      for (let c = 0; c < n; c++) if (active[c]) { feedCells.push(c); break; }
    }

    const gFeed = new Float64Array(n);
    const boardT = (d.pcb && d.pcb.boardT) || 1.6;
    // Trunk entry length L_entry ≈ 0.15 * W through trace of cross-section A = W_trace * t_copper * nFeedPlanes
    const nFeedPlanes = Math.max(1, Math.floor(layers / 2));
    const lEntryM = Math.max(0.002, 0.15 * (d.W / 1000));
    const aTrunkM2 = traceCrossSectionM2(traceWidthMm, oz) * nFeedPlanes;
    feedCells.forEach(function (c) {
      const tempC = tRes.grid ? tRes.grid[c] : d.amb;
      const rho = rhoGrid[c] || copperResistivity(tempC);
      const gTrunkCell = (aTrunkM2 / (rho * lEntryM)) / feedCells.length;
      const gViaCell = (vias * singleViaConductance(tempC, boardT)) / feedCells.length;
      // Series combination of trunk trace entry + via array at each feed cell
      gFeed[c] = (gTrunkCell * gViaCell) / Math.max(1e-18, gTrunkCell + gViaCell);
    });

    // 5. Solve the 2-D nodal system
    const sol = solveNodalGrid({
      nx: nx, ny: ny,
      gx: gx, gy: gy,
      gFeed: gFeed,
      iLoad: iLoad,
      active: active,
      railV: railV,
      tol: (opts && opts.tol) || 1e-7
    });

    // 6. Compute voltage map, IR-drop map, and 2-D current density map jGrid [A/mm²]
    // Cross-sectional area of a single copper trace: A = W_trace * t_copper [mm²].
    // Current is shared across nFeedPlanes parallel power layers, so effective trace area is
    // A_eff = crossSectionMm2 * nFeedPlanes, while per-cell sheet current density is also
    // evaluated so both plane hot-spots and trace bottlenecks are captured on jGrid.
    const vGrid = new Float32Array(n);
    const dropGridMv = new Float32Array(n);
    const jGrid = new Float32Array(n);
    let minVoltageV = railV;
    let worstIrDropMv = 0;
    let worstCurrentDensityAmm2 = 0;

    // Effective cell cross-section [mm²] mapping cell current to trace current density:
    // At a feed cell carrying I_tot / feedCells.length, the sum of feed currents is I_tot,
    // which flows through the trunk trace of cross-section A_trace = W_trace * t_copper (per power plane).
    const trunkAreaMm2 = Math.max(1e-9, crossSectionMm2 * Math.max(1, Math.floor(layers / 4)));
    const cellAreaMm2 = Math.max(1e-9, Math.min(trunkAreaMm2, (0.5 * (dxMm + dyMm)) * tMm * nPowerLayers * traceFill));

    for (let j = 0; j < ny; j++) {
      const row = j * nx;
      for (let i = 0; i < nx; i++) {
        const c = row + i;
        if (!active[c]) {
          vGrid[c] = railV;
          dropGridMv[c] = 0;
          jGrid[c] = 0;
          continue;
        }
        const vc = sol.V[c];
        vGrid[c] = vc;
        const dropMv = Math.max(0, (railV - vc) * 1000);
        dropGridMv[c] = dropMv;
        if (vc < minVoltageV) minVoltageV = vc;
        if (dropMv > worstIrDropMv) worstIrDropMv = dropMv;

        // X and Y link currents [A]
        const ixL = (i > 0 && active[c - 1]) ? gx[c - 1] * (sol.V[c - 1] - vc) : 0;
        const ixR = (i < nx - 1 && active[c + 1]) ? gx[c] * (vc - sol.V[c + 1]) : 0;
        const iyU = (j > 0 && active[c - nx]) ? gy[c - nx] * (sol.V[c - nx] - vc) : 0;
        const iyD = (j < ny - 1 && active[c + nx]) ? gy[c] * (vc - sol.V[c + nx]) : 0;
        const ix = 0.5 * (Math.abs(ixL) + Math.abs(ixR));
        const iy = 0.5 * (Math.abs(iyU) + Math.abs(iyD));
        const iFeedCell = gFeed[c] > 0 ? gFeed[c] * Math.max(0, railV - vc) * feedCells.length : 0;
        const iLateral = Math.hypot(ix, iy);

        const jLateral = iLateral / cellAreaMm2;
        const jTrunk = iFeedCell / trunkAreaMm2;
        const jc = Math.max(jLateral, jTrunk);
        jGrid[c] = jc;
        if (jc > worstCurrentDensityAmm2) worstCurrentDensityAmm2 = jc;
      }
    }

    const worstIrDropPct = (worstIrDropMv / (railV * 1000)) * 100;
    const irDropLimitMv = railV * 1000 * (IR_DROP_LIMIT_PCT / 100);
    const irDropFlag = worstIrDropPct > IR_DROP_LIMIT_PCT;
    const currentDensityFlag = worstCurrentDensityAmm2 > CURRENT_DENSITY_LIMIT_AMM2;
    const overModelLimit = (worstIrDropMv > railV * 1000) || (worstCurrentDensityAmm2 > J_MODEL_LIMIT_AMM2);
    const pass = !irDropFlag && !currentDensityFlag && sol.converged;

    const warnings = sd.warnings.slice();
    if (!sol.converged) {
      warnings.push("Electrical nodal solver did not reach the local KCL residual convergence criterion (local residual " + (sol.localResidual * 100).toFixed(4) + " %).");
    }

    return {
      hasCopper: true,
      hasPowerDelivery: true,
      applicable: true,
      status: pass ? "PASS" : "FLAG",
      message: DISCLAIMER,
      disclaimer: DISCLAIMER,
      design: d,
      railV: railV,
      copper: {
        traceWidthMm: traceWidthMm,
        copperOz: oz,
        thicknessUm: tUm,
        thicknessMm: tMm,
        crossSectionMm2: crossSectionMm2,
        layers: layers,
        vias: vias,
        railV: railV
      },
      vGrid: vGrid,
      dropGridMv: dropGridMv,
      jGrid: jGrid,
      rhoGrid: rhoGrid,
      nx: nx,
      ny: ny,
      active: active,
      totalCurrentA: sol.totalCurrentA,
      minVoltageV: minVoltageV,
      worstIrDropMv: worstIrDropMv,
      worstIrDropPct: worstIrDropPct,
      worstIrDropDisplay: formatIrDrop(worstIrDropMv, railV),
      worstIrDropShort: formatIrDropShort(worstIrDropMv, railV),
      worstCurrentDensityAmm2: worstCurrentDensityAmm2,
      worstCurrentDensityDisplay: formatCurrentDensity(worstCurrentDensityAmm2),
      worstCurrentDensityShort: formatCurrentDensityShort(worstCurrentDensityAmm2),
      irDropLimitPct: IR_DROP_LIMIT_PCT,
      irDropLimitMv: irDropLimitMv,
      currentDensityLimitAmm2: CURRENT_DENSITY_LIMIT_AMM2,
      irDropFlag: irDropFlag,
      currentDensityFlag: currentDensityFlag,
      overModelLimit: overModelLimit,
      pass: pass,
      converged: sol.converged,
      localResidual: sol.localResidual,
      iterations: sol.sweeps,
      ms: now() - t0,
      assumptions: ELECTRICAL_ASSUMPTIONS,
      warnings: warnings
    };
  }

  /* ------------------------------------------------------------------ */
  /* ElectroBench-3: Independent Hand-Computed Analytical Benchmarks     */
  /* ------------------------------------------------------------------ */
  // Every reference constant below is hand-computed from first principles
  // with full arithmetic shown in comments, and coded as a literal number.
  // None of these benchmarks ever call solver helpers to compute their
  // reference values (Section 2, Rule 4 & Section 3.3).
  function benchCase(id, name, analytic, numeric, tolPct, localResidual, detail, extra) {
    const errPct = Math.abs(numeric - analytic) / Math.max(1e-12, Math.abs(analytic)) * 100;
    const resOk = !(localResidual > RESIDUAL_LIMIT);
    return Object.assign({
      id: id,
      name: name,
      analytic: analytic,
      numeric: numeric,
      errPct: errPct,
      tolPct: tolPct,
      residualPct: (localResidual || 0) * 100,
      pass: errPct < tolPct && resOk,
      detail: detail
    }, extra || {});
  }

  function runElectroBench3() {
    const t0 = now();
    const cases = [];

    // ------------------------------------------------------------------
    // EB1 — Single Straight Trace: ΔV = I · ρ · L / A
    // Hand calculation from first principles:
    //   Current:       I = 4.0 A
    //   Supply rail:   V_rail = 5.0 V
    //   Trace length:  L = 50 mm = 0.050 m
    //   Trace width:   W = 2.0 mm = 0.002 m
    //   Copper weight: 1 oz → t_copper = 35 µm = 3.5e-5 m
    //   Temperature:   T = 20 °C → ρ = 1.68e-8 Ω·m
    //   Cross-section: A = W × t_copper = 0.002 m × 3.5e-5 m = 7.0e-8 m² (0.070 mm²)
    //   Resistance:    R = ρ · L / A = (1.68e-8 × 0.050) / 7.0e-8
    //                    = 8.4e-10 / 7.0e-8 = 0.012 Ω (12.0 mΩ)
    //   IR drop:       ΔV = I × R = 4.0 A × 0.012 Ω = 0.048 V = 48.0 mV
    //   Current dens.: J  = I / A_mm² = 4.0 A / 0.070 mm² = 57.142857 A/mm²
    // ------------------------------------------------------------------
    (function () {
      const ANALYTIC_DROP_MV = 48.0;       // Hand-computed literal: 4.0 A * 0.012 Ω * 1000
      const ANALYTIC_J_AMM2  = 57.142857;  // Hand-computed literal: 4.0 A / 0.070 mm²
      const nx = 32, ny = 4, n = nx * ny;
      const nSeg = nx - 1;                 // 31 series segments spanning L = 0.050 m
      const dxM = 0.050 / nSeg;
      const gSegTotal = (1 / 1.68e-8) * (7.0e-8 / dxM);
      const gx = gSegTotal / ny;           // Split equally across the ny=4 strip rows
      const gy = gx * 10;                  // Transverse equipotential coupling across trace width
      const fixed = new Uint8Array(n);
      const iLoad = new Float64Array(n);
      for (let j = 0; j < ny; j++) {
        fixed[j * nx + 0] = 1;             // Left end of trace clamped to V_rail = 5.0 V
        iLoad[j * nx + (nx - 1)] = 4.0 / ny; // 4.0 A total drawn at right end of trace
      }
      const s = solveNodalGrid({ nx: nx, ny: ny, gx: gx, gy: gy, fixed: fixed, iLoad: iLoad, railV: 5.0, tol: 1e-11 });
      const dropMv = (5.0 - s.V[nx - 1]) * 1000;
      const iSeg = 0;
      let totalCurrentEnd = 0;
      for (let j = 0; j < ny; j++) {
        totalCurrentEnd += gx * (s.V[j * nx + (nx - 2)] - s.V[j * nx + (nx - 1)]);
      }
      const jSolved = totalCurrentEnd / (0.002 * 1000 * 0.035);
      cases.push(benchCase(
        "EB1",
        "Single straight trace: ΔV = I·ρL/A hand-computed (48.0 mV)",
        ANALYTIC_DROP_MV,
        dropMv,
        0.5,
        s.localResidual,
        "Hand ref 48.0 mV (R = 12.0 mΩ, J = " + jSolved.toFixed(2) + " vs " + ANALYTIC_J_AMM2.toFixed(2) + " A/mm²)",
        { jAnalyticAmm2: ANALYTIC_J_AMM2, jNumericAmm2: jSolved }
      ));
    })();

    // ------------------------------------------------------------------
    // EB2 — Two Parallel Traces: Current Split & Drop by Conductance
    // Hand calculation from first principles:
    //   Two parallel 1 oz (t = 3.5e-5 m) copper traces of length L = 40 mm = 0.040 m
    //   at T = 20 °C (ρ = 1.68e-8 Ω·m) between V_rail = 12.0 V and a common load
    //   bus drawing I_tot = 6.0 A:
    //   - Trace A (width W_A = 1.5 mm = 0.0015 m):
    //       A_A = 0.0015 × 3.5e-5 = 5.25e-8 m²
    //       R_A = (1.68e-8 × 0.040) / 5.25e-8 = 6.72e-10 / 5.25e-8 = 0.0128 Ω
    //       G_A = 1 / 0.0128 = 78.125 S
    //   - Trace B (width W_B = 3.0 mm = 0.0030 m):
    //       A_B = 0.0030 × 3.5e-5 = 1.05e-7 m²
    //       R_B = (1.68e-8 × 0.040) / 1.05e-7 = 6.72e-10 / 1.05e-7 = 0.0064 Ω
    //       G_B = 1 / 0.0064 = 156.25 S
    //   - Parallel combination:
    //       G_eq = G_A + G_B = 78.125 + 156.25 = 234.375 S
    //       ΔV   = I_tot / G_eq = 6.0 / 234.375 = 0.0256 V = 25.6 mV
    //   - Branch currents split by conductance:
    //       I_A = 6.0 × (78.125 / 234.375) = 2.0 A
    //       I_B = 6.0 × (156.25 / 234.375) = 4.0 A
    // ------------------------------------------------------------------
    (function () {
      const ANALYTIC_DROP_MV = 25.6;       // Hand-computed literal: 6.0 A / 234.375 S * 1000
      const ANALYTIC_IA = 2.0;             // Hand-computed literal: 6.0 * (1/3) A
      const ANALYTIC_IB = 4.0;             // Hand-computed literal: 6.0 * (2/3) A
      const nx = 32, ny = 5, n = nx * ny;
      const nSeg = nx - 1;                 // 31 segments spanning L = 0.040 m
      const dxM = 0.040 / nSeg;
      const gx = new Float64Array(n);
      const gy = new Float64Array(n);
      const act = new Uint8Array(n);
      const fixed = new Uint8Array(n);
      const iLoad = new Float64Array(n);

      const gSegA = (5.25e-8 / (1.68e-8 * dxM));
      const gSegB = (1.05e-7 / (1.68e-8 * dxM));

      // Row j=1 is Trace A, Row j=3 is Trace B; column i=nx-1 is the common load bus
      for (let i = 0; i < nx; i++) {
        act[1 * nx + i] = 1;
        act[3 * nx + i] = 1;
        if (i < nx - 1) {
          gx[1 * nx + i] = gSegA;
          gx[3 * nx + i] = gSegB;
        }
      }
      // Common load bus at i = nx - 1 connecting j = 1, 2, 3 with superconducting bus bar
      act[2 * nx + (nx - 1)] = 1;
      gy[1 * nx + (nx - 1)] = 1e8;
      gy[2 * nx + (nx - 1)] = 1e8;

      fixed[1 * nx + 0] = 1;
      fixed[3 * nx + 0] = 1;
      iLoad[2 * nx + (nx - 1)] = 6.0;

      const s = solveNodalGrid({ nx: nx, ny: ny, gx: gx, gy: gy, fixed: fixed, iLoad: iLoad, active: act, railV: 12.0, tol: 1e-11 });
      const dropMv = (12.0 - s.V[2 * nx + (nx - 1)]) * 1000;
      const iA = gSegA * (s.V[1 * nx + 0] - s.V[1 * nx + 1]);
      const iB = gSegB * (s.V[3 * nx + 0] - s.V[3 * nx + 1]);
      const splitErrPct = Math.max(
        Math.abs(iA - ANALYTIC_IA) / ANALYTIC_IA * 100,
        Math.abs(iB - ANALYTIC_IB) / ANALYTIC_IB * 100
      );
      cases.push(benchCase(
        "EB2",
        "Two parallel traces: current split by conductance hand-computed (25.6 mV, 2.0 A / 4.0 A)",
        ANALYTIC_DROP_MV,
        dropMv,
        0.5,
        s.localResidual,
        "Hand ref 25.6 mV; branch currents I_A = " + iA.toFixed(4) + " A (ref 2.0 A), I_B = " + iB.toFixed(4) + " A (ref 4.0 A)",
        { iA: iA, iB: iB, analyticIA: ANALYTIC_IA, analyticIB: ANALYTIC_IB, splitErrPct: splitErrPct }
      ));
    })();

    // ------------------------------------------------------------------
    // EB3 — Via Field: Equivalent Resistance & IR Drop of 16 Parallel Vias
    // Hand calculation from first principles:
    //   16 plated through-hole vias in parallel (4×4 stitching array)
    //   Board thickness:   h_via = 1.6 mm = 0.0016 m
    //   Outer barrel rad.: r_o = 0.15 mm = 1.5e-4 m (0.30 mm drill)
    //   Inner barrel rad.: r_i = 0.125 mm = 1.25e-4 m (25 µm Cu barrel plating)
    //   Temperature:       T = 20 °C → ρ = 1.68e-8 Ω·m
    //   Single via barrel cross-sectional area:
    //     r_o² − r_i² = (2.25 − 1.5625) × 10⁻⁸ = 6.875 × 10⁻⁹ m²
    //     A_via = π × 6.875 × 10⁻⁹ = 2.15984495 × 10⁻⁸ m²
    //   Single via resistance:
    //     R_via = ρ · h_via / A_via = (1.68e-8 × 0.0016) / 2.15984495e-8
    //           = 2.688e-11 / 2.15984495e-8 = 0.0012445338 Ω (1.2445338 mΩ)
    //   16 parallel vias equivalent resistance:
    //     R_eq = R_via / 16 = 7.778336 × 10⁻⁵ Ω (0.07778336 mΩ)
    //   At total load current I_tot = 16.0 A on V_rail = 3.3 V:
    //     ΔV = I_tot × R_eq = 16.0 × 7.778336e-5 = 0.0012445338 V = 1.2445338 mV
    // ------------------------------------------------------------------
    (function () {
      const ANALYTIC_DROP_MV  = 1.2445338;  // Hand-computed literal: 16.0 A * 7.778336e-5 Ω * 1000
      const ANALYTIC_REQ_MOHM = 0.07778336; // Hand-computed literal: 1.2445338 mΩ / 16
      const nx = 16, ny = 16, n = nx * ny;
      const gFeed = new Float64Array(n);
      const iLoad = new Float64Array(n);
      const rOuterM = 1.5e-4, rInnerM = 1.25e-4, hViaM = 0.0016, rho20 = 1.68e-8;
      const gSingleVia = (Math.PI * (rOuterM * rOuterM - rInnerM * rInnerM)) / (rho20 * hViaM);
      const viaCoords = [3, 6, 9, 12];
      viaCoords.forEach(function (vj) {
        viaCoords.forEach(function (vi) {
          const c = vj * nx + vi;
          gFeed[c] = gSingleVia;
          iLoad[c] = 16.0 / 16; // 16.0 A total load across the 16-via stitching pad
        });
      });
      const s = solveNodalGrid({
        nx: nx, ny: ny,
        gx: 1e6, gy: 1e6, // Isopotential copper pad connecting the 16-via array
        gFeed: gFeed,
        iLoad: iLoad,
        railV: 3.3,
        tol: 1e-11
      });
      const c0 = viaCoords[0] * nx + viaCoords[0];
      const dropMv = (3.3 - s.V[c0]) * 1000;
      const reqMohm = dropMv / 16.0;
      cases.push(benchCase(
        "EB3",
        "Via field (16 parallel PTH vias): R_eq = 0.07778 mΩ, ΔV = 1.2445 mV hand-computed",
        ANALYTIC_DROP_MV,
        dropMv,
        0.5,
        s.localResidual,
        "Hand ref ΔV = 1.244534 mV, R_eq = " + reqMohm.toFixed(6) + " mΩ (ref " + ANALYTIC_REQ_MOHM.toFixed(6) + " mΩ)",
        { reqMohm: reqMohm, analyticReqMohm: ANALYTIC_REQ_MOHM }
      ));
    })();

    const worstErrPct = cases.reduce(function (m, c) { return Math.max(m, c.errPct); }, 0);
    return {
      cases: cases,
      allPass: cases.every(function (c) { return c.pass; }),
      worstErrPct: worstErrPct,
      ms: now() - t0
    };
  }

  /* ------------------------------------------------------------------ */
  /* Viewport helpers (3-D heatPlane & 2-D #grid2d colour + sampling)   */
  /* ------------------------------------------------------------------ */
  function elecColor(jAmm2, lo, hi) {
    let f = (jAmm2 - lo) / Math.max(1e-6, hi - lo);
    f = Math.min(1, Math.max(0, isFinite(f) ? f : 0));
    // Distinct cyan-indigo-magenta-amber-crimson ramp for current density
    const stops = [
      [15, 23, 42],
      [14, 165, 233],
      [16, 185, 129],
      [245, 158, 11],
      [239, 68, 68],
      [217, 70, 239]
    ];
    const p = f * (stops.length - 1), i = Math.min(stops.length - 2, Math.floor(p)), u = p - i;
    const a = stops[i], b = stops[i + 1];
    return [
      (a[0] + (b[0] - a[0]) * u) / 255,
      (a[1] + (b[1] - a[1]) * u) / 255,
      (a[2] + (b[2] - a[2]) * u) / 255
    ];
  }

  function sampleGridField(elecResult, gridArr, xMm, zMm) {
    if (!elecResult || !elecResult.hasPowerDelivery || !gridArr) return null;
    const d = elecResult.design, n = elecResult.nx, ny = elecResult.ny;
    const fx = (xMm / d.W + 0.5) * n - 0.5, fz = (zMm / d.D + 0.5) * ny - 0.5;
    if (fx < -0.5 || fz < -0.5 || fx > n - 0.5 || fz > ny - 0.5) return null;
    const ci = Math.min(n - 1, Math.max(0, Math.round(fx))), cj = Math.min(ny - 1, Math.max(0, Math.round(fz)));
    if (elecResult.active && !elecResult.active[cj * n + ci]) return null;
    const x0 = Math.max(0, Math.min(n - 2, Math.floor(fx))), z0 = Math.max(0, Math.min(ny - 2, Math.floor(fz)));
    const ux = Math.min(1, Math.max(0, fx - x0)), uz = Math.min(1, Math.max(0, fz - z0));
    const at = function (i, j) {
      const c = j * n + i;
      return (elecResult.active && !elecResult.active[c]) ? gridArr[cj * n + ci] : gridArr[c];
    };
    return (at(x0, z0) * (1 - ux) + at(x0 + 1, z0) * ux) * (1 - uz) +
           (at(x0, z0 + 1) * (1 - ux) + at(x0 + 1, z0 + 1) * ux) * uz;
  }

  function sampleCurrentDensity(elecResult, xMm, zMm) {
    return sampleGridField(elecResult, elecResult && elecResult.jGrid, xMm, zMm);
  }

  function sampleIrDropMv(elecResult, xMm, zMm) {
    return sampleGridField(elecResult, elecResult && elecResult.dropGridMv, xMm, zMm);
  }

  return {
    VERSION: "3.0.0",
    GRID: GRID,
    RHO_CU_20C: RHO_CU_20C,
    TEMP_COEFF_PER_C: TEMP_COEFF_PER_C,
    COPPER_THICKNESS_UM: COPPER_THICKNESS_UM,
    COPPER_THICKNESS_MM: COPPER_THICKNESS_MM,
    COPPER_THICKNESS_M: COPPER_THICKNESS_M,
    IR_DROP_LIMIT_PCT: IR_DROP_LIMIT_PCT,
    CURRENT_DENSITY_LIMIT_AMM2: CURRENT_DENSITY_LIMIT_AMM2,
    J_MODEL_LIMIT_AMM2: J_MODEL_LIMIT_AMM2,
    RESIDUAL_LIMIT: RESIDUAL_LIMIT,
    DISCLAIMER: DISCLAIMER,
    NO_POWER_MESSAGE: NO_POWER_MESSAGE,
    ASSUMPTIONS: ELECTRICAL_ASSUMPTIONS,
    copperResistivity: copperResistivity,
    copperThicknessUm: copperThicknessUm,
    copperThicknessMm: copperThicknessMm,
    copperThicknessM: copperThicknessM,
    traceCrossSectionMm2: traceCrossSectionMm2,
    traceCrossSectionM2: traceCrossSectionM2,
    sheetResistance: sheetResistance,
    formatIrDrop: formatIrDrop,
    formatIrDropShort: formatIrDropShort,
    formatCurrentDensity: formatCurrentDensity,
    formatCurrentDensityShort: formatCurrentDensityShort,
    localKclResidual: localKclResidual,
    solveNodalGrid: solveNodalGrid,
    solveElectrical: solveElectrical,
    runElectroBench3: runElectroBench3,
    elecColor: elecColor,
    densityColor: elecColor,
    sampleCurrentDensity: sampleCurrentDensity,
    sampleIrDropMv: sampleIrDropMv
  };
});
