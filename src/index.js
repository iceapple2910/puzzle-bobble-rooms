import { DurableObject } from "cloudflare:workers";
import { DIAG_PAGE } from "./diag_page.js";

const CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const ROOM_LIFETIME_MS = 6 * 60 * 60 * 1000;

/** Raw WebSocket frame cap (JSON). Full dual-board snaps need headroom. */
const MAX_WS_MESSAGE_CHARS = 65536;
/** Per game-event data JSON size caps. */
const GAME_DATA_LIMITS = {
  match_init: 2048,
  client_input: 512,
  state: 49152,
  sfx: 2048,
  quit: 256,
  /** WebRTC signaling (SDP can be large; still capped). */
  webrtc_sdp: 24576,
  webrtc_ice: 2048
};
const ALLOWED_GAME_EVENTS = new Set(Object.keys(GAME_DATA_LIMITS));
/** Signaling allowed before match_start (room join only). */
const WEBRTC_SIGNAL_EVENTS = new Set(["webrtc_sdp", "webrtc_ice"]);
/** Per-slot rate limits for signaling abuse prevention. */
const SIGNAL_RATE = {
  webrtc_sdp: { windowMs: 10000, max: 8 },
  webrtc_ice: { windowMs: 10000, max: 60 }
};
/** Northeast Asia-Pacific (KR/JP) — best-effort; only first getByName for a name applies. */
const ROOM_LOCATION_HINT = "apac-ne";

function roomStub(env, code) {
  return env.ROOMS.getByName(code, { locationHint: ROOM_LOCATION_HINT });
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "GET, POST, OPTIONS",
      "access-control-allow-headers": "content-type"
    }
  });
}

function randomRoomCode() {
  const bytes = crypto.getRandomValues(new Uint8Array(6));
  return Array.from(bytes, x => CODE_CHARS[x % CODE_CHARS.length]).join("");
}

function isRoomCode(code) {
  return typeof code === "string" && code.length === 6 &&
    [...code].every(ch => CODE_CHARS.includes(ch));
}

function dataSize(data) {
  try {
    return JSON.stringify(data ?? null).length;
  } catch (_) {
    return Number.MAX_SAFE_INTEGER;
  }
}

function edgeColo(request) {
  return request.cf?.colo || null;
}

/**
 * Worker-only WebSocket echo — does NOT touch Durable Objects / storage.
 * Terminates at the edge colo that accepted the upgrade (≠ DO location).
 */
function handleWorkerEchoWs(request) {
  if (request.method !== "GET" || request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
    return json({ error: "websocket_upgrade_required", path: "/api/echo/ws" }, 426);
  }
  const colo = edgeColo(request);
  const pair = new WebSocketPair();
  const [client, server] = Object.values(pair);
  server.accept();
  server.send(JSON.stringify({
    type: "echo_hello",
    via: "worker",
    edge_colo: colo,
    note: "WS terminates at Worker edge colo; this is NOT the Durable Object location"
  }));
  server.addEventListener("message", (event) => {
    const t0 = performance.now();
    const raw = typeof event.data === "string" ? event.data : "";
    if (raw.length > 4096) return;
    let msg;
    try { msg = JSON.parse(raw); } catch (_) { return; }
    if (!msg || typeof msg !== "object") return;
    if (msg.type !== "diag_echo" && msg.type !== "echo") return;
    const procMs = Math.round((performance.now() - t0) * 1000) / 1000;
    server.send(JSON.stringify({
      type: "diag_echo_reply",
      id: msg.id,
      token: msg.token ?? null,
      t_client_us: msg.t_client_us ?? null,
      path: "worker",
      via: "worker",
      edge_colo: colo,
      server_proc_ms: procMs
    }));
  });
  return new Response(null, { status: 101, webSocket: client });
}

