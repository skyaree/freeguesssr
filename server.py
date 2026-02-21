import os
import json
import hmac
import time
import math
import asyncio
import base64
import secrets
import hashlib
from dataclasses import dataclass, field
from typing import Dict, Optional, Tuple, List
from urllib.parse import quote

from aiohttp import web, WSMsgType


HOST = "0.0.0.0"
PORT = int(os.getenv("PORT", "10000"))

PUBLIC_BASE_URL = os.getenv("PUBLIC_BASE_URL", "")
YANDEX_MAPS_API_KEY = os.getenv("YANDEX_MAPS_API_KEY", "")
SIGNING_SECRET = os.getenv("SIGNING_SECRET", "") or secrets.token_urlsafe(32)

ROUNDS_TOTAL_DEFAULT = int(os.getenv("ROUNDS_TOTAL", "5"))
ROUND_SECONDS_DEFAULT = int(os.getenv("ROUND_SECONDS", "90"))
REVEAL_SECONDS_DEFAULT = int(os.getenv("REVEAL_SECONDS", "12"))
MAX_PLAYERS = int(os.getenv("MAX_PLAYERS", "30"))

# bbox: [lat_min, lng_min, lat_max, lng_max]
REGIONS = {
    "WORLD":     {"name": "Весь мир",          "bbox": [-55, -170, 70, 170]},
    "EUROPE":    {"name": "Европа",            "bbox": [34, -11, 71, 40]},
    "N_AMERICA": {"name": "Северная Америка",  "bbox": [15, -168, 72, -52]},
    "S_AMERICA": {"name": "Южная Америка",     "bbox": [-56, -82, 13, -34]},
    "ASIA":      {"name": "Азия",              "bbox": [1, 25, 78, 180]},
    "AFRICA":    {"name": "Африка",            "bbox": [-35, -20, 38, 55]},
    "OCEANIA":   {"name": "Океания",           "bbox": [-47, 110, -5, 180]},
    "RU":        {"name": "Россия",            "bbox": [41, 19, 82, 180]},
}

COUNTRIES = {
    "RU": {"name": "Россия", "bbox": REGIONS["RU"]["bbox"]},
    "KZ": {"name": "Казахстан", "bbox": [40.5, 46.5, 55.5, 87.5]},
    "TR": {"name": "Турция", "bbox": [35.8, 25.6, 42.2, 44.8]},
    "DE": {"name": "Германия", "bbox": [47.2, 5.9, 55.1, 15.1]},
    "FR": {"name": "Франция", "bbox": [41.0, -5.2, 51.3, 9.6]},
    "GB": {"name": "Великобритания", "bbox": [49.8, -8.6, 60.9, 1.8]},
    "US": {"name": "США (континентальная часть)", "bbox": [24.5, -124.8, 49.4, -66.9]},
    "JP": {"name": "Япония", "bbox": [30.0, 129.0, 45.8, 146.0]},
}


def now_ms() -> int:
    return int(time.time() * 1000)


def b64url(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).decode().rstrip("=")


def sign_payload(payload: str) -> str:
    mac = hmac.new(SIGNING_SECRET.encode(), payload.encode(), hashlib.sha256).digest()
    return b64url(mac)


def verify_sig(payload: str, sig: str) -> bool:
    return hmac.compare_digest(sign_payload(payload), sig)


def haversine_km(a: Tuple[float, float], b: Tuple[float, float]) -> float:
    lat1, lon1 = a
    lat2, lon2 = b
    R = 6371.0
    p1 = math.radians(lat1)
    p2 = math.radians(lat2)
    dlat = math.radians(lat2 - lat1)
    dlon = math.radians(lon2 - lon1)
    x = (math.sin(dlat / 2) ** 2) + math.cos(p1) * math.cos(p2) * (math.sin(dlon / 2) ** 2)
    return 2 * R * math.asin(min(1.0, math.sqrt(x)))


def score_from_distance_km(d: float) -> int:
    # “геогесср-подобная” кривая: близко -> много, далеко -> мало
    s = 5000.0 * math.exp(-d / 2000.0)
    return int(max(0, min(5000, round(s))))


