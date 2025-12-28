import {
	App,
	Plugin,
	PluginSettingTab,
	Setting,
	Notice,
	TFile,
	MarkdownView,
	Menu,
	Editor,
	ItemView,
	WorkspaceLeaf,
	Modal
} from 'obsidian';
import * as http from 'http';
import * as url from 'url';

// NotebookLM 웹뷰 타입
const NOTEBOOKLM_VIEW_TYPE = 'notebooklm-webview';

// 노트북 정보 인터페이스
interface NotebookInfo {
	id: string;
	title: string;
	url: string;
}

interface NotebookLMBridgeSettings {
	serverPort: number;
	autoStart: boolean;
	includeMetadata: boolean;
	includeFrontmatter: boolean;
}

const DEFAULT_SETTINGS: NotebookLMBridgeSettings = {
	serverPort: 27123,
	autoStart: true,
	includeMetadata: true,
	includeFrontmatter: false
};

interface NoteData {
	title: string;
	content: string;
	path: string;
	metadata?: {
		created?: number;
		modified?: number;
		tags?: string[];
	};
}

interface QueuedNote {
	id: string;
	note: NoteData;
	timestamp: number;
	status: 'pending' | 'sent' | 'failed';
}

export default class NotebookLMBridgePlugin extends Plugin {
	settings: NotebookLMBridgeSettings;
	server: http.Server | null = null;
	isServerRunning: boolean = false;
	statusBarItem: HTMLElement;
	noteQueue: Map<string, QueuedNote> = new Map();
	currentPageState: any = null;

	async onload() {
		await this.loadSettings();

		// NotebookLM 웹뷰 등록
		this.registerView(
			NOTEBOOKLM_VIEW_TYPE,
			(leaf) => new NotebookLMView(leaf, this)
		);

		// 상태바 아이템 추가
		this.statusBarItem = this.addStatusBarItem();
		this.updateStatusBar();

		// 리본 아이콘 추가 - 전송
		this.addRibbonIcon('send', 'NotebookLM에 전송', async () => {
			await this.sendCurrentNoteToQueue();
		});

		// 리본 아이콘 추가 - NotebookLM 열기
		this.addRibbonIcon('book-open', 'NotebookLM 열기', async () => {
			await this.openNotebookLMView();
		});

		// 명령어 추가
		this.addCommand({
			id: 'send-to-notebooklm',
			name: '현재 노트를 NotebookLM에 전송',
			editorCallback: async (editor: Editor, view: MarkdownView) => {
				await this.sendCurrentNoteToQueue();
			}
		});

		this.addCommand({
			id: 'send-selection-to-notebooklm',
			name: '선택된 텍스트를 NotebookLM에 전송',
			editorCallback: async (editor: Editor, view: MarkdownView) => {
				const selection = editor.getSelection();
				if (selection) {
					await this.sendTextToQueue(selection, view.file?.basename || 'Selection');
				} else {
					new Notice('텍스트를 선택해주세요');
				}
			}
		});

		this.addCommand({
			id: 'toggle-server',
			name: '브릿지 서버 시작/중지',
			callback: async () => {
				if (this.isServerRunning) {
					await this.stopServer();
				} else {
					await this.startServer();
				}
			}
		});

		this.addCommand({
			id: 'clear-queue',
			name: '전송 대기열 비우기',
			callback: () => {
				this.noteQueue.clear();
				new Notice('대기열이 비워졌습니다');
			}
		});

		this.addCommand({
			id: 'open-notebooklm',
			name: 'NotebookLM 열기',
			callback: async () => {
				await this.openNotebookLMView();
			}
		});

		// 디버그: 현재 웹뷰 DOM 정보 수집
		this.addCommand({
			id: 'debug-webview-dom',
			name: '[DEBUG] NotebookLM 페이지 DOM 정보 수집',
			callback: async () => {
				await this.debugWebviewDOM();
			}
		});

		// 파일 메뉴에 항목 추가
		this.registerEvent(
			this.app.workspace.on('file-menu', (menu: Menu, file: TFile) => {
				if (file instanceof TFile && file.extension === 'md') {
					menu.addItem((item) => {
						item
							.setTitle('NotebookLM에 전송')
							.setIcon('send')
							.onClick(async () => {
								await this.sendFileToQueue(file);
							});
					});
				}
			})
		);

		// 에디터 메뉴에 항목 추가
		this.registerEvent(
			this.app.workspace.on('editor-menu', (menu: Menu, editor: Editor, view: MarkdownView) => {
				const selection = editor.getSelection();
				if (selection) {
					menu.addItem((item) => {
						item
							.setTitle('선택 영역을 NotebookLM에 전송')
							.setIcon('send')
							.onClick(async () => {
								await this.sendTextToQueue(selection, view.file?.basename || 'Selection');
							});
					});
				}
			})
		);

		// 설정 탭 추가
		this.addSettingTab(new NotebookLMBridgeSettingTab(this.app, this));

		// 자동 시작 설정 확인
		if (this.settings.autoStart) {
			await this.startServer();
		}
	}

	async onunload() {
		await this.stopServer();
	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}

	updateStatusBar() {
		if (this.isServerRunning) {
			this.statusBarItem.setText(`🟢 NLM Bridge :${this.settings.serverPort}`);
			this.statusBarItem.setAttribute('title', `NotebookLM Bridge 서버 실행 중 (포트: ${this.settings.serverPort})\n대기열: ${this.noteQueue.size}개`);
		} else {
			this.statusBarItem.setText('🔴 NLM Bridge');
			this.statusBarItem.setAttribute('title', 'NotebookLM Bridge 서버 중지됨');
		}
	}

