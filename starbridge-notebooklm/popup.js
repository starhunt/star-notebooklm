// Popup Script for Obsidian to NotebookLM Extension

class PopupController {
  constructor() {
    this.serverPort = 27123;
    this.queuedNotes = [];
    this.isObsidianConnected = false;
    this.isNotebookLMOpen = false;

    this.init();
  }

  async init() {
    await this.loadSettings();
    this.bindEvents();
    await this.checkConnections();
    await this.loadQueue();

    // 주기적 새로고침
    setInterval(() => this.loadQueue(), 3000);
  }

  async loadSettings() {
    const result = await chrome.storage.local.get(['serverPort', 'autoAdd']);
    this.serverPort = result.serverPort || 27123;
    document.getElementById('server-port').value = this.serverPort;
    document.getElementById('auto-add').checked = result.autoAdd || false;
  }

  async saveSettings() {
    const port = parseInt(document.getElementById('server-port').value);
    const autoAdd = document.getElementById('auto-add').checked;
    
    await chrome.storage.local.set({ 
      serverPort: port,
      autoAdd: autoAdd
    });
    this.serverPort = port;
    this.showNotification('설정이 저장되었습니다', 'success');
  }

  bindEvents() {
    document.getElementById('btn-refresh').addEventListener('click', async () => {
      await this.checkConnections();
      await this.loadQueue();
    });

    document.getElementById('btn-add-all').addEventListener('click', () => {
      this.addAllToNotebookLM();
    });

    document.getElementById('btn-add-current').addEventListener('click', () => {
      this.addCurrentNoteToNotebookLM();
    });

    document.getElementById('server-port').addEventListener('change', () => {
      this.saveSettings();
    });

    document.getElementById('auto-add').addEventListener('change', () => {
      this.saveSettings();
    });
  }

  async checkConnections() {
    // 옵시디언 서버 확인
    try {
      const response = await fetch(`http://127.0.0.1:${this.serverPort}/status`, {
        method: 'GET',
        headers: { 'Content-Type': 'application/json' }
      });
      
      if (response.ok) {
        this.isObsidianConnected = true;
        this.updateStatus('obsidian-status', '연결됨', true);
      } else {
        throw new Error('Server error');
      }
    } catch (error) {
      this.isObsidianConnected = false;
      this.updateStatus('obsidian-status', '연결 안됨', false);
    }

    // NotebookLM 탭 확인
    try {
      const tabs = await chrome.tabs.query({ url: 'https://notebooklm.google.com/*' });
      this.isNotebookLMOpen = tabs.length > 0;
      this.updateStatus('notebooklm-status', 
        this.isNotebookLMOpen ? '페이지 열림' : '페이지 없음', 
        this.isNotebookLMOpen
      );
    } catch (error) {
      this.isNotebookLMOpen = false;
      this.updateStatus('notebooklm-status', '확인 불가', false);
    }

    this.updateButtons();
  }

  updateStatus(elementId, text, isConnected) {
    const element = document.getElementById(elementId);
    element.textContent = text;
    element.className = `status-badge ${isConnected ? 'connected' : 'disconnected'}`;
  }

  updateButtons() {
    const btnAddAll = document.getElementById('btn-add-all');
    const btnAddCurrent = document.getElementById('btn-add-current');

    const canAdd = this.isObsidianConnected && this.isNotebookLMOpen;
    
    btnAddAll.disabled = !canAdd || this.queuedNotes.length === 0;
    btnAddCurrent.disabled = !canAdd;
  }

  async loadQueue() {
    if (!this.isObsidianConnected) {
      this.queuedNotes = [];
      this.renderQueue();
      return;
    }

    try {
      const response = await fetch(`http://127.0.0.1:${this.serverPort}/queue`);
      const data = await response.json();
      this.queuedNotes = data.notes || [];
      this.renderQueue();
    } catch (error) {
      console.error('Failed to load queue:', error);
      this.queuedNotes = [];
      this.renderQueue();
    }
  }