def safe_int(x, default):
    try:
        return int(x)
    except Exception:
        return default


def safe_float(x, default):
    try:
        return float(x)
    except Exception:
        return default


def pick_point(bbox: List[float]) -> Tuple[float, float]:
    lat_min, lng_min, lat_max, lng_max = bbox
    # secrets.randbelow -> криптостойко, плюс равномерно
    lat = lat_min + secrets.randbelow(10_000_000) / 10_000_000 * (lat_max - lat_min)
    lng = lng_min + secrets.randbelow(10_000_000) / 10_000_000 * (lng_max - lng_min)
    return (lat, lng)


@dataclass
class Player:
    user_id: str
    name: str = ""
    total_score: int = 0
    has_guessed: bool = False
    guess: Optional[Tuple[float, float]] = None
    last_distance_km: Optional[float] = None
    last_score: Optional[int] = None


@dataclass
class Round:
    index: int
    seed_lat: float
    seed_lng: float
    started_at_ms: int
    ends_at_ms: int
    reveal_ends_at_ms: int
    status: str = "running"   # running|reveal|ended
    true_lat: Optional[float] = None
    true_lng: Optional[float] = None


@dataclass
class Room:
    code: str
    host_user_id: str
    created_at_ms: int = field(default_factory=now_ms)

    rounds_total: int = ROUNDS_TOTAL_DEFAULT
    round_seconds: int = ROUND_SECONDS_DEFAULT
    reveal_seconds: int = REVEAL_SECONDS_DEFAULT

    region: str = "WORLD"
    country: str = ""

    round_number: int = 0
    game_status: str = "lobby"  # lobby|countdown|running|finished
    countdown_ends_at_ms: int = 0
    countdown_task: Optional[asyncio.Task] = None

    current_round: Optional[Round] = None
    players: Dict[str, Player] = field(default_factory=dict)
    ws: Dict[str, web.WebSocketResponse] = field(default_factory=dict)
    timer_task: Optional[asyncio.Task] = None

    def bbox(self) -> List[float]:
        if self.country and self.country in COUNTRIES:
            return COUNTRIES[self.country]["bbox"]
        if self.region in REGIONS:
            return REGIONS[self.region]["bbox"]
        return REGIONS["WORLD"]["bbox"]

    def public_state(self) -> dict:
        cr = self.current_round
        players_sorted = sorted(self.players.values(), key=lambda p: p.total_score, reverse=True)

        guesses = []
        for p in players_sorted:
            if p.guess:
                guesses.append({
                    "user_id": p.user_id,
                    "name": p.name,
                    "lat": p.guess[0],
                    "lng": p.guess[1],
                    "distance_km": p.last_distance_km,
                    "score": p.last_score,
                })

        return {
            "code": self.code,
            "host_user_id": self.host_user_id,
            "game_status": self.game_status,
            "countdown_ends_at_ms": self.countdown_ends_at_ms,
            "round_number": self.round_number,
            "rounds_total": self.rounds_total,
            "round_seconds": self.round_seconds,
            "reveal_seconds": self.reveal_seconds,
            "region": self.region,
            "country": self.country,
            "regions": {k: v["name"] for k, v in REGIONS.items()},
            "countries": {k: v["name"] for k, v in COUNTRIES.items()},
            "current_round": None if not cr else {
                "index": cr.index,
                "seed_lat": cr.seed_lat,
                "seed_lng": cr.seed_lng,
                "started_at_ms": cr.started_at_ms,
                "ends_at_ms": cr.ends_at_ms,
                "reveal_ends_at_ms": cr.reveal_ends_at_ms,
                "status": cr.status,
                "true": None if cr.true_lat is None else {"lat": cr.true_lat, "lng": cr.true_lng},
            },
            "players": [{
                "user_id": p.user_id,
                "name": p.name,
                "total_score": p.total_score,
                "has_guessed": p.has_guessed,
                "last_distance_km": p.last_distance_km,
                "last_score": p.last_score,
            } for p in players_sorted],
            "guesses": guesses,
        }


