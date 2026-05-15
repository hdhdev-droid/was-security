# was-security

Node.js로 연결된 NIC를 찾고, 해당 네트워크 대역에 대해 **전체 포트(1–65535)** 스캔을 수행하는 웹 서비스입니다.

## 요구 사항

- Node.js 18+

## 설정

- **WEB_PORT**: 웹 서버 포트 (기본값: `8888`)

## 도커

```bash
docker build -t was-security .
docker run -p 8888:8888 --cap-add=NET_RAW -e WEB_PORT=8888 was-security
```

ICMP ping은 **`net-ping` 네이티브 모듈로 raw 소켓을 직접 열어** 보냅니다(OS의 `ping` 바이너리를 사용하지 않음). 도커 기본 capability에 `NET_RAW`가 포함되지만, Kubernetes 등 capability를 제한하는 환경에서는 명시적으로 `--cap-add=NET_RAW` 또는 `securityContext.capabilities.add: ["NET_RAW"]` 가 필요합니다. ICMP가 네트워크에서 차단되면 ping은 실패하지만 HTTP/TCP 진단은 정상 동작합니다.

## 아웃바운드 진단 (컨테이너 기준)

웹 UI 상단 또는 다음 API로 **컨테이너에서 나가는** 연결을 검사합니다.

| 메서드 | 경로 | body 예시 | 설명 |
|--------|------|-----------|------|
| POST | `/api/debug/http` | `{ "url": "https://example.com/", "insecure": false }` | HTTP(S) GET, 상태 코드·지연·본문 일부 |
| POST | `/api/debug/ping` | `{ "host": "8.8.8.8", "count": 3 }` | ICMP ping (`ping` 바이너리 필요) |
| POST | `/api/debug/tcp` | `{ "host": "example.com", "port": 443, "timeoutMs": 5000 }` | TCP 연결 성공 여부·왕복 시간(ms) |

## 실행

```bash
# 기본 포트 3000
npm start

# 또는 포트 지정
set WEB_PORT=8080
npm start
```

```bash
# Linux/macOS
WEB_PORT=8080 node index.js
```

브라우저에서 `http://localhost:포트` 또는 같은 머신의 IP로 접속합니다. 서버는 **0.0.0.0**에 바인딩되어 외부(도커 호스트 등)에서도 접근할 수 있습니다.

## 웹 UI

- **NIC 목록**: 연결된 네트워크 인터페이스 목록과 IP/넷마스크/스캔 대상 대역 표시
- **스캔 시작**: 사용할 NIC를 선택한 뒤 "스캔 시작"으로 해당 네트워크 전체 포트(1–65535) 스캔
- **진행 상황**: 호스트 진행률, 현재 호스트 포트 진행률, 진행 바 표시
- **결과 테이블**: 열린 포트가 있는 호스트만 실시간으로 표시

## API

| 메서드 | 경로 | 설명 |
|--------|------|------|
| GET | `/api/interfaces` | 연결된 NIC 목록 |
| POST | `/api/scan` | 스캔 시작 (body: `{ "interfaceIndex": 0 }`) |
| POST | `/api/scan/stop` | 진행 중인 스캔 중지 요청 |
| GET | `/api/scan/status` | 현재 스캔 상태 및 결과 |
| GET | `/api/scan/stream` | SSE 스트림 (실시간 진행/결과) |
| POST | `/api/debug/http` | 아웃바운드 HTTP(S) 요청 |
| POST | `/api/debug/ping` | ICMP ping |
| POST | `/api/debug/tcp` | TCP 연결 테스트 |

## 주의사항

- 전체 포트 스캔은 네트워크 규모에 따라 수 분~수십 분 걸릴 수 있습니다.
- 허가받지 않은 네트워크에 대한 스캔은 법·정책 위반이 될 수 있으므로, 본인 소유 또는 허가된 네트워크에서만 사용하세요.
