"use strict";
const { test, suite, ok, near, eq, throws } = require("./harness");
const P = require("../presets.js");
const T = require("../thermal-solver.js");
const E = require("../exporters.js");

suite("exporters.js — KiCad S-Expression parser", function () {
  test("parses .kicad_pcb S-expression perimeter and footprints", function () {
    const sampleKiCad = `
(kicad_pcb (version 20240108) (generator pcbnew)
  (general (thickness 1.6))
  (gr_line (start 10 20) (end 110 20) (layer "Edge.Cuts") (stroke (width 0.1)))
  (gr_line (start 110 20) (end 110 100) (layer "Edge.Cuts") (stroke (width 0.1)))
  (gr_line (start 110 100) (end 10 100) (layer "Edge.Cuts") (stroke (width 0.1)))
  (gr_line (start 10 100) (end 10 20) (layer "Edge.Cuts") (stroke (width 0.1)))
  (footprint "Package_SO:SOIC-8" (at 40 50 90)
    (fp_text reference "U1" (at 0 -2) (layer "F.SilkS"))
  )
  (footprint "Resistor_SMD:R_0805" (at 70 80)
    (fp_text reference "R1" (at 0 -1.5) (layer "F.SilkS"))
  )
)
`;
    const res = E.parseKiCadPcb(sampleKiCad);
    eq(res.W, 100, "W should be 100 mm");
    eq(res.D, 80, "D should be 80 mm");
    eq(res.components.length, 2);
    eq(res.components[0].ref, "U1");
    eq(res.components[1].ref, "R1");
  });

  test("handles empty or invalid KiCad syntax gracefully", function () {
    throws(() => E.parseKiCadPcb("(invalid_root)"), "Must reject non-kicad_pcb");
  });
});

suite("exporters.js — Watertight STL & iOS Quick Look USDZ", function () {
  test("STL export is watertight and contains valid binary data", function () {
    const d = P.designFromPreset(P.FAMOUS_BOARDS[0]);
    const res = T.solveThermal(d);
    const stl = E.exportSTL(d, res);
    ok(stl.isWatertight, "Exported STL must be 100% watertight");
    eq(stl.badEdges, 0);
    ok(stl.buffer.byteLength > 84);
  });

  test("USDZ generator creates true 0.001 scale and single-img anchor", function () {
    const d = P.designFromPreset(P.FAMOUS_BOARDS[0]);
    const res = T.solveThermal(d);
    const usdz = E.generateUSDZ(d, res);
    eq(usdz.scale, 0.001, "USDZ scale must be 0.001 for true mm-to-m");
    ok(usdz.usda.includes("metersPerUnit = 1"));
    ok(usdz.zip.byteLength > 0);
    ok(usdz.anchorHtml.includes('<a rel="ar"'));
    ok(usdz.anchorHtml.includes('<img'));
  });
});

suite("exporters.js — CTM-JSON & PDF Report & SolidSayMCP", function () {
  test("CTM-JSON generates valid resistor-capacitor network schema with electrical summary", function () {
    const d = P.designFromPreset(P.FAMOUS_BOARDS[0]);
    const res = T.solveThermal(d);
    const ctm = E.exportCTM(d, res);
    eq(ctm.schema, "SolidSay-CTM-v1");
    ok(ctm.nodes.length >= 4);
    ok(ctm.resistors.length >= 3);
    ok(ctm.electrical && ctm.electrical.hasPowerDelivery === true, "CTM electrical summary present");
    ok(ctm.electrical.worstIrDropMv > 0 && ctm.electrical.worstCurrentDensityAmm2 > 0);
  });

  test("PDF generator produces PDF document with verification badges", function () {
    const d = P.designFromPreset(P.FAMOUS_BOARDS[0]);
    const res = T.solveThermal(d);
    const pdf = E.generatePDFReport(d, res);
    ok(pdf.pdfBlob || pdf.pdfArrayBuffer, "PDF output must be generated");
  });

  test("window.SolidSayMCP interface deterministic project gate", function () {
    const mcp = E.createSolidSayMCP();
    const proj = mcp.get_enterprise_project();
    eq(proj.version, "2.0.0");
    mcp.update_enterprise_project({ maxTjLimitC: 110.0 });
    const updated = mcp.get_enterprise_project();
    eq(updated.maxTjLimitC, 110.0);

    // Pi 5 with forced air cooler clears gate
    const coolDesign = P.designFromPreset(P.FAMOUS_BOARDS[0]);
    coolDesign.air = "forced";
    const gateRes = mcp.run_thermal_gate(coolDesign);
    ok(gateRes.checks.peakTj.pass, "Peak Tj should pass limit with forced air cooling");
    ok(gateRes.checks.localResidual.pass, "Local residual should pass the 3% limit");
    ok(gateRes.result.peakTjDisplay, "MCP gate includes peakTjDisplay");
    ok(gateRes.result.electrical && gateRes.result.electrical.hasPowerDelivery === true, "MCP gate includes electrical result");
    ok(gateRes.result.electrical.disclaimer && gateRes.result.electrical.copper && gateRes.result.electrical.railV > 0, "MCP gate includes complete electrical summary");
  });

  test("exportGistSnapshot, exportCTM, and generatePDFReport handle both active and copper: null presets", function () {
    // Active preset (Pi 5)
    const dActive = P.designFromPreset(P.FAMOUS_BOARDS[0]);
    const rActive = T.solveThermal(dActive);
    const gistActive = E.exportGistSnapshot(dActive, rActive);
    eq(gistActive.app, "SolidSay v3 Power-Integrity");
    ok(gistActive.result.peakTjDisplay, "Gist active includes peakTjDisplay");
    const elA = gistActive.result.electrical;
    eq(elA.hasPowerDelivery, true);
    ok(elA.railV > 0);
    ok(elA.copper && elA.copper.thicknessUm > 0 && elA.copper.crossSectionMm2 > 0);
    ok(typeof elA.worstIrDropPctDisplay === "string");
    ok(elA.disclaimer && /DC resistive screener/i.test(elA.disclaimer));

    // Passive preset (Cold Plate, copper: null)
    const coldPlate = P.PRESETS.find(p => p.name === "Cold Plate");
    const dNull = P.designFromPreset(coldPlate);
    const rNull = T.solveThermal(dNull);

    const ctmNull = E.exportCTM(dNull, rNull);
    eq(ctmNull.electrical.hasPowerDelivery, false);
    eq(ctmNull.electrical.copper, null);
    eq(ctmNull.electrical.railV, null);
    eq(ctmNull.electrical.status, "no power delivery in this part");
    eq(ctmNull.electrical.message, "no power delivery in this part");
    ok(ctmNull.electrical.disclaimer && /DC resistive screener/i.test(ctmNull.electrical.disclaimer));

    const gistNull = E.exportGistSnapshot(dNull, rNull);
    eq(gistNull.result.electrical.hasPowerDelivery, false);
    eq(gistNull.result.electrical.copper, null);
    eq(gistNull.result.electrical.railV, null);
    eq(gistNull.result.electrical.status, "no power delivery in this part");
    eq(gistNull.result.electrical.message, "no power delivery in this part");
    ok(gistNull.result.electrical.disclaimer);

    const pdfNull = E.generatePDFReport(dNull, rNull);
    ok(pdfNull.pdfBlob || pdfNull.pdfArrayBuffer, "PDF generated for copper: null preset");
  });
});