ROOMS: Dict[str, Room] = {}
LOCK = asyncio.Lock()

THIS_DIR = os.path.dirname(os.path.abspath(__file__))
STATIC_DIR = os.path.join(THIS_DIR, "static")
routes = web.RouteTableDef()


def render_index_html() -> str:
    with open(os.path.join(STATIC_DIR, "index.html"), "r", encoding="utf-8") as f:
        html = f.read()
    return html.replace("__YMAPS_KEY__", YANDEX_MAPS_API_KEY or "")


async def ws_send(ws, obj):
    try:
        await ws.send_str(json.dumps(obj, ensure_ascii=False))
    except Exception:
        pass


async def broadcast(room: Room, obj: dict):
    dead = []
    for uid, ws in room.ws.items():
        if ws.closed:
            dead.append(uid)
            continue
        await ws_send(ws, obj)
    for uid in dead:
        room.ws.pop(uid, None)


@routes.get("/healthz")
async def healthz(_req):
    return web.json_response({"ok": True, "ts": int(time.time())})


@routes.get("/")
async def index(_req):
    return web.Response(text=render_index_html(), content_type="text/html")


@routes.get("/room/{code}")
async def room_page(_req):
    return web.Response(text=render_index_html(), content_type="text/html")


@routes.get("/static/{name}")
async def static_files(req):
    name = req.match_info["name"]
    path = os.path.join(STATIC_DIR, name)
    if not os.path.isfile(path):
        return web.Response(status=404, text="Not found")
    ctype = "application/javascript" if name.endswith(".js") else "text/plain"
    return web.FileResponse(path, headers={"Content-Type": ctype})


@routes.post("/api/create_room")
async def api_create_room(req):
    # важно: если тут исключение -> aiohttp отдаст HTML 500 -> фронт упадёт на JSON.parse
    data = await req.json()

    host_user_id = str(data.get("host_user_id") or "")
    name = str(data.get("name") or "Host")
    rounds_total = safe_int(data.get("rounds_total"), ROUNDS_TOTAL_DEFAULT)
    round_seconds = safe_int(data.get("round_seconds"), ROUND_SECONDS_DEFAULT)
    reveal_seconds = safe_int(data.get("reveal_seconds"), REVEAL_SECONDS_DEFAULT)
    region = str(data.get("region") or "WORLD").upper()
    country = str(data.get("country") or "").upper()

    if not host_user_id:
        return web.json_response({"ok": False, "error": "host_user_id required"}, status=400)

    rounds_total = max(1, min(20, rounds_total))
    round_seconds = max(15, min(600, round_seconds))
    reveal_seconds = max(5, min(40, reveal_seconds))
    if region not in REGIONS:
        region = "WORLD"
    if country and country not in COUNTRIES:
        country = ""

    async with LOCK:
        while True:
            code = "".join(secrets.choice("ABCDEFGHJKLMNPQRSTUVWXYZ23456789") for _ in range(6))
            if code not in ROOMS:
                room = Room(
                    code=code,
                    host_user_id=host_user_id,
                    rounds_total=rounds_total,
                    round_seconds=round_seconds,
                    reveal_seconds=reveal_seconds,
                    region=region,
                    country=country,
                )
                room.players[host_user_id] = Player(user_id=host_user_id, name=name)
                ROOMS[code] = room
                break

    payload = f"{code}:{host_user_id}"
    sig = sign_payload(payload)

    base = (PUBLIC_BASE_URL or f"{req.scheme}://{req.host}").rstrip("/")
    join_url = f"{base}/room/{code}?user={quote(host_user_id)}&sig={quote(sig)}&name={quote(name)}"
    return web.json_response({"ok": True, "code": code, "join_url": join_url, "sig": sig})


