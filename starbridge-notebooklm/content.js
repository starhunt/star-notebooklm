// Content Script for NotebookLM Page
// 이 스크립트는 notebooklm.google.com에서 실행됩니다

(function() {
  'use strict';

  console.log('[Obsidian-NotebookLM] Content script loaded');

  // 서버 포트 설정 (chrome.storage에서 로드)
  let SERVER_PORT = 27123;

  // 설정에서 포트 로드
  chrome.storage.local.get(['serverPort'], (result) => {
    if (result.serverPort) {
      SERVER_PORT = result.serverPort;
      console.log('[Obsidian-NotebookLM] Server port loaded:', SERVER_PORT);
    }
  });

  // 서버 URL 생성 헬퍼
  function getServerUrl(path) {
    return `http://127.0.0.1:${SERVER_PORT}${path}`;
  }

  // 플로팅 버튼 UI 생성
  function createFloatingUI() {
    // 이미 있으면 생성하지 않음
    if (document.getElementById('obsidian-nlm-floating')) return;

    const container = document.createElement('div');
    container.id = 'obsidian-nlm-floating';
    container.innerHTML = `
      <div class="obsidian-nlm-panel">
        <div class="obsidian-nlm-header">
          <span>📓 Obsidian Bridge</span>
          <button class="obsidian-nlm-minimize">−</button>
        </div>
        <div class="obsidian-nlm-body">
          <div class="obsidian-nlm-status">
            <span id="obsidian-nlm-connection-status">연결 확인 중...</span>
          </div>
          <div class="obsidian-nlm-queue">
            <span>대기열: </span><span id="obsidian-nlm-queue-count">0</span>개
          </div>
          <div class="obsidian-nlm-page-status">
            <span id="obsidian-nlm-page-info">페이지 분석 중...</span>
          </div>
          <div class="obsidian-nlm-actions">
            <button id="obsidian-nlm-add-btn" class="obsidian-nlm-btn primary" disabled>
              📥 대기열 추가
            </button>
            <button id="obsidian-nlm-current-btn" class="obsidian-nlm-btn secondary" disabled>
              📄 현재 노트
            </button>
          </div>
          <div class="obsidian-nlm-debug">
            <button id="obsidian-nlm-analyze-btn" class="obsidian-nlm-btn small">
              🔍 DOM 분석
            </button>
          </div>
        </div>
      </div>
    `;

    document.body.appendChild(container);

    // 이벤트 바인딩
    const minimizeBtn = container.querySelector('.obsidian-nlm-minimize');
    const body = container.querySelector('.obsidian-nlm-body');
    let isMinimized = false;

    minimizeBtn.addEventListener('click', () => {
      isMinimized = !isMinimized;
      body.style.display = isMinimized ? 'none' : 'block';
      minimizeBtn.textContent = isMinimized ? '+' : '−';
    });

    document.getElementById('obsidian-nlm-add-btn').addEventListener('click', () => {
      addFromQueue();
    });

    document.getElementById('obsidian-nlm-current-btn').addEventListener('click', () => {
      addCurrentNote();
    });

    document.getElementById('obsidian-nlm-analyze-btn').addEventListener('click', () => {
      analyzeNotebookLMPage();
    });

    // 연결 상태 확인 시작
    checkConnection();
    setInterval(checkConnection, 5000);

    // 페이지 상태 분석
    setTimeout(analyzePageStatus, 1000);
    setInterval(analyzePageStatus, 3000);
  }

  // NotebookLM 페이지 상태 분석
  function analyzePageStatus() {
    const pageInfoEl = document.getElementById('obsidian-nlm-page-info');
    if (!pageInfoEl) return;

    const url = window.location.href;
    const path = window.location.pathname;

    // URL 패턴으로 현재 상태 파악
    if (path === '/' || path === '') {
      pageInfoEl.innerHTML = '📋 <b>노트북 목록</b> - 노트북을 선택하세요';
      pageInfoEl.className = 'warning';
    } else if (path.includes('/notebook/')) {
      // 노트북 내부
      const notebookTitle = document.querySelector('h1, [class*="title"], [class*="notebook-name"]');
      const title = notebookTitle ? notebookTitle.textContent.trim() : '노트북';
      pageInfoEl.innerHTML = `📓 <b>${title}</b> 열림`;
      pageInfoEl.className = 'connected';
    } else {
      pageInfoEl.innerHTML = '❓ 알 수 없는 페이지';
      pageInfoEl.className = 'disconnected';
    }
  }

  // NotebookLM DOM 상세 분석 (디버그용)
  function analyzeNotebookLMPage() {
    console.log('=== NotebookLM DOM 분석 시작 ===');

    const analysis = {
      url: window.location.href,
      path: window.location.pathname,
      buttons: [],
      notebooks: [],
      sources: [],
      modals: [],
      textareas: []
    };

    // 모든 버튼 분석
    document.querySelectorAll('button').forEach(btn => {
      const info = {
        text: btn.textContent.trim().substring(0, 50),
        ariaLabel: btn.getAttribute('aria-label'),
        className: btn.className,
        id: btn.id
      };
      if (info.text || info.ariaLabel) {
        analysis.buttons.push(info);
      }
    });

    // 클릭 가능한 요소 중 "add", "source", "upload" 포함하는 것들
    document.querySelectorAll('[role="button"], [class*="add"], [class*="source"], [class*="upload"]').forEach(el => {
      console.log('발견:', el.tagName, el.className, el.textContent.substring(0, 30));
    });

    // 모달/다이얼로그 확인
    document.querySelectorAll('[role="dialog"], .modal, .dialog, [class*="modal"], [class*="dialog"]').forEach(el => {
      analysis.modals.push({
        className: el.className,
        visible: el.offsetParent !== null
      });
    });

    // textarea 확인
    document.querySelectorAll('textarea, [contenteditable="true"]').forEach(el => {
      analysis.textareas.push({
        placeholder: el.getAttribute('placeholder'),
        className: el.className
      });
    });

    console.log('분석 결과:', JSON.stringify(analysis, null, 2));

    // 주요 버튼들 찾기 시도
    const addSourceSelectors = [
      'button[aria-label*="Add"]',
      'button[aria-label*="source"]',
      'button[aria-label*="추가"]',
      '[class*="add-source"]',
      '[class*="upload"]'
    ];

    console.log('\n=== 소스 추가 관련 버튼 검색 ===');
    addSourceSelectors.forEach(sel => {
      try {
        const found = document.querySelectorAll(sel);
        if (found.length > 0) {
          console.log(`✅ "${sel}":`, found.length, '개 발견');
          found.forEach(el => console.log('  -', el.tagName, el.textContent.substring(0, 30)));
        }
      } catch (e) {}
    });

    // 결과를 토스트로 표시
    showToast(`분석 완료! 콘솔(F12)에서 결과 확인`, 'info', 5000);

    return analysis;
  }

  // 옵시디언 서버 연결 확인
  async function checkConnection() {
    const statusEl = document.getElementById('obsidian-nlm-connection-status');
    const queueCountEl = document.getElementById('obsidian-nlm-queue-count');
    const addBtn = document.getElementById('obsidian-nlm-add-btn');
    const currentBtn = document.getElementById('obsidian-nlm-current-btn');

    try {
      const response = await fetch(getServerUrl('/status'));
      const data = await response.json();
      
      statusEl.textContent = '🟢 연결됨';
      statusEl.className = 'connected';
      
      queueCountEl.textContent = data.queueSize || 0;
      
      addBtn.disabled = data.queueSize === 0;
      currentBtn.disabled = false;
    } catch (error) {
      statusEl.textContent = '🔴 연결 안됨';
      statusEl.className = 'disconnected';
      queueCountEl.textContent = '0';
      addBtn.disabled = true;
      currentBtn.disabled = true;
    }
  }

  // 대기열에서 노트 가져와서 추가
  async function addFromQueue() {
    try {
      const response = await fetch(getServerUrl('/queue/pop'), {
        method: 'POST'
      });
      
      if (!response.ok) {
        showToast('대기열이 비어있습니다', 'warning');
        return;
      }

      const item = await response.json();
      await addSourceToNotebook(item.note);
      
      // 대기열 업데이트
      checkConnection();
      
    } catch (error) {
      console.error('[Obsidian-NotebookLM] Error:', error);
      showToast('노트 가져오기 실패', 'error');
    }
  }

  // 현재 노트 추가
  async function addCurrentNote() {
    try {
      const response = await fetch(getServerUrl('/current-note'));
      
      if (!response.ok) {
        showToast('현재 열린 노트가 없습니다', 'warning');
        return;
      }

      const note = await response.json();
      await addSourceToNotebook(note);
      
    } catch (error) {
      console.error('[Obsidian-NotebookLM] Error:', error);
      showToast('현재 노트 가져오기 실패', 'error');
    }
  }

  // NotebookLM에 소스 추가 (핵심 로직)
  async function addSourceToNotebook(note) {
    showToast(`"${note.title}" 추가 중...`, 'info');

    try {
      // 방법 1: "Add source" 버튼을 찾아서 클릭
      const addSourceBtn = await findElement([
        'button[aria-label*="Add source"]',
        'button[aria-label*="소스 추가"]',
        '[data-testid="add-source-button"]',
        'button:has(mat-icon:contains("add"))',
        // 소스 패널의 + 버튼
        '.sources-panel button[aria-label*="add"]',
        '.add-source-button',
        // 일반적인 추가 버튼들
        'button[class*="add-source"]',
        '[role="button"][aria-label*="Add"]'
      ]);

      if (addSourceBtn) {
        addSourceBtn.click();
        await sleep(500);
      }

      // 방법 2: "Copied text" / "텍스트 붙여넣기" 옵션 찾기
      const copiedTextOption = await findElement([
        '[data-testid="copied-text-option"]',
        'button:contains("Copied text")',
        'button:contains("복사된 텍스트")',
        'button:contains("Paste text")',
        'div[role="menuitem"]:contains("Copied text")',
        'div[role="menuitem"]:contains("텍스트")',
        // Material 메뉴 아이템
        'mat-option:contains("Copied")',
        '.source-type-option:contains("text")',
        // 일반 버튼/링크
        'a:contains("Copied text")',
        '[class*="paste-text"]'
      ], 1000);

      if (copiedTextOption) {
        copiedTextOption.click();
        await sleep(500);
      }

      // 방법 3: 텍스트 입력 영역 찾기
      const textarea = await findElement([
        'textarea[placeholder*="Paste"]',
        'textarea[placeholder*="붙여넣기"]',
        'textarea[aria-label*="source"]',
        'textarea[aria-label*="content"]',
        '.source-input textarea',
        'div[contenteditable="true"]',
        'textarea.paste-area',
        // 일반 textarea
        '.modal textarea',
        '.dialog textarea',
        '[role="dialog"] textarea'
      ], 1000);

      if (textarea) {
        // 제목과 내용 조합
        const fullContent = `# ${note.title}\n\n${note.content}`;
        
        if (textarea.tagName === 'TEXTAREA') {
          textarea.value = fullContent;
          textarea.dispatchEvent(new Event('input', { bubbles: true }));
          textarea.dispatchEvent(new Event('change', { bubbles: true }));
        } else {
          // contenteditable div인 경우
          textarea.textContent = fullContent;
          textarea.dispatchEvent(new InputEvent('input', { bubbles: true }));
        }
        
        await sleep(300);

        // 방법 4: 확인/Insert 버튼 클릭
        const confirmBtn = await findElement([
          'button:contains("Insert")',
          'button:contains("Add")',
          'button:contains("추가")',
          'button:contains("확인")',
          'button[type="submit"]',
          '.modal button.primary',
          '.dialog button.primary',
          '[role="dialog"] button[class*="primary"]',
          'button.confirm-button',
          'button[aria-label*="confirm"]',
          'button[aria-label*="insert"]'
        ], 500);

        if (confirmBtn) {
          confirmBtn.click();
          await sleep(500);
          showToast(`✅ "${note.title}" 추가 완료!`, 'success');
          return { success: true };
        }
      }

      // DOM 조작이 실패하면 클립보드 방식으로 대체
      await fallbackClipboardMethod(note);
      
    } catch (error) {
      console.error('[Obsidian-NotebookLM] Add source error:', error);
      showToast('소스 추가 실패. 수동으로 추가해주세요.', 'error');
      
      // 실패 시 클립보드에 복사
      await fallbackClipboardMethod(note);
    }
  }

  // 클립보드 대체 방법
  async function fallbackClipboardMethod(note) {
    const fullContent = `# ${note.title}\n\n${note.content}`;
    
    try {
      await navigator.clipboard.writeText(fullContent);
      showToast('📋 클립보드에 복사됨. "Copied text"로 붙여넣기 해주세요.', 'info', 5000);
    } catch (error) {
      console.error('[Obsidian-NotebookLM] Clipboard error:', error);
    }
  }

  // 요소 찾기 헬퍼 (여러 셀렉터 시도)
  async function findElement(selectors, timeout = 2000) {
    const startTime = Date.now();
    
    while (Date.now() - startTime < timeout) {
      for (const selector of selectors) {
        try {
          // 일반 CSS 셀렉터
          let element = document.querySelector(selector);
          
          // :contains() 가상 셀렉터 처리
          if (!element && selector.includes(':contains(')) {
            element = findByContains(selector);
          }
          
          if (element && element.offsetParent !== null) {
            return element;
          }
        } catch (e) {
          // 잘못된 셀렉터 무시
        }
      }
      await sleep(100);
    }
    
    return null;
  }

  // :contains() 셀렉터 에뮬레이션
  function findByContains(selector) {
    const match = selector.match(/(.+?):contains\("(.+?)"\)/);
    if (!match) return null;
    
    const [, baseSelector, text] = match;
    const elements = document.querySelectorAll(baseSelector || '*');
    
    for (const el of elements) {
      if (el.textContent && el.textContent.includes(text)) {
        return el;
      }
    }
    return null;
  }

  // 토스트 메시지 표시
  function showToast(message, type = 'info', duration = 3000) {
    // 기존 토스트 제거
    const existing = document.querySelector('.obsidian-nlm-toast');
    if (existing) existing.remove();

    const toast = document.createElement('div');
    toast.className = `obsidian-nlm-toast ${type}`;
    toast.textContent = message;
    document.body.appendChild(toast);

    setTimeout(() => {
      toast.classList.add('fade-out');
      setTimeout(() => toast.remove(), 300);
    }, duration);
  }

  // 딜레이 헬퍼
  function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  // 메시지 리스너 (팝업에서 메시지 받기)
  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    console.log('[Obsidian-NotebookLM] Message received:', request);

    if (request.action === 'addSource') {
      addSourceToNotebook(request.note)
        .then(result => sendResponse(result || { success: true }))
        .catch(error => sendResponse({ success: false, error: error.message }));
      return true; // 비동기 응답을 위해 true 반환
    }

    if (request.action === 'ping') {
      sendResponse({ success: true, message: 'Content script is active' });
      return true;
    }
  });

  // 페이지 로드 시 플로팅 UI 생성
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', createFloatingUI);
  } else {
    createFloatingUI();
  }

})();