const TEST_PAGE = "<!doctype html>\n<html lang=\"ko\">\n<head>\n<meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">\n<title>Bubble Battle — 서버 테스트</title>\n<style>\n:root{font-family:system-ui,sans-serif;color:#ecf3ff;background:#10172a}\n*{box-sizing:border-box}main{max-width:620px;margin:8vh auto;padding:24px;border:1px solid #344b70;border-radius:18px;background:#1a2540}\nh1{margin-top:0}p{color:#b9c8e7}input,button{padding:12px;border-radius:9px;font:inherit}input{background:#101a30;color:white;border:1px solid #496088;text-transform:uppercase;width:140px}\nbutton{background:#427fea;color:white;border:0;cursor:pointer}button.secondary{background:#3e536e}button:disabled{opacity:.45;cursor:default}\n.row{display:flex;gap:9px;flex-wrap:wrap;margin:12px 0}.status{padding:12px;border-radius:8px;background:#0b1833;color:#a9d3ff}\n#log{white-space:pre-wrap;height:220px;overflow:auto;background:#0b1222;border-radius:10px;padding:12px;font:12px/1.6 monospace;color:#c1dbfa}\ncode{color:#ffd977}small{color:#95aacc}\n</style>\n</head>\n<body><main>\n<h1>🫧 Bubble Battle · 서버 테스트</h1>\n<p>Cloudflare Workers + Durable Objects 연결 테스트. 지연 원인 분리 벤치: <a href=\"/diag\" style=\"color:#ffd977\">/diag (Worker vs DO Echo)</a></p>\n<div class=\"row\"><button id=\"create\">새 방 만들기</button><input id=\"code\" maxlength=\"6\" placeholder=\"방 코드\" autocomplete=\"off\"><button id=\"join\" class=\"secondary\">방 참가</button></div>\n<div id=\"status\" class=\"status\">연결 안 됨</div>\n<div class=\"row\"><button id=\"ready\" disabled>준비 완료</button><button id=\"send\" disabled class=\"secondary\">테스트 메시지 전송</button><button id=\"leave\" disabled class=\"secondary\">연결 해제</button></div>\n<p><small>테스트 방법: 한 탭에서 방 만들기 → 다른 탭/기기에서 같은 사이트 접속 → 코드 입력 → 두 쪽에서 준비 완료 → 메시지 전송</small></p>\n<div id=\"log\" aria-label=\"서버 로그\"></div>\n</main>\n<script>\nlet socket=null, roomCode=null, hostToken=null, ready=false;\nconst $=id=>document.getElementById(id);\nfunction log(s){ $('log').textContent += `${new Date().toLocaleTimeString()} ${s}\\n`; $('log').scrollTop=$('log').scrollHeight; }\nfunction status(s){ $('status').textContent=s; }\nfunction send(m){if(socket && socket.readyState===WebSocket.OPEN) socket.send(JSON.stringify(m));}\nfunction controls(connected){$('ready').disabled=!connected;$('send').disabled=!connected;$('leave').disabled=!connected;}\nfunction connect(code,token){\n  if(socket)socket.close();\n  roomCode=code;hostToken=token;ready=false;\n  const protocol=location.protocol==='https:'?'wss:':'ws:';\n  socket=new WebSocket(`${protocol}//${location.host}/api/rooms/${code}/ws`);\n  status(`방 ${code} 접속 중...`);\n  socket.onopen=()=>{send({type:'join',host_token:token});log('WebSocket 연결됨');};\n  socket.onmessage=e=>{let m;try{m=JSON.parse(e.data)}catch{return}; log(JSON.stringify(m));\n    if(m.type==='joined'){controls(true);status(`방 ${code} | ${m.role==='host'?'방장 (1P)':'참가자 (2P)'}`)}\n    if(m.type==='match_start')status(`방 ${code} | 양쪽 준비 완료, 게임 시작 이벤트 수신!`);\n    if(m.type==='error')status(`오류: ${m.error}`);\n    if(m.type==='player_left')status(`방 ${code} | ${m.player}P가 나감`);\n  };\n  socket.onerror=()=>log('연결 오류. 주소 및 배포 설정 확인.');\n  socket.onclose=e=>{log(`연결 종료 ${e.code}`);controls(false);ready=false;status('연결 종료됨')};\n}\n$('create').onclick=async()=>{\n  try{let r=await fetch('/api/rooms',{method:'POST'});let d=await r.json();if(!d.ok)throw Error(JSON.stringify(d));\n    $('code').value=d.code;log(`방 생성 성공: ${d.code}`);connect(d.code,d.host_token);\n  }catch(e){log('방 생성 실패: '+e.message)}\n};\n$('join').onclick=()=>{const code=$('code').value.toUpperCase().trim();if(code.length!==6)return status('6자리 코드를 입력해 줘');connect(code,null)};\n$('ready').onclick=()=>{ready=!ready;send({type:'ready',ready});$('ready').textContent=ready?'준비 취소':'준비 완료'};\n$('send').onclick=()=>send({type:'game',event:'test_message',data:{hello:'버블 보블!',time:Date.now()}});\n$('leave').onclick=()=>{if(socket)socket.close(1000,'Left room');};\n</script></body></html>\n";

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") return json({ ok: true });

    if (url.pathname === "/" && request.method === "GET") {
      return new Response(TEST_PAGE, {
        headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" }
      });
    }

    if (url.pathname === "/diag" && request.method === "GET") {
      return new Response(DIAG_PAGE, {
        headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" }
      });
    }

    if (url.pathname === "/api/echo/ws") {
      return handleWorkerEchoWs(request);
    }

    if (url.pathname === "/api/echo/info" && request.method === "GET") {
      return json({
        ok: true,
        via: "worker",
        edge_colo: edgeColo(request),
        cf_ray: request.headers.get("cf-ray"),
        location_hint: ROOM_LOCATION_HINT,
        note: "edge_colo is the request entry PoP. Durable Object may run elsewhere; hint applies only at first DO create.",
        endpoints: {
          worker_ws: "/api/echo/ws",
          do_ws: "/api/rooms/:code/ws",
          diag_page: "/diag"
        }
      });
    }

    if (url.pathname === "/api/health" && request.method === "GET") {
      return json({
        ok: true,
        service: "puzzle-bobble-room-server",
        version: 9,
        signaling_version: 2,
        location_hint: ROOM_LOCATION_HINT,
        edge_colo: edgeColo(request),
        note: "location_hint applies only on first getByName for a new DO name; edge_colo ≠ DO location",
        echo: { worker_ws: "/api/echo/ws", diag_page: "/diag" },
        webrtc_signaling: ["webrtc_sdp", "webrtc_ice"],
        signal_types: ["signal"],
        limits: { ws: MAX_WS_MESSAGE_CHARS, game: GAME_DATA_LIMITS }
      });
    }

    if (url.pathname === "/api/rooms" && request.method === "POST") {
      for (let attempt = 0; attempt < 8; attempt++) {
        const code = randomRoomCode();
        const hostToken = crypto.randomUUID();
        const room = roomStub(env, code);
        const created = await room.fetch("https://internal/internal/init", {
          method: "POST",
          body: JSON.stringify({ code, hostToken })
        });
        if (created.status === 201) {
          const protocol = url.protocol === "https:" ? "wss:" : "ws:";
          return json({
            ok: true,
            code,
            host_token: hostToken,
            location_hint: ROOM_LOCATION_HINT,
            websocket_url: `${protocol}//${url.host}/api/rooms/${code}/ws`
          }, 201);
        }
        if (created.status !== 409) return json({ error: "room_create_failed" }, 500);
      }
      return json({ error: "try_again" }, 503);
    }

    const match = url.pathname.match(/^\/api\/rooms\/([A-Z2-9]{6})(?:\/(ws))?$/);
    if (!match || !isRoomCode(match[1])) return json({ error: "not_found" }, 404);
    const room = roomStub(env, match[1]);

    if (match[2] === "ws") {
      if (request.method !== "GET" || request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
        return json({ error: "websocket_upgrade_required" }, 426);
      }
      return room.fetch(request);
    }

    if (request.method === "GET") {
      return room.fetch("https://internal/internal/status");
    }
    return json({ error: "method_not_allowed" }, 405);
  }
};

