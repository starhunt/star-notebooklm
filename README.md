# Obsidian to NotebookLM Bridge

옵시디언 노트를 Google NotebookLM에 소스로 추가하는 브릿지 솔루션입니다.

## 구성 요소

이 프로젝트는 두 가지 컴포넌트로 구성됩니다:

1. **옵시디언 플러그인** (`star-bridge/`)
   - 로컬 HTTP 서버 운영
   - 노트를 전송 대기열에 추가
   - API를 통해 노트 내용 제공

2. **크롬 확장** (`starbridge-notebooklm/`)
   - NotebookLM 페이지에서 실행
   - 옵시디언 서버와 통신
   - DOM 조작으로 소스 추가

## 아키텍처

```
┌─────────────────────────┐          HTTP          ┌────────────────────────┐
│                         │  ◄──────────────────►  │                        │
│   옵시디언 플러그인       │   localhost:27123     │    크롬 확장            │
│   (로컬 서버)            │                        │   (content script)     │
│                         │                        │                        │
└─────────────────────────┘                        └───────────┬────────────┘
                                                               │
                                                               │ DOM 조작
                                                               ▼
                                                   ┌────────────────────────┐
                                                   │                        │
                                                   │    NotebookLM 웹       │
                                                   │                        │
                                                   └────────────────────────┘
```

## 설치 방법

### 1. 옵시디언 플러그인 설치

```bash
cd star-bridge

# 의존성 설치
npm install

# 빌드
npm run build

# 빌드된 파일을 옵시디언 플러그인 폴더로 복사
# Windows: %APPDATA%\obsidian\plugins\notebooklm-bridge\
# macOS: ~/Library/Application Support/obsidian/plugins/notebooklm-bridge/
# Linux: ~/.config/obsidian/plugins/notebooklm-bridge/
```

플러그인 폴더에 복사할 파일:
- `main.js`
- `manifest.json`
- `styles.css`

### 2. 크롬 확장 설치

1. Chrome에서 `chrome://extensions/` 열기
2. "개발자 모드" 활성화 (우상단 토글)
3. "압축해제된 확장 프로그램을 로드합니다" 클릭
4. `starbridge-notebooklm/` 폴더 선택

## 사용 방법

### 기본 워크플로우

1. **옵시디언에서**:
   - 플러그인 설정에서 서버가 실행 중인지 확인 (🟢 상태)
   - 노트를 열고 리본 아이콘(📤) 클릭 또는 명령어 `NotebookLM에 전송` 실행
   - 노트가 대기열에 추가됨

2. **크롬에서**:
   - NotebookLM 페이지 열기 (https://notebooklm.google.com)
   - 우측 하단의 플로팅 패널에서 "대기열 추가" 클릭
   - 또는 확장 팝업에서 "모두 NotebookLM에 추가" 클릭

### 옵시디언 명령어

| 명령어 | 설명 |
|--------|------|
| `현재 노트를 NotebookLM에 전송` | 활성 노트를 대기열에 추가 |
| `선택된 텍스트를 NotebookLM에 전송` | 선택 영역만 대기열에 추가 |
| `브릿지 서버 시작/중지` | 로컬 서버 토글 |
| `전송 대기열 비우기` | 대기열 초기화 |

### 컨텍스트 메뉴

- 파일 탐색기에서 마크다운 파일 우클릭 → "NotebookLM에 전송"
- 에디터에서 텍스트 선택 후 우클릭 → "선택 영역을 NotebookLM에 전송"

## API 엔드포인트

옵시디언 플러그인이 제공하는 API:

| 엔드포인트 | 메서드 | 설명 |
|-----------|--------|------|
| `/status` | GET | 서버 상태 확인 |
| `/current-note` | GET | 현재 활성 노트 반환 |
| `/queue` | GET | 대기열 조회 |
| `/queue/pop` | POST | 대기열에서 노트 하나 가져오기 |
| `/queue/complete/:id` | POST | 특정 노트 완료 처리 |
| `/queue/clear` | DELETE | 대기열 비우기 |
| `/notes` | GET | 모든 노트 목록 (최대 100개) |
| `/note/:path` | GET | 특정 노트 가져오기 |

## 설정

### 옵시디언 플러그인 설정

- **서버 포트**: 기본 27123
- **자동 시작**: 옵시디언 시작 시 서버 자동 시작
- **메타데이터 포함**: 생성/수정 시간, 태그 포함 여부
- **Frontmatter 포함**: YAML frontmatter 포함 여부

### 크롬 확장 설정

- **서버 포트**: 옵시디언 서버 포트 (동일하게 설정)
- **자동 추가**: 대기열에 노트가 추가되면 자동으로 NotebookLM에 추가

## 문제 해결

### 서버 연결 안됨

1. 옵시디언 플러그인이 활성화되어 있는지 확인
2. 상태바에서 🟢 표시 확인
3. 포트 충돌이 있는지 확인 (다른 포트로 변경)

### NotebookLM에 추가 실패

DOM 구조 변경으로 인해 자동 추가가 실패할 수 있습니다.

1. 토스트 메시지 확인 - "클립보드에 복사됨" 표시되면 수동 붙여넣기
2. NotebookLM에서 "Add source" → "Copied text" 선택
3. Ctrl+V로 붙여넣기

### content script 작동 안함

1. 확장 프로그램이 활성화되어 있는지 확인
2. NotebookLM 페이지 새로고침
3. 개발자 도구(F12) 콘솔에서 에러 확인

## 보안 고려사항

- 로컬 서버는 127.0.0.1에서만 수신 (외부 접근 불가)
- CORS 헤더로 cross-origin 요청 허용 (로컬 통신 필요)
- 노트 내용은 로컬에서만 처리되며 외부 서버로 전송되지 않음

## 개발

### 옵시디언 플러그인 개발

```bash
cd star-bridge
npm install
npm run dev  # 감시 모드로 빌드
```

### 크롬 확장 수정

1. 코드 수정 후 `chrome://extensions/`에서 새로고침
2. NotebookLM 페이지도 새로고침

## 라이선스

MIT License

## 기여

버그 리포트, 기능 제안, PR 환영합니다!

---

## 향후 개선 사항

- [ ] NotebookLM DOM 셀렉터 자동 업데이트
- [ ] 여러 노트 일괄 추가 UI
- [ ] 노트북 선택 기능
- [ ] 양방향 동기화 (NotebookLM → 옵시디언)
- [ ] Firefox 확장 지원
