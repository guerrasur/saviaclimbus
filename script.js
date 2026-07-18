(() => {
  "use strict";

  const SAVE_KEY = "climbus_save_v1";
  const TICK_MS = 200;

  const UPGRADE_DEFS = {
    colonia: {
      name: "Colonia",
      desc: "Nuevas hormigas se suman al hormiguero. Aumenta la generación pasiva.",
      baseCost: 10,
      costMult: 1.15,
      effectLabel: (lvl) => `+${(lvl * 0.8).toFixed(1)} hormigas/s`,
      locked: () => false,
    },
    nudo: {
      name: "Nudo reforzado",
      desc: "Refuerza los apoyos en la corteza. Podés cargar el salto más tiempo antes de pasarte.",
      baseCost: 15,
      costMult: 1.22,
      effectLabel: (lvl) => `+${(lvl * 0.22).toFixed(2)}s de carga segura`,
      locked: () => false,
    },
    impulso: {
      name: "Impulso de zancada",
      desc: "Cada paso avanza más corteza. Multiplica la altura de cada salto.",
      baseCost: 40,
      costMult: 1.18,
      effectLabel: (lvl) => `x${(1 + lvl * 0.35).toFixed(2)} altura por salto`,
      locked: (state) => !state.sapUnlocks.impulso,
    },
    enjambre: {
      name: "Enjambre",
      desc: "El hormiguero se multiplica. Multiplica toda la generación de hormigas.",
      baseCost: 500,
      costMult: 1.25,
      effectLabel: (lvl) => `x${Math.pow(1.12, lvl).toFixed(2)} hormigas/s`,
      locked: (state) => !state.sapUnlocks.enjambre,
    },
  };

  const SAP_THRESHOLDS = [
    {
      id: "impulso",
      threshold: 10,
      name: "Impulso de zancada",
      desc: "Desbloquea la mejora Impulso de zancada: cada toque exitoso avanza más altura.",
    },
    {
      id: "percepcion",
      threshold: 50,
      name: "Percepción del viento",
      desc: "Aprendés a leer el viento antes de moverte. Extiende el tiempo que podés mantenerte agarrado sin riesgo.",
    },
    {
      id: "enjambre",
      threshold: 150,
      name: "Enjambre",
      desc: "Desbloquea la mejora Enjambre: multiplica toda tu generación de hormigas.",
    },
    {
      id: "agarre",
      threshold: 400,
      name: "Agarre de savia",
      desc: "La savia impregna tus manos. Reduce a la mitad lo que retrocedés si te excedés sosteniendo el agarre.",
    },
  ];

  function defaultState() {
    return {
      version: 1,
      ants: 0,
      sap: 0,
      height: 0,
      heightRecord: 0,
      upgrades: { colonia: 0, nudo: 0, impulso: 0, enjambre: 0 },
      sapUnlocks: { impulso: false, percepcion: false, enjambre: false, agarre: false },
      sapNotified: { impulso: false, percepcion: false, enjambre: false, agarre: false },
    };
  }

  function loadState() {
    try {
      const raw = localStorage.getItem(SAVE_KEY);
      if (!raw) return defaultState();
      const parsed = JSON.parse(raw);
      const base = defaultState();
      return {
        ...base,
        ...parsed,
        upgrades: { ...base.upgrades, ...(parsed.upgrades || {}) },
        sapUnlocks: { ...base.sapUnlocks, ...(parsed.sapUnlocks || {}) },
        sapNotified: { ...base.sapNotified, ...(parsed.sapNotified || {}) },
      };
    } catch (e) {
      return defaultState();
    }
  }

  let state = loadState();

  // Merge with whatever is currently on disk before writing, taking the
  // higher value for anything that should only ever grow. Without this,
  // a second tab (or a save written while this tab was in the background)
  // gets silently clobbered by this tab's own autosave/beforeunload.
  function saveState() {
    try {
      const raw = localStorage.getItem(SAVE_KEY);
      if (raw) {
        const other = JSON.parse(raw);
        state.ants = Math.max(state.ants, other.ants || 0);
        state.sap = Math.max(state.sap, other.sap || 0);
        // height (current climb position) is intentionally NOT merged —
        // it can legitimately decrease (slip/overextension), so this
        // tab's own value is authoritative. Only the record is monotonic.
        state.heightRecord = Math.max(state.heightRecord, other.heightRecord || 0);
        if (other.upgrades) {
          Object.keys(state.upgrades).forEach((k) => {
            state.upgrades[k] = Math.max(state.upgrades[k], other.upgrades[k] || 0);
          });
        }
        if (other.sapUnlocks) {
          Object.keys(state.sapUnlocks).forEach((k) => {
            state.sapUnlocks[k] = state.sapUnlocks[k] || !!other.sapUnlocks[k];
          });
        }
        if (other.sapNotified) {
          Object.keys(state.sapNotified).forEach((k) => {
            state.sapNotified[k] = state.sapNotified[k] || !!other.sapNotified[k];
          });
        }
      }
    } catch (e) {
      // Corrupt save on disk — just write what we have in memory.
    }
    localStorage.setItem(SAVE_KEY, JSON.stringify(state));
  }

  // ---------- Derived values ----------

  function antsPerSecond() {
    const base = 0.6 + state.upgrades.colonia * 0.8;
    const mult = Math.pow(1.12, state.upgrades.enjambre);
    return base * mult;
  }

  function sapPerSecond() {
    return 0.05 + Math.floor(state.heightRecord / 100) * 0.01;
  }

  function climbPower() {
    return 1 + state.upgrades.impulso * 0.35;
  }

  // Charge-and-release climbing: nothing happens while the button is held
  // down except a charge meter filling up. The jump itself only happens
  // on release, and its length scales with how long you charged — up to
  // a cap. Charge past that cap and releasing costs you height instead
  // of gaining it. No randomness, no movement during the hold itself.
  const MIN_HOP = 1.6; // jump length at an instant tap/release (scaled by climbPower)
  const MAX_HOP = 9; // jump length at a full, uncapped charge (scaled by climbPower)
  const BASE_MAX_CHARGE_MS = 1100; // hold time to reach a full charge
  const OVERCHARGE_WINDOW_MS = 900; // extra hold time to reach max retreat penalty
  const MAX_OVERCHARGE_RETREAT = 5; // retreat at max overcharge (scaled by climbPower)

  function maxChargeMs() {
    let ms = BASE_MAX_CHARGE_MS + state.upgrades.nudo * 220;
    if (state.sapUnlocks.percepcion) ms += 300;
    return ms;
  }

  function retreatMultiplier() {
    return state.sapUnlocks.agarre ? 0.5 : 1;
  }

  function upgradeCost(id) {
    const def = UPGRADE_DEFS[id];
    const lvl = state.upgrades[id];
    return Math.ceil(def.baseCost * Math.pow(def.costMult, lvl));
  }

  // ---------- DOM refs ----------

  const $ = (id) => document.getElementById(id);
  const antsValue = $("antsValue");
  const antsRate = $("antsRate");
  const sapValue = $("sapValue");
  const sapRate = $("sapRate");
  const heightValue = $("heightValue");
  const heightRecordValue = $("heightRecordValue");
  const gripHudValue = $("gripHudValue");
  const gripFill = $("gripFill");
  const climbBtn = $("climbBtn");
  const climbZone = $("climbZone");
  const climber = $("climber");
  const stage = $("stage");
  const barkLayer = $("barkLayer");
  const slipFlash = $("slipFlash");
  const toast = $("toast");
  const upgradeList = $("upgradeList");
  const sapList = $("sapList");
  const veinsGroup = $("veinsGroup");
  const veinsSvg = $("veinsSvg");
  const antsAmbient = $("antsAmbient");
  const tabs = $("tabs");
  const panelMejoras = $("panel-mejoras");
  const panelSavia = $("panel-savia");
  const saviaBadge = $("saviaBadge");

  function fmt(n, decimals = 0) {
    if (n >= 1000000) return (n / 1000000).toFixed(2) + "M";
    if (n >= 10000) return (n / 1000).toFixed(1) + "k";
    return n.toFixed(decimals);
  }

  // ---------- Ambient background: sap veins ----------

  // One tile's worth of veins, meant to repeat seamlessly every
  // VEIN_TILE_HEIGHT viewBox units so the pattern can scroll forever.
  const VEIN_TILE_HEIGHT = 700;
  const VEIN_PATHS = [
    "M 40 700 C 60 600 20 520 50 440 C 80 360 30 300 60 220 C 90 140 50 80 70 0",
    "M 200 700 C 220 640 180 560 210 480 C 240 400 190 340 220 260 C 250 180 210 100 230 0",
    "M 340 700 C 320 620 360 540 330 460 C 300 380 350 320 320 240 C 290 160 330 90 310 0",
    "M 120 700 C 140 660 100 600 130 540 C 160 480 110 420 140 360",
    "M 280 700 C 260 650 300 590 270 530 C 240 470 280 410 250 350",
  ];

  function buildVeins() {
    veinsGroup.innerHTML = "";
    const unlockedCount = Object.values(state.sapUnlocks).filter(Boolean).length;
    const visibleCount = Math.min(VEIN_PATHS.length, 2 + unlockedCount);
    // Stack three copies of the tile (above, current, below) so panning
    // the viewBox within one tile height always shows continuous veins.
    [-1, 0, 1].forEach((tileOffset) => {
      const g = document.createElementNS("http://www.w3.org/2000/svg", "g");
      g.setAttribute("transform", `translate(0, ${tileOffset * VEIN_TILE_HEIGHT})`);
      for (let i = 0; i < visibleCount; i++) {
        const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
        path.setAttribute("d", VEIN_PATHS[i]);
        path.style.animationDelay = `${i * 0.7}s`;
        g.appendChild(path);
      }
      veinsGroup.appendChild(g);
    });
  }

  // ---------- Ambient ants ----------

  function spawnAmbientAnts() {
    antsAmbient.innerHTML = "";
    const count = Math.min(12, 4 + state.upgrades.colonia);
    for (let i = 0; i < count; i++) {
      const el = document.createElement("div");
      const goingRight = Math.random() > 0.5;
      el.className = "ant-sprite";
      const top = 10 + Math.random() * 75;
      const duration = 5 + Math.random() * 5;
      const delay = Math.random() * 6;
      el.style.top = top + "%";
      if (goingRight) {
        el.style.left = "-16px";
      } else {
        el.style.right = "-16px";
      }
      el.style.animationName = goingRight ? "antWalkRight" : "antWalkLeft";
      el.style.animationDuration = duration + "s";
      el.style.animationDelay = delay + "s";
      antsAmbient.appendChild(el);
    }
  }

  // Ants scurry, not glide: horizontal travel plus small irregular
  // vertical bobbing, so they read as little creatures, not a line
  // sweeping across the screen.
  const styleSheet = document.createElement("style");
  styleSheet.textContent = `
    @keyframes antWalkRight {
      0% { transform: translate(0, 0); opacity: 0; }
      4% { opacity: 0.95; }
      20% { transform: translate(22vw, -4px); }
      40% { transform: translate(45vw, 3px); }
      60% { transform: translate(65vw, -3px); }
      80% { transform: translate(85vw, 2px); }
      96% { opacity: 0.95; }
      100% { transform: translate(108vw, 0); opacity: 0; }
    }
    @keyframes antWalkLeft {
      0% { transform: translate(0, 0) scaleX(-1); opacity: 0; }
      4% { opacity: 0.95; }
      20% { transform: translate(-22vw, 3px) scaleX(-1); }
      40% { transform: translate(-45vw, -3px) scaleX(-1); }
      60% { transform: translate(-65vw, 2px) scaleX(-1); }
      80% { transform: translate(-85vw, -2px) scaleX(-1); }
      96% { opacity: 0.95; }
      100% { transform: translate(-108vw, 0) scaleX(-1); opacity: 0; }
    }
  `;
  document.head.appendChild(styleSheet);

  // ---------- Parallax (bark grain + sap veins) ----------

  // How far the world visibly scrolls per cm climbed. This is deliberately
  // much bigger than 1:1 so climbing reads as real motion rather than a
  // number ticking up behind a static painting.
  const BARK_SCROLL_PX_PER_CM = 11;
  const VEIN_SCROLL_UNITS_PER_CM = 13;

  function updateParallax() {
    // Shift the seamless diagonal grain (::before) via CSS var — unbounded
    // is fine, no jump no matter how high the climb gets.
    barkLayer.style.setProperty("--bark-shift", `${state.height * BARK_SCROLL_PX_PER_CM}px`);

    // Pan the veins viewBox within one tile height; the 3 stacked copies
    // (see buildVeins) make the wrap at the tile boundary seamless.
    const veinY = (state.height * VEIN_SCROLL_UNITS_PER_CM) % VEIN_TILE_HEIGHT;
    veinsSvg.setAttribute("viewBox", `0 ${veinY} 400 700`);
  }

  // ---------- Toast / feedback ----------

  function showToast(msg, kind) {
    toast.textContent = msg;
    toast.style.borderColor = kind === "slip" ? "var(--bermellon)" : "var(--ambar)";
    toast.classList.remove("show");
    void toast.offsetWidth;
    toast.classList.add("show");
  }

  function flashSlip() {
    slipFlash.classList.remove("active");
    void slipFlash.offsetWidth;
    slipFlash.classList.add("active");
    stage.classList.remove("shake");
    void stage.offsetWidth;
    stage.classList.add("shake");
  }

  // ---------- Climb action ----------

  function announceRecordIfCrossed(prevRecord) {
    if (Math.floor(state.heightRecord / 100) > Math.floor(prevRecord / 100)) {
      showToast(`Nuevo récord: ${Math.floor(state.heightRecord)} cm`, "record");
    }
  }

  let press = null; // { startTime, rafId }

  function updateChargeMeter(holdDuration, cap) {
    const pct = Math.min(100, (holdDuration / cap) * 100);
    gripHudValue.textContent = Math.round(pct);
    gripFill.style.width = pct + "%";
    const overcharged = holdDuration > cap;
    gripFill.classList.toggle("danger", overcharged);
    gripFill.classList.toggle("low", !overcharged && pct > 65);
    gripHudValue.classList.toggle("low", overcharged);
    climbBtn.classList.toggle("danger", overcharged);
  }

  function resetChargeMeter() {
    gripHudValue.textContent = "0";
    gripFill.style.width = "0%";
    gripFill.classList.remove("danger", "low");
    gripHudValue.classList.remove("low");
    climbBtn.classList.remove("danger");
  }

  // While held, only the charge meter updates — nothing moves yet.
  function stepCharge() {
    if (!press) return;
    const holdDuration = performance.now() - press.startTime;
    const cap = maxChargeMs();
    updateChargeMeter(holdDuration, cap);
    climber.classList.toggle("charging", holdDuration <= cap);
    climber.classList.toggle("overextended", holdDuration > cap);
    press.rafId = requestAnimationFrame(stepCharge);
  }

  // The jump (or fumble) resolves once, on release.
  function resolvePress(holdDuration) {
    const cap = maxChargeMs();

    if (holdDuration <= cap) {
      const chargeRatio = cap > 0 ? holdDuration / cap : 1;
      const gain = (MIN_HOP + chargeRatio * (MAX_HOP - MIN_HOP)) * climbPower();
      const prevRecord = state.heightRecord;
      state.height += gain;
      if (state.height > state.heightRecord) state.heightRecord = state.height;
      announceRecordIfCrossed(prevRecord);

      climber.classList.remove("slipping", "overextended", "charging");
      climber.classList.add("climbing");
      setTimeout(() => climber.classList.remove("climbing"), 300);
    } else {
      const overMs = Math.min(OVERCHARGE_WINDOW_MS, holdDuration - cap);
      const overRatio = overMs / OVERCHARGE_WINDOW_MS;
      const loss = overRatio * MAX_OVERCHARGE_RETREAT * climbPower() * retreatMultiplier();
      state.height = Math.max(0, state.height - loss);

      climber.classList.remove("climbing", "charging", "overextended");
      climber.classList.add("slipping");
      setTimeout(() => climber.classList.remove("slipping"), 500);
      flashSlip();
      if (navigator.vibrate) navigator.vibrate(60);
      showToast(`¡Te pasaste! Resbalás -${loss.toFixed(0)} cm`, "slip");
    }

    updateParallax();
    renderStats();
    resetChargeMeter();
    saveState();
  }

  function onPressStart(e) {
    e.preventDefault();
    if (press) return;
    press = { startTime: performance.now(), rafId: null };
    if (climbBtn.setPointerCapture && e.pointerId !== undefined) {
      try { climbBtn.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
    }
    press.rafId = requestAnimationFrame(stepCharge);
  }

  function onPressEnd() {
    if (!press) return;
    cancelAnimationFrame(press.rafId);
    const holdDuration = performance.now() - press.startTime;
    press = null;
    resolvePress(holdDuration);
  }

  climbBtn.addEventListener("pointerdown", onPressStart);
  climbBtn.addEventListener("pointerup", onPressEnd);
  climbBtn.addEventListener("pointercancel", onPressEnd);
  climbBtn.addEventListener("pointerleave", (e) => {
    // Only end the press if the pointer actually left without a capture
    // (touch devices keep capture on the button; mouse can drag off it).
    if (press && e.pointerType === "mouse") onPressEnd();
  });
  climbBtn.addEventListener("contextmenu", (e) => e.preventDefault());
  climbBtn.addEventListener("selectstart", (e) => e.preventDefault());
  climbBtn.addEventListener("dragstart", (e) => e.preventDefault());

  let keyHeld = false;
  document.addEventListener("keydown", (e) => {
    if (e.code !== "Space" && e.code !== "ArrowUp") return;
    e.preventDefault();
    if (e.repeat) return;
    if (keyHeld) return;
    keyHeld = true;
    onPressStart({ preventDefault() {} });
  });
  document.addEventListener("keyup", (e) => {
    if (e.code !== "Space" && e.code !== "ArrowUp") return;
    keyHeld = false;
    onPressEnd();
  });

  // ---------- Rendering ----------

  function renderStats() {
    antsValue.textContent = fmt(Math.floor(state.ants));
    antsRate.textContent = `+${antsPerSecond().toFixed(1)}/s`;
    sapValue.textContent = fmt(state.sap, 1);
    sapRate.textContent = `+${sapPerSecond().toFixed(2)}/s`;
    heightValue.textContent = fmt(Math.floor(state.height));
    heightRecordValue.textContent = fmt(Math.floor(state.heightRecord));
  }

  function renderUpgrades() {
    upgradeList.innerHTML = "";
    Object.keys(UPGRADE_DEFS).forEach((id) => {
      const def = UPGRADE_DEFS[id];
      const locked = def.locked(state);
      const lvl = state.upgrades[id];
      const cost = upgradeCost(id);

      const card = document.createElement("div");
      card.className = "upgrade-card" + (locked ? " locked" : "");

      if (locked) {
        card.innerHTML = `
          <div class="upgrade-card__head">
            <span class="upgrade-card__name">🔒 ${def.name}</span>
          </div>
          <div class="upgrade-card__desc">Se desbloquea acumulando savia.</div>
        `;
      } else {
        card.innerHTML = `
          <div class="upgrade-card__head">
            <span class="upgrade-card__name">${def.name}</span>
            <span class="upgrade-card__level">nivel ${lvl}</span>
          </div>
          <div class="upgrade-card__desc">${def.desc}</div>
          <div class="upgrade-card__row">
            <span class="upgrade-card__effect">${def.effectLabel(lvl)}</span>
            <button class="buy-btn" data-upgrade="${id}" ${state.ants < cost ? "disabled" : ""}>
              ${cost} 🐜
            </button>
          </div>
        `;
      }
      upgradeList.appendChild(card);
    });

    upgradeList.querySelectorAll(".buy-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        const id = btn.getAttribute("data-upgrade");
        buyUpgrade(id);
      });
    });
  }

  function buyUpgrade(id) {
    const cost = upgradeCost(id);
    if (state.ants < cost) return;
    state.ants -= cost;
    state.upgrades[id]++;
    if (id === "colonia") spawnAmbientAnts();
    renderStats();
    renderUpgrades();
    saveState();
  }

  function renderSap() {
    sapList.innerHTML = "";
    SAP_THRESHOLDS.forEach((t) => {
      const unlocked = state.sapUnlocks[t.id];
      const claimable = !unlocked && state.sap >= t.threshold;
      const progress = Math.min(100, (state.sap / t.threshold) * 100);

      const card = document.createElement("div");
      card.className = "sap-card" + (unlocked ? " unlocked" : claimable ? " claimable" : " locked");
      card.innerHTML = `
        <div class="sap-card__head">
          <span class="sap-card__name">${unlocked ? "✓" : claimable ? "🌿" : "🔒"} ${t.name}</span>
          <span class="sap-card__threshold">${t.threshold} savia</span>
        </div>
        <div class="sap-card__desc">${t.desc}</div>
        ${
          unlocked
            ? `<div class="sap-card__status">Desbloqueado permanentemente</div>`
            : claimable
            ? `<button class="claim-btn" data-claim="${t.id}">Desbloquear</button>`
            : `<div class="sap-card__bar"><div class="sap-card__bar-fill" data-sap-id="${t.id}" style="width:${progress}%"></div></div>`
        }
      `;
      sapList.appendChild(card);
    });

    sapList.querySelectorAll(".claim-btn").forEach((btn) => {
      btn.addEventListener("click", () => claimSap(btn.getAttribute("data-claim")));
    });
  }

  function updateSapBadge() {
    const pending = SAP_THRESHOLDS.filter(
      (t) => !state.sapUnlocks[t.id] && state.sap >= t.threshold
    ).length;
    saviaBadge.textContent = pending;
    saviaBadge.hidden = pending === 0;
  }

  // Sap thresholds don't unlock themselves: crossing one only flags it
  // as ready and notifies the player. The player must open Savia and
  // tap "Desbloquear" to actually claim the effect.
  function checkSapReady() {
    let changed = false;
    SAP_THRESHOLDS.forEach((t) => {
      if (!state.sapUnlocks[t.id] && !state.sapNotified[t.id] && state.sap >= t.threshold) {
        state.sapNotified[t.id] = true;
        changed = true;
        showToast(`🌿 Savia lista para desbloquear: ${t.name}`, "sap");
      }
    });
    if (changed) {
      updateSapBadge();
      if (!panelSavia.hidden) renderSap();
      saveState();
    }
  }

  function claimSap(id) {
    const t = SAP_THRESHOLDS.find((s) => s.id === id);
    if (!t || state.sapUnlocks[id] || state.sap < t.threshold) return;
    state.sapUnlocks[id] = true;
    buildVeins();
    showToast(`✓ ${t.name} desbloqueado`, "sap");
    renderUpgrades();
    renderSap();
    updateSapBadge();
    saveState();
  }

  // ---------- Tabs ----------

  tabs.addEventListener("click", (e) => {
    const btn = e.target.closest(".tab");
    if (!btn) return;
    const tabName = btn.getAttribute("data-tab");

    tabs.querySelectorAll(".tab").forEach((t) => t.classList.remove("active"));
    btn.classList.add("active");

    panelMejoras.hidden = tabName !== "mejoras";
    panelSavia.hidden = tabName !== "savia";
    climbZone.style.display = tabName === "escalar" ? "flex" : "none";

    if (tabName === "mejoras") renderUpgrades();
    if (tabName === "savia") renderSap();
  });

  // Keep open panels live: buy buttons enable themselves as ants accrue,
  // and sap progress bars fill in real time.
  function refreshOpenPanels() {
    if (!panelMejoras.hidden) {
      upgradeList.querySelectorAll(".buy-btn").forEach((btn) => {
        const id = btn.getAttribute("data-upgrade");
        btn.disabled = state.ants < upgradeCost(id);
      });
    }
    if (!panelSavia.hidden) {
      sapList.querySelectorAll(".sap-card__bar-fill").forEach((fill) => {
        const t = SAP_THRESHOLDS.find((s) => s.id === fill.getAttribute("data-sap-id"));
        if (t) fill.style.width = Math.min(100, (state.sap / t.threshold) * 100) + "%";
      });
    }
  }

  // ---------- Game loop ----------

  let lastTick = performance.now();

  function tick() {
    const now = performance.now();
    const dt = (now - lastTick) / 1000;
    lastTick = now;

    state.ants += antsPerSecond() * dt;
    state.sap += sapPerSecond() * dt;

    checkSapReady();
    renderStats();
    refreshOpenPanels();
  }

  setInterval(tick, TICK_MS);

  window.addEventListener("beforeunload", saveState);
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) saveState();
  });
  setInterval(saveState, 5000);

  // ---------- Init ----------

  buildVeins();
  spawnAmbientAnts();
  updateParallax();
  renderStats();
  renderUpgrades();
  renderSap();
  updateSapBadge();
})();
