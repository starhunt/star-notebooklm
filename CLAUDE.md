# Star NotebookLM - 개발 가이드

Obsidian ↔ NotebookLM 브릿지 프로젝트

## 프로젝트 구조

```
star-notebooklm/
├── star-notebooklm/              # Obsidian 플러그인 (메인)
│   ├── main.ts              # 플러그인 메인 소스
│   ├── main.js              # 빌드된 파일
│   ├── manifest.json        # 플러그인 메타데이터
│   ├── styles.css           # 스타일
│   ├── package.json         # npm 설정
│   ├── tsconfig.json        # TypeScript 설정
│   ├── esbuild.config.mjs   # 빌드 설정
│   └── test-api.mjs         # API 테스트 스크립트 (Playwright)
│
├── ref/                      # 레퍼런스
│   └── nlm-py/              # NotebookLM Python API 참조
│
├── CLAUDE.md                 # 이 파일 (개발 가이드)
└── README.md                 # 사용자 문서
```

## 아키텍처

### 현재 방식 (웹뷰 + API 직접 호출)
```
Obsidian 노트 → 내장 웹뷰 → NotebookLM API (izAoDd RPC) → 소스 추가
```

**더 이상 필요하지 않은 것:**
- Chrome 확장 프로그램 (삭제됨)
- HTTP 서버 (제거됨)

## 빌드 & 개발

### Obsidian 플러그인

```bash
cd star-notebooklm

# 의존성 설치
npm install

# 프로덕션 빌드
npm run build

# 개발 모드 (watch)
npm run dev
```

### 설치

빌드 후 파일 복사:
```bash
cp main.js manifest.json styles.css "/path/to/vault/.obsidian/plugins/notebooklm-bridge/"
```

**현재 테스트 Vault**: `/Users/starhunter/Documents/StarhunterNote`

## 핵심 기능

### 1. NotebookLM 웹뷰 통합
- `NotebookLMView` 클래스: Obsidian 내에 NotebookLM 웹뷰 임베드
- 사이드바에서 NotebookLM 직접 사용 가능

### 2. 노트 전송 흐름
1. 노트 우클릭 → "NotebookLM에 전송"
2. 웹뷰가 노트북 목록 페이지로 이동
3. 노트북 목록 수집 (`getNotebooksFromWebview`)
4. 노트북 선택 모달 표시 (`NotebookSelectModal`)
5. 선택한 노트북으로 이동
6. 소스 자동 추가

### 3. 소스 추가 방식

#### API 방식 (기본, 권장)
- `izAoDd` RPC 엔드포인트 사용
- 텍스트 소스 페이로드: `[[[null, [title, content], null, 2]], notebookId]`
- URL 소스 페이로드: `[[[null, null, [url]]], notebookId]`
- XMLHttpRequest + window 폴링으로 Zone.js 간섭 회피
- UTF-8 Base64 인코딩으로 한글 지원

#### DOM 방식 (폴백)
1. "소스 추가" 버튼 클릭
2. "복사된 텍스트" 옵션 클릭
3. textarea에 내용 입력
4. "삽입" 버튼 클릭

## NotebookLM API 레퍼런스

### RPC 엔드포인트 (ref/nlm-py 참조)

| RPC ID | 기능 |
|--------|------|
| `wXbhsf` | ListRecentlyViewedProjects (노트북 목록) |
| `CCqFvf` | CreateProject (노트북 생성) |
| `rLM1Ne` | GetProject (노트북 상세) |
| `izAoDd` | AddSources (소스 추가) |
| `tGMBJ` | DeleteSources (소스 삭제) |
| `CYK0Xb` | CreateNote (노트 생성) |
| `AHyHrd` | CreateAudioOverview (오디오 생성) |

### AT 토큰 추출
```javascript
// WIZ_global_data에서 추출
window.WIZ_global_data.SNlM0e

// 또는 script 태그에서 추출
/"SNlM0e":"([^"]+)"/
```

## NotebookLM DOM 셀렉터 (2024-12 기준)

### 노트북 목록 페이지
- PC 뷰 카드: `project-button.project-button`
- 노트북 제목: `span.project-button-title`
- 테이블 뷰: `table.project-table`

### 노트북 내부 페이지
- 소스 추가 버튼: `button.add-source-button`
- 업로드 버튼: `button[aria-label="업로드 소스 대화상자 열기"]`

### 소스 추가 모달
- 모달 컨테이너: `.upload-dialog-panel`, `mat-bottom-sheet-container`
- 텍스트 입력: `textarea.text-area`
- 삽입 버튼: 텍스트가 "삽입"인 버튼

## 디버그

### 명령어
`Cmd+P` → `[DEBUG] NotebookLM 페이지 DOM 정보 수집`

### API 테스트
```bash
cd star-notebooklm
node test-api.mjs
```

## 알려진 이슈

1. **NotebookLM DOM 변경**: Google이 UI를 변경하면 DOM 셀렉터 업데이트 필요
2. **Zone.js 간섭**: Promise 기반 코드가 제대로 동작하지 않아 XMLHttpRequest + 폴링 사용

## 변경 이력

### 2024-12-28
- [x] HTTP 서버 코드 완전 제거
- [x] Chrome 확장 폴더 삭제
- [x] API 방식 기본값으로 변경
- [x] Zone.js 호환성 수정 (XMLHttpRequest + 폴링)
- [x] UTF-8 인코딩 문제 수정

### 2024-12 초기
- [x] NotebookLM 웹뷰 직접 통합
- [x] 노트북 선택 모달
- [x] 새 노트북 생성 기능
- [x] API 직접 호출 방식 구현