export class Room extends DurableObject {
  /** In-memory room cache — avoids storage round-trip on every WS frame (inflates RTT). */
  _roomCache = null;

  peers() {
    return this.ctx.getWebSockets().map(ws => ({ ws, ...ws.deserializeAttachment() }))
      .filter(p => p.slot === 1 || p.slot === 2);
  }

  send(ws, payload) {
    try { ws.send(JSON.stringify(payload)); } catch (_) {}
  }

  broadcast(payload, skip = null) {
    for (const p of this.peers()) {
      if (p.ws !== skip) this.send(p.ws, payload);
    }
  }

  presence() {
    const players = this.peers().map(p => ({
      player: p.slot,
      ready: !!p.ready,
      name: typeof p.name === "string" ? p.name.slice(0, 12) : ""
    }));
    return { type: "presence", players };
  }

  async loadRoom() {
    if (this._roomCache && Date.now() < this._roomCache.expiresAt) {
      return this._roomCache;
    }
    const room = await this.ctx.storage.get("room");
    this._roomCache = room || null;
    return this._roomCache;
  }

  /** Tiny latency probes — no storage, no game ACL. Joined peers only. */
  handleDiagFast(ws, slot, msg, t0) {
    const procMs = Math.round((performance.now() - t0) * 1000) / 1000;
    if (msg.type === "diag_echo") {
      this.send(ws, {
        type: "diag_echo_reply",
        id: msg.id,
        token: msg.token ?? null,
        t_client_us: msg.t_client_us ?? null,
        path: "fast",
        via: "do",
        location_hint: ROOM_LOCATION_HINT,
        server_proc_ms: procMs
      });
      return true;
    }
    if (msg.type === "diag_relay") {
      const hop = msg.hop === "back" ? "back" : "out";
      this.broadcast(
        {
          type: "diag_relay",
          from: slot,
          id: msg.id,
          hop,
          server_proc_ms: procMs
        },
        ws
      );
      return true;
    }
    if (msg.type === "ping") {
      this.send(ws, {
        type: "pong",
        t: typeof msg.t === "number" ? msg.t : Date.now(),
        path: "fast",
        server_proc_ms: procMs
      });
      return true;
    }
    return false;
  }