  renderQueue() {
    const queueList = document.getElementById('queue-list');
    const queueCount = document.getElementById('queue-count');

    queueCount.textContent = this.queuedNotes.length;

    if (this.queuedNotes.length === 0) {
      queueList.innerHTML = '<p class="empty-message">대기 중인 노트가 없습니다</p>';
      return;
    }

    queueList.innerHTML = this.queuedNotes.map(item => `
      <div class="queue-item" data-id="${item.id}">
        <div class="queue-item-info">
          <span class="queue-item-title">${this.escapeHtml(item.note.title)}</span>
          <span class="queue-item-meta">${this.formatBytes(item.note.content.length)} · ${this.formatTime(item.timestamp)}</span>
        </div>
        <div class="queue-item-actions">
          <button class="btn-icon btn-add-single" title="이 노트만 추가">➕</button>
          <button class="btn-icon btn-remove" title="대기열에서 제거">❌</button>
        </div>
      </div>
    `).join('');

    // 개별 버튼 이벤트 바인딩
    queueList.querySelectorAll('.btn-add-single').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const id = e.target.closest('.queue-item').dataset.id;
        this.addSingleToNotebookLM(id);
      });
    });

    queueList.querySelectorAll('.btn-remove').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const id = e.target.closest('.queue-item').dataset.id;
        this.removeFromQueue(id);
      });
    });

    this.updateButtons();
  }

  async addAllToNotebookLM() {
    for (const item of this.queuedNotes) {
      await this.sendToContentScript(item);
    }
  }

  async addSingleToNotebookLM(noteId) {
    const item = this.queuedNotes.find(n => n.id === noteId);
    if (item) {
      await this.sendToContentScript(item);
    }
  }

  async addCurrentNoteToNotebookLM() {
    try {
      const response = await fetch(`http://127.0.0.1:${this.serverPort}/current-note`);
      if (!response.ok) {
        this.showNotification('현재 열린 노트가 없습니다', 'error');
        return;
      }
      const note = await response.json();
      const item = {
        id: 'current-' + Date.now(),
        note: note,
        timestamp: Date.now()
      };
      await this.sendToContentScript(item);
    } catch (error) {
      this.showNotification('노트 가져오기 실패: ' + error.message, 'error');
    }
  }

  async sendToContentScript(item) {
    try {
      // NotebookLM 탭 찾기
      const tabs = await chrome.tabs.query({ url: 'https://notebooklm.google.com/*' });
      
      if (tabs.length === 0) {
        this.showNotification('NotebookLM 페이지를 열어주세요', 'error');
        return;
      }

      const tab = tabs[0];
      
      // Content script에 메시지 전송
      const response = await chrome.tabs.sendMessage(tab.id, {
        action: 'addSource',
        note: item.note
      });

      if (response && response.success) {
        this.showNotification(`"${item.note.title}" 추가 완료`, 'success');
        
        // 대기열에서 제거
        await fetch(`http://127.0.0.1:${this.serverPort}/queue/complete/${item.id}`, {
          method: 'POST'
        });
        await this.loadQueue();
      } else {
        this.showNotification(response?.error || '추가 실패', 'error');
      }
    } catch (error) {
      console.error('Failed to send to content script:', error);
      this.showNotification('추가 실패: ' + error.message, 'error');
    }
  }

  async removeFromQueue(noteId) {
    try {
      await fetch(`http://127.0.0.1:${this.serverPort}/queue/complete/${noteId}`, {
        method: 'POST'
      });
      await this.loadQueue();
      this.showNotification('대기열에서 제거됨', 'success');
    } catch (error) {
      this.showNotification('제거 실패', 'error');
    }
  }

  showNotification(message, type = 'info') {
    const notification = document.getElementById('notification');
    notification.textContent = message;
    notification.className = `notification ${type}`;
    
    setTimeout(() => {
      notification.className = 'notification hidden';
    }, 3000);
  }

  escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

  formatBytes(bytes) {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
  }

  formatTime(timestamp) {
    const date = new Date(timestamp);
    return date.toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' });
  }
}

// 초기화
document.addEventListener('DOMContentLoaded', () => {
  new PopupController();
});
