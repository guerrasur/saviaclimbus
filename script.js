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
      effectLabel: (lvl) => `+${(lvl * 0.4).toFixed(1)} hormigas/s`,
      locked: () => false,
    },
    nudo: {
      name: "Nudo reforzado",
      desc: "Refuerza los apoyos en la corteza. Tus manos aguantan más el apuro sin perder agarre.",
      baseCost: 15,
      costMult: 1.22,
      effectLabel: (lvl) => `-${Math.min(24, lvl * 3)} desgaste por toque rápido`,
      locked: () => false,
    },
    impulso: {
      name: "Impulso de zancada",
      desc: "Cada paso avanza más corteza. Aumenta la altura ganada por toque.",
      baseCost: 40,
      costMult: 1.18,
      effectLabel: (lvl) => `+${(lvl * 0.5).toFixed(1)} cm/toque`,
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
      desc: "Aprendés a leer el viento antes de moverte. Permite tocar más rápido sin perder agarre.",
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
      desc: "La savia impregna tus manos. Cada 8vo toque restaura tu agarre por completo.",
    },
  ];

  function defaultState() {
    return {
      version: 1,
      ants: 0,
      sap: 0,
      height: 0,
      heightRecord: 0,
      tapCount: 0,
      grip: 100,
      lastTapTime: null,
      upgrades: { colonia: 0, nudo: 0, impulso: 0, enjambre: 0 },
      sapUnlocks: { impulso: false, percepcion: false, enjambre: false, agarre: false },
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
      };
    } catch (e) {
      return defaultState();
    }
  }

  let state = loadState();

  function saveState() {
    localStorage.setItem(SAVE_KEY, JSON.stringify(state));
  }

  // ---------- Derived values ----------

  function antsPerSecond() {
    const base = 0.4 + state.upgrades.colonia * 0.4;
    const mult = Math.pow(1.12, state.upgrades.enjambre);
    return base * mult;
  }

  function sapPerSecond() {
    return 0.05 + Math.floor(state.heightRecord / 100) * 0.01;
  }

  function climbPower() {
    return 1 + state.upgrades.impulso * 0.5;
  }

  // Grip system: tapping faster than the safe interval drains grip.
  // Grip hits 0 -> slip. No randomness involved, purely rhythm-based.
  const BASE_SAFE_INTERVAL_MS = 380;
  const MIN_SAFE_INTERVAL_MS = 160;
  const PASSIVE_REGEN_PER_SEC = 8;

  function safeIntervalMs() {
    let interval = BASE_SAFE_INTERVAL_MS;
    if (state.sapUnlocks.percepcion) interval -= 80;
    return Math.max(MIN_SAFE_INTERVAL_MS, interval);
  }

  function drainPerFastestTap() {
    return Math.max(10, 34 - state.upgrades.nudo * 3);
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
  const antsAmbient = $("antsAmbient");
  const tabs = $("tabs");
  const panelMejoras = $("panel-mejoras");
  const panelSavia = $("panel-savia");

  function fmt(n, decimals = 0) {
    if (n >= 1000000) return (n / 1000000).toFixed(2) + "M";
    if (n >= 10000) return (n / 1000).toFixed(1) + "k";
    return n.toFixed(decimals);
  }

  // ---------- Ambient background: sap veins ----------

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
    for (let i = 0; i < visibleCount; i++) {
      const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
      path.setAttribute("d", VEIN_PATHS[i]);
      path.style.animationDelay = `${i * 0.7}s`;
      veinsGroup.appendChild(path);
    }
  }

  // ---------- Ambient ants ----------

  function spawnAmbientAnts() {
    antsAmbient.innerHTML = "";
    const count = 5;
    for (let i = 0; i < count; i++) {
      const el = document.createElement("div");
      el.className = "ant-sprite";
      const top = 10 + Math.random() * 75;
      const duration = 6 + Math.random() * 6;
      const delay = Math.random() * 5;
      el.style.top = top + "%";
      el.style.left = "-10px";
      el.style.animationName = Math.random() > 0.5 ? "antWalkRight" : "antWalkLeft";
      el.style.animationDuration = duration + "s";
      el.style.animationDelay = delay + "s";
      antsAmbient.appendChild(el);
    }
  }

  const styleSheet = document.createElement("style");
  styleSheet.textContent = `
    @keyframes antWalkRight {
      0% { transform: translateX(0); opacity: 0; }
      5% { opacity: 0.85; }
      95% { opacity: 0.85; }
      100% { transform: translateX(105vw); opacity: 0; }
    }
    @keyframes antWalkLeft {
      0% { transform: translateX(105vw); opacity: 0; }
      5% { opacity: 0.85; }
      95% { opacity: 0.85; }
      100% { transform: translateX(0); opacity: 0; }
    }
  `;
  document.head.appendChild(styleSheet);

  // ---------- Bark parallax ----------

  function updateBarkPosition() {
    const offset = (state.height * 2.2) % 400;
    barkLayer.style.transform = `translateY(${offset}px)`;
  }

  // ---------- Toast / feedback ----------

  let toastTimer = null;
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

  function doClimb() {
    state.tapCount++;

    const now = Date.now();
    const interval = state.lastTapTime === null ? Infinity : now - state.lastTapTime;
    state.lastTapTime = now;

    const forcedSafe = state.sapUnlocks.agarre && state.tapCount % 8 === 0;
    const safeInterval = safeIntervalMs();

    if (forcedSafe) {
      state.grip = 100;
    } else if (interval >= safeInterval) {
      state.grip = Math.min(100, state.grip + 18);
    } else {
      const speedRatio = 1 - interval / safeInterval; // 0 = paced, 1 = instant retap
      state.grip = Math.max(0, state.grip - drainPerFastestTap() * speedRatio);
    }

    const slip = !forcedSafe && state.grip <= 0;

    if (slip) {
      const loss = Math.max(2, state.height * (0.08 + Math.random() * 0.07));
      state.height = Math.max(0, state.height - loss);
      state.grip = 30;
      climber.classList.remove("climbing");
      climber.classList.add("slipping");
      setTimeout(() => climber.classList.remove("slipping"), 500);
      flashSlip();
      showToast(`¡Resbalón! Fuiste muy rápido -${loss.toFixed(0)} cm`, "slip");
    } else {
      state.height += climbPower();
      if (state.height > state.heightRecord) state.heightRecord = state.height;
      climber.classList.remove("slipping");
      climber.classList.add("climbing");
      setTimeout(() => climber.classList.remove("climbing"), 350);
    }

    updateBarkPosition();
    renderStats();
    saveState();
  }

  climbBtn.addEventListener("click", (e) => {
    e.preventDefault();
    doClimb();
  });

  let touchStartY = null;
  climbZone.addEventListener(
    "touchstart",
    (e) => {
      touchStartY = e.touches[0].clientY;
    },
    { passive: true }
  );
  climbZone.addEventListener(
    "touchend",
    (e) => {
      if (touchStartY === null) return;
      const dy = touchStartY - e.changedTouches[0].clientY;
      touchStartY = null;
      if (dy > 40) doClimb();
    },
    { passive: true }
  );

  // ---------- Rendering ----------

  function renderStats() {
    antsValue.textContent = fmt(Math.floor(state.ants));
    antsRate.textContent = `+${antsPerSecond().toFixed(1)}/s`;
    sapValue.textContent = fmt(state.sap, 1);
    sapRate.textContent = `+${sapPerSecond().toFixed(2)}/s`;
    heightValue.textContent = fmt(Math.floor(state.height));
    heightRecordValue.textContent = fmt(Math.floor(state.heightRecord));

    const gripPct = Math.round(state.grip);
    gripHudValue.textContent = gripPct;
    gripFill.style.width = gripPct + "%";
    const low = gripPct < 30;
    gripHudValue.classList.toggle("low", low);
    gripFill.classList.toggle("low", low);
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
    renderStats();
    renderUpgrades();
    saveState();
  }

  function renderSap() {
    sapList.innerHTML = "";
    SAP_THRESHOLDS.forEach((t) => {
      const unlocked = state.sapUnlocks[t.id];
      const progress = Math.min(100, (state.sap / t.threshold) * 100);

      const card = document.createElement("div");
      card.className = "sap-card" + (unlocked ? " unlocked" : " locked");
      card.innerHTML = `
        <div class="sap-card__head">
          <span class="sap-card__name">${unlocked ? "✓" : "🔒"} ${t.name}</span>
          <span class="sap-card__threshold">${t.threshold} savia</span>
        </div>
        <div class="sap-card__desc">${t.desc}</div>
        ${
          unlocked
            ? `<div class="sap-card__status">Desbloqueado permanentemente</div>`
            : `<div class="sap-card__bar"><div class="sap-card__bar-fill" style="width:${progress}%"></div></div>`
        }
      `;
      sapList.appendChild(card);
    });
  }

  function checkSapUnlocks() {
    let changed = false;
    SAP_THRESHOLDS.forEach((t) => {
      if (!state.sapUnlocks[t.id] && state.sap >= t.threshold) {
        state.sapUnlocks[t.id] = true;
        changed = true;
        showToast(`🌿 Savia desbloquea: ${t.name}`, "sap");
        buildVeins();
      }
    });
    if (changed) {
      renderUpgrades();
      renderSap();
      saveState();
    }
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

  // ---------- Game loop ----------

  let lastTick = performance.now();

  function tick() {
    const now = performance.now();
    const dt = (now - lastTick) / 1000;
    lastTick = now;

    state.ants += antsPerSecond() * dt;
    state.sap += sapPerSecond() * dt;
    state.grip = Math.min(100, state.grip + PASSIVE_REGEN_PER_SEC * dt);

    checkSapUnlocks();
    renderStats();
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
  updateBarkPosition();
  renderStats();
  renderUpgrades();
  renderSap();
})();
