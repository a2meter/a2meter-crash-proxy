# a2meter-crash-proxy

A2Meter 클라이언트에서 보낸 마스킹된 크래시 리포트를 받아 GitHub Issue로 변환하는 Cloudflare Worker.

## 왜 프록시인가

GitHub PAT을 클라이언트 바이너리에 넣으면 디컴파일로 추출돼 스팸/계정 정지 위험이 있습니다. 프록시가 토큰을 보관하고, 클라이언트는 자격 증명을 보지 않습니다.

## 동작 흐름

```
A2Meter (next start)
  ├─ crash.log 새 엔트리 발견
  ├─ 경로/캐릭터명/IP 마스킹
  └─ POST https://a2meter-crash-proxy.workers.dev/report
                                        │
                                        ▼
                       Worker (이 레포)
                       ├─ payload 검증 (hash, body 크기, 필수 필드)
                       ├─ KV로 IP rate-limit (옵션)
                       ├─ GitHub Search API: 같은 hash 이슈가 있나
                       │    ├─ 있음 → 기존 이슈에 "+1 occurrence" 코멘트
                       │    └─ 없음 → 새 이슈 생성 (label: crash, auto-reported)
                       └─ 200 OK + issue URL
```

## 보내는 데이터

| 필드 | 예시 | 비고 |
|---|---|---|
| `hash` | `4f8b...` | 마스킹된 본문의 SHA-256, 중복 판단 키 |
| `source` | `UnhandledException` | 핸들러 종류 |
| `timestamp` | `2026-05-15T14:23:01.123+09:00` | 발생 시각 |
| `app_version` | `1.2.3` | A2Meter 버전 |
| `os` | `Microsoft Windows NT 10.0.26100.0` | |
| `dotnet` | `8.0.10` | |
| `body` | (마스킹된 스택트레이스 + 메시지) | 최대 32KB |

클라이언트가 전송 전에 적용하는 마스킹 (`src/A2Meter/Core/CrashReporter.cs`):

- `C:\Users\saydst123` → `C:\Users\<user>`
- `홍길동[네자칸]` → `<player>[<server>]`
- IPv4 주소 → `<ip>`

## 배포

### 1) Cloudflare 계정 + Wrangler 설치

```powershell
npm install -g wrangler
wrangler login
```

### 2) GitHub Fine-grained PAT 발급

- https://github.com/settings/tokens?type=beta
- Repository access: `a2meter/Aion2Meter` (만 선택)
- Permissions: **Issues = Read and write** (그 외 권한 X)
- 만료일 지정 (1년 권장)

### 3) Worker 시크릿 등록

```powershell
cd a2meter-crash-proxy
npm install
wrangler secret put GITHUB_TOKEN
# → 프롬프트에 발급한 PAT 붙여넣기
```

### 4) (선택) Rate-limit KV

```powershell
wrangler kv:namespace create RATE_KV
# → 출력된 id를 wrangler.toml [[kv_namespaces]]에 반영, 주석 해제
```

### 5) 배포

```powershell
wrangler deploy
```

기본 도메인은 `https://a2meter-crash-proxy.<your-subdomain>.workers.dev`.
A2Meter 클라이언트 (`CrashReporter.cs:14` `ProxyEndpoint`)가 이 URL을 가리키도록 일치시킬 것.

### 6) 헬스 체크

```powershell
curl https://a2meter-crash-proxy.workers.dev/health
# → {"ok":true}
```

## GitHub 리포 사전 작업

- `crash`, `auto-reported` 라벨을 만들어 두면 깔끔합니다 (없어도 자동 생성됨).
- 이슈 템플릿이 너무 강제적이면 Workers에서 생성한 이슈가 검증에 걸릴 수 있음 — `.github/ISSUE_TEMPLATE/config.yml`에 `blank_issues_enabled: true` 유지 권장.

## 운영 비용

- Cloudflare Workers 무료 티어: **100,000 req/일**
- KV 무료 티어: 100,000 read + 1,000 write/일
- 일반적인 A2Meter 사용량이라면 둘 다 한참 남습니다.

## 보안 가드

- Worker 코드에는 토큰이 평문으로 들어가지 않습니다 — `wrangler secret put`으로 등록한 값은 빌드 산출물에 포함되지 않고 런타임에만 주입됩니다.
- IP rate-limit이 켜져 있으면 한 IP당 60초에 1건. 광범위한 스팸은 Cloudflare 자체 WAF로 차단 가능.
- PAT 권한이 "Issues: write"로 한정되어 있으므로, 만에 하나 토큰이 유출돼도 코드/액션/시크릿엔 접근 불가.

## 로컬 개발

```powershell
wrangler dev
# 로컬 8787 포트로 실행. .dev.vars에 GITHUB_TOKEN 등 입력 가능.
```