async def start_round(room: Room):
    room.round_number += 1
    lat, lng = pick_point(room.bbox())

    st = now_ms()
    et = st + room.round_seconds * 1000
    rt = et + room.reveal_seconds * 1000

    for p in room.players.values():
        p.has_guessed = False
        p.guess = None
        p.last_distance_km = None
        p.last_score = None

    room.current_round = Round(
        index=room.round_number,
        seed_lat=lat,
        seed_lng=lng,
        started_at_ms=st,
        ends_at_ms=et,
        reveal_ends_at_ms=rt,
        status="running",
    )
    room.game_status = "running"
    await broadcast(room, {"t": "state", "state": room.public_state()})
    await broadcast(room, {"t": "toast", "kind": "info", "text": f"Раунд {room.round_number}/{room.rounds_total} начался!"})

    if room.timer_task and not room.timer_task.done():
        room.timer_task.cancel()
    room.timer_task = asyncio.create_task(timer_loop(room))


async def start_countdown(room: Room, seconds: int = 5):
    if room.game_status != "lobby":
        return

    room.game_status = "countdown"
    room.countdown_ends_at_ms = now_ms() + seconds * 1000
    await broadcast(room, {"t": "countdown", "ends_at_ms": room.countdown_ends_at_ms})
    await broadcast(room, {"t": "state", "state": room.public_state()})

    async def _job():
        try:
            while now_ms() < room.countdown_ends_at_ms:
                await asyncio.sleep(0.1)
            async with LOCK:
                if room.game_status == "countdown":
                    await start_round(room)
        except asyncio.CancelledError:
            return

    if room.countdown_task and not room.countdown_task.done():
        room.countdown_task.cancel()
    room.countdown_task = asyncio.create_task(_job())


async def finish_round(room: Room):
    cr = room.current_round
    if not cr:
        return

    true_lat = cr.true_lat if cr.true_lat is not None else cr.seed_lat
    true_lng = cr.true_lng if cr.true_lng is not None else cr.seed_lng
    cr.true_lat, cr.true_lng = true_lat, true_lng

    best_d = None
    winners: List[str] = []
    no_guess: List[str] = []

    for uid, p in room.players.items():
        if not p.has_guessed or not p.guess:
            no_guess.append(uid)
            continue

        d = haversine_km((true_lat, true_lng), p.guess)
        s = score_from_distance_km(d)

        p.last_distance_km = float(d)
        p.last_score = int(s)
        p.total_score += s

        if best_d is None or d < best_d:
            best_d = d
            winners = [uid]
        elif d == best_d:
            winners.append(uid)

    await broadcast(room, {
        "t": "round_end",
        "winners": winners,
        "no_guess": no_guess,
        "best_distance_km": None if best_d is None else float(best_d),
    })
    await broadcast(room, {"t": "state", "state": room.public_state()})


async def timer_loop(room: Room):
    try:
        while True:
            await asyncio.sleep(0.25)
            async with LOCK:
                cr = room.current_round
                if not cr:
                    return

                t = now_ms()

                if cr.status == "running":
                    left = cr.ends_at_ms - t
                    await broadcast(room, {"t": "timer", "phase": "guess", "ms_left": max(0, left)})
                    if left <= 0:
                        cr.status = "reveal"
                        await finish_round(room)
                        await broadcast(room, {"t": "toast", "kind": "info", "text": "Результаты 👀"})
                        await broadcast(room, {"t": "state", "state": room.public_state()})

                elif cr.status == "reveal":
                    left = cr.reveal_ends_at_ms - t
                    await broadcast(room, {"t": "timer", "phase": "reveal", "ms_left": max(0, left)})
                    if left <= 0:
                        cr.status = "ended"
                        await broadcast(room, {"t": "state", "state": room.public_state()})

                        if room.round_number >= room.rounds_total:
                            room.game_status = "finished"
                            await broadcast(room, {"t": "toast", "kind": "ok", "text": "Игра завершена 🏁"})
                            await broadcast(room, {"t": "state", "state": room.public_state()})
                            return

                        await asyncio.sleep(0.75)
                        await start_round(room)
                        return
                else:
                    return
    except asyncio.CancelledError:
        return


