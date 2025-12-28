# Star NotebookLM - Obsidian Plugin

Obsidian 노트를 Google NotebookLM에 소스로 추가하는 플러그인입니다.

## 특징

- **내장 웹뷰**: Obsidian 내에서 NotebookLM 직접 사용
- **다양한 전송 방법**: 리본 아이콘, 컨텍스트 메뉴, 명령어 팔레트
- **API 직접 호출**: 빠르고 안정적인 소스 추가 (DOM 조작 대비)
- **노트북 선택**: 기존 노트북 선택 또는 새로 생성

## 아키텍처

```
┌─────────────────────────┐
│     Obsidian 노트        │
└───────────┬─────────────┘
            │
            ▼
┌─────────────────────────┐
│   NotebookLM 웹뷰       │  ◄── Obsidian 내장
│   (사이드바 패널)        │
└───────────┬─────────────┘
            │ API 직접 호출
            │ (izAoDd RPC)
            ▼
┌─────────────────────────┐
│   Google NotebookLM     │
│   (소스 추가)            │
└─────────────────────────┘
```

## 설치 방법

### 빌드

```bash
cd star-notebooklm

# 의존성 설치
npm install

# 빌드
npm run build
```

### 플러그인 설치

빌드된 파일을 Obsidian 플러그인 폴더로 복사:

```bash
# macOS
mkdir -p ~/Library/Application\ Support/obsidian/plugins/star-notebooklm/
cp main.js manifest.json styles.css ~/Library/Application\ Support/obsidian/plugins/star-notebooklm/

# Windows
# %APPDATA%\obsidian\plugins\star-notebooklm\

# Linux
# ~/.config/obsidian/plugins/star-notebooklm/
```

복사할 파일:
- `main.js`
- `manifest.json`
- `styles.css`

## 사용 방법

### 1. NotebookLM 패널 열기

- 왼쪽 리본의 책 아이콘(book-open) 클릭
- 또는 명령어 팔레트에서 `NotebookLM 열기`

### 2. 로그인

- NotebookLM 패널에서 Google 계정으로 로그인
- 로그인 상태는 유지됨

### 3. 노트 전송

여러 가지 방법으로 노트를 전송할 수 있습니다:

| 방법 | 설명 |
|------|------|
| 리본 아이콘 | 전송 아이콘(send) 클릭 |
| 파일 탐색기 | 노트 우클릭 → "NotebookLM에 전송" |
| 에디터 컨텍스트 메뉴 | 본문에서 우클릭 → "NotebookLM에 전송" |
| 선택 영역 전송 | 텍스트 선택 후 우클릭 → "선택 영역을 NotebookLM에 전송" |
| 명령어 팔레트 | `현재 노트를 NotebookLM에 전송` |

### 4. 노트북 선택

- 기존 노트북 목록에서 선택
- 또는 "새 노트북 만들기" 선택

## 명령어

| 명령어 | 설명 |
|--------|------|
| `현재 노트를 NotebookLM에 전송` | 활성 노트를 NotebookLM에 추가 |
| `선택된 텍스트를 NotebookLM에 전송` | 선택 영역만 추가 |
| `NotebookLM 열기` | 웹뷰 패널 열기 |

## 설정

| 설정 | 설명 |
|------|------|
| 메타데이터 포함 | 생성/수정 시간, 태그 포함 |
| Frontmatter 포함 | YAML frontmatter 포함 |
| 소스 추가 방식 | API (권장) 또는 DOM 조작 |

## 문제 해결

### NotebookLM 로그인이 안됨

1. NotebookLM 패널에서 직접 로그인
2. Google 계정 권한 확인
3. 툴바의 "새로고침" 버튼 클릭

### 소스 추가 실패

1. 노트북이 열려있는지 확인
2. API 방식이 실패하면 DOM 방식으로 자동 전환됨
3. 수동: 클립보드에 복사 후 NotebookLM에서 붙여넣기

### 한글이 깨져서 표시됨

- 최신 버전으로 업데이트 (UTF-8 인코딩 수정됨)

## 개발

```bash
cd star-notebooklm

# 개발 모드 (watch)
npm run dev

# 프로덕션 빌드
npm run build
```

## 라이선스

MIT License

## 기여

버그 리포트, 기능 제안, PR 환영합니다!