	async startServer() {
		if (this.isServerRunning) {
			new Notice('서버가 이미 실행 중입니다');
			return;
		}

		try {
			this.server = http.createServer(async (req, res) => {
				// CORS 헤더 설정
				res.setHeader('Access-Control-Allow-Origin', '*');
				res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
				res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
				res.setHeader('Content-Type', 'application/json; charset=utf-8');

				// Preflight 요청 처리
				if (req.method === 'OPTIONS') {
					res.writeHead(200);
					res.end();
					return;
				}

				const parsedUrl = url.parse(req.url || '', true);
				const pathname = parsedUrl.pathname;

				try {
					// 상태 확인
					if (pathname === '/status' && req.method === 'GET') {
						res.writeHead(200);
						res.end(JSON.stringify({
							status: 'running',
							version: '1.0.0',
							queueSize: this.noteQueue.size
						}));
						return;
					}

					// 현재 활성 노트 가져오기
					if (pathname === '/current-note' && req.method === 'GET') {
						const note = await this.getCurrentNote();
						if (note) {
							res.writeHead(200);
							res.end(JSON.stringify(note));
						} else {
							res.writeHead(404);
							res.end(JSON.stringify({ error: '활성 노트가 없습니다' }));
						}
						return;
					}

					// 대기열에 있는 노트들 가져오기
					if (pathname === '/queue' && req.method === 'GET') {
						const queue = Array.from(this.noteQueue.values())
							.filter(item => item.status === 'pending');
						res.writeHead(200);
						res.end(JSON.stringify({ notes: queue }));
						return;
					}

					// 대기열에서 노트 가져오고 제거
					if (pathname === '/queue/pop' && req.method === 'POST') {
						const pendingNotes = Array.from(this.noteQueue.entries())
							.filter(([, item]) => item.status === 'pending');
						
						if (pendingNotes.length > 0) {
							const [id, item] = pendingNotes[0];
							item.status = 'sent';
							this.noteQueue.delete(id);
							this.updateStatusBar();
							res.writeHead(200);
							res.end(JSON.stringify(item));
						} else {
							res.writeHead(404);
							res.end(JSON.stringify({ error: '대기 중인 노트가 없습니다' }));
						}
						return;
					}

					// 특정 노트 전송 완료 표시
					if (pathname?.startsWith('/queue/complete/') && req.method === 'POST') {
						const noteId = pathname.replace('/queue/complete/', '');
						if (this.noteQueue.has(noteId)) {
							this.noteQueue.delete(noteId);
							this.updateStatusBar();
							res.writeHead(200);
							res.end(JSON.stringify({ success: true }));
						} else {
							res.writeHead(404);
							res.end(JSON.stringify({ error: '노트를 찾을 수 없습니다' }));
						}
						return;
					}

					// 대기열 비우기
					if (pathname === '/queue/clear' && req.method === 'DELETE') {
						this.noteQueue.clear();
						this.updateStatusBar();
						res.writeHead(200);
						res.end(JSON.stringify({ success: true }));
						return;
					}

					// 모든 노트 목록 가져오기 (선택적)
					if (pathname === '/notes' && req.method === 'GET') {
						const files = this.app.vault.getMarkdownFiles();
						const notes = files.slice(0, 100).map(file => ({
							title: file.basename,
							path: file.path
						}));
						res.writeHead(200);
						res.end(JSON.stringify({ notes }));
						return;
					}

					// 특정 노트 가져오기
					if (pathname?.startsWith('/note/') && req.method === 'GET') {
						const notePath = decodeURIComponent(pathname.replace('/note/', ''));
						const file = this.app.vault.getAbstractFileByPath(notePath);
						if (file instanceof TFile) {
							const note = await this.getFileContent(file);
							res.writeHead(200);
							res.end(JSON.stringify(note));
						} else {
							res.writeHead(404);
							res.end(JSON.stringify({ error: '노트를 찾을 수 없습니다' }));
						}
						return;
					}

					// 알 수 없는 엔드포인트
					res.writeHead(404);
					res.end(JSON.stringify({ error: 'Not found' }));

				} catch (error) {
					console.error('Server error:', error);
					res.writeHead(500);
					res.end(JSON.stringify({ error: 'Internal server error' }));
				}
			});

			this.server.listen(this.settings.serverPort, '127.0.0.1', () => {
				this.isServerRunning = true;
				this.updateStatusBar();
				new Notice(`NotebookLM Bridge 서버 시작 (포트: ${this.settings.serverPort})`);
			});

			this.server.on('error', (error: NodeJS.ErrnoException) => {
				if (error.code === 'EADDRINUSE') {
					new Notice(`포트 ${this.settings.serverPort}가 이미 사용 중입니다`);
				} else {
					new Notice(`서버 오류: ${error.message}`);
				}
				this.isServerRunning = false;
				this.updateStatusBar();
			});

		} catch (error) {
			console.error('Failed to start server:', error);
			new Notice('서버 시작 실패');
		}
	}

	async stopServer() {
		if (this.server) {
			return new Promise<void>((resolve) => {
				this.server?.close(() => {
					this.server = null;
					this.isServerRunning = false;
					this.updateStatusBar();
					new Notice('NotebookLM Bridge 서버 중지');
					resolve();
				});
			});
		}
	}

	// NotebookLM 웹뷰 열기
	async openNotebookLMView() {
		const existing = this.app.workspace.getLeavesOfType(NOTEBOOKLM_VIEW_TYPE);

		if (existing.length > 0) {
			// 이미 열려있으면 활성화
			this.app.workspace.revealLeaf(existing[0]);
		} else {
			// 오른쪽 사이드바에 열기
			const leaf = this.app.workspace.getRightLeaf(false);
			if (leaf) {
				await leaf.setViewState({
					type: NOTEBOOKLM_VIEW_TYPE,
					active: true,
				});
				this.app.workspace.revealLeaf(leaf);
			}
		}
	}

	// NotebookLM 웹뷰 가져오기
	getNotebookLMView(): NotebookLMView | null {
		const leaves = this.app.workspace.getLeavesOfType(NOTEBOOKLM_VIEW_TYPE);
		if (leaves.length > 0) {
			return leaves[0].view as NotebookLMView;
		}
		return null;
	}