@routes.get("/ws")
async def ws_handler(req):
    code = (req.query.get("room") or "").upper()
    user = str(req.query.get("user") or "")
    sig = str(req.query.get("sig") or "")
    name = str(req.query.get("name") or "")

    ws = web.WebSocketResponse(heartbeat=20)
    await ws.prepare(req)

    if not code or not user:
        await ws_send(ws, {"t": "toast", "kind": "error", "text": "room/user required"})
        await ws.close()
        return ws

    # подпись опциональна: если пришла — проверим
    if sig:
        payload = f"{code}:{user}"
        if not verify_sig(payload, sig):
            await ws_send(ws, {"t": "toast", "kind": "error", "text": "bad signature"})
            await ws.close()
            return ws

    async with LOCK:
        room = ROOMS.get(code)
        if not room:
            await ws_send(ws, {"t": "toast", "kind": "error", "text": "room not found"})
            await ws.close()
            return ws

        if user not in room.players and len(room.players) >= MAX_PLAYERS:
            await ws_send(ws, {"t": "toast", "kind": "error", "text": "room full"})
            await ws.close()
            return ws

        if user not in room.players:
            room.players[user] = Player(user_id=user, name=name or f"User {user}")
        else:
            if name:
                room.players[user].name = name

        room.ws[user] = ws

    await ws_send(ws, {"t": "state", "state": room.public_state()})
    await ws_send(ws, {"t": "toast", "kind": "ok", "text": "Подключено ✅"})

    async for msg in ws:
        if msg.type != WSMsgType.TEXT:
            continue

        try:
            data = json.loads(msg.data)
        except Exception:
            await ws_send(ws, {"t": "toast", "kind": "error", "text": "invalid json"})
            continue

        t = data.get("t")

        async with LOCK:
            room = ROOMS.get(code)
            if not room:
                continue
            is_host = (room.host_user_id == user)
            cr = room.current_round

            if t == "start_game":
                if is_host and room.game_status == "lobby":
                    await start_countdown(room, seconds=5)

            elif t == "set_settings":
                if not is_host or room.game_status != "lobby":
                    continue
                region = str(data.get("region") or room.region).upper()
                country = str(data.get("country") or room.country).upper()
                if region in REGIONS:
                    room.region = region
                if country == "" or country in COUNTRIES:
                    room.country = country
                await broadcast(room, {"t": "state", "state": room.public_state()})

            elif t == "pano_ready":
                # фиксируем координаты реальной панорамы для честного reveal/scoring
                if not is_host or not cr or cr.status != "running":
                    continue
                if cr.true_lat is None:
                    cr.true_lat = safe_float(data.get("trueLat"), cr.seed_lat)
                    cr.true_lng = safe_float(data.get("trueLng"), cr.seed_lng)
                    await broadcast(room, {"t": "state", "state": room.public_state()})

            elif t == "guess":
                if not cr or cr.status != "running" or room.game_status != "running":
                    await ws_send(ws, {"t": "toast", "kind": "error", "text": "Нельзя угадывать сейчас"})
                    continue
                lat = safe_float(data.get("lat"), None)
                lng = safe_float(data.get("lng"), None)
                if lat is None or lng is None:
                    continue
                p = room.players.get(user)
                if not p or p.has_guessed:
                    continue
                p.guess = (lat, lng)
                p.has_guessed = True
                await broadcast(room, {"t": "state", "state": room.public_state()})

            elif t == "reroll":
                if not is_host or not cr or cr.status != "running":
                    continue
                lat, lng = pick_point(room.bbox())
                cr.seed_lat, cr.seed_lng = lat, lng
                cr.true_lat, cr.true_lng = None, None
                await broadcast(room, {"t": "toast", "kind": "info", "text": "Место перегенерировано 🔁"})
                await broadcast(room, {"t": "state", "state": room.public_state()})

    async with LOCK:
        room = ROOMS.get(code)
        if room:
            room.ws.pop(user, None)
    return ws


def create_app() -> web.Application:
    app = web.Application()
    app.add_routes(routes)
    return app


if __name__ == "__main__":
    web.run_app(create_app(), host=HOST, port=PORT)
