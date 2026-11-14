/* =====================================================================
   SolidSay v2 · presets.js
   Presets, datasheet component / TIM catalog and parametric geometry.

   - 100% client-side. No network access of any kind.
   - Loads as a classic <script> (exposes window.SolidSayPresets) or as a
     CommonJS module (module.exports) so the Node test-suite can run it.
   - Depends on nothing. thermal-solver.js and exporters.js depend on it;
     it never calls them (an evaluate() callback is injected instead), so
     there is no circular dependency.

   Coordinate convention for every builder: millimetres, origin at the
   plate centre, +y up, x spans the width W, z spans the depth D.
   ===================================================================== */
(function (root, factory) {
  "use strict";
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.SolidSayPresets = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  /* ------------------------------------------------------------------ */
  /* Materials                                                          */
  /* ------------------------------------------------------------------ */
  // k [W/m·K], density [kg/m³], cp [J/kg·K], usdPerKg = raw stock price
  // (representative, used only for relative BOM deltas).
  const MATERIALS = {
    fr4:      { id: "fr4",      label: "FR4",        k: 0.3, density: 1850, cp: 1100, usdPerKg: 0 },
    aluminum: { id: "aluminum", label: "Al 6061-T6", k: 167, density: 2700, cp: 896,  usdPerKg: 6.5 },
    copper:   { id: "copper",   label: "Cu C110",    k: 385, density: 8940, cp: 385,  usdPerKg: 14 }
  };
  const FDM_DENSITY_G_CM3 = 1.24;   // PLA
  const FDM_INFILL = 0.35;
  const K_COPPER_FOIL = 385;        // PCB copper planes
  const OZ_TO_MM = 0.035;           // 1 oz/ft² copper ≈ 35 µm
  // Exact copper thickness table (0.5 oz = 17.5 µm, 1 oz = 35 µm, 2 oz = 70 µm).
  const COPPER_OZ_TABLE = {
    0.5: { oz: 0.5, thicknessUm: 17.5, thicknessMm: 0.0175, label: "0.5 oz (17.5 µm)" },
    1:   { oz: 1.0, thicknessUm: 35.0, thicknessMm: 0.0350, label: "1 oz (35 µm)" },
    2:   { oz: 2.0, thicknessUm: 70.0, thicknessMm: 0.0700, label: "2 oz (70 µm)" }
  };
  function copperThicknessUm(oz) {
    if (COPPER_OZ_TABLE[oz]) return COPPER_OZ_TABLE[oz].thicknessUm;
    const w = (typeof oz === "number" && isFinite(oz) && oz > 0) ? oz : 1;
    return w * 35.0;
  }
  function copperThicknessMm(oz) {
    return copperThicknessUm(oz) / 1000;
  }

  /* ------------------------------------------------------------------ */
  /* Datasheet component & TIM catalog                                  */
  /* ------------------------------------------------------------------ */
  // Values are representative figures taken from the manufacturers'
  // public datasheets. Distributor part numbers are deliberately NOT
  // hard-coded (they change and must not be invented); `distributor`
  // carries the exact search string to use on LCSC / DigiKey instead.
  // Always confirm against the current datasheet before ordering.
  const PARTS_CATALOG = [
    /* ---- Thermal interface materials (k in W/m·K, t = bond line mm) ---- */
    { id: "tim_3m_8810", kind: "tim", mfr: "3M", mpn: "8810", desc: "Thermally conductive adhesive transfer tape",
      k: 0.6, tMm: 0.25, priceUSD: 0.45, distributor: { name: "DigiKey", query: "3M 8810 thermal tape" } },
    { id: "tim_bergquist_sp900s", kind: "tim", mfr: "Henkel Bergquist", mpn: "SIL-PAD 900S", desc: "Silicone insulator pad",
      k: 1.6, tMm: 0.23, priceUSD: 0.60, distributor: { name: "DigiKey", query: "Sil-Pad 900S" } },
    { id: "tim_bergquist_gp3000s30", kind: "tim", mfr: "Henkel Bergquist", mpn: "GAP PAD 3000S30", desc: "Gap filler pad",
      k: 3.0, tMm: 0.5, priceUSD: 2.10, distributor: { name: "DigiKey", query: "Gap Pad 3000S30" } },
    { id: "tim_laird_hd90000", kind: "tim", mfr: "Laird", mpn: "Tflex HD90000", desc: "High-performance gap filler",
      k: 7.5, tMm: 1.0, priceUSD: 4.80, distributor: { name: "DigiKey", query: "Tflex HD90000" } },
    { id: "tim_honeywell_ptm7950", kind: "tim", mfr: "Honeywell", mpn: "PTM7950", desc: "Phase-change pad (bond line after first heat cycle)",
      k: 8.5, tMm: 0.05, priceUSD: 3.50, distributor: { name: "LCSC", query: "PTM7950" } },
    { id: "tim_arctic_mx4", kind: "tim", mfr: "ARCTIC", mpn: "MX-4", desc: "Carbon-based thermal paste",
      k: 8.5, tMm: 0.05, priceUSD: 0.30, distributor: { name: "Retail", query: "Arctic MX-4" } },
    { id: "tim_tg_kryonaut", kind: "tim", mfr: "Thermal Grizzly", mpn: "Kryonaut", desc: "High-conductivity paste",
      k: 12.5, tMm: 0.05, priceUSD: 0.90, distributor: { name: "Retail", query: "Thermal Grizzly Kryonaut" } },
    { id: "tim_fujipoly_xrm", kind: "tim", mfr: "Fujipoly", mpn: "SARCON XR-m", desc: "Ultra-soft high-k gap filler",
      k: 17.0, tMm: 0.5, priceUSD: 9.00, distributor: { name: "DigiKey", query: "Sarcon XR-m" } },
    { id: "tim_dry_contact", kind: "tim", mfr: "—", mpn: "(none)", desc: "Dry metal-to-metal contact, no TIM (worst case)",
      k: 0.026, tMm: 0.02, priceUSD: 0, distributor: null },

    /* ---- Heatsinks / spreaders (geometry mapped onto the fin generator) ---- */
    { id: "hs_wakefield_637_20abpe", kind: "heatsink", mfr: "Wakefield-Vette", mpn: "637-20ABPE", desc: "Extruded aluminium TO-220 heatsink, 637 series",
      thetaSA: 7.8, priceUSD: 1.35, distributor: { name: "DigiKey", query: "Wakefield 637-20ABPE" }, geometryApprox: true,
      apply: { W: 35, D: 25, fins: 6, finH: 18, finT: 1.6, baseT: 2, mat: "aluminum" } },
    { id: "hs_boyd_577202b", kind: "heatsink", mfr: "Boyd (Aavid)", mpn: "577202B00000G", desc: "Clip-on TO-220 heatsink",
      thetaSA: 21.0, priceUSD: 0.55, distributor: { name: "DigiKey", query: "577202B00000G" }, geometryApprox: true,
      apply: { W: 20, D: 15, fins: 4, finH: 10, finT: 1.0, baseT: 1.2, mat: "aluminum" } },
    { id: "hs_boyd_531002b", kind: "heatsink", mfr: "Boyd (Aavid)", mpn: "531002B02500G", desc: "Extruded TO-220 heatsink, 25.4 mm",
      thetaSA: 9.0, priceUSD: 1.10, distributor: { name: "DigiKey", query: "531002B02500G" }, geometryApprox: true,
      apply: { W: 42, D: 25, fins: 8, finH: 12, finT: 1.5, baseT: 2.5, mat: "aluminum" } },
    { id: "hs_fischer_sk89", kind: "heatsink", mfr: "Fischer Elektronik", mpn: "SK 89 75 SA", desc: "Extruded profile, 75 mm cut length",
      thetaSA: 1.9, priceUSD: 11.80, distributor: { name: "DigiKey", query: "Fischer SK 89 75 SA" }, geometryApprox: true,
      apply: { W: 100, D: 75, fins: 14, finH: 30, finT: 2.0, baseT: 6, mat: "aluminum" } },
    { id: "hs_rpi_active_cooler", kind: "heatsink", mfr: "Raspberry Pi Ltd", mpn: "SC1148", desc: "Raspberry Pi 5 Active Cooler (fan included)",
      thetaSA: 3.5, priceUSD: 5.00, distributor: { name: "Retail", query: "Raspberry Pi Active Cooler SC1148" }, geometryApprox: true,
      apply: { W: 56, D: 40, fins: 14, finH: 8, finT: 0.8, baseT: 2, mat: "aluminum", air: "forced", hForced: 30 } },
    { id: "hs_al6061_machined", kind: "heatsink", mfr: "Generic CNC", mpn: "AL6061-CUSTOM", desc: "Custom machined Al 6061-T6 block, 18 fins",
      thetaSA: null, priceUSD: 18.00, distributor: null, geometryApprox: false,
      apply: { W: 100, D: 80, fins: 18, finH: 25, finT: 1.5, baseT: 5, mat: "aluminum" } },
    { id: "hs_c110_skived", kind: "heatsink", mfr: "Generic (skived)", mpn: "C110-SKIVED", desc: "C110 skived copper, 0.5 mm fins",
      thetaSA: null, priceUSD: 38.00, distributor: null, geometryApprox: false,
      apply: { W: 100, D: 80, fins: 40, finH: 25, finT: 0.5, baseT: 4, mat: "copper" } },

    /* ---- Fans (forced convection, h estimated from free-air flow) ---- */
    { id: "fan_noctua_nfa4x10_5v", kind: "fan", mfr: "Noctua", mpn: "NF-A4x10 5V", desc: "40 mm fan, 4.8 CFM",
      priceUSD: 14.95, distributor: { name: "Retail", query: "Noctua NF-A4x10 5V" }, apply: { air: "forced", hForced: 35 } },
    { id: "fan_noctua_nfa4x20_5v", kind: "fan", mfr: "Noctua", mpn: "NF-A4x20 5V", desc: "40 mm fan, 5.5 CFM, high static pressure",
      priceUSD: 15.95, distributor: { name: "Retail", query: "Noctua NF-A4x20 5V" }, apply: { air: "forced", hForced: 45 } },

    /* ---- Packages (junction-to-case resistance θJC, °C/W) ---- */
    { id: "pkg_lm2576hvsx", kind: "package", mfr: "Texas Instruments", mpn: "LM2576HVSX-5.0/NOPB", desc: "3 A buck regulator, TO-263-5",
      thetaJC: 2.0, priceUSD: 3.20, distributor: { name: "LCSC", query: "LM2576HVSX-5.0" }, apply: { rjc: 2.0 } },
    { id: "pkg_bsc010n04ls", kind: "package", mfr: "Infineon", mpn: "BSC010N04LS", desc: "OptiMOS 40 V 1.0 mΩ, SuperSO8",
      thetaJC: 1.0, priceUSD: 1.90, distributor: { name: "DigiKey", query: "BSC010N04LS" }, apply: { rjc: 1.0 } },
    { id: "pkg_stm32h743", kind: "package", mfr: "STMicroelectronics", mpn: "STM32H743VIT6", desc: "Cortex-M7 MCU, LQFP100",
      thetaJC: 7.0, priceUSD: 11.50, distributor: { name: "LCSC", query: "STM32H743VIT6" }, apply: { rjc: 7.0 } },

    /* ---- Copper weight swaps (0.5 oz = 17.5 µm, 1 oz = 35 µm, 2 oz = 70 µm) ---- */
    { id: "cu_weight_05oz", kind: "copper", mfr: "IPC-4562", mpn: "CU-FOIL-0.5OZ", desc: "0.5 oz/ft² electrodeposited copper foil (17.5 µm)",
      copperOz: 0.5, tUm: 17.5, tMm: 0.0175, priceUSD: 0.00, distributor: { name: "JLCPCB / PCBWay", query: "0.5 oz copper stackup" },
      apply: { copperOz: 0.5 } },
    { id: "cu_weight_1oz", kind: "copper", mfr: "IPC-4562", mpn: "CU-FOIL-1.0OZ", desc: "1.0 oz/ft² standard copper foil (35 µm)",
      copperOz: 1.0, tUm: 35.0, tMm: 0.0350, priceUSD: 1.50, distributor: { name: "JLCPCB / PCBWay", query: "1 oz copper stackup" },
      apply: { copperOz: 1.0 } },
    { id: "cu_weight_2oz", kind: "copper", mfr: "IPC-4562", mpn: "CU-FOIL-2.0OZ", desc: "2.0 oz/ft² heavy copper foil (70 µm)",
      copperOz: 2.0, tUm: 70.0, tMm: 0.0700, priceUSD: 6.00, distributor: { name: "JLCPCB / PCBWay", query: "2 oz heavy copper stackup" },
      apply: { copperOz: 2.0 } }
  ];
  const PARTS_BY_ID = {};
  PARTS_CATALOG.forEach(function (p) { PARTS_BY_ID[p.id] = p; });
  // TIMs ordered from worst to best interface resistance per unit area (t/k).
  const TIM_UPGRADE_ORDER = PARTS_CATALOG.filter(function (p) { return p.kind === "tim"; })
    .slice().sort(function (a, b) { return (b.tMm / b.k) - (a.tMm / a.k); })
    .map(function (p) { return p.id; });

  function getPart(id) { return PARTS_BY_ID[id] || null; }

  /* ------------------------------------------------------------------ */
  /* Design defaults + sanitising                                       */
  /* ------------------------------------------------------------------ */
  const GENERATORS = ["heatsink", "enclosure", "chiplet", "bracket", "pcb"];
  const DESIGN_DEFAULTS = {
    gen: "heatsink", W: 85, D: 56, fins: 9, finH: 12, finT: 1.5, baseT: 3, dies: 4,
    power: 12, powerPeak: 0, powerMode: "continuous", amb: 25, air: "natural", hNat: 9, hForced: 55,
    mat: "aluminum", mode: "heatsink", timId: "tim_3m_8810", rjc: 0.5,
    srcW: 0, srcD: 0,                // 0 = auto heat-source footprint
    encH: 0,                         // 0 = auto enclosure interior height
    ports: null,                     // enclosure port cut-outs (null = defaults)
    pcb: null,                       // PCB stack + components for gen "pcb"
    railV: 5.0,                      // Supply rail voltage (V), null when copper is null
    copper: { traceWidthMm: 5, copperOz: 1, layers: 6, vias: 120 },
    heatsinkPartId: null, fanPartId: null, copperPartId: null,
    board: "pi5", showcase: false, presetName: null
  };
  const LIMITS = {
    W: [10, 400], D: [10, 400], fins: [0, 100], finH: [0, 80], finT: [0.3, 6], baseT: [0.5, 20],
    dies: [1, 16], power: [0, 2000], powerPeak: [0, 5000], amb: [-40, 125], hNat: [2, 25], hForced: [10, 250],
    rjc: [0, 50], srcW: [0, 400], srcD: [0, 400], encH: [0, 200]
  };
  const MIN_FIN_GAP_MM = 0.3;  // manufacturable minimum (skived copper)

  function num(v, fallback) {
    const n = typeof v === "string" ? parseFloat(v) : v;
    return (typeof n === "number" && isFinite(n)) ? n : fallback;
  }
  function clamp(v, lo, hi) { return Math.min(hi, Math.max(lo, v)); }
  function clone(o) { return JSON.parse(JSON.stringify(o)); }

  // Maximum fin count that keeps at least MIN_FIN_GAP_MM between fins.
  function maxFinsFor(W, finT) {
    if (!(W > 0) || !(finT > 0)) return 0;
    return Math.max(0, Math.min(LIMITS.fins[1], Math.floor((W + MIN_FIN_GAP_MM) / (finT + MIN_FIN_GAP_MM))));
  }

  // Returns { design, warnings }. Never throws; every numeric field ends up
  // finite and inside LIMITS, so downstream code can't divide by zero.
  function sanitizeDesign(input) {
    const d = Object.assign(clone(DESIGN_DEFAULTS), input ? clone(input) : {});
    const warnings = [];
    Object.keys(LIMITS).forEach(function (k) {
      const raw = d[k];
      let v = num(raw, DESIGN_DEFAULTS[k]);
      const lim = LIMITS[k];
      if (v < lim[0] || v > lim[1]) {
        warnings.push(k + "=" + raw + " is outside " + lim[0] + "…" + lim[1] + "; clamped.");
        v = clamp(v, lim[0], lim[1]);
      } else if (raw !== undefined && raw !== null && num(raw, NaN) !== num(raw, NaN)) {
        warnings.push(k + " was not a number; reset to " + DESIGN_DEFAULTS[k] + ".");
      }
      d[k] = v;
    });
    d.fins = Math.round(d.fins);
    d.dies = Math.round(d.dies);
    if (GENERATORS.indexOf(d.gen) < 0) { warnings.push("Unknown generator '" + d.gen + "'; using heatsink."); d.gen = "heatsink"; }
    if (!MATERIALS[d.mat]) { warnings.push("Unknown material '" + d.mat + "'; using aluminum."); d.mat = "aluminum"; }
    if (d.air !== "natural" && d.air !== "forced") d.air = "natural";
    if (d.mode !== "heatsink" && d.mode !== "bare") d.mode = "heatsink";
    if (d.powerMode !== "continuous" && d.powerMode !== "peak") d.powerMode = "continuous";
    if (!PARTS_BY_ID[d.timId] || PARTS_BY_ID[d.timId].kind !== "tim") d.timId = DESIGN_DEFAULTS.timId;
    const maxF = maxFinsFor(d.W, d.finT);
    if (d.fins > maxF) {
      warnings.push(d.fins + " fins of " + d.finT + " mm cannot fit in " + d.W + " mm (min gap " + MIN_FIN_GAP_MM + " mm); reduced to " + maxF + ".");
      d.fins = maxF;
    }
    if (d.gen === "pcb" && !d.pcb) d.pcb = clone(DEFAULT_PCB);
    if (input && Object.prototype.hasOwnProperty.call(input, "copper") && input.copper === null) {
      d.copper = null;
      d.railV = null;
    } else if (d.copper && typeof d.copper === "object") {
      const ozRaw = num(d.copper.copperOz, (d.pcb && d.pcb.copperOz) || 1);
      const oz = (ozRaw <= 0.75) ? 0.5 : (ozRaw >= 1.5 ? 2 : 1);
      d.copper = {
        traceWidthMm: clamp(num(d.copper.traceWidthMm, 5), 0.1, 200),
        copperOz: oz,
        layers: Math.max(1, Math.round(clamp(num(d.copper.layers, (d.pcb && d.pcb.layers) || 4), 1, 64))),
        vias: Math.max(1, Math.round(clamp(num(d.copper.vias, 64), 1, 10000)))
      };
      d.railV = clamp(num(d.railV, 5.0), 0.3, 1000);
    } else {
      d.copper = null;
      d.railV = null;
    }
    return { design: d, warnings: warnings };
  }

  /* ------------------------------------------------------------------ */
  /* PCB helpers                                                        */
  /* ------------------------------------------------------------------ */
  const DEFAULT_PCB = {
    outline: "rect", boardT: 1.6, layers: 4, copperOz: 1, planeCount: 2, coverage: 0.5,
    holes: [], standoffH: 6, components: []
  };
  // Effective in-plane conductivity of a laminated board: parallel
  // conduction through copper planes (weighted by fill coverage) and FR4.
  function pcbInPlaneK(pcb) {
    const p = Object.assign({}, DEFAULT_PCB, pcb || {});
    const tTot = Math.max(0.2, num(p.boardT, 1.6));
    const tCu = clamp(num(p.planeCount, 2), 0, 40) * clamp(num(p.copperOz, 1), 0.25, 6) * OZ_TO_MM;
    const cov = clamp(num(p.coverage, 0.5), 0, 1);
    const tCuEff = Math.min(tCu, tTot * 0.9);
    return (K_COPPER_FOIL * tCuEff * cov + MATERIALS.fr4.k * (tTot - tCuEff)) / tTot;
  }
  function mountHoles(W, D, inset, dia) {
    const x = W / 2 - inset, z = D / 2 - inset;
    return [[-x, -z], [x, -z], [-x, z], [x, z]].map(function (p) { return { x: p[0], z: p[1], d: dia }; });
  }

  /* ------------------------------------------------------------------ */
  /* Famous boards (1-tap pills) incl. the 4 ProtoFlow high-heat boards  */
  /* ------------------------------------------------------------------ */
  const PROTOFLOW_BOARDS = [
    {
      id: "preset_eth_gateway", name: "Industrial Ethernet + CAN-FD Gateway", short: "ETH/CAN-FD Gateway", gen: "pcb",
      W: 100, D: 80, fins: 0, finH: 0, dies: 1, power: 8.5, powerPeak: 8.5, mat: "fr4", air: "natural", note: "6-layer FR4, 2 oz planes",
      railV: 24.0, copper: { traceWidthMm: 4, copperOz: 2, layers: 6, vias: 140 },
      pcb: {
        outline: "rect", boardT: 1.6, layers: 6, copperOz: 2, planeCount: 4, coverage: 0.55, standoffH: 6,
        holes: mountHoles(100, 80, 4, 3.2),
        components: [
          { ref: "U1", name: "STM32H743VIT6 MCU (LQFP100)", x: -12, z: 4, w: 14, d: 14, h: 1.6, power: 1.2, rjc: 7.0 },
          { ref: "U2", name: "KSZ9031RNX GbE PHY (QFN48)", x: 24, z: 20, w: 7, d: 7, h: 0.9, power: 0.8, rjc: 6.0 },
          { ref: "U3", name: "KSZ9031RNX GbE PHY (QFN48)", x: 24, z: -12, w: 7, d: 7, h: 0.9, power: 0.8, rjc: 6.0 },
          { ref: "T1", name: "RJ45 magnetics, port A", x: 40, z: 20, w: 16, d: 14, h: 6, power: 0.6, rjc: 15 },
          { ref: "T2", name: "RJ45 magnetics, port B", x: 40, z: -12, w: 16, d: 14, h: 6, power: 0.6, rjc: 15 },
          { ref: "U4", name: "TCAN1042HGV CAN-FD transceiver", x: -38, z: 22, w: 5, d: 4, h: 1.5, power: 0.15, rjc: 40 },
          { ref: "U5", name: "TCAN1042HGV CAN-FD transceiver", x: -38, z: 10, w: 5, d: 4, h: 1.5, power: 0.15, rjc: 40 },
          { ref: "U6", name: "TPS54360B 24 V→5 V buck", x: -30, z: -24, w: 5, d: 6, h: 1.5, power: 1.6, rjc: 3.0 },
          { ref: "U7", name: "TLV62130 5 V→3.3 V buck (QFN16)", x: -12, z: -24, w: 3, d: 3, h: 1.0, power: 0.5, rjc: 8.0 },
          { ref: "MISC", name: "LDOs, passives, LEDs (lumped)", x: 6, z: -26, w: 20, d: 10, h: 1.0, power: 2.1, rjc: 20 }
        ]
      }
    },
    {
      id: "preset_robot_io_24v", name: "Industrial 24 V Robot Peripheral I/O Controller", short: "24 V Robot I/O", gen: "pcb",
      W: 100, D: 80, fins: 0, finH: 0, dies: 1, power: 14.0, powerPeak: 14.0, mat: "fr4", air: "natural", note: "4-layer, worst-case load",
      railV: 24.0, copper: { traceWidthMm: 5, copperOz: 1, layers: 4, vias: 110 },
      pcb: {
        outline: "rect", boardT: 1.6, layers: 4, copperOz: 1, planeCount: 2, coverage: 0.5, standoffH: 6,
        holes: mountHoles(100, 80, 4, 3.2),
        components: [
          { ref: "U1", name: "LM2576HVSX-5.0 buck (TO-263-5)", x: -30, z: -20, w: 10, d: 15, h: 4.5, power: 4.2, rjc: 2.0 },
          { ref: "L1", name: "100 µH buck inductor", x: -14, z: -20, w: 12, d: 12, h: 6, power: 1.2, rjc: 10 },
          { ref: "D1", name: "5 A Schottky catch diode (SMC)", x: -30, z: -2, w: 7, d: 6, h: 2.3, power: 1.8, rjc: 5 },
          { ref: "U2", name: "STM32F103C8T6 MCU (LQFP48)", x: 4, z: 6, w: 9, d: 9, h: 1.4, power: 0.25, rjc: 12 },
          { ref: "Q1-4", name: "VN7140AS high-side switches ×4", x: 32, z: 0, w: 14, d: 40, h: 1.7, power: 4.0, rjc: 4.0 },
          { ref: "F1", name: "Reverse-polarity FET + TVS", x: -42, z: -30, w: 8, d: 6, h: 2, power: 0.8, rjc: 6 },
          { ref: "U3-4", name: "ISO1212 isolated 24 V inputs ×2", x: 4, z: 28, w: 24, d: 6, h: 1.5, power: 1.75, rjc: 30 }
        ]
      }
    },
    {
      id: "preset_robot_joint_foc", name: "Hollow-Shaft Robot Joint FOC Controller", short: "Robot Joint FOC", gen: "pcb",
      W: 55, D: 55, fins: 0, finH: 0, dies: 1, power: 28.0, powerPeak: 65.0, mat: "fr4", air: "natural", note: "Ø55 annular, 28 W / 65 W stall",
      railV: 24.0, copper: { traceWidthMm: 8, copperOz: 2, layers: 6, vias: 180 },
      pcb: {
        outline: "annulus", innerD: 20, boardT: 1.6, layers: 6, copperOz: 2, planeCount: 4, coverage: 0.6, standoffH: 5,
        holes: [],
        components: (function () {
          const c = [];
          for (let i = 0; i < 6; i++) {
            const a = (i / 6) * Math.PI * 2;
            c.push({ ref: "Q" + (i + 1), name: "BSC010N04LS MOSFET (phase " + "UVW"[i >> 1] + ")", x: +(Math.cos(a) * 19).toFixed(2), z: +(Math.sin(a) * 19).toFixed(2), w: 5, d: 6, h: 1.0, power: 4.0, rjc: 1.0 });
          }
          c.push({ ref: "U1", name: "DRV8353RS gate driver", x: 0, z: -14.5, w: 7, d: 7, h: 0.9, power: 0.8, rjc: 6 });
          c.push({ ref: "U2", name: "STM32G431 MCU", x: 14, z: 0, w: 5, d: 5, h: 0.9, power: 0.3, rjc: 15 });
          c.push({ ref: "U3", name: "AS5047P magnetic encoder", x: 0, z: 14.5, w: 5, d: 4, h: 1.0, power: 0.05, rjc: 30 });
          c.push({ ref: "R1-3", name: "Phase current shunts ×3", x: -14, z: 0, w: 4, d: 10, h: 0.6, power: 2.4, rjc: 10 });
          c.push({ ref: "MISC", name: "Bulk caps, LDO (lumped)", x: -9, z: -10.5, w: 5, d: 5, h: 2, power: 0.45, rjc: 20 });
          return c;
        })()
      }
    },
    {
      id: "preset_drone_fc_305", name: "30.5 mm Drone Flight Controller + 4-in-1 ESC", short: "Drone FC+ESC 30.5", gen: "pcb",
      W: 36, D: 36, fins: 0, finH: 0, dies: 1, power: 35.0, powerPeak: 110.0, mat: "fr4", air: "forced", hForced: 45, note: "30.5×30.5 M3 stack, prop-wash cooled",
      railV: 24.0, copper: { traceWidthMm: 10, copperOz: 2, layers: 6, vias: 200 },
      pcb: {
        outline: "rect", boardT: 1.6, layers: 6, copperOz: 2, planeCount: 4, coverage: 0.6, standoffH: 5,
        holes: mountHoles(36, 36, 2.75, 3.2),     // 30.5 mm M3 pattern
        components: (function () {
          const c = [];
          // 12 MOSFETs: 3 per ESC channel, one channel per board edge
          const edge = [[0, -12.5, 1, 0], [12.5, 0, 0, 1], [0, 12.5, 1, 0], [-12.5, 0, 0, 1]];
          edge.forEach(function (e, ch) {
            for (let k = -1; k <= 1; k++) {
              c.push({ ref: "Q" + (ch * 3 + k + 2), name: "30 V N-MOSFET, DFN3.3×3.3 (ESC ch " + (ch + 1) + ")",
                x: +(e[0] + e[2] * k * 6.2).toFixed(2), z: +(e[1] + e[3] * k * 6.2).toFixed(2), w: 3.3, d: 3.3, h: 0.8, power: 2.6, rjc: 1.8 });
            }
          });
          c.push({ ref: "U1", name: "STM32F722RET6 flight MCU", x: 0, z: 0, w: 7, d: 7, h: 1.4, power: 0.4, rjc: 10 });
          c.push({ ref: "U2", name: "ICM-42688-P IMU", x: 5.5, z: 5.5, w: 2.5, d: 3, h: 0.9, power: 0.01, rjc: 40 });
          c.push({ ref: "U3-6", name: "AT32F421 ESC MCUs ×4 (lumped)", x: -5.5, z: 5.5, w: 4, d: 4, h: 0.9, power: 0.6, rjc: 15 });
          c.push({ ref: "U7", name: "5 V / 10 V BEC regulators", x: -5.5, z: -5.5, w: 4, d: 4, h: 1.0, power: 2.0, rjc: 8 });
          c.push({ ref: "MISC", name: "Passives, OSD, LEDs (lumped)", x: 5.5, z: -5.5, w: 4, d: 3, h: 1.0, power: 0.79, rjc: 20 });
          return c;
        })()
      }
    }
  ];

  const FAMOUS_BOARDS = [
    { id: "pi5",    name: "Raspberry Pi 5",   short: "Raspberry Pi 5", gen: "heatsink",  W: 85,  D: 56,  fins: 9,  finH: 12, dies: 1, power: 12,  mat: "aluminum", note: "SBC", rjc: 0.6, srcW: 17, srcD: 17, railV: 5.0,  copper: { traceWidthMm: 5,  copperOz: 1, layers: 6,  vias: 120 } },
    { id: "esp32",  name: "ESP32-S3 DevKit",  short: "ESP32-S3",       gen: "enclosure", W: 62,  D: 28,  fins: 0,  finH: 8,  dies: 1, power: 5,   mat: "fr4",      note: "IoT module",                           railV: 3.3,  copper: { traceWidthMm: 3,  copperOz: 1, layers: 4,  vias: 64 } },
    { id: "orin",   name: "NVIDIA Orin Nano", short: "Orin Nano",      gen: "heatsink",  W: 100, D: 79,  fins: 14, finH: 16, dies: 1, power: 25,  mat: "aluminum", note: "Edge AI", rjc: 0.3, srcW: 28, srcD: 28, railV: 12.0, copper: { traceWidthMm: 8,  copperOz: 1, layers: 8,  vias: 180 } },
    // AMD Instinct MI300X: 750 W OAM module power (locked at 750 W).
    { id: "mi300x", name: "AMD MI300X",       short: "AMD MI300X",     gen: "chiplet",   W: 110, D: 110, fins: 20, finH: 22, dies: 8, power: 750, mat: "copper",   note: "OAM module, 750 W", air: "forced", hForced: 120, rjc: 0.02, railV: 12.0, copper: { traceWidthMm: 36, copperOz: 2, layers: 12, vias: 1200 } },
    { id: "nema17", name: "NEMA-17 Bracket",  short: "NEMA-17",        gen: "bracket",   W: 56,  D: 56,  fins: 0,  finH: 10, dies: 1, power: 8,   mat: "aluminum", note: "Stepper mount",                        railV: null, copper: null }
  ].concat(PROTOFLOW_BOARDS);
  const MI300X_OAM_POWER_W = 750;

  /* ------------------------------------------------------------------ */
  /* Preset library (46 legacy hardware presets + 4 ProtoFlow boards)    */
  /* ------------------------------------------------------------------ */
  const PRESET_CATS = [
    "Microchip & packaging",
    "Circuit boards & power",
    "Cooling",
    "Enclosures & 3D-print parts",
    "Robotics parts — static, printable",
    "Quantum showcase — visual only",
    "ProtoFlow high-heat boards"
  ];
  const PRESETS = [
    /* ---- Microchip & packaging — 12 ---- */
    { name: "CPU Die", cat: 0, gen: "chiplet", W: 54, D: 54, fins: 0, finH: 6, dies: 1, power: 125, mat: "copper", railV: 1.8, copper: { traceWidthMm: 18, copperOz: 2, layers: 8, vias: 400 } },
    { name: "GPU Die", cat: 0, gen: "chiplet", W: 70, D: 60, fins: 0, finH: 6, dies: 1, power: 250, mat: "copper", railV: 12.0, copper: { traceWidthMm: 22, copperOz: 2, layers: 10, vias: 600 } },
    { name: "Neural Engine / NPU Die", cat: 0, gen: "chiplet", W: 45, D: 45, fins: 0, finH: 6, dies: 1, power: 35, mat: "copper", railV: 1.8, copper: { traceWidthMm: 12, copperOz: 1, layers: 6, vias: 240 } },
    { name: "Chiplet Package (multi-die)", cat: 0, gen: "chiplet", W: 80, D: 80, fins: 0, finH: 10, dies: 4, power: 180, mat: "copper", railV: 12.0, copper: { traceWidthMm: 20, copperOz: 2, layers: 8, vias: 480 } },
    { name: "HBM Memory Stack", cat: 0, gen: "chiplet", W: 70, D: 55, fins: 0, finH: 8, dies: 3, power: 140, mat: "copper", railV: 5.0, copper: { traceWidthMm: 18, copperOz: 2, layers: 8, vias: 500 } },
    { name: "Interposer", cat: 0, gen: "chiplet", W: 65, D: 50, fins: 0, finH: 8, dies: 4, power: 60, mat: "copper", railV: 3.3, copper: { traceWidthMm: 14, copperOz: 1, layers: 6, vias: 360 } },
    { name: "Heat Spreader Lid", cat: 0, gen: "chiplet", W: 60, D: 60, fins: 0, finH: 8, dies: 2, power: 90, mat: "copper", railV: null, copper: null },
    { name: "Substrate / BGA Package", cat: 0, gen: "chiplet", W: 55, D: 55, fins: 0, finH: 8, dies: 1, power: 45, mat: "aluminum", railV: 3.3, copper: { traceWidthMm: 12, copperOz: 1, layers: 6, vias: 300 } },
    { name: "DRAM Memory Chip", cat: 0, gen: "chiplet", W: 40, D: 30, fins: 0, finH: 6, dies: 1, power: 8, mat: "aluminum", railV: 1.8, copper: { traceWidthMm: 6, copperOz: 1, layers: 4, vias: 120 } },
    { name: "Power Management IC", cat: 0, gen: "chiplet", W: 38, D: 38, fins: 0, finH: 6, dies: 1, power: 15, mat: "aluminum", railV: 5.0, copper: { traceWidthMm: 8, copperOz: 2, layers: 4, vias: 96 } },
    { name: "Capacitor Array / Passives", cat: 0, gen: "chiplet", W: 50, D: 40, fins: 0, finH: 6, dies: 6, power: 5, mat: "aluminum", railV: 5.0, copper: { traceWidthMm: 6, copperOz: 1, layers: 4, vias: 80 } },
    { name: "Pin / BGA Ball Grid", cat: 0, gen: "chiplet", W: 60, D: 60, fins: 0, finH: 6, dies: 1, power: 20, mat: "aluminum", railV: 3.3, copper: { traceWidthMm: 10, copperOz: 1, layers: 4, vias: 256 } },
    /* ---- Circuit boards & power — 10 ---- */
    { name: "Raspberry Pi 5 Board", cat: 1, gen: "heatsink", W: 85, D: 56, fins: 9, finH: 12, dies: 1, power: 12, mat: "aluminum", srcW: 17, srcD: 17, rjc: 0.6, railV: 5.0, copper: { traceWidthMm: 5, copperOz: 1, layers: 6, vias: 120 } },
    { name: "ESP32-S3 Board", cat: 1, gen: "enclosure", W: 62, D: 28, fins: 0, finH: 8, dies: 1, power: 5, mat: "fr4", railV: 3.3, copper: { traceWidthMm: 3, copperOz: 1, layers: 4, vias: 64 } },
    { name: "FPGA Board", cat: 1, gen: "chiplet", W: 90, D: 70, fins: 0, finH: 10, dies: 5, power: 160, mat: "copper", railV: 12.0, copper: { traceWidthMm: 18, copperOz: 2, layers: 8, vias: 320 } },
    { name: "Power Stage / Buck Converter Board", cat: 1, gen: "heatsink", W: 85, D: 60, fins: 8, finH: 12, dies: 1, power: 20, mat: "aluminum", railV: 12.0, copper: { traceWidthMm: 6, copperOz: 2, layers: 4, vias: 96 } },
    { name: "EV Charger Power Board", cat: 1, gen: "heatsink", W: 120, D: 90, fins: 12, finH: 16, dies: 1, power: 180, mat: "copper", railV: 48.0, copper: { traceWidthMm: 16, copperOz: 2, layers: 6, vias: 240 } },
    { name: "Motor Driver Board", cat: 1, gen: "heatsink", W: 85, D: 60, fins: 8, finH: 12, dies: 1, power: 30, mat: "aluminum", railV: 24.0, copper: { traceWidthMm: 8, copperOz: 2, layers: 4, vias: 110 } },
    { name: "Sensor Board", cat: 1, gen: "enclosure", W: 70, D: 50, fins: 0, finH: 8, dies: 1, power: 4, mat: "fr4", railV: 3.3, copper: { traceWidthMm: 2.5, copperOz: 1, layers: 4, vias: 48 } },
    { name: "NVIDIA Orin Nano Module", cat: 1, gen: "heatsink", W: 100, D: 79, fins: 14, finH: 16, dies: 1, power: 25, mat: "aluminum", srcW: 28, srcD: 28, rjc: 0.3, railV: 12.0, copper: { traceWidthMm: 8, copperOz: 1, layers: 8, vias: 180 } },
    // 750 W OAM module power.
    { name: "AMD MI300X Chiplet Mockup", cat: 1, gen: "chiplet", W: 110, D: 110, fins: 0, finH: 10, dies: 8, power: 750, mat: "copper", air: "forced", hForced: 120, rjc: 0.02, railV: 12.0, copper: { traceWidthMm: 36, copperOz: 2, layers: 12, vias: 1200 } },
    { name: "Microcontroller Dev Board", cat: 1, gen: "enclosure", W: 90, D: 60, fins: 0, finH: 10, dies: 1, power: 6, mat: "fr4", railV: 5.0, copper: { traceWidthMm: 3, copperOz: 1, layers: 4, vias: 60 } },
    /* ---- Cooling — 8 (passive cooling hardware: copper: null) ---- */
    { name: "Extruded Fin Heatsink", cat: 2, gen: "heatsink", W: 100, D: 80, fins: 14, finH: 20, dies: 1, power: 60, mat: "aluminum", railV: null, copper: null },
    { name: "Cold Plate", cat: 2, gen: "heatsink", W: 70, D: 70, fins: 0, finH: 6, dies: 1, power: 80, mat: "copper", railV: null, copper: null },
    { name: "Fan Shroud (40mm)", cat: 2, gen: "enclosure", W: 62, D: 62, fins: 0, finH: 10, dies: 1, power: 10, mat: "fr4", railV: null, copper: null },
    { name: "Vapor Chamber", cat: 2, gen: "heatsink", W: 90, D: 90, fins: 0, finH: 5, dies: 1, power: 120, mat: "copper", railV: null, copper: null },
    { name: "Heat Pipe Assembly", cat: 2, gen: "heatsink", W: 110, D: 60, fins: 6, finH: 12, dies: 1, power: 75, mat: "copper", railV: null, copper: null },
    { name: "Pin-Fin Heatsink", cat: 2, gen: "heatsink", W: 65, D: 65, fins: 11, finH: 18, dies: 1, power: 22, mat: "aluminum", railV: null, copper: null },
    { name: "Liquid Cooling Block", cat: 2, gen: "heatsink", W: 80, D: 80, fins: 0, finH: 8, dies: 1, power: 150, mat: "copper", railV: null, copper: null },
    { name: "Thermal Interface Pad / TIM Layer", cat: 2, gen: "heatsink", W: 50, D: 50, fins: 0, finH: 4, dies: 1, power: 20, mat: "aluminum", railV: null, copper: null },
    /* ---- Enclosures & 3D-print parts — 10 (passive mechanical parts: copper: null) ---- */
    { name: "Snap-Fit PCB Enclosure", cat: 3, gen: "enclosure", W: 95, D: 65, fins: 0, finH: 10, dies: 1, power: 8, mat: "fr4", railV: null, copper: null },
    { name: "Vented Enclosure Lid", cat: 3, gen: "enclosure", W: 120, D: 80, fins: 0, finH: 12, dies: 1, power: 18, mat: "aluminum", railV: null, copper: null },
    { name: "Wall Mount Bracket", cat: 3, gen: "bracket", W: 110, D: 50, fins: 0, finH: 12, dies: 1, power: 1, mat: "aluminum", railV: null, copper: null },
    { name: "DIN Rail Mount", cat: 3, gen: "enclosure", W: 105, D: 45, fins: 0, finH: 10, dies: 1, power: 12, mat: "fr4", railV: null, copper: null },
    { name: "L-Bracket / NEMA-17 Stepper Mount", cat: 3, gen: "bracket", W: 56, D: 56, fins: 0, finH: 10, dies: 1, power: 8, mat: "aluminum", railV: null, copper: null },
    { name: "Cable Management Clip", cat: 3, gen: "bracket", W: 55, D: 45, fins: 0, finH: 8, dies: 1, power: 1, mat: "aluminum", railV: null, copper: null },
    { name: "Standoff / Boss Mount", cat: 3, gen: "bracket", W: 60, D: 60, fins: 0, finH: 10, dies: 1, power: 1, mat: "aluminum", railV: null, copper: null },
    { name: "Raspberry Pi Case", cat: 3, gen: "enclosure", W: 92, D: 62, fins: 0, finH: 10, dies: 1, power: 12, mat: "fr4", railV: null, copper: null },
    { name: "Control Box / Junction Box", cat: 3, gen: "enclosure", W: 180, D: 120, fins: 0, finH: 14, dies: 1, power: 15, mat: "fr4", railV: null, copper: null },
    { name: "Ventilation Grille Panel", cat: 3, gen: "enclosure", W: 150, D: 100, fins: 0, finH: 8, dies: 1, power: 5, mat: "aluminum", railV: null, copper: null },
    /* ---- Robotics parts — 4 (static 3D-printable parts only: copper: null) ---- */
    { name: "Servo Bracket", cat: 4, gen: "bracket", W: 70, D: 50, fins: 0, finH: 10, dies: 1, power: 1, mat: "aluminum", railV: null, copper: null },
    { name: "Robot Joint / Hinge", cat: 4, gen: "bracket", W: 90, D: 40, fins: 0, finH: 8, dies: 1, power: 1, mat: "aluminum", railV: null, copper: null },
    { name: "Gripper Finger", cat: 4, gen: "bracket", W: 80, D: 30, fins: 0, finH: 8, dies: 1, power: 1, mat: "aluminum", railV: null, copper: null },
    { name: "Limb Segment / Arm Link", cat: 4, gen: "bracket", W: 140, D: 45, fins: 0, finH: 10, dies: 1, power: 1, mat: "aluminum", railV: null, copper: null },
    /* ---- Quantum showcase — 2 (visual showcase only: copper: null) ---- */
    { name: "Qubit Chip Array (superconducting)", cat: 5, gen: "chiplet", W: 60, D: 60, fins: 0, finH: 8, dies: 6, power: 5, mat: "copper", showcase: true, railV: null, copper: null },
    { name: "Cryostat Cold Plate Stage", cat: 5, gen: "heatsink", W: 100, D: 100, fins: 0, finH: 10, dies: 1, power: 10, mat: "copper", showcase: true, railV: null, copper: null }
  ].concat(PROTOFLOW_BOARDS.map(function (b) { return Object.assign({ cat: 6, boardId: b.id }, clone(b)); }));
  PRESETS.forEach(function (p, i) { p.n = i + 1; });

  // Convert a board/preset record into a full sanitized design.
  function designFromPreset(p, base) {
    const keep = base ? clone(base) : {};
    const d = Object.assign({}, DESIGN_DEFAULTS, {
      amb: keep.amb !== undefined ? keep.amb : DESIGN_DEFAULTS.amb,
      timId: keep.timId || DESIGN_DEFAULTS.timId,
      mode: keep.mode || "heatsink"
    });
    ["gen", "W", "D", "fins", "finH", "finT", "baseT", "dies", "power", "powerPeak", "mat", "air", "hForced", "rjc", "srcW", "srcD", "encH", "showcase", "railV", "copperPartId"].forEach(function (k) {
      if (p[k] !== undefined) d[k] = clone(p[k]);
    });
    if (Object.prototype.hasOwnProperty.call(p, "copper")) {
      d.copper = p.copper ? clone(p.copper) : null;
      if (p.copper === null) d.railV = null;
    }
    d.pcb = p.pcb ? clone(p.pcb) : null;
    d.presetName = p.name || null;
    d.board = p.boardId || p.id || null;
    d.powerMode = "continuous";
    return sanitizeDesign(d).design;
  }

  /* ------------------------------------------------------------------ */
  /* Heat sources (shared by solver, probe and exporters)               */
  /* ------------------------------------------------------------------ */
  function autoSourceSide(d) { return clamp(0.35 * Math.sqrt(d.W * d.D), 8, 45); }
  function chipletDieBoxes(d) {
    const n = Math.max(1, d.dies), cols = Math.ceil(Math.sqrt(n)), rows = Math.ceil(n / cols);
    const cw = d.W * 0.62 / cols, cd = d.D * 0.62 / rows;
    const out = [];
    let idx = 0;
    for (let r = 0; r < rows; r++) for (let c = 0; c < cols && idx < n; c++, idx++) {
      out.push({ x: (c - (cols - 1) / 2) * (cw + 2), z: (r - (rows - 1) / 2) * (cd + 2), w: Math.max(1, cw - 3), d: Math.max(1, cd - 3) });
    }
    return out;
  }
  function powerScale(d) {
    if (d.powerMode === "peak" && d.powerPeak > 0 && d.power > 0) return d.powerPeak / d.power;
    return 1;
  }
  // -> [{ref, name, x, z, w, d, power, rjc}] in mm / W / °C·W⁻¹
  function heatSources(design) {
    const d = design;
    const scale = powerScale(d);
    const P = d.power * scale;
    if (d.gen === "pcb" && d.pcb && d.pcb.components && d.pcb.components.length) {
      const comps = d.pcb.components;
      const listed = comps.reduce(function (s, c) { return s + Math.max(0, num(c.power, 0)); }, 0);
      // Components carry the authoritative split; the design power slider
      // rescales them proportionally so the two can never disagree.
      const k = listed > 0 ? P / listed : 0;
      return comps.map(function (c) {
        return { ref: c.ref, name: c.name || c.ref, x: num(c.x, 0), z: num(c.z, 0), w: Math.max(0.5, num(c.w, 2)), d: Math.max(0.5, num(c.d, 2)),
          power: Math.max(0, num(c.power, 0)) * k, rjc: Math.max(0, num(c.rjc, d.rjc)) };
      });
    }
    if (d.gen === "chiplet") {
      const boxes = chipletDieBoxes(d);
      return boxes.map(function (b, i) { return { ref: "DIE" + (i + 1), name: "Die " + (i + 1), x: b.x, z: b.z, w: b.w, d: b.d, power: P / boxes.length, rjc: d.rjc }; });
    }
    if (d.gen === "bracket") {
      const s = Math.min(42, 0.75 * Math.min(d.W, d.D));   // NEMA-17 face is 42 mm
      return [{ ref: "M1", name: "Motor face", x: 0, z: 0, w: s, d: s, power: P, rjc: d.rjc }];
    }
    if (d.gen === "enclosure") {
      return [{ ref: "PCB", name: "Enclosed PCB", x: 0, z: 0, w: d.W * 0.55, d: d.D * 0.55, power: P, rjc: d.rjc }];
    }
    const sw = d.srcW > 0 ? Math.min(d.srcW, d.W) : Math.min(autoSourceSide(d), d.W);
    const sd = d.srcD > 0 ? Math.min(d.srcD, d.D) : Math.min(autoSourceSide(d), d.D);
    return [{ ref: "U1", name: "Die / package", x: 0, z: 0, w: sw, d: sd, power: P, rjc: d.rjc }];
  }

  /* ------------------------------------------------------------------ */
  /* Mesh building — every shell is a closed, consistently oriented      */
  /* 2-manifold. Shells never share vertices with each other.            */
  /* ------------------------------------------------------------------ */
  function MeshBuilder(role) {
    this.role = role; this.pos = []; this.idx = []; this.vmap = new Map();
  }
  MeshBuilder.prototype.v = function (x, y, z) {
    const k = Math.round(x * 1e5) + "," + Math.round(y * 1e5) + "," + Math.round(z * 1e5);
    let i = this.vmap.get(k);
    if (i === undefined) { i = this.pos.length / 3; this.pos.push(x, y, z); this.vmap.set(k, i); }
    return i;
  };
  MeshBuilder.prototype.tri = function (a, b, c) {
    if (a === b || b === c || a === c) return;
    this.idx.push(a, b, c);
  };
  MeshBuilder.prototype.finish = function () {
    const shell = { role: this.role, positions: new Float32Array(this.pos), indices: new Uint32Array(this.idx) };
    if (signedVolume(shell) < 0) flipShell(shell);
    return shell;
  };
  function signedVolume(shell) {
    const p = shell.positions, ix = shell.indices;
    let v = 0;
    for (let t = 0; t < ix.length; t += 3) {
      const a = ix[t] * 3, b = ix[t + 1] * 3, c = ix[t + 2] * 3;
      v += p[a] * (p[b + 1] * p[c + 2] - p[b + 2] * p[c + 1])
         - p[a + 1] * (p[b] * p[c + 2] - p[b + 2] * p[c])
         + p[a + 2] * (p[b] * p[c + 1] - p[b + 1] * p[c]);
    }
    return v / 6;
  }
  function flipShell(shell) {
    const ix = shell.indices;
    for (let t = 0; t < ix.length; t += 3) { const tmp = ix[t + 1]; ix[t + 1] = ix[t + 2]; ix[t + 2] = tmp; }
  }

  function boxShell(role, cx, cy, cz, w, h, d) {
    const mb = new MeshBuilder(role);
    const x0 = cx - w / 2, x1 = cx + w / 2, y0 = cy - h / 2, y1 = cy + h / 2, z0 = cz - d / 2, z1 = cz + d / 2;
    const v = [
      mb.v(x0, y0, z0), mb.v(x1, y0, z0), mb.v(x1, y1, z0), mb.v(x0, y1, z0),
      mb.v(x0, y0, z1), mb.v(x1, y0, z1), mb.v(x1, y1, z1), mb.v(x0, y1, z1)
    ];
    const q = function (a, b, c, e) { mb.tri(v[a], v[b], v[c]); mb.tri(v[a], v[c], v[e]); };
    q(0, 3, 2, 1); q(4, 5, 6, 7); q(0, 1, 5, 4); q(3, 7, 6, 2); q(0, 4, 7, 3); q(1, 2, 6, 5);
    return mb.finish();
  }

  // Revolve a closed (r, y) profile (all r > 0) about a vertical axis.
  function latheShell(role, profile, cx, cz, y0, segs) {
    const mb = new MeshBuilder(role);
    const n = profile.length, S = Math.max(8, segs | 0);
    const ring = [];
    for (let s = 0; s < S; s++) {
      const a = (s / S) * Math.PI * 2, ca = Math.cos(a), sa = Math.sin(a);
      ring.push(profile.map(function (p) { return mb.v(cx + p[0] * ca, y0 + p[1], cz + p[0] * sa); }));
    }
    for (let s = 0; s < S; s++) {
      const A = ring[s], B = ring[(s + 1) % S];
      for (let i = 0; i < n; i++) {
        const j = (i + 1) % n;
        mb.tri(A[i], B[i], B[j]); mb.tri(A[i], B[j], A[j]);
      }
    }
    return mb.finish();
  }
  // Through-hole boss with a counterbore at the top (heat-set insert /
  // screw head pocket). True ring geometry, not a solid cylinder.
  function buildMountingBossRing(opts) {
    const o = Object.assign({ x: 0, z: 0, y0: 0, height: 6, holeD: 3.2, outerD: 6.5, cbD: 5.6, cbDepth: 1.5, counterboreAt: "top", segs: 24 }, opts || {});
    const rH = Math.max(0.3, o.holeD / 2), rO = Math.max(rH + 0.4, o.outerD / 2);
    const rC = clamp(o.cbD / 2, rH + 0.1, rO - 0.2), h = Math.max(0.5, o.height), dc = clamp(o.cbDepth, 0, h - 0.3);
    let prof;
    if (dc <= 0) prof = [[rH, 0], [rO, 0], [rO, h], [rH, h]];
    else if (o.counterboreAt === "bottom") prof = [[rC, 0], [rO, 0], [rO, h], [rH, h], [rH, dc], [rC, dc]];
    else prof = [[rH, 0], [rO, 0], [rO, h], [rC, h], [rC, h - dc], [rH, h - dc]];
    return latheShell("boss", prof, o.x, o.z, o.y0, o.segs);
  }

  /* Rectilinear 2-D cell grid extruded along a third axis.
     cell(i,j) -> 0 (empty) | 1 (solid) | {cu, cv, r, seg} (solid quadrant
     cell with a quarter of a round through-hole centred on one corner).
     Every cell shares exact grid edges with its neighbours, so the result
     is watertight with no T-junctions. P maps (u, v, w) to [x, y, z]. */
  function extrudeGrid2D(mb, us, vs, cell, w0, w1, P) {
    const nu = us.length - 1, nv = vs.length - 1;
    const type = function (i, j) { return (i < 0 || j < 0 || i >= nu || j >= nv) ? 0 : cell(i, j); };
    const V = function (u, v, w) { const p = P(u, v, w); return mb.v(p[0], p[1], p[2]); };
    const cap = function (a, b, c) {
      const cr = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
      if (Math.abs(cr) < 1e-12) return;
      if (cr < 0) { const t = b; b = c; c = t; }
      mb.tri(V(a[0], a[1], w1), V(b[0], b[1], w1), V(c[0], c[1], w1));
      mb.tri(V(a[0], a[1], w0), V(c[0], c[1], w0), V(b[0], b[1], w0));
    };
    const wall = function (A, B, n) {
      const ev = B[1] - A[1], eu = B[0] - A[0];
      if (ev * n[0] - eu * n[1] < 0) { const t = A; A = B; B = t; }
      const a0 = V(A[0], A[1], w0), b0 = V(B[0], B[1], w0), b1 = V(B[0], B[1], w1), a1 = V(A[0], A[1], w1);
      mb.tri(a0, b0, b1); mb.tri(a0, b1, a1);
    };
    for (let i = 0; i < nu; i++) for (let j = 0; j < nv; j++) {
      const t = type(i, j);
      if (!t) continue;
      const u0 = us[i], u1 = us[i + 1], v0 = vs[j], v1 = vs[j + 1];
      if (t === 1) {
        cap([u0, v0], [u1, v0], [u1, v1]); cap([u0, v0], [u1, v1], [u0, v1]);
      } else {
        const C = [t.cu, t.cv];
        const Au = Math.abs(u0 - t.cu) < 1e-9 ? u1 : u0, Bv = Math.abs(v0 - t.cv) < 1e-9 ? v1 : v0;
        const su = Math.sign(Au - t.cu), sv = Math.sign(Bv - t.cv);
        const A = [Au, t.cv], B = [t.cu, Bv], F = [Au, Bv];
        const arc = [];
        for (let k = 0; k <= t.seg; k++) {
          if (k === 0) { arc.push([t.cu + su * t.r, t.cv]); continue; }
          if (k === t.seg) { arc.push([t.cu, t.cv + sv * t.r]); continue; }
          const ang = (k / t.seg) * Math.PI / 2;
          arc.push([t.cu + su * t.r * Math.cos(ang), t.cv + sv * t.r * Math.sin(ang)]);
        }
        cap(F, A, arc[0]);
        for (let k = 0; k < t.seg; k++) cap(F, arc[k], arc[k + 1]);
        cap(F, arc[t.seg], B);
        for (let k = 0; k < t.seg; k++) {
          const m = [(arc[k][0] + arc[k + 1][0]) / 2, (arc[k][1] + arc[k + 1][1]) / 2];
          wall(arc[k], arc[k + 1], [C[0] - m[0], C[1] - m[1]]);
        }
      }
      if (!type(i + 1, j)) wall([u1, v0], [u1, v1], [1, 0]);
      if (!type(i - 1, j)) wall([u0, v0], [u0, v1], [-1, 0]);
      if (!type(i, j + 1)) wall([u0, v1], [u1, v1], [0, 1]);
      if (!type(i, j - 1)) wall([u0, v0], [u1, v0], [0, -1]);
    }
  }
  function uniqSorted(a) {
    const s = a.slice().sort(function (x, y) { return x - y; });
    const out = [];
    s.forEach(function (v) { if (!out.length || Math.abs(v - out[out.length - 1]) > 1e-6) out.push(v); });
    return out;
  }

  // Flat plate in the x-z plane (y0..y1) with round through-holes.
  // Holes whose square tiles would overlap or leave the plate are skipped
  // (with a warning) because the tile layout must stay conflict-free.
  function plateWithHoles(role, W, D, holes, y0, y1, warnings) {
    const accepted = [];
    (holes || []).forEach(function (h) {
      // Tile half-size a > r keeps every fan triangle from the tile corner
      // outside the hole (corner sees the whole quarter arc when a > r).
      const r = Math.max(0.2, num(h.d, 3.2) / 2), a = r * (r > 5 ? 1.1 : 1.25);
      const cx = num(h.x, 0), cz = num(h.z, 0);
      const inside = Math.abs(cx) + a < W / 2 - 0.2 && Math.abs(cz) + a < D / 2 - 0.2;
      const clash = accepted.some(function (o) {
        const du = Math.abs(o.cx - cx) < 1e-6 && Math.abs(o.a - a) < 1e-6, dv = Math.abs(o.cz - cz) < 1e-6 && Math.abs(o.a - a) < 1e-6;
        const ou = Math.abs(o.cx - cx) < o.a + a, ov = Math.abs(o.cz - cz) < o.a + a;
        return (ou && !du) || (ov && !dv) || (du && dv);
      });
      if (!inside || clash) { if (warnings) warnings.push("Hole Ø" + (2 * r).toFixed(1) + " at (" + cx + ", " + cz + ") skipped: " + (inside ? "overlaps another hole's keep-out" : "too close to the plate edge") + "."); return; }
      accepted.push({ cx: cx, cz: cz, r: r, a: a, seg: r > 5 ? 8 : 4 });
    });
    const us = [-W / 2, W / 2], vs = [-D / 2, D / 2];
    accepted.forEach(function (h) { us.push(h.cx - h.a, h.cx, h.cx + h.a); vs.push(h.cz - h.a, h.cz, h.cz + h.a); });
    const U = uniqSorted(us), Vv = uniqSorted(vs);
    const mb = new MeshBuilder(role);
    extrudeGrid2D(mb, U, Vv, function (i, j) {
      const um = (U[i] + U[i + 1]) / 2, vm = (Vv[j] + Vv[j + 1]) / 2;
      for (let k = 0; k < accepted.length; k++) {
        const h = accepted[k];
        if (Math.abs(um - h.cx) < h.a && Math.abs(vm - h.cz) < h.a) return { cu: h.cx, cv: h.cz, r: h.r, seg: h.seg };
      }
      return 1;
    }, y0, y1, function (u, v, w) { return [u, w, v]; });
    return { shell: mb.finish(), holes: accepted };
  }

  // Fin x-intervals: edge fins flush with the base, uniform pitch, so the
  // clear gap is s = (W − N·t)/(N − 1) exactly as the solver assumes.
  function finIntervals(W, N, t) {
    const out = [];
    if (N <= 0) return out;
    if (N === 1) return [[-t / 2, t / 2]];
    const pitch = (W - t) / (N - 1);
    for (let i = 0; i < N; i++) { const l = -W / 2 + i * pitch; out.push([l, i === N - 1 ? W / 2 : l + t]); }
    return out;
  }
  // Base plate + fins as ONE continuous watertight comb solid.
  function buildHeatsink(params) {
    const d = sanitizeDesign(params).design;
    const y0 = num(params && params.y0, 0);
    const fins = d.finH > 0 ? finIntervals(d.W, d.fins, d.finT) : [];
    const xs = [-d.W / 2, d.W / 2];
    fins.forEach(function (f) { xs.push(f[0], f[1]); });
    const us = uniqSorted(xs);
    const vs = fins.length ? [y0, y0 + d.baseT, y0 + d.baseT + d.finH] : [y0, y0 + d.baseT];
    const mb = new MeshBuilder("body");
    extrudeGrid2D(mb, us, vs, function (i, j) {
      if (j === 0) return 1;
      const um = (us[i] + us[i + 1]) / 2;
      return fins.some(function (f) { return um > f[0] && um < f[1]; }) ? 1 : 0;
    }, -d.D / 2, d.D / 2, function (u, v, w) { return [u, v, w]; });
    return mb.finish();
  }

  /* Rectilinear 3-D voxel solid: faces only between solid and empty
     cells, so every edge is shared by exactly two faces. */
  function voxelShell(role, xs, ys, zs, solid) {
    const mb = new MeshBuilder(role);
    const nx = xs.length - 1, ny = ys.length - 1, nz = zs.length - 1;
    const S = function (i, j, k) { return i >= 0 && j >= 0 && k >= 0 && i < nx && j < ny && k < nz && solid(i, j, k); };
    const quad = function (p, n) {
      // p: four corners in any cyclic order; orient so the normal is n.
      const a = p[0], b = p[1], c = p[2];
      const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2], vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
      const cx = uy * vz - uz * vy, cy = uz * vx - ux * vz, cz = ux * vy - uy * vx;
      const ids = p.map(function (q) { return mb.v(q[0], q[1], q[2]); });
      if (cx * n[0] + cy * n[1] + cz * n[2] < 0) ids.reverse();
      mb.tri(ids[0], ids[1], ids[2]); mb.tri(ids[0], ids[2], ids[3]);
    };
    for (let i = 0; i < nx; i++) for (let j = 0; j < ny; j++) for (let k = 0; k < nz; k++) {
      if (!S(i, j, k)) continue;
      const x0 = xs[i], x1 = xs[i + 1], y0 = ys[j], y1 = ys[j + 1], z0 = zs[k], z1 = zs[k + 1];
      if (!S(i + 1, j, k)) quad([[x1, y0, z0], [x1, y1, z0], [x1, y1, z1], [x1, y0, z1]], [1, 0, 0]);
      if (!S(i - 1, j, k)) quad([[x0, y0, z0], [x0, y1, z0], [x0, y1, z1], [x0, y0, z1]], [-1, 0, 0]);
      if (!S(i, j + 1, k)) quad([[x0, y1, z0], [x1, y1, z0], [x1, y1, z1], [x0, y1, z1]], [0, 1, 0]);
      if (!S(i, j - 1, k)) quad([[x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1]], [0, -1, 0]);
      if (!S(i, j, k + 1)) quad([[x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]], [0, 0, 1]);
      if (!S(i, j, k - 1)) quad([[x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0]], [0, 0, -1]);
    }
    return mb.finish();
  }

  const PORT_TYPES = {
    rj45:   { label: "RJ45",               w: 16.0, h: 13.5 },
    usbc:   { label: "USB-C",              w: 9.2,  h: 3.6 },
    term2:  { label: "2-pos screw terminal (5.08 mm)", w: 10.4, h: 8.5 },
    term3:  { label: "3-pos screw terminal (5.08 mm)", w: 15.5, h: 8.5 }
  };
  const ENC = { wall: 2.5, floor: 3, standoffH: 5, boardT: 1.6 };
  function enclosureInteriorH(d) { return d.encH > 0 ? d.encH : Math.max(14, d.finH + 8); }
  // Default cut-outs sit on the PCB top surface; ones that cannot fit the
  // current interior height are left out silently (user-specified ports
  // that don't fit produce a warning instead).
  function defaultPorts(d) {
    const y0 = ENC.standoffH + ENC.boardT, room = enclosureInteriorH(d) - 0.5;
    const ports = [];
    if (y0 + PORT_TYPES.usbc.h < room && d.W >= 40) ports.push({ wall: "front", type: "usbc", c: -d.W * 0.25, y0: y0 });
    if (y0 + PORT_TYPES.rj45.h < room && d.W >= 70) ports.push({ wall: "front", type: "rj45", c: d.W * 0.18, y0: y0 });
    if (y0 + PORT_TYPES.term2.h < room && d.D >= 40) ports.push({ wall: "left", type: "term2", c: 0, y0: y0 });
    return ports;
  }
  function enclosureKeepout(d) {
    const interior = enclosureInteriorH(d);
    const limit = interior - 2;
    if (d.finH > limit) {
      return { ok: false, finH: d.finH, interiorH: interior, message: "Keep-out violation: heatsink fin height " + d.finH + " mm exceeds interior height " + interior + " mm − 2 mm clearance (max " + limit.toFixed(1) + " mm)." };
    }
    return { ok: true, finH: d.finH, interiorH: interior, message: "Fin height " + d.finH + " mm clears the " + interior + " mm interior with ≥ 2 mm margin." };
  }
  // Open-top PCB enclosure with real port cut-outs, standoff bosses and a
  // floated snap-fit lid. Returns { shells, warnings, ports, keepout }.
  function buildEnclosure(params) {
    const d = sanitizeDesign(params).design;
    const warnings = [];
    const t = ENC.wall, fl = ENC.floor, H = fl + enclosureInteriorH(d);
    const W = d.W, D = d.D;
    const ports = [];
    (d.ports || defaultPorts(d)).forEach(function (p) {
      const pt = PORT_TYPES[p.type];
      if (!pt) { warnings.push("Unknown port type '" + p.type + "' skipped."); return; }
      const span = (p.wall === "front" || p.wall === "back") ? W - 2 * t : D - 2 * t;
      const c = num(p.c, 0), yb = fl + Math.max(0.5, num(p.y0, 0));
      if (Math.abs(c) + pt.w / 2 > span / 2 - 0.5 || yb + pt.h > H - 0.5) {
        warnings.push(pt.label + " on the " + p.wall + " wall does not fit and was skipped.");
        return;
      }
      // Cut-outs on the same wall must keep ≥ 1 mm of material between
      // them; touching rectangles would create a non-manifold edge.
      const clash = ports.some(function (q) {
        return q.wall === p.wall && c - pt.w / 2 < q.a1 + 1 && c + pt.w / 2 > q.a0 - 1 && yb < q.y1 + 1 && yb + pt.h > q.y0 - 1;
      });
      if (clash) { warnings.push(pt.label + " on the " + p.wall + " wall overlaps another cut-out and was skipped."); return; }
      ports.push({ wall: p.wall, type: p.type, label: pt.label, c: c, y0: yb, y1: yb + pt.h, a0: c - pt.w / 2, a1: c + pt.w / 2 });
    });
    const xs = [-W / 2, -W / 2 + t, W / 2 - t, W / 2], zs = [-D / 2, -D / 2 + t, D / 2 - t, D / 2], ys = [0, fl, H];
    ports.forEach(function (p) {
      ys.push(p.y0, p.y1);
      if (p.wall === "front" || p.wall === "back") xs.push(p.a0, p.a1); else zs.push(p.a0, p.a1);
    });
    const X = uniqSorted(xs), Y = uniqSorted(ys), Z = uniqSorted(zs);
    const body = voxelShell("wall", X, Y, Z, function (i, j, k) {
      const x = (X[i] + X[i + 1]) / 2, y = (Y[j] + Y[j + 1]) / 2, z = (Z[k] + Z[k + 1]) / 2;
      if (y < fl) return true;
      const inWall = x < -W / 2 + t || x > W / 2 - t || z < -D / 2 + t || z > D / 2 - t;
      if (!inWall) return false;
      for (let q = 0; q < ports.length; q++) {
        const p = ports[q];
        if (y <= p.y0 || y >= p.y1) continue;
        if (p.wall === "front" && z > D / 2 - t && x > p.a0 && x < p.a1) return false;
        if (p.wall === "back" && z < -D / 2 + t && x > p.a0 && x < p.a1) return false;
        if (p.wall === "left" && x < -W / 2 + t && z > p.a0 && z < p.a1) return false;
        if (p.wall === "right" && x > W / 2 - t && z > p.a0 && z < p.a1) return false;
      }
      return true;
    });
    const shells = [body];
    // PCB standoffs (through-hole + counterbore for a heat-set insert)
    const pw = W * 0.55, pd = D * 0.55;
    const bx = pw / 2 - 3.5, bz = pd / 2 - 3.5;
    if (bx > 2 && bz > 2) {
      [[-bx, -bz], [bx, -bz], [-bx, bz], [bx, bz]].forEach(function (p) {
        shells.push(buildMountingBossRing({ x: p[0], z: p[1], y0: fl, height: ENC.standoffH, holeD: 2.5, outerD: 6, cbD: 4.0, cbDepth: 2.0 }));
      });
    }
    shells.push(boxShell("die", 0, fl + ENC.standoffH + ENC.boardT / 2, 0, pw, ENC.boardT, pd));     // enclosed PCB
    shells.push(boxShell("lid", 0, H + 4 + 1.25, 0, W - 6, 2.5, D - 6));                                // floated snap-fit lid
    const keepout = enclosureKeepout(d);
    if (!keepout.ok) warnings.push(keepout.message);
    return { shells: shells, warnings: warnings, ports: ports, keepout: keepout, interiorH: H - fl };
  }

  function buildPCB(d, warnings) {
    const pcb = Object.assign({}, DEFAULT_PCB, d.pcb || {});
    const t = Math.max(0.4, num(pcb.boardT, 1.6));
    const shells = [];
    if (pcb.outline === "annulus") {
      const rO = Math.min(d.W, d.D) / 2, rI = clamp(num(pcb.innerD, 20) / 2, 1, rO - 3);
      shells.push(latheShell("board", [[rI, 0], [rO, 0], [rO, t], [rI, t]], 0, 0, 0, 64));
    } else {
      const res = plateWithHoles("board", d.W, d.D, pcb.holes, 0, t, warnings);
      shells.push(res.shell);
      res.holes.forEach(function (h) {
        shells.push(buildMountingBossRing({ x: h.cx, z: h.cz, y0: -Math.max(1, num(pcb.standoffH, 6)), height: Math.max(1, num(pcb.standoffH, 6)),
          holeD: 2 * h.r, outerD: Math.max(2 * h.r + 2.4, 5.5), cbD: 2 * h.r + 1.6, cbDepth: 1.2, counterboreAt: "bottom" }));
      });
    }
    (pcb.components || []).forEach(function (c) {
      const h = Math.max(0.3, num(c.h, 1));
      shells.push(boxShell("component", num(c.x, 0), t + h / 2, num(c.z, 0), Math.max(0.5, num(c.w, 2)), h, Math.max(0.5, num(c.d, 2))));
    });
    return shells;
  }

  function buildChiplet(d) {
    const shells = [boxShell("base", 0, 1.25, 0, d.W, 2.5, d.D)];
    chipletDieBoxes(d).forEach(function (b) { shells.push(boxShell("die", b.x, 2.5 + 1.6, b.z, b.w, 3.2, b.d)); });
    shells.push(boxShell("lid", 0, 6.4, 0, d.W * 0.8, 1.2, d.D * 0.8));
    if (d.fins > 0 && d.finH > 0 && d.mode !== "bare") {
      shells.push(buildHeatsink(Object.assign({}, d, { y0: 7.0 })));
    }
    return shells;
  }

  function buildBracket(d, warnings) {
    const t = 5;
    const holes = [];
    const m = Math.min(d.W, d.D);
    if (m >= 50) {
      holes.push({ x: 0, z: 0, d: 22.4 });                         // NEMA-17 pilot boss
      [[-15.5, -15.5], [15.5, -15.5], [-15.5, 15.5], [15.5, 15.5]].forEach(function (p) { holes.push({ x: p[0], z: p[1], d: 3.4 }); });
    } else {
      const ix = d.W / 2 - 6, iz = d.D / 2 - 6;
      if (ix > 3 && iz > 3) [[-ix, -iz], [ix, -iz], [-ix, iz], [ix, iz]].forEach(function (p) { holes.push({ x: p[0], z: p[1], d: 3.4 }); });
    }
    const base = plateWithHoles("body", d.W, d.D, holes, 0, t, warnings).shell;
    const upH = Math.max(24, d.finH * 2.4);
    return [base, boxShell("wall", 0, t + upH / 2, -d.D / 2 + t / 2 + 0.5, d.W, upH, t)];
  }

  // Dispatch: full design -> { shells, warnings, keepout?, ports? }
  function buildDesignMesh(design) {
    const sd = sanitizeDesign(design);
    const d = sd.design;
    const warnings = sd.warnings.slice();
    let shells = [], extra = {};
    if (d.gen === "heatsink") {
      shells.push(buildHeatsink(d));
      if (d.mode !== "bare") {
        heatSources(d).forEach(function (s) { shells.push(boxShell("die", s.x, -1.25, s.z, s.w, 2.5, s.d)); });
      }
    } else if (d.gen === "enclosure") {
      const e = buildEnclosure(d);
      shells = e.shells; warnings.push.apply(warnings, e.warnings); extra = { keepout: e.keepout, ports: e.ports, interiorH: e.interiorH };
    } else if (d.gen === "chiplet") {
      shells = buildChiplet(d);
    } else if (d.gen === "bracket") {
      shells = buildBracket(d, warnings);
    } else {
      shells = buildPCB(d, warnings);
    }
    return Object.assign({ shells: shells, warnings: warnings, design: d }, extra);
  }
  // Top surface height (mm) where the heat-map skin is drawn.
  function heatSurfaceY(d) {
    if (d.gen === "heatsink") return d.baseT;
    if (d.gen === "bracket") return 5;
    if (d.gen === "pcb") return (d.pcb && d.pcb.boardT) || 1.6;
    if (d.gen === "chiplet") return 2.5;
    return ENC.floor;
  }

  /* ------------------------------------------------------------------ */
  /* Mesh checks + mass                                                 */
  /* ------------------------------------------------------------------ */
  // Topological check per shell: every undirected edge used by exactly
  // two triangles AND every directed edge used once (consistent winding).
  function checkShell(shell) {
    const ix = shell.indices;
    const und = new Map(), dir = new Set();
    let flips = 0;
    for (let t = 0; t < ix.length; t += 3) {
      for (let e = 0; e < 3; e++) {
        const a = ix[t + e], b = ix[t + (e + 1) % 3];
        const k = a < b ? a + "_" + b : b + "_" + a;
        und.set(k, (und.get(k) || 0) + 1);
        const dk = a + ">" + b;
        if (dir.has(dk)) flips++;
        dir.add(dk);
      }
    }
    let bad = 0;
    und.forEach(function (n) { if (n !== 2) bad++; });
    const vol = signedVolume(shell);
    const empty = ix.length < 12 || Math.abs(vol) < 1e-9;
    return { watertight: bad === 0 && !empty, empty: empty, badEdges: bad, orientationErrors: flips, outward: vol > 0, volumeMm3: Math.abs(vol), edgeCount: und.size, triangles: ix.length / 3 };
  }
  function checkMesh(mesh) {
    const per = mesh.shells.map(checkShell);
    return {
      watertight: per.every(function (c) { return c.watertight; }),
      consistent: per.every(function (c) { return c.orientationErrors === 0 && c.outward; }),
      badEdges: per.reduce(function (s, c) { return s + c.badEdges; }, 0),
      orientationErrors: per.reduce(function (s, c) { return s + c.orientationErrors; }, 0),
      shells: per.length,
      triangles: per.reduce(function (s, c) { return s + c.triangles; }, 0),
      perShell: per
    };
  }
  const STRUCTURAL_ROLES = { body: 1, wall: 1, boss: 1, lid: 1, board: 1, base: 1 };
  function massReport(mesh) {
    const d = mesh.design;
    let vol = 0;
    mesh.shells.forEach(function (s) { if (STRUCTURAL_ROLES[s.role]) vol += Math.abs(signedVolume(s)); });
    const cm3 = vol / 1000;
    const metal = (d.gen === "pcb") ? 0 : cm3 * (MATERIALS[d.mat === "fr4" ? "aluminum" : d.mat].density / 1000);
    return { volumeCm3: cm3, massFdmG: cm3 * FDM_DENSITY_G_CM3 * FDM_INFILL, massAlG: cm3 * 2.70, massMetalG: metal };
  }

  /* ------------------------------------------------------------------ */
  /* BOM estimate + part swap with single-step undo                     */
  /* ------------------------------------------------------------------ */
  const PROCESS_FACTOR = { aluminum: 2.2, copper: 3.0, fr4: 0 };
  // Analytic comb volume (identical to the buildHeatsink solid): base
  // plate + N rectangular fins. Cheap enough for the optimizer loop.
  function heatsinkVolumeMm3(d) {
    const fins = d.finH > 0 ? Math.min(d.fins, maxFinsFor(d.W, d.finT)) : 0;
    const finW = fins === 1 ? d.finT : fins * d.finT;
    return d.W * d.D * d.baseT + finW * d.finH * d.D;
  }
  function heatsinkBodyMassG(d) {
    if (d.gen !== "heatsink" && !(d.gen === "chiplet" && d.fins > 0)) return 0;
    const mat = MATERIALS[d.mat === "fr4" ? "aluminum" : d.mat];
    return heatsinkVolumeMm3(d) / 1000 * (mat.density / 1000);
  }
  // Which catalog parts make physical sense for the current generator.
  function partAppliesTo(design, part) {
    if (!part || !design) return false;
    const g = design.gen;
    if (part.kind === "copper") return !!design.copper;
    if (part.kind === "fan") return true;
    if (part.kind === "tim" || part.kind === "package") return g === "heatsink" || g === "chiplet";
    if (part.kind === "heatsink") return g === "heatsink";
    return false;
  }
  function estimateBomUSD(design) {
    const d = sanitizeDesign(design).design;
    const lines = [];
    const hsPart = d.heatsinkPartId && getPart(d.heatsinkPartId);
    const attached = d.mode !== "bare" && (d.gen === "heatsink" || (d.gen === "chiplet" && d.fins > 0));
    if (attached) {
      if (hsPart) lines.push({ item: hsPart.mfr + " " + hsPart.mpn, usd: hsPart.priceUSD });
      else {
        const g = heatsinkBodyMassG(d);
        const m = d.mat === "fr4" ? "aluminum" : d.mat;
        lines.push({ item: MATERIALS[m].label + " heatsink, " + g.toFixed(0) + " g", usd: g / 1000 * MATERIALS[m].usdPerKg * (PROCESS_FACTOR[m] || 1) });
      }
      const tim = getPart(d.timId);
      if (tim) lines.push({ item: tim.mfr + " " + tim.mpn, usd: tim.priceUSD });
    }
    const fan = d.fanPartId && getPart(d.fanPartId);
    if (fan) lines.push({ item: fan.mfr + " " + fan.mpn, usd: fan.priceUSD });
    const cuPart = d.copperPartId && getPart(d.copperPartId);
    if (cuPart) lines.push({ item: cuPart.mfr + " " + cuPart.mpn, usd: cuPart.priceUSD });
    return { totalUSD: lines.reduce(function (s, l) { return s + l.usd; }, 0), lines: lines };
  }

  function applyPart(design, partId) {
    const p = getPart(partId);
    if (!p) throw new Error("Unknown part " + partId);
    const d = clone(design);
    if (!partAppliesTo(d, p)) throw new Error(p.mpn + " does not apply to a " + d.gen + " design.");
    if (p.kind === "tim") d.timId = p.id;
    else if (p.kind === "heatsink") { Object.assign(d, clone(p.apply)); d.heatsinkPartId = p.id; d.mode = "heatsink"; }
    else if (p.kind === "fan") { Object.assign(d, clone(p.apply)); d.fanPartId = p.id; }
    else if (p.kind === "package") Object.assign(d, clone(p.apply));
    else if (p.kind === "copper") {
      d.copper = Object.assign({}, d.copper, { copperOz: p.copperOz });
      if (d.pcb) d.pcb.copperOz = p.copperOz;
      d.copperPartId = p.id;
    }
    return sanitizeDesign(d).design;
  }
  function fmtSigned(v, digits) { return (v >= 0 ? "+" : "−") + Math.abs(v).toFixed(digits); }
  // evaluate(design) -> { tj, worstIrDropMv?, worstCurrentDensityAmm2? }  (injected: keeps presets.js solver-free)
  function previewSwap(design, partId, evaluate) {
    const before = evaluate(design);
    const next = applyPart(design, partId);
    const after = evaluate(next);
    const bomB = estimateBomUSD(design).totalUSD, bomA = estimateBomUSD(next).totalUSD;
    const dT = (after && typeof after.tj === "number" && before && typeof before.tj === "number") ? (after.tj - before.tj) : 0;
    const dUSD = bomA - bomB;
    const dIr = (after && typeof after.worstIrDropMv === "number" && before && typeof before.worstIrDropMv === "number")
      ? (after.worstIrDropMv - before.worstIrDropMv) : null;
    const dJ = (after && typeof after.worstCurrentDensityAmm2 === "number" && before && typeof before.worstCurrentDensityAmm2 === "number")
      ? (after.worstCurrentDensityAmm2 - before.worstCurrentDensityAmm2) : null;
    const tjAfter = (after && typeof after.tj === "number") ? after.tj : 0;
    const tjBefore = (before && typeof before.tj === "number") ? before.tj : 0;
    const overLimit = tjBefore > 1000 || tjAfter > 1000;
    const tjStr = tjAfter > 1000
      ? ">1000 °C — model limit, uncooled bare-die output, not a real temperature"
      : tjAfter.toFixed(1) + "°C";
    const dTStr = overLimit ? "model limit" : fmtSigned(dT, 1) + "°C";
    return {
      partId: partId, part: getPart(partId), before: before, after: after, design: next,
      deltaTj: dT, deltaBomUSD: dUSD, deltaIrDropMv: dIr, deltaCurrentDensityAmm2: dJ,
      text: "New Tj: " + tjStr + " (ΔT: " + dTStr + ", " + (dUSD >= 0 ? "+" : "−") + "$" + Math.abs(dUSD).toFixed(2) + " BOM)"
    };
  }
  function SwapHistory() { this.prev = null; }
  SwapHistory.prototype.commit = function (designBefore, designAfter) { this.prev = clone(designBefore); return clone(designAfter); };
  SwapHistory.prototype.canUndo = function () { return !!this.prev; };
  SwapHistory.prototype.undo = function () { const p = this.prev; this.prev = null; return p ? clone(p) : null; };

  return {
    VERSION: "3.0.0",
    MATERIALS: MATERIALS, COPPER_OZ_TABLE: COPPER_OZ_TABLE, copperThicknessUm: copperThicknessUm, copperThicknessMm: copperThicknessMm,
    PARTS_CATALOG: PARTS_CATALOG, TIM_UPGRADE_ORDER: TIM_UPGRADE_ORDER, getPart: getPart,
    FAMOUS_BOARDS: FAMOUS_BOARDS, PROTOFLOW_BOARDS: PROTOFLOW_BOARDS, PRESET_CATS: PRESET_CATS, PRESETS: PRESETS,
    MI300X_OAM_POWER_W: MI300X_OAM_POWER_W, GENERATORS: GENERATORS, DESIGN_DEFAULTS: DESIGN_DEFAULTS, LIMITS: LIMITS,
    MIN_FIN_GAP_MM: MIN_FIN_GAP_MM, PORT_TYPES: PORT_TYPES, DEFAULT_PCB: DEFAULT_PCB,
    sanitizeDesign: sanitizeDesign, designFromPreset: designFromPreset, maxFinsFor: maxFinsFor, clone: clone,
    pcbInPlaneK: pcbInPlaneK, heatSources: heatSources, powerScale: powerScale, finIntervals: finIntervals,
    enclosureInteriorH: enclosureInteriorH, enclosureKeepout: enclosureKeepout, ENCLOSURE: ENC,
    buildHeatsink: buildHeatsink, buildEnclosure: buildEnclosure, buildMountingBossRing: buildMountingBossRing,
    buildDesignMesh: buildDesignMesh, heatSurfaceY: heatSurfaceY, plateWithHoles: plateWithHoles, boxShell: boxShell, latheShell: latheShell,
    checkShell: checkShell, checkMesh: checkMesh, signedVolume: signedVolume, massReport: massReport,
    estimateBomUSD: estimateBomUSD, heatsinkBodyMassG: heatsinkBodyMassG, heatsinkVolumeMm3: heatsinkVolumeMm3, partAppliesTo: partAppliesTo, applyPart: applyPart, previewSwap: previewSwap, SwapHistory: SwapHistory
  };
});
