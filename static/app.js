(function () {
  const el = document.getElementById("app");

  const qs = (k) => new URL(location.href).searchParams.get(k) || "";
  const clampCode = (s) =>
    (s || "")
      .toUpperCase()
      .replace(/[^A-Z0-9]/g, "")
      .slice(0, 6);

  // ✅ поддержка входа по коду:
  // - /room/ABC123
  // - /?code=ABC123
  // - /?room=ABC123
  const roomFromPath = () => {
    const m = location.pathname.match(/\/room\/([A-Z0-9]{6})/);
    if (m) return m[1];
    return "";
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
    // если юзер не задан — генерим
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
    joinCodeInput: roomFromQuery(),
    creating: false,
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
      const msg = JSON.parse(ev.data);
      if (msg.t === "state") {
        state.server = msg.state;
        render();
      }
      if (msg.t === "timer") {
        state.timer = { phase: msg.phase, ms_left: msg.ms_left };
        renderTimerOnly();
      }
      if (msg.t === "toast") setToast(msg.kind, msg.text);
    };
    ws.onclose = () => setToast("error", "Соединение закрыто 😕");
    ws.onerror = () => setToast("error", "WebSocket ошибка");
  }

  function send(obj) {
    if (state.ws && state.ws.readyState === 1) state.ws.send(JSON.stringify(obj));
  }

  // ====== PANORAMA ======
  function mountPanorama(container, seedLat, seedLng, isHost) {
    container.innerHTML = "";
    const panoDiv = h("div", { class: "w-full h-full" });
    container.appendChild(panoDiv);

    ensureYmaps((ok) => {
      if (!ok) {
        setToast("error", "Yandex Maps не загрузились");
        return;
      }

      const seedKey = `${seedLat.toFixed(5)},${seedLng.toFixed(5)}`;
      if (state.lastSeedKey !== seedKey) {
        state.panoAttempts = 0;
        state.lastSeedKey = seedKey;
      }

      state.panoAttempts += 1;
      const attemptsLeft = 8 - state.panoAttempts;

      if (!ymaps.panorama || !ymaps.panorama.locate) {
        setToast("error", "Панорамы недоступны (проверь ключ/тариф)");
        return;
      }

      setToast("info", "Ищем панораму рядом…");
      ymaps.panorama
        .locate([seedLat, seedLng], { layer: "yandex#panorama", radius: 5000 })
        .then((panos) => {
          if (!panos || !panos.length) {
            if (isHost && attemptsLeft > 0) {
              setToast("info", `Панорама не найдена 😕 Реролл (${attemptsLeft})`);
              send({ t: "reroll" });
            } else {
              setToast(
                "error",
                "Панорама не найдена рядом. Хост может нажать 🔁 или сменить регион."
              );
            }
            return;
          }

          const pano = panos[0];

          new ymaps.panorama.Player(panoDiv, pano, {
            direction: [256, 16],
            controls: ["zoomControl"],
          });

          // ✅ фиксируем точные координаты панорамы для честного скоринга
          if (isHost && pano && pano.getPosition) {
            const pos = pano.getPosition();
            if (pos && pos.length === 2) {
              send({ t: "pano_ready", trueLat: pos[0], trueLng: pos[1] });
            }
          }
        })
        .catch((e) => {
          console.error(e);
          setToast("error", "Ошибка загрузки панорамы");
        });
    });
  }

  // ====== MAPS ======
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

      if (state.guess) {
        miniMark = new ymaps.Placemark(
          [state.guess.lat, state.guess.lng],
          {},
          { preset: "islands#redIcon" }
        );
        miniMap.geoObjects.add(miniMark);
        miniMap.setCenter([state.guess.lat, state.guess.lng], 4, { duration: 200 });
      }

      if (disabled) return;

      miniMap.events.add("click", function (e) {
        const coords = e.get("coords");
        state.guess = { lat: coords[0], lng: coords[1] };

        if (!miniMark) {
          miniMark = new ymaps.Placemark(coords, {}, { preset: "islands#redIcon" });
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
        const m = new ymaps.Placemark(
          pos,
          {
            balloonContent:
              (g.name || g.user_id) +
              (g.distance_km != null ? `<br/>${g.distance_km.toFixed(0)} км` : ""),
          },
          { preset: "islands#blueIcon" }
        );
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

  function pill(text, cls = "") {
    return h(
      "div",
      {
        class:
          "px-3 py-2 rounded-2xl bg-zinc-900/60 border border-zinc-800/80 backdrop-blur flex flex-col " +
          cls,
      },
      h("div", { class: "text-[11px] text-zinc-300/70" }, text.split("|")[0]),
      h("div", { class: "font-semibold" }, text.split("|")[1] || "")
    );
  }

  // ✅ Вход по коду: просто переводим на /room/CODE, юзер/ник подтянутся из query или сгенерятся
  function goToRoom(code) {
    const c = clampCode(code);
    if (c.length !== 6) {
      setToast("error", "Код должен быть из 6 символов");
      return;
    }
    const url = new URL(location.origin + `/room/${c}`);
    if (state.name) url.searchParams.set("name", state.name);
    // user и sig можно не ставить — сервер пускает и без подписи
    url.searchParams.set("user", state.user);
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
      const j = await res.json();
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

    // Top bar
    const top = h(
      "div",
      { class: "max-w-6xl mx-auto p-4 md:p-6 pop" },
      h(
        "div",
        { class: "flex flex-col md:flex-row gap-3 md:items-center md:justify-between" },
        h(
          "div",
          null,
          h("div", { class: "text-3xl md:text-4xl font-extrabold tracking-tight" }, "FreeGuessr"),
          h(
            "div",
            { class: "text-zinc-300/80 text-sm mt-1" },
            state.server
              ? `Комната ${state.server.code} • Раунд ${state.server.round_number}/${state.server.rounds_total}`
              : state.room
              ? `Комната ${state.room}`
              : "Создай или открой комнату по коду"
          )
        ),
        h(
          "div",
          { class: "flex items-center gap-2" },
          pill(`Фаза|${state.timer.phase === "reveal" ? "Результаты" : "Угадывание"}`),
          pill(`Таймер|${fmtMs(state.timer.ms_left)}`, state.timer.ms_left < 15000 ? "pulseRing" : "")
        )
      )
    );

    el.appendChild(top);

    if (state.toast) {
      const cls =
        state.toast.kind === "error"
          ? "border-red-900/80 bg-red-950/40"
          : state.toast.kind === "ok"
          ? "border-emerald-900/80 bg-emerald-950/30"
          : "border-zinc-800 bg-zinc-900/50";
      el.appendChild(
        h(
          "div",
          { class: "max-w-6xl mx-auto px-4 md:px-6 pop" },
          h("div", { class: `rounded-2xl p-3 border ${cls} backdrop-blur` }, state.toast.text)
        )
      );
    }

    // HOME (no room yet)
    if (!state.room || (!roomFromPath() && roomFromQuery() && location.pathname === "/")) {
      const card = h(
        "div",
        { class: "max-w-6xl mx-auto p-4 md:p-6 grid grid-cols-1 lg:grid-cols-2 gap-4 pop" },

        // Create lobby
        h(
          "div",
          { class: "rounded-3xl border border-zinc-800/80 bg-zinc-900/35 backdrop-blur p-6 shadow-xl" },
          h("div", { class: "text-xl font-bold" }, "🎮 Создать лобби"),
          h("div", { class: "text-sm text-zinc-300/80 mt-1" }, "Выбери регион/страну и играйте вместе."),
          h("div", { class: "mt-5 grid grid-cols-1 gap-3" },
            h("input", {
              class:
                "px-4 py-3 rounded-2xl bg-zinc-950/40 border border-zinc-800 outline-none focus:ring-2 focus:ring-indigo-500/60",
              placeholder: "Ник (необязательно)",
              value: state.name,
              oninput: (e) => (state.name = e.target.value),
            }),
            h(
              "select",
              {
                id: "regionSel",
                class:
                  "px-4 py-3 rounded-2xl bg-zinc-950/40 border border-zinc-800 outline-none focus:ring-2 focus:ring-indigo-500/60",
              },
              h("option", { value: "WORLD" }, "Регион: Весь мир"),
              h("option", { value: "EUROPE" }, "Регион: Европа"),
              h("option", { value: "N_AMERICA" }, "Регион: Северная Америка"),
              h("option", { value: "S_AMERICA" }, "Регион: Южная Америка"),
              h("option", { value: "ASIA" }, "Регион: Азия"),
              h("option", { value: "AFRICA" }, "Регион: Африка"),
              h("option", { value: "OCEANIA" }, "Регион: Океания"),
              h("option", { value: "RU" }, "Регион: Россия")
            ),
            h(
              "select",
              {
                id: "countrySel",
                class:
                  "px-4 py-3 rounded-2xl bg-zinc-950/40 border border-zinc-800 outline-none focus:ring-2 focus:ring-indigo-500/60",
              },
              h("option", { value: "" }, "Страна: (не выбрано)"),
              h("option", { value: "RU" }, "Россия"),
              h("option", { value: "KZ" }, "Казахстан"),
              h("option", { value: "TR" }, "Турция"),
              h("option", { value: "DE" }, "Германия"),
              h("option", { value: "FR" }, "Франция"),
              h("option", { value: "GB" }, "Великобритания"),
              h("option", { value: "US" }, "США"),
              h("option", { value: "JP" }, "Япония")
            ),
            h(
              "button",
              {
                class:
                  "px-4 py-3 rounded-2xl bg-indigo-600 hover:bg-indigo-500 transition shadow-lg shadow-indigo-600/20 font-semibold",
                onclick: () => {
                  const region = document.getElementById("regionSel").value;
                  const country = document.getElementById("countrySel").value;
                  createLobby(region, country);
                },
                disabled: state.creating ? "true" : null,
              },
              state.creating ? "Создаём…" : "Создать лобби"
            ),
            h(
              "div",
              { class: "text-xs text-zinc-400/80" },
              "Если панорама не найдена, хост автоматически сделает несколько 🔁."
            )
          )
        ),

        // Join by code
        h(
          "div",
          { class: "rounded-3xl border border-zinc-800/80 bg-zinc-900/35 backdrop-blur p-6 shadow-xl" },
          h("div", { class: "text-xl font-bold" }, "🔑 Войти по коду"),
          h("div", { class: "text-sm text-zinc-300/80 mt-1" }, "Если тебя пригласили — вставь код комнаты."),
          h("div", { class: "mt-5 grid grid-cols-1 gap-3" },
            h("input", {
              class:
                "px-4 py-3 rounded-2xl bg-zinc-950/40 border border-zinc-800 outline-none focus:ring-2 focus:ring-emerald-500/60 tracking-widest uppercase",
              placeholder: "КОД (например: A1B2C3)",
              value: state.joinCodeInput,
              oninput: (e) => (state.joinCodeInput = clampCode(e.target.value)),
            }),
            h(
              "button",
              {
                class:
                  "px-4 py-3 rounded-2xl bg-emerald-600 hover:bg-emerald-500 transition shadow-lg shadow-emerald-600/20 font-semibold",
                onclick: () => goToRoom(state.joinCodeInput),
              },
              "Войти"
            ),
            h(
              "div",
              { class: "text-xs text-zinc-400/80" },
              "Юзербот может присылать ссылку вида: ",
              h("span", { class: "text-zinc-200" }, `${location.origin}/room/ABC123`),
              " — тогда код подставится автоматически ✅"
            )
          )
        )
      );

      el.appendChild(card);

      // если пришли на /?code=XXXXXX — авто-переход
      const qcode = roomFromQuery();
      if (qcode && location.pathname === "/") {
        setTimeout(() => goToRoom(qcode), 250);
      }
      return;
    }

    // IN ROOM
    const server = state.server;
    const isHost = server && server.host_user_id === state.user;
    const cr = server && server.current_round;
    const canGuess = server && server.game_status === "running" && cr && cr.status === "running";

    const grid = h("div", { class: "max-w-6xl mx-auto p-4 md:p-6 grid grid-cols-1 lg:grid-cols-3 gap-4 pop" });

    const panoWrap = h(
      "div",
      { class: "lg:col-span-2 rounded-3xl border border-zinc-800/80 bg-zinc-900/35 backdrop-blur overflow-hidden shadow-xl" },
      h(
        "div",
        { class: "p-4 flex items-center justify-between border-b border-zinc-800/70" },
        h("div", { class: "font-bold text-lg" }, "🌐 Панорама"),
        h(
          "div",
          { class: "text-xs text-zinc-300/70" },
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
      h(
        "div",
        { class: "p-4 flex items-center justify-between border-b border-zinc-800/70" },
        h("div", { class: "font-bold" }, "🗺️ Мини-карта"),
        h("div", { id: "guess-status", class: "text-xs text-zinc-300/70" }, state.guess ? "Точка выбрана 📍" : "Выбери точку")
      ),
      h("div", { id: "minimap", class: "h-[320px] relative" }),
      h(
        "div",
        { class: "p-4 flex gap-2" },
        h(
          "button",
          {
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
          },
          "Отправить"
        ),
        h(
          "button",
          {
            class: "px-4 py-3 rounded-2xl bg-zinc-800 hover:bg-zinc-700 transition",
            onclick: () => {
              state.guess = null;
              render();
            },
            title: "Сбросить",
          },
          "↺"
        )
      )
    );

    const controls = h(
      "div",
      { class: "rounded-3xl border border-zinc-800/80 bg-zinc-900/35 backdrop-blur overflow-hidden shadow-xl" },
      h(
        "div",
        { class: "p-4 border-b border-zinc-800/70 flex items-center justify-between" },
        h("div", { class: "font-bold" }, "🎛️ Управление"),
        h("div", { class: "text-xs text-zinc-300/70" }, isHost ? "Хост" : "Игрок")
      ),
      h(
        "div",
        { class: "p-4 flex gap-2" },
        h(
          "button",
          {
            class:
              `flex-1 px-4 py-3 rounded-2xl font-semibold transition shadow-lg ` +
              (isHost
                ? "bg-indigo-600 hover:bg-indigo-500 shadow-indigo-600/20"
                : "bg-zinc-800 text-zinc-400 cursor-not-allowed"),
            onclick: () => {
              if (isHost) send({ t: "start_game" });
            },
          },
          server && server.game_status === "lobby" ? "Начать игру" : "Игра идёт"
        ),
        h(
          "button",
          {
            class:
              `px-4 py-3 rounded-2xl transition ` +
              (isHost ? "bg-zinc-800 hover:bg-zinc-700" : "bg-zinc-800 text-zinc-400 cursor-not-allowed"),
            onclick: () => {
              if (isHost) send({ t: "reroll" });
            },
            title: "Если панорама не находится",
          },
          "🔁"
        )
      ),
      h("div", { class: "px-4 pb-4 text-xs text-zinc-300/70" },
        "Ссылка комнаты: ",
        h("span", { class: "text-zinc-100" }, `${location.origin}/room/${state.room}`)
      )
    );

    const leaderboard = h(
      "div",
      { class: "rounded-3xl border border-zinc-800/80 bg-zinc-900/35 backdrop-blur overflow-hidden shadow-xl" },
      h(
        "div",
        { class: "p-4 border-b border-zinc-800/70 flex items-center justify-between" },
        h("div", { class: "font-bold" }, "🏆 Лидерборд"),
        h("div", { class: "text-xs text-zinc-300/70" }, server ? `${server.players.length} игроков` : "")
      ),
      h(
        "div",
        { class: "p-4 space-y-2" },
        ...(server
          ? server.players.slice(0, 15).map((p, idx) => {
              const you = p.user_id === state.user;
              const sub =
                cr && cr.status !== "running" && p.last_distance_km != null
                  ? `• ${p.last_distance_km.toFixed(0)} км • +${p.last_score}`
                  : p.has_guessed
                  ? "• ответил"
                  : "• ждём";
              return h(
                "div",
                {
                  class:
                    "flex items-center justify-between rounded-2xl px-4 py-3 border border-zinc-800/70 bg-zinc-950/20 " +
                    (you ? "ring-2 ring-indigo-500/50" : ""),
                },
                h(
                  "div",
                  { class: "flex items-center gap-2" },
                  h("div", { class: "text-xs text-zinc-300/70 w-7" }, `#${idx + 1}`),
                  h("div", { class: "font-semibold" }, p.name || p.user_id),
                  h("div", { class: "text-[11px] text-zinc-300/60" }, sub)
                ),
                h("div", { class: "font-extrabold tabular-nums" }, String(p.total_score))
              );
            })
          : [h("div", { class: "text-sm text-zinc-300/70" }, "Подключаемся…")])
      )
    );

    const right = h("div", { class: "lg:col-span-1 flex flex-col gap-4" }, mini, controls, leaderboard);

    grid.appendChild(panoWrap);
    grid.appendChild(right);

    if (server && cr && cr.status === "reveal") {
      const reveal = h(
        "div",
        { class: "lg:col-span-3 rounded-3xl border border-zinc-800/80 bg-zinc-900/35 backdrop-blur overflow-hidden shadow-xl" },
        h(
          "div",
          { class: "p-4 border-b border-zinc-800/70 flex items-center justify-between" },
          h("div", { class: "font-bold text-lg" }, "📌 Результаты раунда"),
          h("div", { class: "text-xs text-zinc-300/70" }, "★ истинное место • линии до отметок")
        ),
        h("div", { class: "h-[380px] relative", id: "revealmap" })
      );
      grid.appendChild(reveal);
    }

    el.appendChild(grid);

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

  // ✅ если мы уже знаем room — сразу подключаемся
  if (state.room && location.pathname.startsWith("/room/")) {
    connectWS();
  } else {
    // если пришли на /?code=ABC123 — отрисуем домашнюю и автоперейдём (см render)
  }

  render();
})();
