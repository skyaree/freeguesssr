(function () {
  const el = document.getElementById("app");

  const qs = (k) => new URL(location.href).searchParams.get(k) || "";
  const clampCode = (s) =>
    (s || "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 6);

  const roomFromPath = () => {
    const m = location.pathname.match(/\/room\/([A-Z0-9]{6})/);
    return m ? m[1] : "";
  };
  const roomFromQuery = () => clampCode(qs("code") || qs("room") || "");

  const fmtMs = (ms) => {
    const s = Math.max(0, Math.floor(ms / 1000));
    const mm = String(Math.floor(s / 60)).padStart(2, "0");
    const ss = String(s % 60).padStart(2, "0");
    return `${mm}:${ss}`;
  };

  const state = {
    room: roomFromPath() || roomFromQuery(),
    user: qs("user") || String(Math.floor(Math.random() * 1e9)),
    name: qs("name") || "",
    sig: qs("sig") || "",
    ws: null,
    server: null,
    timer: { phase: "guess", ms_left: 0 },
    guess: null,
    toast: null,

    panoAttempts: 0,
    lastSeedKey: "",
    creating: false,

    joinCodeInput: roomFromQuery(),
    countdownEndsAt: 0,
    lastRoundEnd: null,
  };

  function setToast(kind, text) {
    state.toast = { kind, text };
    render();
    setTimeout(() => {
      if (state.toast && state.toast.text === text) {
        state.toast = null;
        render();
      }
    }, 2800);
  }

  function h(tag, attrs, ...children) {
    const e = document.createElement(tag);
    if (attrs) {
      for (const [k, v] of Object.entries(attrs)) {
        if (k === "class") e.className = v;
        else if (k.startsWith("on") && typeof v === "function")
          e.addEventListener(k.slice(2).toLowerCase(), v);
        else if (v !== null && v !== undefined) e.setAttribute(k, String(v));
      }
    }
    for (const c of children.flat()) {
      if (c === null || c === undefined) continue;
      if (typeof c === "string") e.appendChild(document.createTextNode(c));
      else e.appendChild(c);
    }
    return e;
  }
  function clear(node) {
    while (node.firstChild) node.removeChild(node.firstChild);
  }

  function ensureYmaps(cb) {
    const start = Date.now();
    const tick = () => {
      if (window.ymaps && typeof window.ymaps.ready === "function") {
        window.ymaps.ready(() => cb(true));
        return;
      }
      if (Date.now() - start > 9000) return cb(false);
      setTimeout(tick, 120);
    };
    tick();
  }

  function connectWS() {
    if (!state.room) return;
    const proto = location.protocol === "https:" ? "wss" : "ws";
    const url =
      `${proto}://${location.host}/ws?room=${encodeURIComponent(state.room)}` +
      `&user=${encodeURIComponent(state.user)}` +
      `&sig=${encodeURIComponent(state.sig)}` +
      `&name=${encodeURIComponent(state.name)}`;

    const ws = new WebSocket(url);
    state.ws = ws;

    ws.onopen = () => setToast("ok", "Подключено ✅");
    ws.onmessage = (ev) => {
      let msg;
      try {
        msg = JSON.parse(ev.data);
      } catch (e) {
        console.error("WS non-JSON:", ev.data);
        return;
      }

      if (msg.t === "state") {
        state.server = msg.state;
        if (state.server && state.server.countdown_ends_at_ms) {
          state.countdownEndsAt = state.server.countdown_ends_at_ms;
        }
        render();
      }
      if (msg.t === "timer") {
        state.timer = { phase: msg.phase, ms_left: msg.ms_left };
        renderTimerOnly();
      }
      if (msg.t === "toast") setToast(msg.kind, msg.text);

      if (msg.t === "countdown") {
        state.countdownEndsAt = msg.ends_at_ms;
        render();
      }

      if (msg.t === "round_end") {
        state.lastRoundEnd = msg;
        render();
      }
    };
    ws.onclose = () => setToast("error", "Соединение закрыто 😕");
    ws.onerror = () => setToast("error", "WebSocket ошибка");
  }

  function send(obj) {
    if (state.ws && state.ws.readyState === 1) state.ws.send(JSON.stringify(obj));
  }

  // ======== красивый “аватар” маркер (инициал + цвет по id) ========
  function colorFromId(id) {
    let hsh = 0;
    for (let i = 0; i < id.length; i++) hsh = (hsh * 31 + id.charCodeAt(i)) >>> 0;
    return `hsl(${hsh % 360} 80% 55%)`;
  }
  function avatarLayout(text, color) {
    const safe = (text || "?").toString().slice(0, 2).toUpperCase();
    return ymaps.templateLayoutFactory.createClass(
      `<div style="
        width:36px;height:36px;border-radius:999px;
        background:${color};
        display:flex;align-items:center;justify-content:center;
        color:white;font-weight:900;font-size:14px;
        border:2px solid rgba(0,0,0,.55);
        box-shadow:0 10px 26px rgba(0,0,0,.35);
      ">${safe}</div>`
    );
  }
  function makeAvatarPlacemark(coords, label, color) {
    return new ymaps.Placemark(coords, {}, {
      iconLayout: avatarLayout(label, color),
      iconShape: { type: "Circle", coordinates: [18, 18], radius: 18 },
    });
  }

  // ======== PANORAMA (стабильнее) ========
  function mountPanorama(container, seedLat, seedLng, isHost) {
    container.innerHTML = "";
    container.style.position = "relative";

    const panoDiv = h("div", { class: "w-full h-full" });
    container.appendChild(panoDiv);

    const loading = document.createElement("div");
    loading.className =
      "absolute inset-0 flex items-center justify-center bg-black/35 backdrop-blur-sm text-sm text-zinc-200 glow";
    loading.textContent = "Загрузка панорамы…";
    container.appendChild(loading);

    ensureYmaps((ok) => {
      if (!ok) {
        loading.remove();
        setToast("error", "Yandex Maps не загрузились");
        return;
      }

      const seedKey = `${seedLat.toFixed(5)},${seedLng.toFixed(5)}`;
      if (state.lastSeedKey !== seedKey) {
        state.panoAttempts = 0;
        state.lastSeedKey = seedKey;
      }

      state.panoAttempts += 1;
      const attemptsLeft = 10 - state.panoAttempts;

      if (!ymaps.panorama || !ymaps.panorama.locate) {
        loading.remove();
        setToast("error", "Панорамы недоступны (проверь ключ/тариф)");
        return;
      }

      // Радиус больше -> выше шанс найти панораму
      ymaps.panorama
        .locate([seedLat, seedLng], { layer: "yandex#panorama", radius: 15000 })
        .then((panos) => {
          if (!panos || !panos.length) {
            loading.remove();
            if (isHost && attemptsLeft > 0) {
              setToast("info", `Панорама не найдена 😕 Реролл (${attemptsLeft})`);
              send({ t: "reroll" });
            } else {
              setToast("error", "Панорама не найдена рядом. Хост может нажать 🔁 или сменить регион.");
            }
            return;
          }

          const pano = panos[0];
          new ymaps.panorama.Player(panoDiv, pano, {
            direction: [256, 16],
            controls: ["zoomControl"],
          });

          loading.remove();

          // фиксируем реальную координату панорамы (честный reveal)
          if (isHost && pano && pano.getPosition) {
            const pos = pano.getPosition();
            if (pos && pos.length === 2) {
              send({ t: "pano_ready", trueLat: pos[0], trueLng: pos[1] });
            }
          }
        })
        .catch((e) => {
          console.error(e);
          loading.remove();
          setToast("error", "Ошибка загрузки панорамы");
        });
    });
  }

  // ======== MAPS ========
  let miniMap = null;
  let miniMark = null;

  function mountMiniMap(container, disabled) {
    container.innerHTML = "";
    const mapDiv = h("div", { class: "w-full h-full" });
    container.appendChild(mapDiv);

    ensureYmaps((ok) => {
      if (!ok) return;

      miniMap = new ymaps.Map(
        mapDiv,
        { center: [20, 0], zoom: 2, controls: [] },
        { suppressMapOpenBlock: true }
      );

      // если уже выбрали — покажем
      if (state.guess) {
        const label = (state.name || "Я").slice(0, 1);
        const color = colorFromId(state.user);
        miniMark = makeAvatarPlacemark([state.guess.lat, state.guess.lng], label, color);
        miniMap.geoObjects.add(miniMark);
        miniMap.setCenter([state.guess.lat, state.guess.lng], 4, { duration: 200 });
      }

      if (disabled) return;

      miniMap.events.add("click", function (e) {
        const coords = e.get("coords");
        state.guess = { lat: coords[0], lng: coords[1] };

        const label = (state.name || "Я").slice(0, 1);
        const color = colorFromId(state.user);

        if (!miniMark) {
          miniMark = makeAvatarPlacemark(coords, label, color);
          miniMap.geoObjects.add(miniMark);
        } else {
          miniMark.geometry.setCoordinates(coords);
        }
        renderGuessOnly();
      });
    });
  }

  function mountRevealMap(container, roomState) {
    container.innerHTML = "";
    const mapDiv = h("div", { class: "w-full h-full" });
    container.appendChild(mapDiv);

    ensureYmaps((ok) => {
      if (!ok) return;

      const tr = roomState.current_round && roomState.current_round.true;
      const center = tr ? [tr.lat, tr.lng] : [20, 0];

      const map = new ymaps.Map(
        mapDiv,
        { center, zoom: tr ? 5 : 2, controls: [] },
        { suppressMapOpenBlock: true }
      );

      if (tr) {
        const trueMark = new ymaps.Placemark(
          [tr.lat, tr.lng],
          { balloonContent: "Истинное место" },
          { preset: "islands#yellowStarIcon" }
        );
        map.geoObjects.add(trueMark);
      }

      (roomState.guesses || []).forEach((g) => {
        const pos = [g.lat, g.lng];
        const label = (g.name || g.user_id).slice(0, 1);
        const color = colorFromId(g.user_id);

        const m = makeAvatarPlacemark(pos, label, color);
        map.geoObjects.add(m);

        if (tr) {
          const line = new ymaps.Polyline([[tr.lat, tr.lng], pos], {}, {
            strokeWidth: 3,
            strokeColor: "#60a5fa",
            opacity: 0.75,
          });
          map.geoObjects.add(line);
        }
      });
    });
  }

  // ======== UI helpers ========
  function renderTimerOnly() {
    const timerEl = document.getElementById("timer-box");
    if (timerEl) timerEl.textContent = fmtMs(state.timer.ms_left);

    const phaseEl = document.getElementById("phase-box");
    if (phaseEl) phaseEl.textContent = state.timer.phase === "reveal" ? "Результаты" : "Угадывание";
  }

  function renderGuessOnly() {
    const gEl = document.getElementById("guess-status");
    if (!gEl) return;
    gEl.textContent = state.guess ? "Точка выбрана 📍" : "Выбери точку";
  }

  function pill(title, value, cls = "") {
    return h(
      "div",
      { class: "px-3 py-2 rounded-2xl bg-zinc-900/60 border border-zinc-800/80 backdrop-blur flex flex-col " + cls },
      h("div", { class: "text-[11px] text-zinc-300/70" }, title),
      h("div", { class: "font-semibold tabular-nums" }, value)
    );
  }

  function goToRoom(code) {
    const c = clampCode(code);
    if (c.length !== 6) {
      setToast("error", "Код должен быть из 6 символов");
      return;
    }
    const url = new URL(location.origin + `/room/${c}`);
    url.searchParams.set("user", state.user);
    if (state.name) url.searchParams.set("name", state.name);
    location.href = url.toString();
  }

  async function createLobby(region, country) {
    state.creating = true;
    render();
    try {
      const res = await fetch("/api/create_room", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          host_user_id: state.user,
          name: state.name || "Host",
          region,
          country,
        }),
      });

      // безопасно читаем (на случай, если сервер вернёт не JSON)
      const txt = await res.text();
      let j;
      try {
        j = JSON.parse(txt);
      } catch (e) {
        console.error("create_room non-JSON:", txt);
        throw new Error("Сервер вернул не JSON (см. консоль).");
      }

      if (!j.ok) throw new Error(j.error || "ошибка");
      location.href = j.join_url;
    } catch (e) {
      setToast("error", String(e.message || e));
    } finally {
      state.creating = false;
      render();
    }
  }

  function render() {
    clear(el);

    const server = state.server;
    const isRoomPath = location.pathname.startsWith("/room/");
    const isHost = server && server.host_user_id === state.user;
    const cr = server && server.current_round;

    const canGuess = server && server.game_status === "running" && cr && cr.status === "running";

    // HEADER
    const header = h(
      "div",
      { class: "max-w-6xl mx-auto p-4 md:p-6 pop" },
      h(
        "div",
        { class: "flex flex-col md:flex-row gap-3 md:items-center md:justify-between" },
        h(
          "div",
          null,
          h("div", { class: "text-3xl md:text-5xl font-extrabold tracking-tight" }, "FreeGuessr"),
          h("div", { class: "text-zinc-300/80 text-sm mt-1" },
            server
              ? `Комната ${server.code} • Раунд ${server.round_number}/${server.rounds_total}`
              : state.room
              ? `Комната ${state.room}`
              : "Создай или открой комнату по коду"
          )
        ),
        h(
          "div",
          { class: "flex items-center gap-2" },
          pill("Фаза", state.timer.phase === "reveal" ? "Результаты" : "Угадывание"),
          pill("Таймер", fmtMs(state.timer.ms_left), state.timer.ms_left < 15000 ? "pulseRing" : "")
        )
      )
    );
    el.appendChild(header);

    // TOAST
    if (state.toast) {
      const cls =
        state.toast.kind === "error"
          ? "border-red-900/80 bg-red-950/40"
          : state.toast.kind === "ok"
          ? "border-emerald-900/80 bg-emerald-950/30"
          : "border-zinc-800 bg-zinc-900/50";

      el.appendChild(
        h("div", { class: "max-w-6xl mx-auto px-4 md:px-6 pop" },
          h("div", { class: `rounded-2xl p-3 border ${cls} backdrop-blur` }, state.toast.text)
        )
      );
    }

    // COUNTDOWN overlay
    if (state.countdownEndsAt && Date.now() < state.countdownEndsAt) {
      const left = Math.ceil((state.countdownEndsAt - Date.now()) / 1000);
      el.appendChild(
        h("div", { class: "fixed inset-0 z-50 flex items-center justify-center" },
          h("div", { class: "absolute inset-0 bg-black/65 backdrop-blur" }),
          h("div", { class: "relative pop rounded-3xl border border-zinc-700 bg-zinc-950/60 px-10 py-8 text-center shadow-2xl" },
            h("div", { class: "text-sm text-zinc-300/80" }, "Игра начинается через"),
            h("div", { class: "text-6xl font-extrabold mt-2 tabular-nums" }, String(left))
          )
        )
      );
      setTimeout(() => render(), 120);
    }

    // HOME (создать / войти по коду)
    if (!isRoomPath) {
      const home = h(
        "div",
        { class: "max-w-6xl mx-auto p-4 md:p-6 grid grid-cols-1 lg:grid-cols-2 gap-4 pop" },

        // CREATE
        h("div", { class: "rounded-3xl border border-zinc-800/80 bg-zinc-900/35 backdrop-blur p-6 shadow-xl" },
          h("div", { class: "text-xl font-bold" }, "🎮 Создать лобби"),
          h("div", { class: "text-sm text-zinc-300/80 mt-1" }, "Выбери регион/страну и играйте вместе."),
          h("div", { class: "mt-5 grid grid-cols-1 gap-3" },
            h("input", {
              class: "px-4 py-3 rounded-2xl bg-zinc-950/40 border border-zinc-800 outline-none focus:ring-2 focus:ring-indigo-500/60",
              placeholder: "Ник (необязательно)",
              value: state.name,
              oninput: (e) => (state.name = e.target.value),
            }),
            h("select", {
              id: "regionSel",
              class: "px-4 py-3 rounded-2xl bg-zinc-950/40 border border-zinc-800 outline-none focus:ring-2 focus:ring-indigo-500/60",
            },
              h("option", { value: "WORLD" }, "Регион: Весь мир"),
              h("option", { value: "EUROPE" }, "Регион: Европа"),
              h("option", { value: "N_AMERICA" }, "Регион: Северная Америка"),
              h("option", { value: "S_AMERICA" }, "Регион: Южная Америка"),
              h("option", { value: "ASIA" }, "Регион: Азия"),
              h("option", { value: "AFRICA" }, "Регион: Африка"),
              h("option", { value: "OCEANIA" }, "Регион: Океания"),
              h("option", { value: "RU" }, "Регион: Россия"),
            ),
            h("select", {
              id: "countrySel",
              class: "px-4 py-3 rounded-2xl bg-zinc-950/40 border border-zinc-800 outline-none focus:ring-2 focus:ring-indigo-500/60",
            },
              h("option", { value: "" }, "Страна: (не выбрано)"),
              h("option", { value: "RU" }, "Россия"),
              h("option", { value: "KZ" }, "Казахстан"),
              h("option", { value: "TR" }, "Турция"),
              h("option", { value: "DE" }, "Германия"),
              h("option", { value: "FR" }, "Франция"),
              h("option", { value: "GB" }, "Великобритания"),
              h("option", { value: "US" }, "США"),
              h("option", { value: "JP" }, "Япония"),
            ),
            h("button", {
              class: "px-4 py-3 rounded-2xl bg-indigo-600 hover:bg-indigo-500 transition shadow-lg shadow-indigo-600/20 font-semibold",
              onclick: () => {
                const region = document.getElementById("regionSel").value;
                const country = document.getElementById("countrySel").value;
                createLobby(region, country);
              },
              disabled: state.creating ? "true" : null,
            }, state.creating ? "Создаём…" : "Создать лобби"),
            h("div", { class: "text-xs text-zinc-400/80" }, "Если панорама не найдена, хост автоматически сделает несколько 🔁.")
          )
        ),

        // JOIN
        h("div", { class: "rounded-3xl border border-zinc-800/80 bg-zinc-900/35 backdrop-blur p-6 shadow-xl" },
          h("div", { class: "text-xl font-bold" }, "🔑 Войти по коду"),
          h("div", { class: "text-sm text-zinc-300/80 mt-1" }, "Если тебя пригласили — вставь код комнаты."),
          h("div", { class: "mt-5 grid grid-cols-1 gap-3" },
            h("input", {
              class: "px-4 py-3 rounded-2xl bg-zinc-950/40 border border-zinc-800 outline-none focus:ring-2 focus:ring-emerald-500/60 tracking-widest uppercase",
              placeholder: "КОД (например: A1B2C3)",
              value: state.joinCodeInput,
              oninput: (e) => (state.joinCodeInput = clampCode(e.target.value)),
            }),
            h("button", {
              class: "px-4 py-3 rounded-2xl bg-emerald-600 hover:bg-emerald-500 transition shadow-lg shadow-emerald-600/20 font-semibold",
              onclick: () => goToRoom(state.joinCodeInput),
            }, "Войти"),
            h("div", { class: "text-xs text-zinc-400/80" },
              "Можно давать ссылку: ",
              h("span", { class: "text-zinc-200" }, `${location.origin}/?code=ABC123`),
              " — код подставится автоматически ✅"
            )
          )
        ),
      );

      el.appendChild(home);

      // автопереход если пришли на /?code=XXXXXX
      const qcode = roomFromQuery();
      if (qcode && location.pathname === "/") {
        setTimeout(() => goToRoom(qcode), 250);
      }
      return;
    }

    // ROOM UI
    const grid = h("div", { class: "max-w-6xl mx-auto p-4 md:p-6 grid grid-cols-1 lg:grid-cols-3 gap-4 pop" });

    const panoWrap = h(
      "div",
      { class: "lg:col-span-2 rounded-3xl border border-zinc-800/80 bg-zinc-900/35 backdrop-blur overflow-hidden shadow-xl" },
      h("div", { class: "p-4 flex items-center justify-between border-b border-zinc-800/70" },
        h("div", { class: "font-bold text-lg" }, "🌐 Панорама"),
        h("div", { class: "text-xs text-zinc-300/70" },
          !server ? "Подключаемся…" :
          server.game_status === "lobby" ? "Ждём старта от хоста…" :
          (cr && cr.status === "reveal") ? "Результаты" :
          canGuess ? "Осмотрись и угадай 🙂" : "Раунд завершён"
        )
      ),
      h("div", { id: "pano", class: "h-[54vh] min-h-[380px] relative" })
    );

    const mini = h(
      "div",
      { class: "rounded-3xl border border-zinc-800/80 bg-zinc-900/35 backdrop-blur overflow-hidden shadow-xl" },
      h("div", { class: "p-4 flex items-center justify-between border-b border-zinc-800/70" },
        h("div", { class: "font-bold" }, "🗺️ Мини-карта"),
        h("div", { id: "guess-status", class: "text-xs text-zinc-300/70" }, state.guess ? "Точка выбрана 📍" : "Выбери точку")
      ),
      h("div", { id: "minimap", class: "h-[320px] relative" }),
      h("div", { class: "p-4 flex gap-2" },
        h("button", {
          class:
            `flex-1 px-4 py-3 rounded-2xl font-semibold transition shadow-lg ` +
            (canGuess
              ? "bg-emerald-600 hover:bg-emerald-500 shadow-emerald-600/20"
              : "bg-zinc-800 text-zinc-400 cursor-not-allowed"),
          onclick: () => {
            if (!canGuess) return;
            if (!state.guess) return setToast("error", "Сначала поставь точку 📍");
            send({ t: "guess", lat: state.guess.lat, lng: state.guess.lng });
            setToast("ok", "Ответ отправлен ✅");
          },
        }, "Отправить"),
        h("button", {
          class: "px-4 py-3 rounded-2xl bg-zinc-800 hover:bg-zinc-700 transition",
          onclick: () => { state.guess = null; render(); },
          title: "Сбросить",
        }, "↺")
      )
    );

    const controls = h(
      "div",
      { class: "rounded-3xl border border-zinc-800/80 bg-zinc-900/35 backdrop-blur overflow-hidden shadow-xl" },
      h("div", { class: "p-4 border-b border-zinc-800/70 flex items-center justify-between" },
        h("div", { class: "font-bold" }, "🎛️ Управление"),
        h("div", { class: "text-xs text-zinc-300/70" }, isHost ? "Хост" : "Игрок")
      ),
      h("div", { class: "p-4 flex gap-2 flex-wrap" },
        h("button", {
          class:
            `flex-1 min-w-[160px] px-4 py-3 rounded-2xl font-semibold transition shadow-lg ` +
            (isHost && server && server.game_status === "lobby"
              ? "bg-indigo-600 hover:bg-indigo-500 shadow-indigo-600/20"
              : "bg-zinc-800 text-zinc-400 cursor-not-allowed"),
          onclick: () => { if (isHost && server && server.game_status === "lobby") send({ t: "start_game" }); },
        }, "Начать (5 сек)"),
        h("button", {
          class:
            `px-4 py-3 rounded-2xl transition ` +
            (isHost ? "bg-zinc-800 hover:bg-zinc-700" : "bg-zinc-800 text-zinc-400 cursor-not-allowed"),
          onclick: () => { if (isHost) send({ t: "reroll" }); },
          title: "Если панорама не находится",
        }, "🔁"),
        h("button", {
          class: "px-4 py-3 rounded-2xl bg-zinc-800 hover:bg-zinc-700 transition",
          onclick: () => {
            try { if (state.ws) state.ws.close(); } catch (e) {}
            location.href = "/";
          },
        }, "Выйти")
      ),
      h("div", { class: "px-4 pb-4 text-xs text-zinc-300/70" },
        "Ссылка: ",
        h("span", { class: "text-zinc-100" }, `${location.origin}/room/${state.room}`),
        " • Код: ",
        h("span", { class: "text-zinc-100 font-semibold tracking-widest" }, state.room)
      )
    );

    const settings = h(
      "div",
      { class: "rounded-3xl border border-zinc-800/80 bg-zinc-900/35 backdrop-blur overflow-hidden shadow-xl" },
      h("div", { class: "p-4 border-b border-zinc-800/70 flex items-center justify-between" },
        h("div", { class: "font-bold" }, "🌍 Регион"),
        h("div", { class: "text-xs text-zinc-300/70" },
          server && server.game_status === "lobby" && isHost ? "Можно менять до старта" : " "
        )
      ),
      h("div", { class: "p-4 grid grid-cols-1 gap-2" },
        h("div", { class: "text-xs text-zinc-400/80" }, "Континент"),
        h("select", {
          id: "regionRoomSel",
          class:
            "px-4 py-3 rounded-2xl bg-zinc-950/40 border border-zinc-800 outline-none " +
            ((!isHost || (server && server.game_status !== "lobby")) ? "opacity-60" : "focus:ring-2 focus:ring-indigo-500/60"),
        },
          ...(server ? Object.entries(server.regions).map(([k, v]) =>
            h("option", { value: k, selected: server.region === k }, v)
          ) : [])
        ),
        h("div", { class: "text-xs text-zinc-400/80 mt-2" }, "Страна (опционально)"),
        h("select", {
          id: "countryRoomSel",
          class:
            "px-4 py-3 rounded-2xl bg-zinc-950/40 border border-zinc-800 outline-none " +
            ((!isHost || (server && server.game_status !== "lobby")) ? "opacity-60" : "focus:ring-2 focus:ring-indigo-500/60"),
        },
          h("option", { value: "", selected: server ? server.country === "" : true }, "(не выбрано)"),
          ...(server ? Object.entries(server.countries).map(([k, v]) =>
            h("option", { value: k, selected: server.country === k }, v)
          ) : [])
        ),
        h("button", {
          class:
            "mt-2 px-4 py-3 rounded-2xl transition font-semibold " +
            (isHost && server && server.game_status === "lobby"
              ? "bg-zinc-800 hover:bg-zinc-700"
              : "bg-zinc-800 text-zinc-400 cursor-not-allowed"),
          onclick: () => {
            if (!(isHost && server && server.game_status === "lobby")) return;
            const region = document.getElementById("regionRoomSel").value;
            const country = document.getElementById("countryRoomSel").value;
            send({ t: "set_settings", region, country });
            setToast("ok", "Настройки применены ✅");
          },
        }, "Сохранить")
      )
    );

    const leaderboard = h(
      "div",
      { class: "rounded-3xl border border-zinc-800/80 bg-zinc-900/35 backdrop-blur overflow-hidden shadow-xl" },
      h("div", { class: "p-4 border-b border-zinc-800/70 flex items-center justify-between" },
        h("div", { class: "font-bold" }, "🏆 Лидерборд"),
        h("div", { class: "text-xs text-zinc-300/70" }, server ? `${server.players.length} игроков` : "")
      ),
      h("div", { class: "p-4 space-y-2" },
        ...(server ? server.players.slice(0, 15).map((p, idx) => {
          const you = p.user_id === state.user;
          const sub =
            cr && cr.status !== "running" && p.last_distance_km != null
              ? `• ${p.last_distance_km.toFixed(0)} км • +${p.last_score}`
              : (p.has_guessed ? "• ответил" : "• ждём");
          return h("div", {
            class:
              "flex items-center justify-between rounded-2xl px-4 py-3 border border-zinc-800/70 bg-zinc-950/20 " +
              (you ? "ring-2 ring-indigo-500/50" : ""),
          },
            h("div", null,
              h("div", { class: "font-semibold" }, `#${idx + 1}  ${p.name || p.user_id}`),
              h("div", { class: "text-xs text-zinc-300/70 mt-0.5" }, sub),
            ),
            h("div", { class: "font-extrabold tabular-nums" }, String(p.total_score))
          );
        }) : [h("div", { class: "text-sm text-zinc-300/70" }, "Подключаемся…")])
      )
    );

    const right = h("div", { class: "lg:col-span-1 flex flex-col gap-4" }, mini, controls, settings, leaderboard);

    grid.appendChild(panoWrap);
    grid.appendChild(right);

    // Reveal screen (красивый)
    if (server && cr && cr.status === "reveal") {
      const winners = (state.lastRoundEnd && state.lastRoundEnd.winners) ? state.lastRoundEnd.winners : [];
      const noGuess = (state.lastRoundEnd && state.lastRoundEnd.no_guess) ? state.lastRoundEnd.no_guess : [];

      const winnersNames = (server.players || [])
        .filter(p => winners.includes(p.user_id))
        .map(p => p.name || p.user_id);

      const bestLine = winnersNames.length
        ? `🏆 Ближе всех: ${winnersNames.join(", ")}`
        : "🏆 Ближе всех: —";

      const revealCard = h("div", { class: "lg:col-span-3 pop" },
        h("div", { class: "rounded-3xl border border-zinc-800/80 bg-zinc-900/35 backdrop-blur overflow-hidden shadow-xl" },
          h("div", { class: "p-4 md:p-6 border-b border-zinc-800/70 flex items-start justify-between gap-3 flex-wrap" },
            h("div", null,
              h("div", { class: "text-xl md:text-2xl font-extrabold" }, "Результаты раунда ✨"),
              h("div", { class: "text-sm text-zinc-300/80 mt-1" }, bestLine),
            ),
            h("div", { class: "text-xs text-zinc-300/70" }, "⭐ истинная точка • аватары — игроки")
          ),
          h("div", { class: "p-4 md:p-6 grid grid-cols-1 md:grid-cols-2 gap-3" },
            ...server.players.map(p => {
              const bad = noGuess.includes(p.user_id);
              const line =
                (p.last_distance_km != null)
                  ? `${p.last_distance_km.toFixed(0)} км • +${p.last_score}`
                  : (bad ? "не успел 😅" : "—");
              return h("div", {
                class:
                  "rounded-2xl border border-zinc-800/70 bg-zinc-950/20 px-4 py-3 flex items-center justify-between " +
                  (winners.includes(p.user_id) ? "ring-2 ring-emerald-500/40" : ""),
              },
                h("div", null,
                  h("div", { class: "font-semibold" }, p.name || p.user_id),
                  h("div", { class: "text-xs text-zinc-300/70 mt-0.5" }, line),
                ),
                h("div", { class: "font-extrabold tabular-nums" }, String(p.total_score))
              );
            })
          )
        )
      );

      const revealMapWrap = h("div", { class: "lg:col-span-3 rounded-3xl border border-zinc-800/80 bg-zinc-900/35 backdrop-blur overflow-hidden shadow-xl pop" },
        h("div", { class: "p-4 border-b border-zinc-800/70 flex items-center justify-between" },
          h("div", { class: "font-bold text-lg" }, "📌 Карта результатов"),
          h("div", { class: "text-xs text-zinc-300/70" }, "линии до истинной точки")
        ),
        h("div", { class: "h-[380px] relative", id: "revealmap" })
      );

      grid.appendChild(revealCard);
      grid.appendChild(revealMapWrap);
    }

    el.appendChild(grid);

    // mounts
    setTimeout(() => {
      if (server && cr) {
        const pano = document.getElementById("pano");
        if (pano) mountPanorama(pano, cr.seed_lat, cr.seed_lng, isHost);
      }
      const mm = document.getElementById("minimap");
      if (mm) mountMiniMap(mm, !canGuess);

      if (server && cr && cr.status === "reveal") {
        const rm = document.getElementById("revealmap");
        if (rm) mountRevealMap(rm, server);
      }

      renderTimerOnly();
      renderGuessOnly();
    }, 0);
  }

  // Telegram WebApp polish
  try {
    if (window.Telegram && window.Telegram.WebApp) {
      window.Telegram.WebApp.ready();
      window.Telegram.WebApp.expand();
    }
  } catch (e) {}

  // connect if room
  if (state.room && location.pathname.startsWith("/room/")) connectWS();

  render();
})();
