# Star Bridge - 개발 가이드

Obsidian ↔ NotebookLM 브릿지 프로젝트

## 프로젝트 구조

```
star-bridge/
├── star-bridge/              # Obsidian 플러그인 (메인)
│   ├── main.ts              # 플러그인 메인 소스
│   ├── main.js              # 빌드된 파일
│   ├── manifest.json        # 플러그인 메타데이터
│   ├── styles.css           # 스타일
│   ├── package.json         # npm 설정
│   ├── tsconfig.json        # TypeScript 설정
│   └── esbuild.config.mjs   # 빌드 설정
│
├── starbridge-notebooklm/    # Chrome 확장 (더 이상 필요 없음)
│   └── ...                   # 레거시 - 웹뷰로 대체됨
│
├── CLAUDE.md                 # 이 파일 (개발 가이드)
└── README.md                 # 사용자 문서
```

## 아키텍처 변경 (2024-12)

### 이전 방식 (Chrome 확장 필요)
```
Obsidian → HTTP 서버(27123) → Chrome 확장 → NotebookLM
```

### 현재 방식 (웹뷰 직접 통합)
```
Obsidian → 내장 웹뷰(NotebookLM) → DOM 조작으로 소스 추가
```

**Chrome 확장과 HTTP 서버는 더 이상 필요하지 않음**

## 빌드 & 개발

### Obsidian 플러그인

```bash
cd star-bridge

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
5. 선택한 노트북으로 이동 (테이블 행 클릭)
6. 소스 자동 추가 (`addSourceToNotebook`)

### 3. 소스 자동 추가 단계
1. "소스 추가" 버튼 클릭 (`button.add-source-button`)
2. "복사된 텍스트" 옵션 클릭
3. `textarea.text-area`에 내용 입력
4. "삽입" 버튼 클릭

## NotebookLM DOM 셀렉터 (2024-12 기준)

### 노트북 목록 페이지
- 노트북 테이블: `table.project-table`
- 노트북 제목: `.project-table-title`
- 만들기 버튼: `button.create-new-button`

### 노트북 내부 페이지
- 소스 추가 버튼: `button.add-source-button` 또는 `button[aria-label="출처 추가"]`
- 업로드 버튼: `button[aria-label="업로드 소스 대화상자 열기"]`

### 소스 추가 모달
- 모달 컨테이너: `.upload-dialog-panel`, `mat-bottom-sheet-container`
- 텍스트 입력: `textarea.text-area`
- 삽입 버튼: 텍스트가 "삽입"인 버튼

## 디버그 명령어

`Cmd+P` → `[DEBUG] NotebookLM 페이지 DOM 정보 수집`

Vault에 `notebooklm-debug.json` 파일 생성:
- buttons: 모든 버튼 정보
- notebookLinks: 노트북 링크
- projectItems: 프로젝트 관련 요소
- textInputs: 텍스트 입력 필드
- dialogs: 다이얼로그/모달

## 알려진 이슈

1. **NotebookLM DOM 변경**: Google이 UI를 변경하면 셀렉터 업데이트 필요
2. **HTTP 서버 코드**: 레거시 코드로 남아있음 (제거 예정)
3. **Chrome 확장**: `starbridge-notebooklm/` 폴더는 더 이상 사용 안함

## TODO

- [x] NotebookLM 웹뷰 직접 통합
- [x] 노트북 선택 모달
- [x] 새 노트북 생성 기능
- [x] 기존 노트북에 소스 추가
- [ ] HTTP 서버 코드 제거
- [ ] Chrome 확장 폴더 제거 또는 별도 보관
- [ ] 여러 노트 일괄 추가 UI
