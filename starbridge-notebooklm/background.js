// Background Service Worker

// 설치 시 실행
chrome.runtime.onInstalled.addListener((details) => {
  console.log('[Obsidian-NotebookLM] Extension installed', details.reason);
  
  // 기본 설정 저장
  chrome.storage.local.set({
    serverPort: 27123,
    autoAdd: false
  });
});

// 확장 아이콘 클릭 시 (옵션: NotebookLM 페이지가 없으면 열기)
chrome.action.onClicked.addListener(async (tab) => {
  const tabs = await chrome.tabs.query({ url: 'https://notebooklm.google.com/*' });
  
  if (tabs.length === 0) {
    // NotebookLM 페이지 열기
    chrome.tabs.create({ url: 'https://notebooklm.google.com/' });
  }
});

// 메시지 리스너 (필요시 사용)
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'openNotebookLM') {
    chrome.tabs.create({ url: 'https://notebooklm.google.com/' });
    sendResponse({ success: true });
  }
  return true;
});
