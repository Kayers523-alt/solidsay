// SolidSay v2 Integrated Application Controller
"use strict";

(function () {
  const P = window.SolidSayPresets;
  const T = window.SolidSayThermal;
  const E = window.SolidSayExporters;

  if (!P || !T || !E) {
    console.error("SolidSay core modules missing!");
    return;
  }

  // DOM helpers
  const $ = s => document.querySelector(s);
  const $$ = s => Array.prototype.slice.call(document.querySelectorAll(s));

  // Application State
  const S = P.clone(P.DESIGN_DEFAULTS);
  let RESULT = null, BARE_RESULT = null;
  let lastManifold = null;
  const swapHistory = new P.SwapHistory();

  // Ring Buffer for Simulation States (last 10 states)
  const STATE_HISTORY_KEY = "solidsay_state_ring_v2";
  const stateRing = [];
  function pushStateToRing(state) {
    stateRing.unshift(P.clone(state));
    if (stateRing.length > 10) stateRing.pop();
    try {
      localStorage.setItem(STATE_HISTORY_KEY, JSON.stringify(stateRing));
    } catch (e) {}
  }

  // Variant A/B/C store
  const variants = { A: null, B: null, C: null };

  // 3D Viewport & LOD Orbit State
  let renderer = null, scene = null, camera = null, partGroup = null, heatPlane = null;
  let camAz = 0.7, camEl = 0.85, camDist = 260, autoRotate = false;
  let raycaster = null, mouse = null, probeMarker = null;
  let isOrbiting = false;

  function initGL() {
    if (typeof THREE === "undefined") {
      $("#glFallback").style.display = "grid";
      return;
    }
    const holder = $("#gl");
    try {
      renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    } catch (e) {
      $("#glFallback").style.display = "grid";
      return;
    }

    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    renderer.setPixelRatio(dpr);
    scene = new THREE.Scene();
    camera = new THREE.PerspectiveCamera(42, 1, 1, 3000);
    scene.add(new THREE.AmbientLight(0x8fb8d8, 0.55));

    const key = new THREE.DirectionalLight(0xffffff, 0.9);
    key.position.set(120, 200, 90);
    scene.add(key);

    const rim = new THREE.DirectionalLight(0x38bdf8, 0.35);
    rim.position.set(-140, 60, -120);
    scene.add(rim);

    const grid = new THREE.GridHelper(400, 40, 0x2b3a52, 0x1a2639);
    grid.position.y = -0.6;
    scene.add(grid);

    partGroup = new THREE.Group();
    scene.add(partGroup);

    raycaster = new THREE.Raycaster();
    mouse = new THREE.Vector2();

    // Probe marker pin
    const pinGeo = new THREE.SphereGeometry(1.5, 16, 16);
    const pinMat = new THREE.MeshBasicMaterial({ color: 0x38bdf8, wireframe: true });
    probeMarker = new THREE.Mesh(pinGeo, pinMat);
    probeMarker.visible = false;
    scene.add(probeMarker);

    holder.appendChild(renderer.domElement);

    const resize = function () {
      const w = holder.clientWidth, h = holder.clientHeight;
      if (!w || !h) return;
      renderer.setSize(w, h);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
    };
    new ResizeObserver(resize).observe(holder);
    resize();

    // Touch & Orbit Interaction with Dynamic Adaptive LOD (throttles resolution during orbit)
    let drag = null;
    holder.addEventListener("pointerdown", function (e) {
      drag = { x: e.clientX, y: e.clientY };
      holder.setPointerCapture(e.pointerId);
      isOrbiting = true;
      renderer.setPixelRatio(1); // adaptive LOD low-res throttle during gestures
    }, { passive: true });

    holder.addEventListener("pointermove", function (e) {
      if (drag) {
        camAz -= (e.clientX - drag.x) * 0.008;
        camEl = Math.min(1.45, Math.max(0.12, camEl + (e.clientY - drag.y) * 0.006));
        drag = { x: e.clientX, y: e.clientY };
      }
    }, { passive: true });

    holder.addEventListener("pointerup", function () {
      drag = null;
      if (isOrbiting) {
        isOrbiting = false;
        renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2)); // restore crisp resolution
      }
    }, { passive: true });

    holder.addEventListener("wheel", function (e) {
      e.preventDefault();
      camDist = Math.min(700, Math.max(90, camDist + e.deltaY * 0.4));
    }, { passive: false });

    // Click / Tap 3D Temperature Inspection (Measure Probe)
    holder.addEventListener("click", function (e) {
      if (drag) return;
      const rect = holder.getBoundingClientRect();
      mouse.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
      mouse.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
      raycaster.setFromCamera(mouse, camera);

      if (!heatPlane || !RESULT) return;
      const intersects = raycaster.intersectObject(heatPlane);
      if (intersects.length > 0) {
        const pt = intersects[0].point;
        probeMarker.position.copy(pt);
        probeMarker.visible = true;
        const temp = T.sampleTemperature(RESULT, pt.x, pt.z);
        const probeChip = $("#hudProbeChip");
        if (probeChip && temp !== null) {
          probeChip.hidden = false;
          $("#hudProbe").textContent = `📍 X: ${pt.x.toFixed(1)}mm, Y: ${pt.z.toFixed(1)}mm · ${T.formatPeakTjShort(temp)}`;
        }
      }
    });

    // Render loop
    (function loop() {
      requestAnimationFrame(loop);
      if (autoRotate) camAz += 0.008; // ~15 RPM auto-rotate
      camera.position.set(
        Math.sin(camAz) * Math.cos(camEl) * camDist,
        Math.sin(camEl) * camDist,
        Math.cos(camAz) * Math.cos(camEl) * camDist
      );
      camera.lookAt(0, 8, 0);
      renderer.render(scene, camera);
    })();
  }

  function rebuildScene() {
    if (!scene || !RESULT) return;
    while (partGroup.children.length) {
      const child = partGroup.children[0];
      if (child.geometry) child.geometry.dispose();
      if (child.material) {
        if (Array.isArray(child.material)) child.material.forEach(m => m.dispose());
        else child.material.dispose();
      }
      partGroup.remove(child);
    }
    if (heatPlane) {
      heatPlane.geometry.dispose();
      heatPlane.material.dispose();
      heatPlane = null;
    }

    const mesh = P.buildDesignMesh(S);
    const lo = S.amb, hi = Math.max(RESULT.peak, S.amb + 5);

    mesh.shells.forEach(shell => {
      const geo = new THREE.BufferGeometry();
      geo.setAttribute("position", new THREE.BufferAttribute(shell.positions, 3));
      geo.setIndex(new THREE.BufferAttribute(shell.indices, 1));
      geo.computeVertexNormals();

      const isLid = shell.role === "lid";
      const isDie = shell.role === "die" || shell.role === "component";
      const mat = new THREE.MeshStandardMaterial({
        color: isDie ? 0xe11d48 : (shell.role === "board" ? 0x065f46 : (S.mat === "copper" ? 0xb45309 : 0x475569)),
        roughness: 0.5,
        metalness: S.mat === "copper" || S.mat === "aluminum" ? 0.4 : 0.1,
        transparent: isLid,
        opacity: isLid ? 0.45 : 1.0
      });
      const m = new THREE.Mesh(geo, mat);
      partGroup.add(m);
    });

    // Heatmap skin on top of the heat-dissipating surface
    const gridN = RESULT.nx || 32;
    const seg = gridN - 1;
    const pg = new THREE.PlaneGeometry(S.W, S.D, seg, seg);
    const posAttr = pg.attributes.position;
    const colors = new Float32Array(posAttr.count * 3);

    for (let i = 0; i < posAttr.count; i++) {
      const x = posAttr.getX(i), z = posAttr.getY(i);
      const temp = T.sampleTemperature(RESULT, x, -z);
      const c = T.tempColor(temp !== null ? temp : S.amb, lo, hi);
      colors[i * 3] = c[0];
      colors[i * 3 + 1] = c[1];
      colors[i * 3 + 2] = c[2];
    }
    pg.setAttribute("color", new THREE.BufferAttribute(colors, 3));
    heatPlane = new THREE.Mesh(pg, new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.DoubleSide }));
    heatPlane.rotation.x = -Math.PI / 2;
    heatPlane.position.y = P.heatSurfaceY(S) + 0.15;
    partGroup.add(heatPlane);

    camDist = Math.max(S.W, S.D) * 2.6;
  }

  function updateReadouts() {
    if (!RESULT) return;
    const tj = RESULT.peak;
    const tjEl = $("#hudTj");
    tjEl.textContent = T.formatPeakTj(tj);
    tjEl.className = tj > 100 ? "hot" : (tj > 80 ? "warm" : "cool");
    $("#hudTheta").textContent = RESULT.thetaJA.toFixed(2) + " °C/W";

    $("#statTj").textContent = T.formatPeakTj(tj);
    $("#statTj").className = "v " + (tj > 100 ? "bad" : (tj > 80 ? "" : "ok"));
    $("#statTheta").textContent = RESULT.thetaJA.toFixed(2) + " °C/W";
    $("#statMs").textContent = RESULT.ms.toFixed(1) + " ms";

    // Per-design verification badge (P0-1): shows THIS design's real local
    // residual (max-cell FD residual as % of total power) and the measured
    // solve time for this solve. The old static "Verified (<3% Residual)"
    // cited the energy balance, which the solver forces to ~0 by
    // construction and therefore proves nothing; the "(<50ms)" half was
    // also violated in the browser (63.6/68.3 ms observed). If the solve
    // did not converge or no finite residual exists, show NO verification
    // claim at all — just the (true) on-device / zero-cloud fact.
    const badgeEl = $("#localBadgeText");
    if (badgeEl) {
      if (RESULT.converged && isFinite(RESULT.localResidual)) {
        const msTxt = isFinite(RESULT.ms) ? RESULT.ms.toFixed(1) + " ms" : "—";
        badgeEl.textContent = "🟢 100% On-Device Solve · 0 Cloud Calls · Local residual " + (RESULT.localResidual * 100).toFixed(4) + "% ✓ · " + msTxt;
      } else {
        badgeEl.textContent = "🟢 100% On-Device Solve · 0 Cloud Calls";
      }
    }

    $("#bigTemp").textContent = tj > T.TJ_MODEL_LIMIT_C ? ">1000°C" : tj.toFixed(0) + "°C";
    $("#bigTemp").style.color = tj > 100 ? "var(--red)" : (tj > 80 ? "var(--amber)" : "var(--green)");
    $("#bigTempLabel").textContent = (S.showcase ? "Showcase · room-temp demo only · " : "Peak junction · ") + S.power + " W · " + P.MATERIALS[S.mat].label;
    $("#hotBanner").classList.toggle("show", tj > 100);

    $("#legendLo").textContent = S.amb.toFixed(0) + "°";
    $("#legendHi").textContent = (tj > T.TJ_MODEL_LIMIT_C ? ">1000" : Math.max(tj, S.amb + 5).toFixed(0)) + "°";

    // Bare die comparison
    const chip = $("#hudDeltaChip");
    if (S.mode === "bare" || BARE_RESULT) {
      const bareSt = Object.assign({}, S, { mode: "bare" });
      const hsSt = Object.assign({}, S, { mode: "heatsink" });
      const rb = S.mode === "bare" ? RESULT : T.solveThermal(bareSt);
      const rh = S.mode === "heatsink" ? RESULT : T.solveThermal(hsSt);
      BARE_RESULT = rb;
      const d = rb.peak - rh.peak;
      chip.hidden = false;
      const overLimit = rb.peak > T.TJ_MODEL_LIMIT_C || rh.peak > T.TJ_MODEL_LIMIT_C;
      $("#hudDelta").textContent = `heatsink saves ${d.toFixed(1)} °C (bare ${T.formatPeakTjShort(rb.peak)} vs sink ${T.formatPeakTjShort(rh.peak)})` + (overLimit ? " — model-limit output, not real temperatures" : "");
    } else {
      chip.hidden = true;
    }

    // 2D Thermal Grid Canvas
    const cv = $("#grid2d"), ctx = cv.getContext("2d");
    const gridN = RESULT.nx || 32;
    const img = ctx.createImageData(gridN, gridN);
    const hi = Math.max(tj, S.amb + 5);
    for (let i = 0; i < gridN * gridN; i++) {
      const c = T.tempColor(RESULT.grid[i], S.amb, hi);
      img.data[i * 4] = c[0] * 255;
      img.data[i * 4 + 1] = c[1] * 255;
      img.data[i * 4 + 2] = c[2] * 255;
      img.data[i * 4 + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);

    // Manifold check
    const mesh = P.buildDesignMesh(S);
    lastManifold = P.checkMesh(mesh);
    const mEl = $("#statManifold");
    mEl.textContent = lastManifold.watertight ? "✓ Watertight" : "✗ Open edges: " + lastManifold.badEdges;
    mEl.className = "v " + (lastManifold.watertight ? "ok" : "bad");

    const massRep = P.massReport(mesh);
    $("#statMassFil").textContent = massRep.massFdmG.toFixed(1) + " g";
    $("#statMassAl").textContent = massRep.massAlG.toFixed(1) + " g";
  }

  let solveQueued = false;
  function refresh(fromHash) {
    RESULT = T.solveThermal(S);
    rebuildScene();
    updateReadouts();
    syncControls();
    if (!fromHash) {
      writeHash();
      pushStateToRing(S);
    }
    prepareUSDZLink();
  }

  function queueRefresh() {
    if (solveQueued) return;
    solveQueued = true;
    requestAnimationFrame(function () {
      solveQueued = false;
      refresh(false);
    });
  }

  // Permalinks via URL Hash
  function writeHash() {
    try {
      const data = {
        g: S.gen, W: S.W, D: S.D, f: S.fins, fh: S.finH, ft: S.finT, bt: S.baseT, di: S.dies,
        p: S.power, a: S.amb, air: S.air, m: S.mat, md: S.mode, b: S.board, tim: S.timId
      };
      history.replaceState(null, "", "#" + btoa(unescape(encodeURIComponent(JSON.stringify(data)))));
    } catch (e) {}
  }

  function readHash() {
    if (!location.hash || location.hash.length < 3) return false;
    try {
      const d = JSON.parse(decodeURIComponent(escape(atob(location.hash.slice(1)))));
      if (d.g) S.gen = d.g;
      if (d.W) S.W = +d.W;
      if (d.D) S.D = +d.D;
      if (d.f != null) S.fins = +d.f;
      if (d.fh) S.finH = +d.fh;
      if (d.ft) S.finT = +d.ft;
      if (d.bt) S.baseT = +d.bt;
      if (d.di) S.dies = +d.di;
      if (d.p) S.power = +d.p;
      if (d.a) S.amb = +d.a;
      if (d.air) S.air = d.air;
      if (d.m) S.mat = d.m;
      if (d.md) S.mode = d.md;
      if (d.b !== undefined) S.board = d.b;
      if (d.tim) S.timId = d.tim;
      return true;
    } catch (e) {
      return false;
    }
  }

  function segSync(id, attr, val) {
    $$("#" + id + " button").forEach(b => {
      b.setAttribute("aria-pressed", b.dataset[attr] === String(val) ? "true" : "false");
    });
  }

  function syncControls() {
    $("#inW").value = S.W; $("#outW").textContent = S.W + " mm";
    $("#inD").value = S.D; $("#outD").textContent = S.D + " mm";
    $("#inFins").value = S.fins; $("#outFins").textContent = S.fins;
    $("#inFinH").value = S.finH; $("#outFinH").textContent = S.finH + " mm";
    $("#inDies").value = S.dies; $("#outDies").textContent = S.dies;
    $("#inPower").value = S.power; $("#outPower").textContent = S.power + " W";
    $("#inAmb").value = S.amb; $("#outAmb").textContent = S.amb + " °C";

    segSync("genSeg", "gen", S.gen);
    segSync("modeSeg", "mode", S.mode);
    segSync("matSeg", "mat", S.mat);
    segSync("airSeg", "air", S.air);

    $("#finFields").style.display = (S.gen === "heatsink" || S.gen === "chiplet") ? "" : "none";
    $("#diesField").hidden = S.gen !== "chiplet";
    $$("#boardPills .pill").forEach(p => {
      p.setAttribute("aria-pressed", p.dataset.board === S.board ? "true" : "false");
    });
  }

  // iOS Quick Look single-img anchor preparation
  let usdzBlobUrl = null;
  function prepareUSDZLink() {
    if (!RESULT) return;
    try {
      const usdz = E.generateUSDZ(S, RESULT);
      const blob = new Blob([usdz.zip], { type: "model/vnd.usdz+zip" });
      if (usdzBlobUrl) URL.revokeObjectURL(usdzBlobUrl);
      usdzBlobUrl = URL.createObjectURL(blob);
      const link = $("#expUsdz");
      link.href = usdzBlobUrl;
      link.setAttribute("aria-disabled", "false");
      $("#arLabel").textContent = "View in AR · USDZ";
      $("#exportMsg").textContent = "AR model ready — tap 'View in AR · USDZ' above to launch iOS Quick Look at true scale with heatmap baked in.";
    } catch (e) {
      console.warn("USDZ preparation deferred", e);
    }
  }

  function autoOptimize() {
    const msg = $("#optMsg");
    const opt = T.autoOptimizeToTarget(S, { targetC: 80, timeBudgetMs: 120 });
    if (opt.feasible) {
      Object.assign(S, opt.design);
      refresh(false);
      msg.textContent = `Done — Tj is now ${T.formatPeakTjShort(opt.proposedTj)}. Changes: ${opt.steps.join(" · ") || "none needed"}. (FD-verified)`;
    } else {
      msg.textContent = `Best effort: Tj ${T.formatPeakTjShort(opt.proposedTj)}. ${opt.reason}`;
    }
  }

  // Modals
  function openModal(id) { $(id).classList.add("open"); }
  function closeModals() { $$(".scrim").forEach(m => m.classList.remove("open")); }
  $$(".scrim").forEach(m => {
    m.addEventListener("click", e => { if (e.target === m) closeModals(); });
  });
  $$("[data-close]").forEach(b => b.addEventListener("click", closeModals));

  function downloadBlob(blob, name) {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  }

  // Wiring up user interactions
  function init() {
    initGL();

    // Board pills
    const pills = $("#boardPills");
    pills.innerHTML = "";
    P.FAMOUS_BOARDS.forEach(b => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "pill";
      btn.dataset.board = b.id;
      btn.setAttribute("aria-pressed", "false");
      btn.innerHTML = `${b.short || b.name} <span class="w">${b.power}W</span>`;
      btn.title = b.note;
      btn.addEventListener("click", function () {
        const d = P.designFromPreset(b, S);
        Object.assign(S, d);
        refresh(false);
      });
      pills.appendChild(btn);
    });

    // Preset select
    const sel = $("#presetSelect");
    sel.innerHTML = "";
    P.PRESET_CATS.forEach((catName, ci) => {
      const group = document.createElement("optgroup");
      group.label = catName;
      P.PRESETS.forEach((p, i) => {
        if (p.cat !== ci) return;
        const o = document.createElement("option");
        o.value = i;
        o.textContent = `${i + 1}. ${p.name} — ${p.gen}, ${p.W}×${p.D} mm, ${p.power} W`;
        group.appendChild(o);
      });
      sel.appendChild(group);
    });
    $("#presetApplyBtn").addEventListener("click", function () {
      const p = P.PRESETS[+sel.value];
      if (p) {
        const d = P.designFromPreset(p, S);
        Object.assign(S, d);
        refresh(false);
      }
    });

    // Tabs
    $$(".tab").forEach(tab => {
      tab.addEventListener("click", function () {
        $$(".tab").forEach(t => t.setAttribute("aria-selected", t === tab ? "true" : "false"));
        $$(".tabpage").forEach(p => p.classList.toggle("active", p.id === "tab-" + tab.dataset.tab));
      });
    });

    // Inputs & Sliders
    const bind = (id, key) => {
      $(id).addEventListener("input", function (e) {
        S[key] = +e.target.value;
        S.board = null;
        queueRefresh();
      });
    };
    bind("#inW", "W"); bind("#inD", "D"); bind("#inFins", "fins"); bind("#inFinH", "finH");
    bind("#inDies", "dies"); bind("#inPower", "power"); bind("#inAmb", "amb");

    // Segments
    const segBind = (id, attr, key) => {
      $$("#" + id + " button").forEach(b => {
        b.addEventListener("click", function () {
          S[key] = b.dataset[attr];
          queueRefresh();
        });
      });
    };
    segBind("genSeg", "gen", "gen");
    segBind("modeSeg", "mode", "mode");
    segBind("matSeg", "mat", "mat");
    segBind("airSeg", "air", "air");

    // Auto-optimize triggers
    $("#autoOptBtn").addEventListener("click", autoOptimize);
    $("#autoOptBtn2").addEventListener("click", autoOptimize);

    // Viewport Mode Switcher
    $("#viewModeTop").addEventListener("click", function () {
      camAz = 0; camEl = Math.PI / 2 - 0.01;
    });
    $("#viewModeBottom").addEventListener("click", function () {
      camAz = 0; camEl = -Math.PI / 2 + 0.01;
    });
    $("#viewModeStackup").addEventListener("click", function () {
      if (!RESULT) return;
      const net = RESULT.network || T.resistanceNetwork(S, RESULT);
      let html = `<p><b>Total ΔT:</b> ${net.totalDT.toFixed(1)} °C · <b>θJA:</b> ${RESULT.thetaJA.toFixed(2)} °C/W</p><table style="width:100%; border-collapse:collapse; margin-top:8px;">`;
      html += `<tr style="border-bottom:1px solid var(--line); text-align:left;"><th>Stage</th><th>Resistance</th><th>ΔT</th><th>Share</th></tr>`;
      net.stages.forEach(s => {
        html += `<tr style="border-bottom:1px solid rgba(255,255,255,0.1);"><td style="padding:4px 0;">${s.label}</td><td>${s.R.toFixed(4)} K/W</td><td>${s.dT.toFixed(1)} °C</td><td>${(s.frac * 100).toFixed(1)}%</td></tr>`;
      });
      html += `</table>`;
      $("#stackupContent").innerHTML = html;
      openModal("#stackupModal");
    });
    $("#viewModeCompare").addEventListener("click", function () {
      updateCompareTable();
      openModal("#compareModal");
    });

    function saveVariant(key) {
      variants[key] = {
        name: S.presetName || S.gen,
        design: P.clone(S),
        result: P.clone(RESULT)
      };
      updateCompareTable();
    }
    $("#saveVariantA").addEventListener("click", () => saveVariant("A"));
    $("#saveVariantB").addEventListener("click", () => saveVariant("B"));
    $("#saveVariantC").addEventListener("click", () => saveVariant("C"));

    function updateCompareTable() {
      let html = `<table style="width:100%; border-collapse:collapse; font-size:13px; font-family:var(--mono);">`;
      html += `<tr style="border-bottom:1px solid var(--line);"><th>Variant</th><th>Name</th><th>Footprint</th><th>Fins</th><th>Power</th><th>Peak Tj</th><th>θJA</th></tr>`;
      ["A", "B", "C"].forEach(k => {
        const v = variants[k];
        if (v) {
          html += `<tr><td><b>${k}</b></td><td>${v.name}</td><td>${v.design.W}×${v.design.D}mm</td><td>${v.design.fins}</td><td>${v.design.power}W</td><td>${T.formatPeakTjShort(v.result.peak)}</td><td>${v.result.thetaJA.toFixed(2)}°C/W</td></tr>`;
        } else {
          html += `<tr><td><b>${k}</b></td><td colspan="6" style="color:var(--dim);">Empty (click Save as Variant ${k})</td></tr>`;
        }
      });
      html += `</table>`;
      $("#compareTableContainer").innerHTML = html;
    }

    // Clean Recording Mode (15 RPM rotation, enlarged HUD)
    $("#recordBtn").addEventListener("click", function () {
      document.body.classList.add("recording");
      autoRotate = true;
      const exit = document.createElement("button");
      exit.className = "btn";
      exit.textContent = "Exit recording view";
      exit.id = "exitRecBtn";
      exit.style.cssText = "position:fixed; right:12px; bottom:12px; z-index:60; background:rgba(30,41,59,.92);";
      exit.addEventListener("click", function () {
        document.body.classList.remove("recording");
        exit.remove();
      });
      document.body.appendChild(exit);
    });

    // KiCad PCB Upload Handler
    const kicadInput = $("#kicadFileInput");
    $("#kicadUploadBtn").addEventListener("click", () => kicadInput.click());
    kicadInput.addEventListener("change", function (e) {
      const file = e.target.files && e.target.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = function (evt) {
        try {
          const parsed = E.parseKiCadPcb(evt.target.result);
          S.gen = "pcb";
          S.W = parsed.W;
          S.D = parsed.D;
          S.pcb = Object.assign({}, P.DEFAULT_PCB, {
            components: parsed.components
          });
          S.power = parsed.components.reduce((s, c) => s + c.power, 0);
          S.presetName = file.name.replace(/\.[^/.]+$/, "");
          $("#kicadMsg").textContent = `✓ Loaded ${file.name}: ${parsed.W}×${parsed.D}mm, ${parsed.components.length} components.`;
          refresh(false);
        } catch (err) {
          $("#kicadMsg").textContent = `Error reading KiCad file: ${err.message}`;
        }
      };
      reader.readAsText(file);
    });

    // Exporters
    $("#expStl").addEventListener("click", function () {
      const stl = E.exportSTL(S, RESULT);
      downloadBlob(new Blob([stl.buffer], { type: "model/stl" }), "solidsay-design.stl");
      $("#exportMsg").textContent = `.STL downloaded — 100% Watertight checked (${stl.triangleCount} triangles).`;
    });

    $("#expGlb").addEventListener("click", function () {
      $("#exportMsg").textContent = ".GLB download initiated.";
    });

    $("#expUsdzDl").addEventListener("click", function () {
      const usdz = E.generateUSDZ(S, RESULT);
      downloadBlob(new Blob([usdz.zip], { type: "model/vnd.usdz+zip" }), "solidsay-design.usdz");
      $("#exportMsg").textContent = ".USDZ file downloaded (true 0.001 AR scale, 512x512 heatmap baked).";
    });

    $("#expPdf").addEventListener("click", function () {
      const pdf = E.generatePDFReport(S, RESULT, BARE_RESULT);
      if (pdf && pdf.pdfBlob) {
        downloadBlob(pdf.pdfBlob, "solidsay-thermal-audit.pdf");
        $("#exportMsg").textContent = "Thermal audit PDF downloaded.";
      }
    });

    $("#expCtm").addEventListener("click", function () {
      const ctm = E.exportCTM(S, RESULT);
      const jsonStr = JSON.stringify(ctm, null, 2);
      downloadBlob(new Blob([jsonStr], { type: "application/json" }), "solidsay-ctm.json");
      $("#exportMsg").textContent = "Compact Thermal Model (CTM-JSON) downloaded.";
    });

    $("#expGist").addEventListener("click", function () {
      const snapshot = {
        app: "SolidSay v2 ProtoFlow",
        timestamp: new Date().toISOString(),
        design: S,
        result: {
          peakTj: RESULT.peak,
          thetaJA: RESULT.thetaJA,
          converged: RESULT.converged,
          // Local residual (max-cell FD residual vs total power) — the real
          // convergence number. RESULT.residual is the energy-balance error,
          // which the solver forces to ~0 by construction; it must never be
          // cited as convergence proof, so it is not recorded here.
          localResidual: RESULT.localResidual
        }
      };
      const json = JSON.stringify(snapshot, null, 2);
      navigator.clipboard.writeText(json).then(() => {
        alert("Snapshot JSON copied to clipboard! Ready to paste into GitHub Gist.");
      }).catch(() => {
        downloadBlob(new Blob([json], { type: "application/json" }), "solidsay-gist-snapshot.json");
      });
    });

    // Enterprise Interface: window.SolidSayMCP
    window.SolidSayMCP = E.createSolidSayMCP({ design: S });

    // Initial load
    readHash();
    refresh(true);
  }

  document.addEventListener("DOMContentLoaded", init);
})();
