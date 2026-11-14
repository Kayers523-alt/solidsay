/* =====================================================================
   SolidSay v2 · exporters.js
   Multi-format exporter engine, client-side KiCad .kicad_pcb parser,
   iOS AR Quick Look .USDZ generator, CTM-JSON, jsPDF audit card,
   and deterministic Enterprise Interface (window.SolidSayMCP).

   100% client-side compute. Zero telemetry or network egress.
   Compatible with Node.js and browser environments.
   ===================================================================== */
(function (root, factory) {
  "use strict";
  if (typeof module === "object" && module.exports) {
    module.exports = factory(require("./presets.js"), require("./thermal-solver.js"), require("./electrical-solver.js"));
  } else {
    root.SolidSayExporters = factory(root.SolidSayPresets, root.SolidSayThermal, root.SolidSayElectrical);
  }
})(typeof self !== "undefined" ? self : this, function (P, T, EL) {
  "use strict";

  /* ------------------------------------------------------------------ */
  /* S-Expression Tokenizer and Parser for KiCad .kicad_pcb             */
  /* ------------------------------------------------------------------ */
  function tokenizeSExpr(str) {
    const tokens = [];
    const len = str.length;
    let i = 0;
    while (i < len) {
      const c = str[i];
      if (c === " " || c === "\t" || c === "\n" || c === "\r") {
        i++;
        continue;
      }
      if (c === "(" || c === ")") {
        tokens.push(c);
        i++;
        continue;
      }
      if (c === '"') {
        let s = "";
        i++;
        while (i < len && str[i] !== '"') {
          if (str[i] === "\\" && i + 1 < len) {
            s += str[i + 1];
            i += 2;
          } else {
            s += str[i];
            i++;
          }
        }
        i++; // skip trailing quote
        tokens.push(s);
        continue;
      }
      // atom / symbol / number
      let atom = "";
      while (i < len && str[i] !== " " && str[i] !== "\t" && str[i] !== "\n" && str[i] !== "\r" && str[i] !== "(" && str[i] !== ")") {
        atom += str[i];
        i++;
      }
      tokens.push(atom);
    }
    return tokens;
  }

  function parseSExprTokens(tokens) {
    let pos = 0;
    function parseList() {
      if (tokens[pos] !== "(") return null;
      pos++; // skip '('
      const list = [];
      while (pos < tokens.length && tokens[pos] !== ")") {
        if (tokens[pos] === "(") {
          list.push(parseList());
        } else {
          list.push(tokens[pos]);
          pos++;
        }
      }
      pos++; // skip ')'
      return list;
    }
    return parseList();
  }

  function parseKiCadPcb(sexprStr) {
    const tokens = tokenizeSExpr(sexprStr);
    const tree = parseSExprTokens(tokens);
    if (!tree || tree[0] !== "kicad_pcb") {
      throw new Error("Invalid KiCad PCB file: root symbol is not 'kicad_pcb'");
    }

    const edgeLines = [];
    const footprints = [];

    // Traverse root elements
    for (let i = 1; i < tree.length; i++) {
      const item = tree[i];
      if (!Array.isArray(item)) continue;
      const tag = item[0];

      // Board perimeter: (gr_line (start X Y) (end X Y) (layer "Edge.Cuts") ...)
      // Also supports (gr_rect ...), (gr_arc ...)
      if (tag === "gr_line" || tag === "gr_rect" || tag === "gr_arc") {
        let isEdgeCuts = false;
        let start = null, end = null;
        for (let j = 1; j < item.length; j++) {
          const sub = item[j];
          if (!Array.isArray(sub)) continue;
          if (sub[0] === "layer" && (sub[1] === "Edge.Cuts" || sub[1] === '"Edge.Cuts"')) {
            isEdgeCuts = true;
          } else if (sub[0] === "start") {
            start = [parseFloat(sub[1]), parseFloat(sub[2])];
          } else if (sub[0] === "end") {
            end = [parseFloat(sub[1]), parseFloat(sub[2])];
          }
        }
        if (isEdgeCuts && start && end) {
          edgeLines.push({ type: tag, start: start, end: end });
        }
      }

      // Footprints / modules: (footprint "..." (at X Y [angle]) ...)
      if (tag === "footprint" || tag === "module") {
        const fpName = typeof item[1] === "string" ? item[1] : "Component";
        let at = [0, 0, 0];
        let ref = "";
        for (let j = 1; j < item.length; j++) {
          const sub = item[j];
          if (!Array.isArray(sub)) continue;
          if (sub[0] === "at") {
            at = [parseFloat(sub[1]) || 0, parseFloat(sub[2]) || 0, parseFloat(sub[3]) || 0];
          } else if (sub[0] === "fp_text" && sub[1] === "reference") {
            ref = sub[2] || "";
          } else if (sub[0] === "property" && sub[1] === "Reference") {
            ref = sub[2] || "";
          }
        }
        footprints.push({ ref: ref || fpName, name: fpName, at: at });
      }
    }

    // Determine bounding box from edge lines
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    edgeLines.forEach(l => {
      minX = Math.min(minX, l.start[0], l.end[0]);
      maxX = Math.max(maxX, l.start[0], l.end[0]);
      minY = Math.min(minY, l.start[1], l.end[1]);
      maxY = Math.max(maxY, l.start[1], l.end[1]);
    });

    const W = isFinite(minX) && isFinite(maxX) ? Math.max(10, Math.round(maxX - minX)) : 100;
    const D = isFinite(minY) && isFinite(maxY) ? Math.max(10, Math.round(maxY - minY)) : 80;
    const centerX = isFinite(minX) ? (minX + maxX) / 2 : 0;
    const centerY = isFinite(minY) ? (minY + maxY) / 2 : 0;

    // Convert components to relative coordinates (centered at origin)
    const comps = footprints.map((fp, idx) => {
      const relX = fp.at[0] - centerX;
      const relZ = fp.at[1] - centerY;
      return {
        ref: fp.ref || ("U" + (idx + 1)),
        name: fp.name,
        x: +relX.toFixed(2),
        z: +relZ.toFixed(2),
        w: 6.0,
        d: 6.0,
        h: 1.5,
        power: 0.5, // default configurable dissipation
        rjc: 5.0
      };
    });

    return {
      W: W,
      D: D,
      edgeLines: edgeLines,
      components: comps,
      rawCount: footprints.length
    };
  }

  /* ------------------------------------------------------------------ */
  /* Watertight STL Exporter with Manifold Validation                  */
  /* ------------------------------------------------------------------ */
  function exportSTL(design, result) {
    const mesh = P.buildDesignMesh(design);
    const check = P.checkMesh(mesh);

    // Collect all triangles from all shells
    let totalTris = 0;
    mesh.shells.forEach(s => { totalTris += s.indices.length / 3; });

    const buf = new ArrayBuffer(84 + totalTris * 50);
    const dv = new DataView(buf);
    dv.setUint32(80, totalTris, true);

    let off = 84;
    mesh.shells.forEach(s => {
      const pos = s.positions;
      const idx = s.indices;
      for (let t = 0; t < idx.length; t += 3) {
        const i0 = idx[t] * 3, i1 = idx[t + 1] * 3, i2 = idx[t + 2] * 3;
        const ax = pos[i0], ay = pos[i0 + 1], az = pos[i0 + 2];
        const bx = pos[i1], by = pos[i1 + 1], bz = pos[i1 + 2];
        const cx = pos[i2], cy = pos[i2 + 1], cz = pos[i2 + 2];

        // Normal
        const ux = bx - ax, uy = by - ay, uz = bz - az;
        const vx = cx - ax, vy = cy - ay, vz = cz - az;
        let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
        const len = Math.hypot(nx, ny, nz) || 1;
        nx /= len; ny /= len; nz /= len;

        dv.setFloat32(off, nx, true);
        dv.setFloat32(off + 4, ny, true);
        dv.setFloat32(off + 8, nz, true);
        off += 12;

        dv.setFloat32(off, ax, true);
        dv.setFloat32(off + 4, ay, true);
        dv.setFloat32(off + 8, az, true);
        off += 12;

        dv.setFloat32(off, bx, true);
        dv.setFloat32(off + 4, by, true);
        dv.setFloat32(off + 8, bz, true);
        off += 12;

        dv.setFloat32(off, cx, true);
        dv.setFloat32(off + 4, cy, true);
        dv.setFloat32(off + 8, cz, true);
        off += 12;

        dv.setUint16(off, 0, true);
        off += 2;
      }
    });

    return {
      buffer: buf,
      triangleCount: totalTris,
      isWatertight: check.watertight,
      badEdges: check.badEdges,
      orientationErrors: check.orientationErrors,
      check: check
    };
  }

  /* ------------------------------------------------------------------ */
  /* iOS AR Quick Look USDZ Exporter (True 0.001 Scale, 512x512 Bake)   */
  /* ------------------------------------------------------------------ */
  function bakeThermalGrid512(result, design) {
    const width = 512, height = 512;
    const buf = new Uint8Array(width * height * 4);
    const lo = design.amb;
    const hi = Math.max(result.peak, design.amb + 5);
    const gridN = result.nx || 32;

    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const gx = Math.min(gridN - 1, Math.floor((x / width) * gridN));
        const gz = Math.min(gridN - 1, Math.floor((y / height) * gridN));
        const val = result.grid ? result.grid[gz * gridN + gx] : lo;
        const col = T.tempColor(val, lo, hi);
        const idx = (y * width + x) * 4;
        buf[idx] = Math.round(col[0] * 255);
        buf[idx + 1] = Math.round(col[1] * 255);
        buf[idx + 2] = Math.round(col[2] * 255);
        buf[idx + 3] = 255;
      }
    }
    return { width: width, height: height, data: buf };
  }

  // Pure JS uncompressed PNG encoder for 512x512 RGBA
  function encodeRawPNG(rgbaData, width, height) {
    const CRC_TABLE = (function () {
      const t = new Uint32Array(256);
      for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
        t[n] = c >>> 0;
      }
      return t;
    })();
    function crc32(u8) {
      let c = 0xFFFFFFFF;
      for (let i = 0; i < u8.length; i++) c = CRC_TABLE[(c ^ u8[i]) & 0xFF] ^ (c >>> 8);
      return (c ^ 0xFFFFFFFF) >>> 0;
    }
    function adler32(u8) {
      let a = 1, b = 0;
      for (let i = 0; i < u8.length; i++) {
        a = (a + u8[i]) % 65521;
        b = (b + a) % 65521;
      }
      return ((b << 16) | a) >>> 0;
    }

    // Filter type 0 (None) for each scanline
    const lineLen = width * 4 + 1;
    const rawLen = lineLen * height;
    const raw = new Uint8Array(rawLen);
    for (let y = 0; y < height; y++) {
      raw[y * lineLen] = 0; // Filter: None
      raw.set(rgbaData.subarray(y * width * 4, (y + 1) * width * 4), y * lineLen + 1);
    }

    // Zlib stream (Deflate uncompressed blocks of max 65535 bytes)
    const blocks = Math.ceil(rawLen / 65535);
    const zlibLen = 2 + blocks * 5 + rawLen + 4;
    const zlib = new Uint8Array(zlibLen);
    zlib[0] = 0x78; zlib[1] = 0x01; // zlib header
    let zPos = 2;
    for (let b = 0; b < blocks; b++) {
      const isLast = b === blocks - 1;
      const bStart = b * 65535;
      const bLen = Math.min(65535, rawLen - bStart);
      zlib[zPos++] = isLast ? 1 : 0;
      zlib[zPos++] = bLen & 0xFF;
      zlib[zPos++] = (bLen >> 8) & 0xFF;
      const nLen = (~bLen) & 0xFFFF;
      zlib[zPos++] = nLen & 0xFF;
      zlib[zPos++] = (nLen >> 8) & 0xFF;
      zlib.set(raw.subarray(bStart, bStart + bLen), zPos);
      zPos += bLen;
    }
    const adl = adler32(raw);
    zlib[zPos++] = (adl >> 24) & 0xFF;
    zlib[zPos++] = (adl >> 16) & 0xFF;
    zlib[zPos++] = (adl >> 8) & 0xFF;
    zlib[zPos++] = adl & 0xFF;

    // Build PNG chunks: IHDR, IDAT, IEND
    function makeChunk(type, data) {
      const out = new Uint8Array(12 + data.length);
      const dv = new DataView(out.buffer);
      dv.setUint32(0, data.length, false);
      out[4] = type.charCodeAt(0); out[5] = type.charCodeAt(1);
      out[6] = type.charCodeAt(2); out[7] = type.charCodeAt(3);
      out.set(data, 8);
      const toCrc = out.subarray(4, 8 + data.length);
      dv.setUint32(8 + data.length, crc32(toCrc), false);
      return out;
    }

    const ihdr = new Uint8Array(13);
    const idv = new DataView(ihdr.buffer);
    idv.setUint32(0, width, false);
    idv.setUint32(4, height, false);
    ihdr[8] = 8; // 8 bit depth
    ihdr[9] = 6; // color type: RGBA
    ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;

    const cIHDR = makeChunk("IHDR", ihdr);
    const cIDAT = makeChunk("IDAT", zlib);
    const cIEND = makeChunk("IEND", new Uint8Array(0));

    const total = 8 + cIHDR.length + cIDAT.length + cIEND.length;
    const png = new Uint8Array(total);
    png.set([137, 80, 78, 71, 13, 10, 26, 10], 0); // PNG signature
    let p = 8;
    png.set(cIHDR, p); p += cIHDR.length;
    png.set(cIDAT, p); p += cIDAT.length;
    png.set(cIEND, p);
    return png;
  }

  function generateUSDZ(design, result) {
    const mesh = P.buildDesignMesh(design);
    const S3 = 0.001; // True 0.001 scale: mm to meters for iOS Quick Look
    const pts = [], uvs = [], nors = [], counts = [], inds = [];

    mesh.shells.forEach(s => {
      const pos = s.positions;
      const idx = s.indices;
      for (let t = 0; t < idx.length; t += 3) {
        const i0 = idx[t] * 3, i1 = idx[t + 1] * 3, i2 = idx[t + 2] * 3;
        const p0 = [pos[i0] * S3, pos[i0 + 1] * S3, pos[i0 + 2] * S3];
        const p1 = [pos[i1] * S3, pos[i1 + 1] * S3, pos[i1 + 2] * S3];
        const p2 = [pos[i2] * S3, pos[i2 + 1] * S3, pos[i2 + 2] * S3];

        const ux = p1[0] - p0[0], uy = p1[1] - p0[1], uz = p1[2] - p0[2];
        const vx = p2[0] - p0[0], vy = p2[1] - p0[1], vz = p2[2] - p0[2];
        let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
        const len = Math.hypot(nx, ny, nz) || 1;
        nx /= len; ny /= len; nz /= len;

        const tri = [p0, p1, p2];
        const originalTri = [
          [pos[i0], pos[i0 + 2]],
          [pos[i1], pos[i1 + 2]],
          [pos[i2], pos[i2 + 2]]
        ];

        tri.forEach((pt, k) => {
          pts.push(pt);
          nors.push([nx, ny, nz]);
          // UV mapped across width and depth
          const u = Math.min(1, Math.max(0, originalTri[k][0] / design.W + 0.5));
          const v = Math.min(1, Math.max(0, originalTri[k][1] / design.D + 0.5));
          uvs.push([u, v]);
          inds.push(inds.length);
        });
        counts.push(3);
      }
    });

    const f3 = v => "(" + v.map(n => n.toFixed(5)).join(", ") + ")";
    const usda =
'#usda 1.0\n(\n    defaultPrim = "Design"\n    metersPerUnit = 1\n    upAxis = "Y"\n)\n\n' +
'def Xform "Design"\n{\n    def Mesh "Body"\n    {\n' +
'        point3f[] points = [' + pts.map(f3).join(", ") + ']\n' +
'        int[] faceVertexCounts = [' + counts.join(", ") + ']\n' +
'        int[] faceVertexIndices = [' + inds.join(", ") + ']\n' +
'        float2[] primvars:st = [' + uvs.map(v => "(" + v[0].toFixed(4) + ", " + v[1].toFixed(4) + ")").join(", ") + '] (\n            interpolation = "vertex"\n        )\n' +
'        normal3f[] normals = [' + nors.map(f3).join(", ") + '] (\n            interpolation = "vertex"\n        )\n' +
'        uniform token subdivisionScheme = "none"\n' +
'        uniform bool doubleSided = 1\n' +
'        rel material:binding = </Design/Material>\n    }\n\n' +
'    def Material "Material"\n    {\n' +
'        token outputs:surface.connect = </Design/Material/Surface.outputs:surface>\n' +
'        def Shader "Surface"\n        {\n            uniform token info:id = "UsdPreviewSurface"\n' +
'            color3f inputs:diffuseColor.connect = </Design/Material/Texture.outputs:rgb>\n' +
'            float inputs:roughness = 0.5\n            float inputs:metallic = 0.1\n' +
'            token outputs:surface\n        }\n' +
'        def Shader "Texture"\n        {\n            uniform token info:id = "UsdUVTexture"\n' +
'            asset inputs:file = @thermal.png@\n' +
'            float2 inputs:st.connect = </Design/Material/Primvar.outputs:result>\n' +
'            float3 outputs:rgb\n        }\n' +
'        def Shader "Primvar"\n        {\n            uniform token info:id = "UsdPrimvarReader_float2"\n' +
'            string inputs:varname = "st"\n            float2 outputs:result\n        }\n' +
'    }\n}\n';

    const baked = bakeThermalGrid512(result, design);
    const pngBytes = encodeRawPNG(baked.data, baked.width, baked.height);

    // ZIP storage without compression (USDZ standard)
    const files = [
      { name: "design.usda", data: new TextEncoder().encode(usda) },
      { name: "thermal.png", data: pngBytes }
    ];

    const zipBytes = storeZip(files);
    return {
      usda: usda,
      png: pngBytes,
      zip: zipBytes,
      scale: S3,
      anchorHtml: '<a rel="ar" href="solidsay-design.usdz"><img src="solidsay-preview.png" alt="View in AR"></a>'
    };
  }

  function storeZip(files) {
    const enc = new TextEncoder();
    const parts = [], central = [];
    let offset = 0;
    const CRC_TABLE = (function () {
      const t = new Uint32Array(256);
      for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
        t[n] = c >>> 0;
      }
      return t;
    })();
    function crc32(u8) {
      let c = 0xFFFFFFFF;
      for (let i = 0; i < u8.length; i++) c = CRC_TABLE[(c ^ u8[i]) & 0xFF] ^ (c >>> 8);
      return (c ^ 0xFFFFFFFF) >>> 0;
    }

    files.forEach((f, fi) => {
      const nameB = enc.encode(f.name);
      const crc = crc32(f.data);
      let extraLen = 0;
      // 64-byte alignment for USDZ file contents
      if (fi === 0) {
        const rem = (30 + nameB.length) % 64;
        extraLen = rem === 0 ? 0 : 64 - rem;
      }
      const lh = new DataView(new ArrayBuffer(30));
      lh.setUint32(0, 0x04034b50, true);
      lh.setUint16(4, 20, true);
      lh.setUint32(14, crc, true);
      lh.setUint32(18, f.data.length, true);
      lh.setUint32(22, f.data.length, true);
      lh.setUint16(26, nameB.length, true);
      lh.setUint16(28, extraLen, true);

      parts.push(new Uint8Array(lh.buffer), nameB, new Uint8Array(extraLen), f.data);

      const ch = new DataView(new ArrayBuffer(46));
      ch.setUint32(0, 0x02014b50, true);
      ch.setUint16(4, 20, true);
      ch.setUint16(6, 20, true);
      ch.setUint32(16, crc, true);
      ch.setUint32(20, f.data.length, true);
      ch.setUint32(24, f.data.length, true);
      ch.setUint16(28, nameB.length, true);
      ch.setUint32(42, offset, true);

      central.push(new Uint8Array(ch.buffer), nameB);
      offset += 30 + nameB.length + extraLen + f.data.length;
    });

    let cenSize = 0;
    central.forEach(c => { cenSize += c.length; });
    const end = new DataView(new ArrayBuffer(22));
    end.setUint32(0, 0x06054b50, true);
    end.setUint16(8, files.length, true);
    end.setUint16(10, files.length, true);
    end.setUint32(12, cenSize, true);
    end.setUint32(16, offset, true);

    const all = parts.concat(central, [new Uint8Array(end.buffer)]);
    let total = 0;
    all.forEach(a => { total += a.length; });
    const out = new Uint8Array(total);
    let p = 0;
    all.forEach(a => { out.set(a, p); p += a.length; });
    return out;
  }

  function buildElectricalSummary(design, result, elecResult) {
    const d = (result && result.design) || design;
    const el = elecResult || (EL && EL.solveElectrical ? EL.solveElectrical(d, result) : null);
    if (!el) return null;
    const defaultDisclaimer = (EL && EL.DISCLAIMER) || "Fast DC resistive screener (2D nodal analysis on copper geometry, temperature-coupled +0.393%/°C) — not an Ansys SIwave / HyperLynx PDN sign-off tool.";
    if (!el.hasPowerDelivery) {
      return {
        hasPowerDelivery: false,
        copper: null,
        railV: null,
        status: el.status || "no power delivery in this part",
        message: el.message || "no power delivery in this part",
        disclaimer: el.disclaimer || defaultDisclaimer
      };
    }
    const irOver = !!(el.overModelLimit || (el.worstIrDropMv > el.railV * 1000));
    const irPctVal = +el.worstIrDropPct.toFixed(2);
    return {
      hasPowerDelivery: true,
      railV: el.railV,
      copper: {
        traceWidthMm: el.copper.traceWidthMm,
        copperOz: el.copper.copperOz,
        thicknessUm: el.copper.thicknessUm,
        thicknessMm: el.copper.thicknessMm,
        crossSectionMm2: el.copper.crossSectionMm2,
        layers: el.copper.layers,
        vias: el.copper.vias
      },
      worstIrDropMv: +el.worstIrDropMv.toFixed(2),
      worstIrDropPct: irOver ? 100 : irPctVal,
      worstIrDropPctDisplay: irOver ? ">100% of rail — model limit" : (irPctVal.toFixed(2) + "%"),
      worstIrDropDisplay: el.worstIrDropDisplay,
      worstCurrentDensityAmm2: +el.worstCurrentDensityAmm2.toFixed(2),
      worstCurrentDensityDisplay: el.worstCurrentDensityDisplay,
      localResidual: el.localResidual,
      irDropLimitPct: el.irDropLimitPct,
      currentDensityLimitAmm2: el.currentDensityLimitAmm2,
      overModelLimit: !!el.overModelLimit,
      pass: el.pass,
      status: el.status,
      disclaimer: el.disclaimer || defaultDisclaimer
    };
  }

  /* ------------------------------------------------------------------ */
  /* Compact Thermal Model (CTM-JSON) Exporter                          */
  /* ------------------------------------------------------------------ */
  function exportCTM(design, result, elecResult) {
    const net = result.network || T.resistanceNetwork(design, result);
    const d = result.design || design;
    const mat = P.MATERIALS[d.mat === "fr4" ? "aluminum" : d.mat];

    // Compute estimated thermal capacitance C = mass * cp (J/K)
    const mass = P.heatsinkBodyMassG(d); // grams
    const C_sink = (mass / 1000) * (mat.cp || 900); // J/K

    const nodes = [
      { id: "junction", type: "internal", power: net.sourcePower },
      { id: "case", type: "internal", power: 0 },
      { id: "base", type: "internal", capacitance: +(C_sink * 0.4).toFixed(3) },
      { id: "fins", type: "internal", capacitance: +(C_sink * 0.6).toFixed(3) },
      { id: "ambient", type: "boundary", temperature: d.amb }
    ];

    const resistors = [];
    net.stages.forEach(s => {
      let from = "junction", to = "case";
      if (s.id === "jc") { from = "junction"; to = "case"; }
      else if (s.id === "tim") { from = "case"; to = "base"; }
      else if (s.id === "spread") { from = "base"; to = "fins"; }
      else if (s.id === "conv") { from = "fins"; to = "ambient"; }
      resistors.push({
        id: "R_" + s.id,
        name: s.label,
        from: from,
        to: to,
        resistanceK_W: +s.R.toFixed(4),
        dT_C: +s.dT.toFixed(2),
        fractionPct: +(s.frac * 100).toFixed(1)
      });
    });

    const electricalSummary = buildElectricalSummary(d, result, elecResult);

    return {
      schema: "SolidSay-CTM-v1",
      generator: "SolidSay v3 Power-Integrity Engine",
      created: new Date().toISOString(),
      metadata: {
        designName: d.presetName || d.gen,
        generator: d.gen,
        material: mat.label,
        ambientC: d.amb,
        totalPowerW: net.power,
        peakTjC: +result.peak.toFixed(2),
        peakTjDisplay: T.formatPeakTj(result.peak),
        thetaJA_C_W: +result.thetaJA.toFixed(3),
        thermalLocalResidual: result.localResidual,
        electrical: electricalSummary
      },
      electrical: electricalSummary,
      nodes: nodes,
      resistors: resistors
    };
  }

  /* ------------------------------------------------------------------ */
  /* Gist Snapshot JSON Exporter                                        */
  /* ------------------------------------------------------------------ */
  function exportGistSnapshot(design, result, elecResult) {
    const d = (result && result.design) || design;
    const res = result || T.solveThermal(d);
    return {
      app: "SolidSay v3 Power-Integrity",
      timestamp: new Date().toISOString(),
      design: d,
      result: {
        peakTj: res.peak,
        peakTjDisplay: T.formatPeakTj(res.peak),
        thetaJA: res.thetaJA,
        converged: res.converged,
        localResidual: res.localResidual,
        electrical: buildElectricalSummary(d, res, elecResult)
      }
    };
  }

  /* ------------------------------------------------------------------ */
  /* PDF Regression Record Builder (jsPDF Integration)                  */
  /* ------------------------------------------------------------------ */
  function generatePDFReport(design, result, baselineResult, elecResult) {
    let jsPDFClass = null;
    if (typeof window !== "undefined" && window.jspdf && window.jspdf.jsPDF) {
      jsPDFClass = window.jspdf.jsPDF;
    } else if (typeof require !== "undefined") {
      try { jsPDFClass = require("./vendor/jspdf.umd.min.js").jsPDF; } catch (e) {
        try { jsPDFClass = require("../vendor/jspdf.umd.min.js").jsPDF; } catch (e2) {
          try { jsPDFClass = require("jspdf").jsPDF; } catch (e3) {}
        }
      }
    }

    if (!jsPDFClass) {
      // Return plain text fallback object if jsPDF is not loaded
      return { success: false, error: "jsPDF not loaded" };
    }

    const doc = new jsPDFClass({ orientation: "portrait", unit: "mm", format: "a4" });
    const d = result.design || design;
    const net = result.network || T.resistanceNetwork(d, result);
    const el = elecResult || (EL && EL.solveElectrical ? EL.solveElectrical(d, result) : null);

    // Title & Header
    doc.setFont("helvetica", "bold");
    doc.setFontSize(18);
    doc.text("SolidSay Thermal & Power-Integrity Audit Card", 20, 25);

    doc.setFont("helvetica", "normal");
    doc.setFontSize(10);
    doc.setTextColor(100);
    doc.text("Generated: " + new Date().toISOString() + " · 100% On-Device Compute", 20, 32);

    // Baseline vs. Current Box
    doc.setDrawColor(200);
    doc.setFillColor(248, 250, 252);
    doc.rect(20, 38, 170, 35, "FD");

    doc.setTextColor(20);
    doc.setFont("helvetica", "bold");
    doc.setFontSize(12);
    doc.text("Thermal Verification Summary", 25, 46);

    doc.setFont("helvetica", "normal");
    doc.setFontSize(10);
    doc.text("Design: " + (d.presetName || d.gen) + " (" + d.W + " × " + d.D + " mm, " + d.power + " W)", 25, 54);
    doc.text("Peak Junction (Tj): " + T.formatPeakTj(result.peak), 25, 60);
    doc.text("θJA (Junction → Ambient): " + result.thetaJA.toFixed(2) + " °C/W", 25, 66);

    if (baselineResult) {
      const deltaT = result.peak - baselineResult.peak;
      const overLimit = result.peak > T.TJ_MODEL_LIMIT_C || baselineResult.peak > T.TJ_MODEL_LIMIT_C;
      doc.setFont("helvetica", "bold");
      doc.text("Baseline ΔT: " + (deltaT >= 0 ? "+" : "") + deltaT.toFixed(1) + " °C vs. Previous" + (overLimit ? " (model-limit values)" : ""), 110, 60);
    }

    // Resistance Network Breakdown
    doc.setFont("helvetica", "bold");
    doc.setFontSize(12);
    doc.text("1D Thermal Resistance Network Stackup", 20, 85);

    let y = 94;
    doc.setFontSize(9);
    doc.setFont("helvetica", "bold");
    doc.text("Stage", 25, y);
    doc.text("Resistance (°C/W)", 100, y);
    doc.text("ΔT (°C)", 140, y);
    doc.text("Fraction", 165, y);
    y += 2;
    doc.line(20, y, 190, y);
    y += 6;

    doc.setFont("helvetica", "normal");
    net.stages.forEach(s => {
      doc.text(s.label, 25, y);
      doc.text(s.R.toFixed(4), 100, y);
      doc.text(s.dT.toFixed(1) + " °C", 140, y);
      doc.text((s.frac * 100).toFixed(1) + "%", 165, y);
      y += 6;
    });

    // Electrical Power-Integrity Screener Breakdown
    y += 6;
    doc.setFont("helvetica", "bold");
    doc.setFontSize(12);
    doc.text("2D DC Power-Integrity Screener (Temperature-Coupled)", 20, y);
    y += 7;
    doc.setFont("helvetica", "normal");
    doc.setFontSize(9);
    if (el && el.hasPowerDelivery) {
      doc.text("Rail: " + el.railV.toFixed(1) + " V · Copper: " + el.copper.copperOz + " oz (" + el.copper.thicknessUm + " µm), W = " + el.copper.traceWidthMm + " mm, " + el.copper.layers + "L, " + el.copper.vias + " vias", 25, y);
      y += 5;
      const irPctTxt = (el.worstIrDropMv > el.railV * 1000)
        ? ">100% of rail — model limit"
        : (el.worstIrDropPct.toFixed(2) + "% of " + el.railV.toFixed(1) + " V rail");
      doc.text("Worst IR Drop: " + el.worstIrDropDisplay + " (" + irPctTxt + "; threshold <= 5.0% = " + el.irDropLimitMv.toFixed(0) + " mV)", 25, y);
      y += 5;
      doc.text("Worst Current Density: " + el.worstCurrentDensityDisplay + " (A = " + el.copper.crossSectionMm2.toFixed(4) + " mm²; threshold <= 20.0 A/mm²)", 25, y);
      y += 5;
      doc.text("Scope: " + el.disclaimer, 25, y);
      y += 4;
    } else {
      doc.text("Power delivery: no power delivery in this part (copper: null).", 25, y);
      y += 4;
    }

    // Per-Design Local-Residual Verification Box
    y += 8;
    doc.setDrawColor(52, 211, 153);
    doc.setFillColor(236, 253, 245);
    doc.rect(20, y, 170, 28, "FD");

    doc.setTextColor(6, 95, 70);
    doc.setFont("helvetica", "bold");
    doc.setFontSize(11);
    doc.text("✓ Per-Design Local-Residual Verification", 25, y + 8);

    doc.setFont("helvetica", "normal");
    doc.setFontSize(9);
    // Cite the local PDE / KCL residuals for THIS design — the real convergence numbers.
    const lrPct = result.localResidual;
    const elLrTxt = (el && el.hasPowerDelivery && isFinite(el.localResidual))
      ? " · Electrical KCL local residual " + (el.localResidual * 100).toFixed(4) + "%"
      : "";
    doc.text(isFinite(lrPct)
      ? "Thermal FD local residual " + (lrPct * 100).toFixed(4) + "%" + elLrTxt
      : "No local-residual verification available for this design.", 25, y + 16);
    doc.text("100% deterministic on-device solve (" + (result.ms ? result.ms.toFixed(1) + " ms" : "local") + ").", 25, y + 22);

    // Footer
    doc.setTextColor(150);
    doc.setFontSize(8);
    doc.text("SolidSay v3 · Commercial Licensing: Free Maker ($0) · Indie ($49/mo) · Verified Report Pack ($99)", 20, 280);

    return {
      doc: doc,
      pdfBlob: doc.output("blob"),
      pdfArrayBuffer: doc.output("arraybuffer")
    };
  }

  /* ------------------------------------------------------------------ */
  /* Deterministic Enterprise Interface: window.SolidSayMCP            */
  /* ------------------------------------------------------------------ */
  function createSolidSayMCP(appState) {
    const currentProject = {
      version: "2.0.0",
      ambientRangeC: [20, 85],
      operatingModes: ["continuous", "peak"],
      deratingStandard: "MIL-HDBK-217F / IPC-9592B",
      maxTjLimitC: 105.0,
      targetUnitCostUSD: 15.0,
      requirementsList: [
        "Continuous junction temp Tj <= 80 °C under nominal ambient",
        "Peak burst temp Tj <= 105 °C under max ambient",
        "Watertight 2-manifold STL export",
        "Deterministic on-device thermal + electrical local-residual solve"
      ]
    };

    return {
      get_enterprise_project: function () {
        return JSON.parse(JSON.stringify(currentProject));
      },

      update_enterprise_project: function (params) {
        if (!params || typeof params !== "object") throw new Error("Invalid params object");
        const allowed = ["ambientRangeC", "operatingModes", "deratingStandard", "maxTjLimitC", "targetUnitCostUSD", "requirementsList"];
        allowed.forEach(k => {
          if (params[k] !== undefined) currentProject[k] = JSON.parse(JSON.stringify(params[k]));
        });
        return JSON.parse(JSON.stringify(currentProject));
      },

      run_thermal_gate: function (customDesign) {
        const d = customDesign || (appState && appState.design) || P.DESIGN_DEFAULTS;
        const res = T.solveThermal(d);
        const elRes = (EL && EL.solveElectrical) ? EL.solveElectrical(d, res) : null;
        const passMaxTj = res.peak <= currentProject.maxTjLimitC;
        const bom = P.estimateBomUSD(d);
        const passCost = bom.totalUSD <= currentProject.targetUnitCostUSD;
        // Residual gate uses the LOCAL residual (max-cell FD residual vs
        // total power) — the real convergence number.
        const passResidual = isFinite(res.localResidual) && res.localResidual <= 0.03;

        return {
          gatePassed: passMaxTj && passCost && passResidual,
          checks: {
            peakTj: { valueC: +res.peak.toFixed(1), limitC: currentProject.maxTjLimitC, pass: passMaxTj },
            unitCost: { valueUSD: +bom.totalUSD.toFixed(2), limitUSD: currentProject.targetUnitCostUSD, pass: passCost },
            localResidual: { valuePct: isFinite(res.localResidual) ? +(res.localResidual * 100).toFixed(3) : null, limitPct: 3.0, pass: passResidual }
          },
          design: d,
          result: {
            peakTj: res.peak,
            peakTjDisplay: T.formatPeakTj(res.peak),
            thetaJA: res.thetaJA,
            converged: res.converged,
            localResidual: res.localResidual,
            electrical: buildElectricalSummary(d, res, elRes)
          }
        };
      }
    };
  }

  return {
    VERSION: "2.0.0",
    tokenizeSExpr: tokenizeSExpr,
    parseSExprTokens: parseSExprTokens,
    parseKiCadPcb: parseKiCadPcb,
    exportSTL: exportSTL,
    generateUSDZ: generateUSDZ,
    bakeThermalGrid512: bakeThermalGrid512,
    encodeRawPNG: encodeRawPNG,
    storeZip: storeZip,
    exportCTM: exportCTM,
    exportGistSnapshot: exportGistSnapshot,
    generatePDFReport: generatePDFReport,
    createSolidSayMCP: createSolidSayMCP
  };
});
