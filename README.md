# FreeGuessr (Yandex Maps + Panoramas) — Render-ready

GeoGuessr-like WebApp:
- Backend: Python aiohttp + WebSocket (лобби, таймер, лидерборд, reveal)
- Frontend: Tailwind CDN + Yandex Maps JS API 2.1 + Yandex Panoramas

## Render
Create **Web Service**
- Build: `pip install -r requirements.txt`
- Start: `python server.py`

## Env vars
- `YANDEX_MAPS_API_KEY` — ключ Яндекс JS API 2.1
- `PUBLIC_BASE_URL` — URL Render сервиса (например `https://xxxxx.onrender.com`)
- `SIGNING_SECRET` — любая длинная строка (опционально)

## Regions / Countries
Настраиваются в лобби (континент/страна). Если панорама не найдена рядом — хост автоматически делает несколько reroll.

## Telegram WebApp
Кнопка web_app должна вести на:
`https://xxxxx.onrender.com/room/ABC123?user=<id>&sig=<sig>&name=<name>`
