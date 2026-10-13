# Puzzle Bobble Room Server (Cloudflare)

브라우저에서 방 만들기 / 6자리 코드 참가 / 2명 Ready / WebSocket 메시지 중계용 서버 프로토타입.
게임 판정은 Godot 호스트가 구현하고, 이 서버는 방 입장과 메시지 중계만 담당합니다.

## 학교 PC에서도 배포 (Node 설치 불필요)

1. GitHub에서 **puzzle-bobble-rooms** 이름으로 새 저장소를 만듭니다.
2. 이 ZIP을 풀고 `src/index.js`, `wrangler.jsonc`, `package.json`, `README.md`를 파일 구조 그대로 저장소에 업로드합니다.
3. https://dash.cloudflare.com/ → **Workers & Pages** → **Create application** → **Import repository**에서 GitHub 저장소 연결.
4. Worker 이름은 **puzzle-bobble-rooms** (wrangler.jsonc와 동일).
5. Build command: `npm run build` / Deploy command: `npx wrangler deploy`.
6. Deploy 후 생성된 `https://puzzle-bobble-rooms.<계정서브도메인>.workers.dev/`를 열면 테스트 페이지가 나옵니다.
7. 한 탭에서 방 만들기, 다른 탭에서 방 코드 입력, 양쪽 Ready 후 테스트 메시지를 전송합니다.

> Cloudflare 대시보드는 시기에 따라 메뉴가 조금 달라질 수 있습니다. 배포 오류 시 Builds 로그를 참고하세요.

## API

- GET `/api/health`: 상태 검사
- POST `/api/rooms`: `{ok, code, host_token, websocket_url}`
- GET `/api/rooms/ABC123`: 방 존재 및 접속 상황 확인
- WebSocket `/api/rooms/ABC123/ws`: 방 연결

WebSocket 연결 직후 `{"type":"join","host_token":"방생성응답의 토큰"}` 전송 -> 1P로 입장.
일반 참가자는 `{"type":"join"}` 전송 -> 2P로 입장.
서버가 `{"type":"joined","player":1|2,"role":"host"|"guest","code":"..."}` 를 응답합니다.

`{"type":"ready","ready":true}` 를 두 플레이어가 보내면 `{"type":"match_start"}` 방송.
게임 중 `{"type":"game","event":"shoot","data":{"angle":0.25}}` 형식으로 보내면 상대에게
`{"type":"game","from":1,"event":"shoot","data":{"angle":0.25}}` 전달.

방은 생성 후 6시간 유효. 이미 연결된 플레이어의 빈 슬롯 수를 기준으로 참가 가능합니다.

## 주의

- 공개 서비스용 완제품이 아니라 작은 프로토타입입니다. 채팅과 입력에 대한 안티치트, 계정 인증, 속도제한이 없습니다.
- **host_token**은 방장 인증 비밀값이므로 다른 사람에게 공유하거나 GitHub에 올리지 마세요.
- Worker URL과 방 코드만으로 일반 플레이어가 입장할 수 있습니다.
- Cloudflare에 배포하는 순간 인터넷에서 접근 가능한 주소가 됩니다. 공개 전에는 악용 방지 기능을 추가하세요.
- 서버는 물리 판정을 직접 수행하지 않습니다. 호스트가 확정한 판정 결과를 게스트에 중계하는 방식으로 확장할 수 있습니다.
- 브라우저 테스트 페이지도 `/`에서 제공하므로 Godot 클라이언트 없이 테스트 가능합니다.