  /** Sliding-window rate limit for WebRTC signaling (no IP/token logging). */
  checkSignalRate(slot, event) {
    const cfg = SIGNAL_RATE[event];
    if (!cfg) return null;
    if (!this._signalRates) this._signalRates = new Map();
    const key = `${slot}:${event}`;
    const now = Date.now();
    let bucket = this._signalRates.get(key);
    if (!bucket || now - bucket.start > cfg.windowMs) {
      bucket = { start: now, count: 0 };
      this._signalRates.set(key, bucket);
    }
    bucket.count += 1;
    if (bucket.count > cfg.max) return "signal_rate_limited";
    return null;
  }

  /** Host-authoritative relay rules for Godot game events + WebRTC signaling. */
  validateGameRelay(fromSlot, event, data) {
    if (!ALLOWED_GAME_EVENTS.has(event)) {
      return "unknown_game_event";
    }
    const limit = GAME_DATA_LIMITS[event];
    if (dataSize(data) > limit) {
      return "game_data_too_large";
    }
    if (event === "webrtc_sdp") {
      if (data == null || typeof data !== "object") return "bad_webrtc_sdp";
      if (data.type !== "offer" && data.type !== "answer") return "bad_webrtc_sdp_type";
      if (typeof data.sdp !== "string" || data.sdp.length < 1 || data.sdp.length > 24000) {
        return "bad_webrtc_sdp_body";
      }
      return this.checkSignalRate(fromSlot, event);
    }
    if (event === "webrtc_ice") {
      if (data == null || typeof data !== "object") return "bad_webrtc_ice";
      if (typeof data.mid !== "string" || data.mid.length > 64) return "bad_webrtc_ice_mid";
      // Godot JSON may emit index as int or float; accept both / numeric string.
      const idx = data.index;
      const indexOk =
        (typeof idx === "number" && Number.isFinite(idx)) ||
        (typeof idx === "string" && idx.length > 0 && Number.isFinite(Number(idx)));
      if (!indexOk) return "bad_webrtc_ice_index";
      if (typeof data.candidate !== "string" || data.candidate.length < 1 || data.candidate.length > 1800) {
        return "bad_webrtc_ice_candidate";
      }
      return this.checkSignalRate(fromSlot, event);
    }
    if (event === "client_input") {
      if (fromSlot !== 2) return "client_input_guest_only";
      if (data == null || typeof data !== "object") return "bad_client_input";
      if (typeof data.aim !== "number" || typeof data.mf !== "number") return "bad_client_input";
      return null;
    }
    if (event === "state" || event === "sfx" || event === "match_init") {
      if (fromSlot !== 1) return `${event}_host_only`;
      if (data == null || typeof data !== "object") return `bad_${event}`;
      return null;
    }
    if (event === "quit") {
      if (fromSlot !== 1) return "quit_host_only";
      return null;
    }
    return "unknown_game_event";
  }