	async getCurrentNote(): Promise<NoteData | null> {
		const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);
		if (!activeView || !activeView.file) {
			return null;
		}
		return await this.getFileContent(activeView.file);
	}

	async getFileContent(file: TFile): Promise<NoteData> {
		let content = await this.app.vault.read(file);
		
		// Frontmatter 처리
		if (!this.settings.includeFrontmatter) {
			content = content.replace(/^---\n[\s\S]*?\n---\n/, '');
		}

		const note: NoteData = {
			title: file.basename,
			content: content.trim(),
			path: file.path
		};

		if (this.settings.includeMetadata) {
			const cache = this.app.metadataCache.getFileCache(file);
			note.metadata = {
				created: file.stat.ctime,
				modified: file.stat.mtime,
				tags: cache?.tags?.map(t => t.tag) || []
			};
		}

		return note;
	}

	async sendCurrentNoteToQueue() {
		new Notice('전송 버튼 클릭됨!'); // 디버그용

		const note = await this.getCurrentNote();
		if (!note) {
			new Notice('활성 노트가 없습니다');
			return;
		}

		new Notice(`노트: ${note.title} - 모달 열기 시도`); // 디버그용

		// 바로 모달 표시
		const notebooks: NotebookInfo[] = []; // 빈 목록으로 테스트
		const modal = new NotebookSelectModal(this.app, this, notebooks, note.title, async (selected) => {
			if (selected) {
				new Notice(`선택: ${selected.title}`);
			} else {
				new Notice('새 노트북 만들기 선택됨');
			}
			this.addToQueue(note);
			await this.openNotebookLMView();
		});
		modal.open();
	}

	// 노트북 선택 모달 표시
	async showNotebookSelectModal(note: NoteData) {
		console.log('[NotebookLM Bridge] 모달 표시 시작');

		// 웹뷰에서 노트북 목록 가져오기 시도
		let notebooks: NotebookInfo[] = [];

		const view = this.getNotebookLMView();
		if (view && view.webview) {
			try {
				const result = await view.webview.executeJavaScript(`
					(function() {
						const notebooks = [];
						document.querySelectorAll('a[href*="/notebook/"]').forEach(el => {
							const href = el.getAttribute('href');
							const match = href.match(/\\/notebook\\/([^/]+)/);
							if (match) {
								let title = el.textContent.trim();
								if (!title || title.length > 100) {
									const titleEl = el.querySelector('[class*="title"], h2, h3, span');
									if (titleEl) title = titleEl.textContent.trim();
								}
								if (title && !notebooks.find(n => n.id === match[1])) {
									notebooks.push({
										id: match[1],
										title: title || 'Untitled',
										url: 'https://notebooklm.google.com' + href
									});
								}
							}
						});
						return notebooks;
					})();
				`);
				notebooks = result || [];
				console.log('[NotebookLM Bridge] 노트북 목록:', notebooks);
			} catch (error) {
				console.error('[NotebookLM Bridge] 노트북 목록 가져오기 실패:', error);
			}
		}

		console.log('[NotebookLM Bridge] 모달 생성');

		// 모달 표시
		const modal = new NotebookSelectModal(this.app, this, notebooks, note.title, async (selectedNotebook) => {
			// NotebookLM 웹뷰 열기
			await this.openNotebookLMView();
			const nlmView = this.getNotebookLMView();

			if (selectedNotebook) {
				// 기존 노트북 선택
				new Notice(`"${selectedNotebook.title}" 노트북으로 이동 중...`);

				if (nlmView && nlmView.webview) {
					// 노트북으로 이동
					nlmView.webview.loadURL(selectedNotebook.url);

					// 대기열에 추가하고 자동 추가 시도
					this.addToQueue(note);

					// 잠시 후 소스 추가 시도
					setTimeout(() => {
						nlmView.addFromQueue();
					}, 3000);
				} else {
					this.addToQueue(note);
				}
			} else {
				// 새 노트북 만들기
				new Notice('NotebookLM에서 새 노트북을 만들어주세요.\n노트가 대기열에 추가되었습니다.');
				this.addToQueue(note);

				if (nlmView && nlmView.webview) {
					// 노트북 목록 페이지로 이동
					nlmView.webview.loadURL('https://notebooklm.google.com');
				}
			}
		});

		modal.open();
	}

	async sendFileToQueue(file: TFile) {
		const note = await this.getFileContent(file);

		// NotebookLM 웹뷰 열기
		await this.openNotebookLMView();
		const view = this.getNotebookLMView();

		if (view && view.webview) {
			// 노트북 목록 페이지로 이동 (노트북 목록을 가져오기 위해)
			new Notice('노트북 목록을 가져오는 중...');
			view.webview.loadURL('https://notebooklm.google.com');

			// 페이지 로드 대기 후 노트북 목록 가져오기
			setTimeout(async () => {
				const notebooks = await this.getNotebooksFromWebview();
				console.log('[NotebookLM Bridge] Found notebooks:', notebooks);
				this.showNotebookModal(note, notebooks);
			}, 3000);
		} else {
			// 웹뷰 없으면 바로 모달 표시
			this.showNotebookModal(note, []);
		}
	}

	// 웹뷰에서 노트북 목록 가져오기
	async getNotebooksFromWebview(): Promise<NotebookInfo[]> {
		const view = this.getNotebookLMView();
		if (!view || !view.webview) {
			return [];
		}

		try {
			const result = await view.webview.executeJavaScript(`
				(function() {
					const notebooks = [];
					const seen = new Set();

					// 방법 1: project-table에서 노트북 제목 가져오기
					const table = document.querySelector('table.project-table');
					if (table) {
						const rows = table.querySelectorAll('tbody tr, tr');
						rows.forEach((row, index) => {
							const titleEl = row.querySelector('.project-table-title, [class*="table-title"]');
							if (titleEl) {
								const title = titleEl.textContent.trim();
								if (title && !seen.has(title)) {
									seen.add(title);
									notebooks.push({
										id: 'row-' + index,
										title: title,
										url: '',  // URL 없음, 행 클릭으로 이동
										rowIndex: index
									});
								}
							}
						});
					}

					// 방법 2: project-table-title 스팬 직접 찾기
					if (notebooks.length === 0) {
						document.querySelectorAll('.project-table-title, span[class*="project-table-title"]').forEach((el, index) => {
							const title = el.textContent.trim();
							if (title && !seen.has(title)) {
								seen.add(title);
								notebooks.push({
									id: 'title-' + index,
									title: title,
									url: '',
									rowIndex: index
								});
							}
						});
					}

					// 방법 3: a[href*="/notebook/"] 링크 찾기 (이전 방식)
					if (notebooks.length === 0) {
						document.querySelectorAll('a[href*="/notebook/"]').forEach(el => {
							const href = el.getAttribute('href') || '';
							const match = href.match(/\\/notebook\\/([^/\\?]+)/);
							if (match && !seen.has(match[1])) {
								seen.add(match[1]);
								const title = el.textContent.trim() || 'Untitled notebook';
								notebooks.push({
									id: match[1],
									title: title,
									url: 'https://notebooklm.google.com' + href
								});
							}
						});
					}

					console.log('[Bridge] Found notebooks:', notebooks);
					return notebooks;
				})();
			`);
			return result || [];
		} catch (error) {
			console.error('[NotebookLM Bridge] Failed to get notebooks:', error);
			return [];
		}
	}

	// 노트북 선택 모달 표시
	showNotebookModal(note: NoteData, notebooks: NotebookInfo[]) {
		const modal = new NotebookSelectModal(this.app, this, notebooks, note.title, async (selected: any) => {
			const view = this.getNotebookLMView();

			if (selected) {
				// 기존 노트북 선택
				new Notice(`"${selected.title}" 노트북으로 이동 중...`);

				if (view && view.webview) {
					if (selected.url) {
						// URL이 있으면 직접 이동
						view.webview.loadURL(selected.url);
					} else if (selected.rowIndex !== undefined) {
						// URL이 없으면 테이블 행 클릭
						await view.webview.executeJavaScript(`
							(function() {
								const title = ${JSON.stringify(selected.title)};
								// 제목으로 행 찾기
								const titleEls = document.querySelectorAll('.project-table-title');
								for (const el of titleEls) {
									if (el.textContent.trim() === title) {
										// 부모 행(tr) 찾아서 클릭
										const row = el.closest('tr');
										if (row) {
											row.click();
											console.log('[Bridge] Clicked row for:', title);
											return true;
										}
									}
								}
								return false;
							})();
						`);
					}

					// 페이지 로드 후 소스 추가
					setTimeout(() => {
						this.addSourceToNotebook(view, note);
					}, 3000);
				}
			} else {
				// 새 노트북 만들기
				new Notice('새 노트북 생성 중...');

				if (view && view.webview) {
					// 새 노트북 만들기 버튼 클릭
					await view.webview.executeJavaScript(`
						(function() {
							const buttons = document.querySelectorAll('button');
							for (const btn of buttons) {
								const text = (btn.textContent || '').toLowerCase();
								if (text.includes('만들기') || text.includes('create')) {
									btn.click();
									console.log('[Bridge] Clicked create notebook button');
									return true;
								}
							}
							return false;
						})();
					`);

					setTimeout(() => {
						this.addSourceToNotebook(view, note);
					}, 3000);
				}
			}
		});
		modal.open();
	}

	// 새 노트북 생성 후 소스 추가
	async createNewNotebookAndAddSource(view: NotebookLMView, note: NoteData) {
		if (!view.webview) return;

		try {
			// 새 노트북 만들기 버튼 클릭
			await view.webview.executeJavaScript(`
				(async function() {
					// "+ 만들기" 버튼 찾기
					const createBtnSelectors = [
						'button:has-text("만들기")',
						'button:has-text("Create")',
						'button[aria-label*="Create"]',
						'button[aria-label*="만들기"]',
						'[class*="create"] button',
						'button[class*="create"]'
					];

					let createBtn = null;

					// 버튼 텍스트로 찾기
					const allButtons = document.querySelectorAll('button');
					for (const btn of allButtons) {
						const text = btn.textContent.toLowerCase();
						if (text.includes('만들기') || text.includes('create') || text.includes('new')) {
							createBtn = btn;
							break;
						}
					}

					if (createBtn) {
						createBtn.click();
						console.log('[Obsidian Bridge] Create button clicked');
						return { success: true, action: 'clicked_create' };
					}

					return { success: false, error: 'Create button not found' };
				})();
			`);

			new Notice('새 노트북이 생성되면 소스가 자동 추가됩니다.\n잠시 기다려주세요...');

			// 새 노트북 페이지 로드 후 소스 추가
			setTimeout(() => {
				this.addSourceToNotebook(view, note);
			}, 4000);

		} catch (error) {
			console.error('[NotebookLM Bridge] Create notebook failed:', error);
			new Notice('새 노트북 생성에 실패했습니다. 수동으로 생성해주세요.');
			this.addToQueue(note);
		}
	}

	// 노트북에 소스 추가 (완전 자동화)
	async addSourceToNotebook(view: NotebookLMView, note: NoteData) {
		if (!view.webview) return;

		const content = '# ' + note.title + '\n\n' + note.content;
		new Notice(`"${note.title}" 소스 자동 추가 중...`);

		try {
			// Step 1: 소스 추가 버튼 클릭
			const step1 = await view.webview.executeJavaScript(`
				(function() {
					// 여러 셀렉터 시도
					const selectors = [
						'button.add-source-button',
						'button[aria-label="출처 추가"]',
						'button[aria-label="업로드 소스 대화상자 열기"]',
						'button.upload-button',
						'button.upload-icon-button'
					];

					for (const sel of selectors) {
						const btn = document.querySelector(sel);
						if (btn && !btn.disabled) {
							btn.click();
							console.log('[Bridge] Clicked:', sel);
							return { success: true, selector: sel };
						}
					}

					// 텍스트로 찾기
					const buttons = document.querySelectorAll('button');
					for (const btn of buttons) {
						const text = (btn.textContent || '').trim();
						if (text.includes('소스 추가') || text.includes('소스 업로드') ||
							text === 'upload' || text.includes('Add source')) {
							btn.click();
							console.log('[Bridge] Clicked button with text:', text);
							return { success: true, text: text };
						}
					}

					return { success: false, error: 'Source add button not found' };
				})();
			`);
			console.log('[NotebookLM Bridge] Step 1 (소스 추가 버튼):', step1);

			// Step 2: 소스 업로드 모달에서 "복사된 텍스트" 옵션 찾아 클릭
			await this.delay(1500);

			const step2 = await view.webview.executeJavaScript(`
				(function() {
					// 모달 찾기
					const modal = document.querySelector('.upload-dialog-panel, [role="dialog"], mat-bottom-sheet-container');
					if (!modal) {
						return { success: false, error: 'Modal not found' };
					}

					// 모달 내 모든 요소에서 "복사된 텍스트" 찾기
					const allElements = modal.querySelectorAll('*');
					for (const el of allElements) {
						const text = (el.textContent || '').trim();
						// 정확히 "복사된 텍스트" 매칭
						if (text === '복사된 텍스트' || text === 'Copied text') {
							el.click();
							console.log('[Bridge] Clicked 복사된 텍스트');
							return { success: true, clicked: text };
						}
					}

					// "텍스트 붙여넣기" 섹션 클릭 시도
					for (const el of allElements) {
						const text = (el.textContent || '').trim();
						if (text === '텍스트 붙여넣기' || text.includes('텍스트 붙여넣기')) {
							el.click();
							console.log('[Bridge] Clicked 텍스트 붙여넣기 section');
							return { success: true, clicked: text, needsSecondClick: true };
						}
					}

					return { success: false, error: 'Text paste option not found' };
				})();
			`);
			console.log('[NotebookLM Bridge] Step 2 (복사된 텍스트 옵션):', step2);

			// Step 2.5: "텍스트 붙여넣기" 클릭 후 "복사된 텍스트" 클릭 필요할 수 있음
			if (step2?.needsSecondClick) {
				await this.delay(500);
				await view.webview.executeJavaScript(`
					(function() {
						const modal = document.querySelector('.upload-dialog-panel, [role="dialog"], mat-bottom-sheet-container');
						if (!modal) return;
						const allElements = modal.querySelectorAll('*');
						for (const el of allElements) {
							const text = (el.textContent || '').trim();
							if (text === '복사된 텍스트' || text === 'Copied text') {
								el.click();
								return { success: true };
							}
						}
					})();
				`);
			}

			// Step 3: 텍스트 입력 (textarea.text-area)
			await this.delay(1500);

			const step3 = await view.webview.executeJavaScript(`
				(function() {
					const content = ${JSON.stringify(content)};

					// 정확한 셀렉터: textarea.text-area
					let textarea = document.querySelector('textarea.text-area');

					// 없으면 다이얼로그 내 textarea 찾기
					if (!textarea) {
						const modal = document.querySelector('.upload-dialog-panel, [role="dialog"], mat-dialog-container');
						if (modal) {
							textarea = modal.querySelector('textarea');
						}
					}

					if (textarea && textarea.offsetParent !== null) {
						textarea.focus();
						textarea.value = content;
						// Angular/React 등에서 값 변경 감지를 위해 여러 이벤트 발생
						textarea.dispatchEvent(new Event('input', { bubbles: true }));
						textarea.dispatchEvent(new Event('change', { bubbles: true }));
						textarea.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true }));
						console.log('[Bridge] Text inserted into textarea.text-area');
						return { success: true };
					}

					return { success: false, error: 'textarea.text-area not found or not visible' };
				})();
			`);
			console.log('[NotebookLM Bridge] Step 3 (텍스트 입력):', step3);

			// Step 4: 삽입 버튼 클릭
			await this.delay(800);

			const step4 = await view.webview.executeJavaScript(`
				(function() {
					const buttons = document.querySelectorAll('button');
					for (const btn of buttons) {
						const text = (btn.textContent || '').trim();
						if (text === '삽입' || text === 'Insert') {
							// 버튼이 활성화될 때까지 대기
							if (!btn.disabled) {
								btn.click();
								console.log('[Bridge] Clicked 삽입 button');
								return { success: true };
							} else {
								return { success: false, error: '삽입 button is disabled' };
							}
						}
					}
					return { success: false, error: '삽입 button not found' };
				})();
			`);
			console.log('[NotebookLM Bridge] Step 4 (삽입 버튼):', step4);

			if (step3?.success && step4?.success) {
				new Notice(`✅ "${note.title}" 소스가 추가되었습니다!`, 5000);
			} else if (step3?.success) {
				new Notice(`📝 텍스트 입력 완료!\n"삽입" 버튼을 클릭해주세요.`, 5000);
			} else {
				// 자동화 실패 시 클립보드로 폴백
				await navigator.clipboard.writeText(content);
				new Notice(`📋 자동 입력 실패. 클립보드에 복사됨.\n\nCmd+V로 붙여넣기 후 삽입 클릭`, 8000);
			}

		} catch (error) {
			console.error('[NotebookLM Bridge] Auto add source failed:', error);
			try {
				await navigator.clipboard.writeText(content);
				new Notice(`📋 "${note.title}" 클립보드에 복사됨.\n\n수동으로 붙여넣기 해주세요.`, 8000);
			} catch (e) {
				new Notice('소스 추가에 실패했습니다.', 5000);
			}
		}
	}

	private delay(ms: number): Promise<void> {
		return new Promise(resolve => setTimeout(resolve, ms));
	}

	// 디버그: 웹뷰 DOM 정보 수집
	async debugWebviewDOM() {
		const view = this.getNotebookLMView();
		if (!view || !view.webview) {
			new Notice('NotebookLM 웹뷰가 열려있지 않습니다.\n먼저 NotebookLM을 열어주세요.');
			return;
		}

		new Notice('DOM 정보 수집 중...');

		try {
			const domInfo = await view.webview.executeJavaScript(`
				(function() {
					const info = {
						url: window.location.href,
						title: document.title,
						buttons: [],
						clickableElements: [],
						textInputs: [],
						dialogs: [],
						notebookLinks: []
					};

					// 모든 버튼 정보
					document.querySelectorAll('button').forEach((btn, i) => {
						info.buttons.push({
							index: i,
							text: (btn.textContent || '').trim().substring(0, 50),
							ariaLabel: btn.getAttribute('aria-label'),
							className: btn.className.substring(0, 100),
							disabled: btn.disabled,
							visible: btn.offsetParent !== null
						});
					});

					// role="button" 요소들
					document.querySelectorAll('[role="button"]').forEach((el, i) => {
						info.clickableElements.push({
							index: i,
							tagName: el.tagName,
							text: (el.textContent || '').trim().substring(0, 50),
							ariaLabel: el.getAttribute('aria-label'),
							className: el.className.substring(0, 100)
						});
					});

					// 텍스트 입력 필드
					document.querySelectorAll('textarea, input[type="text"], input:not([type]), [contenteditable="true"]').forEach((el, i) => {
						info.textInputs.push({
							index: i,
							tagName: el.tagName,
							placeholder: el.getAttribute('placeholder'),
							className: el.className.substring(0, 100),
							visible: el.offsetParent !== null
						});
					});

					// 다이얼로그/모달
					document.querySelectorAll('[role="dialog"], [role="modal"], [class*="dialog"], [class*="modal"]').forEach((el, i) => {
						info.dialogs.push({
							index: i,
							tagName: el.tagName,
							role: el.getAttribute('role'),
							className: el.className.substring(0, 100),
							visible: el.offsetParent !== null,
							innerText: (el.textContent || '').trim().substring(0, 200)
						});
					});

					// 노트북 링크 정보 수집 (a 태그)
					document.querySelectorAll('a[href*="/notebook/"]').forEach((el, i) => {
						const href = el.getAttribute('href') || '';
						const parent = el.closest('[class*="card"], [class*="item"], [class*="project"]');
						let title = '';
						if (parent) {
							const titleEl = parent.querySelector('[class*="title"], [class*="name"], h1, h2, h3');
							if (titleEl) title = titleEl.textContent.trim();
						}
						if (!title) title = el.textContent.trim();

						info.notebookLinks.push({
							index: i,
							href: href,
							title: title.substring(0, 100),
							parentClass: parent ? parent.className.substring(0, 100) : null,
							type: 'a-tag'
						});
					});

					// 프로젝트/노트북 카드 요소 수집
					info.projectCards = [];
					document.querySelectorAll('[class*="project-card"], [class*="notebook"], mat-card, [class*="card"]').forEach((el, i) => {
						const text = (el.textContent || '').trim().substring(0, 100);
						const link = el.querySelector('a');
						info.projectCards.push({
							index: i,
							tagName: el.tagName,
							className: el.className.substring(0, 150),
							text: text,
							hasLink: !!link,
							linkHref: link ? link.getAttribute('href') : null
						});
					});

					// 클릭 가능한 project 관련 요소
					info.projectItems = [];
					document.querySelectorAll('[class*="project"]').forEach((el, i) => {
						if (i < 30) { // 처음 30개만
							info.projectItems.push({
								index: i,
								tagName: el.tagName,
								className: el.className.substring(0, 150),
								text: (el.textContent || '').trim().substring(0, 80)
							});
						}
					});

					return info;
				})();
			`);

			// 결과를 파일로 저장
			const debugContent = JSON.stringify(domInfo, null, 2);
			const debugPath = 'notebooklm-debug.json';

			await this.app.vault.adapter.write(debugPath, debugContent);
			new Notice(`DOM 정보가 ${debugPath}에 저장되었습니다.\n\n버튼 ${domInfo.buttons.length}개\n노트북 링크 ${domInfo.notebookLinks.length}개\n입력필드 ${domInfo.textInputs.length}개\n다이얼로그 ${domInfo.dialogs.length}개`, 8000);

			console.log('[NotebookLM Bridge] DOM Info:', domInfo);

		} catch (error) {
			console.error('[NotebookLM Bridge] Debug failed:', error);
			new Notice('DOM 정보 수집 실패: ' + error.message);
		}
	}

	async sendTextToQueue(text: string, title: string) {
		const note: NoteData = {
			title: title,
			content: text,
			path: ''
		};
		this.addToQueue(note);
		new Notice('선택된 텍스트가 대기열에 추가되었습니다.');
	}

	addToQueue(note: NoteData) {
		const id = `note-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
		this.noteQueue.set(id, {
			id,
			note,
			timestamp: Date.now(),
			status: 'pending'
		});
		this.updateStatusBar();
	}
}

// NotebookLM 웹뷰 클래스
class NotebookLMView extends ItemView {
	plugin: NotebookLMBridgePlugin;
	webviewEl: HTMLElement;
	webview: any; // Electron webview

	constructor(leaf: WorkspaceLeaf, plugin: NotebookLMBridgePlugin) {
		super(leaf);
		this.plugin = plugin;
	}

	getViewType(): string {
		return NOTEBOOKLM_VIEW_TYPE;
	}

	getDisplayText(): string {
		return 'NotebookLM';
	}

	getIcon(): string {
		return 'book-open';
	}

	async onOpen() {
		const container = this.containerEl.children[1];
		container.empty();
		container.addClass('notebooklm-view-container');

		// 상단 툴바
		const toolbar = container.createDiv('notebooklm-toolbar');

		// 새로고침 버튼
		const refreshBtn = toolbar.createEl('button', { text: '🔄 새로고침' });
		refreshBtn.onclick = () => this.refresh();

		// 노트북 목록 버튼
		const listBtn = toolbar.createEl('button', { text: '📚 노트북 목록' });
		listBtn.onclick = () => this.goToNotebookList();

		// 대기열 추가 버튼
		const addBtn = toolbar.createEl('button', { text: '📥 대기열 추가', cls: 'mod-cta' });
		addBtn.onclick = () => this.addFromQueue();

		// 상태 표시
		this.webviewEl = container.createDiv('notebooklm-webview-container');

		// Electron webview 생성
		const webviewHtml = `<webview
			id="notebooklm-webview"
			src="https://notebooklm.google.com"
			style="width: 100%; height: 100%;"
			allowpopups
			partition="persist:notebooklm"
		></webview>`;

		this.webviewEl.innerHTML = webviewHtml;
		this.webview = this.webviewEl.querySelector('webview');

		// webview 이벤트 리스너
		if (this.webview) {
			this.webview.addEventListener('dom-ready', () => {
				this.injectScript();
			});

			this.webview.addEventListener('ipc-message', (event: any) => {
				this.handleWebviewMessage(event);
			});

			this.webview.addEventListener('did-navigate', (event: any) => {
				console.log('[NotebookLM] Navigated to:', event.url);
			});
		}
	}

	async onClose() {
		// 정리 작업
	}

	refresh() {
		if (this.webview) {
			this.webview.reload();
		}
	}

	goToNotebookList() {
		if (this.webview) {
			this.webview.loadURL('https://notebooklm.google.com');
		}
	}

	// 웹뷰에 스크립트 삽입
	async injectScript() {
		if (!this.webview) return;

		const script = `
			(function() {
				if (window.__obsidianBridgeInjected) return;
				window.__obsidianBridgeInjected = true;

				console.log('[Obsidian Bridge] Script injected');

				// 페이지 상태 분석
				function analyzePageState() {
					const path = window.location.pathname;
					const state = {
						path: path,
						isNotebookList: path === '/' || path === '',
						isInsideNotebook: path.includes('/notebook/'),
						notebookId: null,
						notebookTitle: null
					};

					if (state.isInsideNotebook) {
						const match = path.match(/\\/notebook\\/([^/]+)/);
						if (match) state.notebookId = match[1];

						// 노트북 제목 찾기
						const titleEl = document.querySelector('h1, [class*="title"]');
						if (titleEl) state.notebookTitle = titleEl.textContent.trim();
					}

					return state;
				}

				// 노트북 목록 가져오기
				function getNotebookList() {
					const notebooks = [];
					// NotebookLM의 노트북 카드/링크 찾기
					document.querySelectorAll('a[href*="/notebook/"]').forEach(el => {
						const href = el.getAttribute('href');
						const match = href.match(/\\/notebook\\/([^/]+)/);
						if (match) {
							notebooks.push({
								id: match[1],
								title: el.textContent.trim() || 'Untitled',
								url: href
							});
						}
					});
					return notebooks;
				}

				// 소스 추가 함수
				async function addSource(content, title) {
					console.log('[Obsidian Bridge] Adding source:', title);

					// "Add source" 버튼 찾기
					const addBtnSelectors = [
						'button[aria-label*="Add"]',
						'button[aria-label*="source"]',
						'[class*="add-source"]',
						'button:has(span:contains("Add"))'
					];

					let addBtn = null;
					for (const sel of addBtnSelectors) {
						try {
							addBtn = document.querySelector(sel);
							if (addBtn) break;
						} catch(e) {}
					}

					if (addBtn) {
						addBtn.click();
						await new Promise(r => setTimeout(r, 500));
					}

					// "Copied text" 옵션 찾기
					const textOptionSelectors = [
						'[role="menuitem"]',
						'button',
						'div[class*="option"]'
					];

					for (const sel of textOptionSelectors) {
						const els = document.querySelectorAll(sel);
						for (const el of els) {
							if (el.textContent.includes('Copied text') ||
								el.textContent.includes('Paste') ||
								el.textContent.includes('텍스트')) {
								el.click();
								await new Promise(r => setTimeout(r, 500));
								break;
							}
						}
					}

					// textarea 찾아서 내용 입력
					const textarea = document.querySelector('textarea, [contenteditable="true"]');
					if (textarea) {
						const fullContent = '# ' + title + '\\n\\n' + content;
						if (textarea.tagName === 'TEXTAREA') {
							textarea.value = fullContent;
							textarea.dispatchEvent(new Event('input', { bubbles: true }));
						} else {
							textarea.textContent = fullContent;
							textarea.dispatchEvent(new InputEvent('input', { bubbles: true }));
						}
						await new Promise(r => setTimeout(r, 300));

						// 확인 버튼 클릭
						const confirmBtn = Array.from(document.querySelectorAll('button')).find(
							btn => btn.textContent.includes('Insert') ||
								   btn.textContent.includes('Add') ||
								   btn.textContent.includes('추가')
						);
						if (confirmBtn) {
							confirmBtn.click();
							return { success: true };
						}
					}

					// 실패 시 클립보드에 복사
					const fullContent = '# ' + title + '\\n\\n' + content;
					await navigator.clipboard.writeText(fullContent);
					return { success: false, clipboard: true };
				}

				// 메시지 리스너
				window.addEventListener('message', async (event) => {
					if (event.data.type === 'obsidian-bridge') {
						const { action, payload } = event.data;
						let result = null;

						switch(action) {
							case 'getPageState':
								result = analyzePageState();
								break;
							case 'getNotebooks':
								result = getNotebookList();
								break;
							case 'addSource':
								result = await addSource(payload.content, payload.title);
								break;
							case 'navigateTo':
								window.location.href = payload.url;
								result = { success: true };
								break;
						}

						// 결과 전송
						if (window.require) {
							const { ipcRenderer } = window.require('electron');
							ipcRenderer.sendToHost('obsidian-bridge-response', { action, result });
						}
					}
				});

				// 초기 상태 전송
				setTimeout(() => {
					const state = analyzePageState();
					if (window.require) {
						const { ipcRenderer } = window.require('electron');
						ipcRenderer.sendToHost('obsidian-bridge-response', {
							action: 'pageStateChanged',
							result: state
						});
					}
				}, 1000);

				// URL 변경 감지
				let lastPath = window.location.pathname;
				setInterval(() => {
					if (window.location.pathname !== lastPath) {
						lastPath = window.location.pathname;
						const state = analyzePageState();
						if (window.require) {
							const { ipcRenderer } = window.require('electron');
							ipcRenderer.sendToHost('obsidian-bridge-response', {
								action: 'pageStateChanged',
								result: state
							});
						}
					}
				}, 1000);
			})();
		`;

		try {
			await this.webview.executeJavaScript(script);
			console.log('[NotebookLM] Script injected successfully');
		} catch (error) {
			console.error('[NotebookLM] Script injection failed:', error);
		}
	}

	// 웹뷰로 메시지 보내기
	sendToWebview(action: string, payload?: any) {
		if (this.webview) {
			this.webview.executeJavaScript(`
				window.postMessage({ type: 'obsidian-bridge', action: '${action}', payload: ${JSON.stringify(payload || {})} }, '*');
			`);
		}
	}

	// 웹뷰 메시지 처리
	handleWebviewMessage(event: any) {
		const { action, result } = event.args[0] || {};
		console.log('[NotebookLM] Message from webview:', action, result);

		if (action === 'pageStateChanged') {
			this.plugin.currentPageState = result;
			this.plugin.updateStatusBar();
		}
	}

	// 대기열에서 노트 추가
	async addFromQueue() {
		const pendingNotes = Array.from(this.plugin.noteQueue.entries())
			.filter(([, item]) => item.status === 'pending');

		if (pendingNotes.length === 0) {
			new Notice('대기열이 비어있습니다');
			return;
		}

		// 현재 노트북 안에 있는지 확인
		if (!this.plugin.currentPageState?.isInsideNotebook) {
			new Notice('먼저 노트북을 선택해주세요');
			return;
		}

		const [id, item] = pendingNotes[0];

		new Notice(`"${item.note.title}" 추가 중...`);

		this.sendToWebview('addSource', {
			title: item.note.title,
			content: item.note.content
		});

		// 대기열에서 제거
		setTimeout(() => {
			this.plugin.noteQueue.delete(id);
			this.plugin.updateStatusBar();
			new Notice(`"${item.note.title}" 추가 완료!`);
		}, 2000);
	}
}

// 노트북 선택 모달
class NotebookSelectModal extends Modal {
	plugin: NotebookLMBridgePlugin;
	notebooks: NotebookInfo[];
	onSelect: (notebook: NotebookInfo | null) => void;
	noteTitle: string;

	constructor(app: App, plugin: NotebookLMBridgePlugin, notebooks: NotebookInfo[], noteTitle: string, onSelect: (notebook: NotebookInfo | null) => void) {
		super(app);
		this.plugin = plugin;
		this.notebooks = notebooks;
		this.noteTitle = noteTitle;
		this.onSelect = onSelect;
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass('notebooklm-select-modal');

		// 헤더
		contentEl.createEl('h2', { text: '📚 노트북 선택' });
		contentEl.createEl('p', {
			text: `"${this.noteTitle}" 노트를 어디에 추가할까요?`,
			cls: 'modal-description'
		});

		// 새 노트북 만들기 섹션
		const newSection = contentEl.createDiv('modal-section');
		newSection.createEl('h3', { text: '새 노트북' });

		const newItem = newSection.createDiv('notebook-item new');
		newItem.innerHTML = `
			<span class="notebook-icon">➕</span>
			<div class="notebook-info">
				<span class="notebook-title">새 노트북 만들기</span>
				<span class="notebook-desc">NotebookLM에서 새 노트북을 생성합니다</span>
			</div>
		`;
		newItem.onclick = () => {
			this.onSelect(null);
			this.close();
		};

		// 기존 노트북 섹션
		if (this.notebooks.length > 0) {
			const existingSection = contentEl.createDiv('modal-section');
			existingSection.createEl('h3', { text: `기존 노트북 (${this.notebooks.length}개)` });

			const list = existingSection.createDiv('notebook-list');

			this.notebooks.forEach(notebook => {
				const item = list.createDiv('notebook-item');
				item.innerHTML = `
					<span class="notebook-icon">📓</span>
					<div class="notebook-info">
						<span class="notebook-title">${notebook.title}</span>
					</div>
				`;
				item.onclick = () => {
					this.onSelect(notebook);
					this.close();
				};
			});
		} else {
			const emptyMsg = contentEl.createDiv('empty-message');
			emptyMsg.innerHTML = `
				<p>⚠️ 기존 노트북을 찾을 수 없습니다.</p>
				<p class="hint">NotebookLM 웹뷰에서 노트북 목록 페이지로 이동한 후 다시 시도해주세요.</p>
			`;
		}

		// 취소 버튼
		const footer = contentEl.createDiv('modal-footer');
		const cancelBtn = footer.createEl('button', { text: '취소' });
		cancelBtn.onclick = () => this.close();
	}

	onClose() {
		const { contentEl } = this;
		contentEl.empty();
	}
}

class NotebookLMBridgeSettingTab extends PluginSettingTab {
	plugin: NotebookLMBridgePlugin;

	constructor(app: App, plugin: NotebookLMBridgePlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		containerEl.createEl('h2', { text: 'NotebookLM Bridge 설정' });

		// 서버 상태
		const statusDiv = containerEl.createDiv('setting-item');
		statusDiv.createEl('div', { 
			text: this.plugin.isServerRunning ? '🟢 서버 실행 중' : '🔴 서버 중지됨',
			cls: 'setting-item-name'
		});

		new Setting(containerEl)
			.setName('서버 포트')
			.setDesc('브릿지 서버가 사용할 포트 번호 (기본: 27123)')
			.addText(text => text
				.setPlaceholder('27123')
				.setValue(this.plugin.settings.serverPort.toString())
				.onChange(async (value) => {
					const port = parseInt(value);
					if (!isNaN(port) && port > 0 && port < 65536) {
						this.plugin.settings.serverPort = port;
						await this.plugin.saveSettings();
					}
				}));

		new Setting(containerEl)
			.setName('자동 시작')
			.setDesc('옵시디언 시작 시 브릿지 서버 자동 시작')
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.autoStart)
				.onChange(async (value) => {
					this.plugin.settings.autoStart = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('메타데이터 포함')
			.setDesc('노트 전송 시 생성/수정 시간, 태그 등 메타데이터 포함')
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.includeMetadata)
				.onChange(async (value) => {
					this.plugin.settings.includeMetadata = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Frontmatter 포함')
			.setDesc('노트 전송 시 YAML frontmatter 포함')
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.includeFrontmatter)
				.onChange(async (value) => {
					this.plugin.settings.includeFrontmatter = value;
					await this.plugin.saveSettings();
				}));

		// 서버 제어 버튼
		new Setting(containerEl)
			.setName('서버 제어')
			.setDesc('브릿지 서버 시작 또는 중지')
			.addButton(button => button
				.setButtonText(this.plugin.isServerRunning ? '서버 중지' : '서버 시작')
				.onClick(async () => {
					if (this.plugin.isServerRunning) {
						await this.plugin.stopServer();
					} else {
						await this.plugin.startServer();
					}
					this.display(); // 화면 새로고침
				}));

		// 크롬 확장 안내
		containerEl.createEl('h3', { text: '크롬 확장 프로그램' });
		containerEl.createEl('p', { 
			text: '이 플러그인을 사용하려면 동반 크롬 확장 프로그램이 필요합니다. NotebookLM 페이지에서 크롬 확장을 통해 대기열의 노트를 추가할 수 있습니다.'
		});

		// API 엔드포인트 정보
		containerEl.createEl('h3', { text: 'API 엔드포인트' });
		const apiList = containerEl.createEl('ul');
		const endpoints = [
			'GET /status - 서버 상태 확인',
			'GET /current-note - 현재 활성 노트 가져오기',
			'GET /queue - 대기열 조회',
			'POST /queue/pop - 대기열에서 노트 가져오기',
			'DELETE /queue/clear - 대기열 비우기'
		];
		endpoints.forEach(ep => {
			apiList.createEl('li', { text: ep });
		});
	}
}