  async fetch(request) {
    const url = new URL(request.url);

    if (url.pathname === "/internal/init" && request.method === "POST") {
      const existing = await this.ctx.storage.get("room");
      if (existing) return json({ error: "taken" }, 409);
      const data = await request.json();
      if (!isRoomCode(data.code) || typeof data.hostToken !== "string") {
        return json({ error: "bad_request" }, 400);
      }
      const now = Date.now();
      const room = {
        code: data.code,
        hostToken: data.hostToken,
        expiresAt: now + ROOM_LIFETIME_MS,
        started: false,
        locationHint: ROOM_LOCATION_HINT,
        createdAt: now,
        /** 0=ALWAYS 1=VANISH 2=NEVER */
        guideMode: 2,
        marginSec: 35
      };
      await this.ctx.storage.put("room", room);
      this._roomCache = room;
      await this.ctx.storage.setAlarm(room.expiresAt);
      console.log(`room_init code=${room.code} locationHint=${room.locationHint}`);
      return json({ ok: true, location_hint: room.locationHint, created_at: room.createdAt }, 201);
    }

    const room = await this.loadRoom();
    if (!room || Date.now() >= room.expiresAt) {
      return json({ error: "room_not_found_or_expired" }, 404);
    }

    if (url.pathname === "/internal/status") {
      return json({
        ok: true,
        code: room.code,
        players: this.presence().players,
        started: room.started,
        expires_at: room.expiresAt,
        location_hint: room.locationHint || null,
        created_at: room.createdAt || null,
        hint_note: "hint recorded at first init; existing DOs do not move"
      });
    }

    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return json({ error: "websocket_upgrade_required" }, 426);
    }
    if (this.ctx.getWebSockets().length >= 8) return json({ error: "too_many_connections" }, 429);

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ slot: 0, ready: false });
    this.send(server, {
      type: "hello",
      code: room.code,
      location_hint: room.locationHint || null,
      created_at: room.createdAt || null,
      signaling_version: 2,
      webrtc_signaling: true,
      message: "Send {type:'join', host_token?:'...'}"
    });
    console.log(`ws_accept code=${room.code}`);
    return new Response(null, { status: 101, webSocket: client });
  }

  /** Relay WebRTC SDP/ICE. Prefer top-level type=signal (works pre-match_start). */
  relaySignal(ws, slot, room, event, data) {
    console.log(`SIGNAL_RECEIVED code=${room.code} from=${slot} event=${event}`);
    if (!WEBRTC_SIGNAL_EVENTS.has(event)) {
      console.log(`SIGNAL_REJECTED code=${room.code} from=${slot} event=${event} reason=unknown_event`);
      this.send(ws, { type: "error", error: "unknown_signal_event", event });
      return;
    }
    if (this.peers().length < 2) {
      console.log(`SIGNAL_REJECTED code=${room.code} from=${slot} event=${event} reason=signal_need_two_players peers=${this.peers().length}`);
      this.send(ws, { type: "error", error: "signal_need_two_players", event });
      return;
    }
    const err = this.validateGameRelay(slot, event, data);
    if (err) {
      console.log(`SIGNAL_REJECTED code=${room.code} from=${slot} event=${event} reason=${err}`);
      this.send(ws, { type: "error", error: err, event });
      return;
    }
    const others = this.peers().filter(p => p.ws !== ws).length;
    this.broadcast({ type: "signal", from: slot, event, data: data ?? null }, ws);
    this.send(ws, { type: "signal_ack", event, ok: true, peers: others });
    console.log(`SIGNAL_RELAYED code=${room.code} from=${slot} event=${event} to_peers=${others}`);
  }

  async webSocketMessage(ws, raw) {
    const t0 = performance.now();
    if (typeof raw !== "string" || raw.length > MAX_WS_MESSAGE_CHARS) {
      this.send(ws, { type: "error", error: "invalid_message" });
      return;
    }
    let msg;
    try { msg = JSON.parse(raw); } catch (_) {
      this.send(ws, { type: "error", error: "invalid_json" });
      return;
    }
    if (!msg || typeof msg !== "object") return;

    const oldAttachment = ws.deserializeAttachment() || { slot: 0, ready: false };

    // Fast path: joined peers — diag + ping with NO storage await.
    if (oldAttachment.slot && this.handleDiagFast(ws, oldAttachment.slot, msg, t0)) {
      return;
    }

    // Slow echo: intentionally await storage so clients can measure inflation.
    if (oldAttachment.slot && msg.type === "diag_echo_slow") {
      const roomSlow = await this.loadRoom();
      const procMs = Math.round((performance.now() - t0) * 1000) / 1000;
      this.send(ws, {
        type: "diag_echo_reply",
        id: msg.id,
        token: msg.token ?? null,
        t_client_us: msg.t_client_us ?? null,
        path: "storage",
        via: "do_storage",
        location_hint: ROOM_LOCATION_HINT,
        server_proc_ms: procMs,
        room_ok: !!(roomSlow && Date.now() < roomSlow.expiresAt)
      });
      return;
    }

    const room = await this.loadRoom();
    if (!room || Date.now() >= room.expiresAt) {
      this.send(ws, { type: "error", error: "room_expired" });
      ws.close(1000, "Room expired");
      return;
    }

    if (!oldAttachment.slot) {
      if (msg.type !== "join") {
        this.send(ws, { type: "error", error: "join_first" });
        return;
      }
      const slot = msg.host_token === room.hostToken ? 1 : 2;
      if (this.peers().some(p => p.slot === slot)) {
        this.send(ws, { type: "error", error: slot === 1 ? "host_already_connected" : "room_full" });
        ws.close(1008, "Slot unavailable");
        return;
      }
      const rawName = typeof msg.name === "string" ? msg.name : "";
      const displayName = rawName.replace(/[^\w\- ]+/g, "").trim().slice(0, 12);
      ws.serializeAttachment({ slot, ready: false, name: displayName });
      this.send(ws, {
        type: "joined",
        player: slot,
        role: slot === 1 ? "host" : "guest",
        code: room.code,
        location_hint: room.locationHint || null,
        created_at: room.createdAt || null,
        signaling_version: 2,
        webrtc_signaling: true,
        name: displayName
      });
      this.broadcast(this.presence());
      console.log(`joined code=${room.code} player=${slot} hint=${room.locationHint || "?"}`);
      return;
    }

    const slot = oldAttachment.slot;

    // Dedicated WebRTC signaling channel (preferred over type=game).
    if (msg.type === "signal") {
      if (typeof msg.event !== "string") {
        console.log(`SIGNAL_REJECTED code=${room.code} from=${slot} reason=bad_event`);
        this.send(ws, { type: "error", error: "invalid_signal_event" });
        return;
      }
      this.relaySignal(ws, slot, room, msg.event, msg.data);
      return;
    }

    // Host-only room options (guideline / margin) — before or after join.
    if (msg.type === "room_opts" && slot === 1) {
      const guide = Number.isFinite(msg.guide) ? Math.max(0, Math.min(2, Math.floor(msg.guide))) : room.guideMode ?? 2;
      const margin = Number.isFinite(msg.margin) ? Math.max(0, Math.min(120, Math.floor(msg.margin))) : room.marginSec ?? 35;
      const next = { ...room, guideMode: guide, marginSec: margin };
      await this.ctx.storage.put("room", next);
      this._roomCache = next;
      this.broadcast({ type: "room_opts", guide, margin });
      return;
    }

    if (msg.type === "ready" && typeof msg.ready === "boolean") {
      ws.serializeAttachment({ ...oldAttachment, ready: msg.ready });
      this.broadcast(this.presence());
      const peers = this.peers();
      if (!room.started && peers.length === 2 && peers.every(p => p.ready)) {
        const next = { ...room, started: true };
        await this.ctx.storage.put("room", next);
        this._roomCache = next;
        this.broadcast({
          type: "match_start",
          guide: next.guideMode ?? 2,
          margin: next.marginSec ?? 35
        });
        console.log(`match_start code=${room.code}`);
      }
      return;
    }
    if (msg.type === "game") {
      if (typeof msg.event !== "string" || !/^[a-z_]{1,32}$/.test(msg.event)) {
        this.send(ws, { type: "error", error: "invalid_game_event" });
        return;
      }
      const isSignal = WEBRTC_SIGNAL_EVENTS.has(msg.event);
      // Legacy: webrtc_* still accepted as type=game for older clients.
      if (isSignal) {
        this.relaySignal(ws, slot, room, msg.event, msg.data);
        return;
      }
      if (!room.started) {
        this.send(ws, { type: "error", error: "match_not_started" });
        return;
      }
      const err = this.validateGameRelay(slot, msg.event, msg.data);
      if (err) {
        this.send(ws, { type: "error", error: err });
        return;
      }
      this.broadcast(
        { type: "game", from: slot, event: msg.event, data: msg.data ?? null },
        ws
      );
    }
  }

  async onLeave(ws) {
    const attachment = ws.deserializeAttachment() || {};
    if (!attachment.slot) return;
    const room = await this.loadRoom();
    if (room && room.started) {
      // Match ends when either peer leaves; clients handle GAME OVER hold locally.
      const next = { ...room, started: false };
      await this.ctx.storage.put("room", next);
      this._roomCache = next;
    }
    this.broadcast({ type: "player_left", player: attachment.slot }, ws);
    const remaining = this.peers().filter(p => p.ws !== ws);
    for (const p of remaining) {
      p.ws.serializeAttachment({ slot: p.slot, ready: false, name: p.name || "" });
      this.send(p.ws, {
        type: "presence",
        players: remaining.map(a => ({
          player: a.slot,
          ready: false,
          name: typeof a.name === "string" ? a.name.slice(0, 12) : ""
        }))
      });
    }
    console.log(`player_left code=${room?.code} player=${attachment.slot}`);
  }

  async webSocketClose(ws, code, reason, _wasClean) {
    console.log(`ws_close code=${code} reason=${reason || ""}`);
    await this.onLeave(ws);
    try { ws.close(code, reason); } catch (_) {}
  }

  async webSocketError(ws, _error) {
    console.log("ws_error");
    await this.onLeave(ws);
    try { ws.close(1011, "Connection error"); } catch (_) {}
  }

  async alarm() {
    for (const ws of this.ctx.getWebSockets()) {
      try { ws.close(1000, "Room expired"); } catch (_) {}
    }
    await this.ctx.storage.deleteAll();
    console.log("room_expired_cleanup");
  }
}
