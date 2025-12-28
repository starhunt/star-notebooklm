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

// NotebookLM 웹뷰 타입
const NOTEBOOKLM_VIEW_TYPE = 'notebooklm-webview';

// 노트북 정보 인터페이스
interface NotebookInfo {
	id: string;
	title: string;
	url: string;
}

type SourceAddMethod = 'dom' | 'api';

interface NotebookLMBridgeSettings {
	includeMetadata: boolean;
	includeFrontmatter: boolean;
	sourceAddMethod: SourceAddMethod; // 'dom' = DOM 조작, 'api' = API 직접 호출
}

const DEFAULT_SETTINGS: NotebookLMBridgeSettings = {
	includeMetadata: true,
	includeFrontmatter: false,
	sourceAddMethod: 'api' // 기본값: API 방식
};

interface NoteData {
	title: string;
	content: string;
	path: string;
	shareLink?: string; // share_link frontmatter property
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
	}

	async onunload() {
		// cleanup
	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}

	updateStatusBar() {
		const queueSize = this.noteQueue.size;
		if (queueSize > 0) {
			this.statusBarItem.setText(`📋 NLM: ${queueSize}`);
			this.statusBarItem.setAttribute('title', `NotebookLM Bridge\n대기열: ${queueSize}개`);
		} else {
			this.statusBarItem.setText('📘 NLM Bridge');
			this.statusBarItem.setAttribute('title', 'NotebookLM Bridge 준비됨');
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
		const cache = this.app.metadataCache.getFileCache(file);

		// share_link frontmatter 속성 추출
		let shareLink: string | undefined;
		if (cache?.frontmatter?.share_link) {
			shareLink = cache.frontmatter.share_link;
		}

		// Frontmatter 처리
		if (!this.settings.includeFrontmatter) {
			content = content.replace(/^---\n[\s\S]*?\n---\n/, '');
		}

		const note: NoteData = {
			title: file.basename,
			content: content.trim(),
			path: file.path,
			shareLink: shareLink
		};

		if (this.settings.includeMetadata) {
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

					// 방법 1: project-table에서 노트북 제목 가져오기 (모바일/좁은 화면)
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
										url: '',
										rowIndex: index,
										viewType: 'table'
									});
								}
							}
						});
					}

					// 방법 2: PC 뷰 카드 레이아웃 - project-button 요소 (넓은 화면)
					if (notebooks.length === 0) {
						// project-button 요소들 찾기 (PC 카드 뷰의 메인 컨테이너)
						const projectButtons = document.querySelectorAll('project-button.project-button');
						projectButtons.forEach((btn, index) => {
							// span.project-button-title에서 제목 추출
							const titleEl = btn.querySelector('span.project-button-title, .project-button-title');
							if (titleEl) {
								const title = titleEl.textContent.trim();
								if (title && !seen.has(title) && !title.includes('새 노트') && !title.includes('만들기')) {
									seen.add(title);
									notebooks.push({
										id: 'projectbtn-' + index,
										title: title,
										url: '',
										cardIndex: index,
										viewType: 'projectButton'
									});
								}
							}
						});
					}

					// 방법 3: mat-card.project-button-card 찾기
					if (notebooks.length === 0) {
						const matCards = document.querySelectorAll('mat-card.project-button-card');
						matCards.forEach((card, index) => {
							const titleEl = card.querySelector('span.project-button-title, .project-button-title');
							if (titleEl) {
								const title = titleEl.textContent.trim();
								if (title && !seen.has(title) && !title.includes('새 노트') && !title.includes('만들기')) {
									seen.add(title);
									notebooks.push({
										id: 'matcard-' + index,
										title: title,
										url: '',
										cardIndex: index,
										viewType: 'matcard'
									});
								}
							}
						});
					}

					// 방법 4: 클릭 가능한 노트북 항목 (href 포함)
					if (notebooks.length === 0) {
						document.querySelectorAll('a[href*="/notebook/"]').forEach(el => {
							const href = el.getAttribute('href') || '';
							const match = href.match(/\\/notebook\\/([^/\\?]+)/);
							if (match && !seen.has(match[1])) {
								seen.add(match[1]);
								const title = el.textContent.trim() || 'Untitled notebook';
								// "새 노트 만들기" 제외
								if (!title.includes('새 노트') && !title.includes('만들기')) {
									notebooks.push({
										id: match[1],
										title: title,
										url: 'https://notebooklm.google.com' + href,
										viewType: 'link'
									});
								}
							}
						});
					}

					// 방법 5: 제목 텍스트 기반 검색 (최후의 방법)
					if (notebooks.length === 0) {
						// "내 노트북" 섹션 찾기
						const sections = document.querySelectorAll('[class*="section"], [class*="content"], main');
						sections.forEach(section => {
							const items = section.querySelectorAll('[role="button"], [role="listitem"], [class*="clickable"]');
							items.forEach((item, index) => {
								const text = item.textContent.trim();
								// 날짜 패턴이 포함된 항목은 노트북일 가능성 높음
								if (text && text.match(/\\d{4}.*\\d{1,2}.*\\d{1,2}/) && !seen.has(text.substring(0, 50))) {
									// 첫 줄만 제목으로 사용
									const lines = text.split('\\n');
									const title = lines[0].trim();
									if (title && !title.includes('새 노트') && !title.includes('만들기')) {
										seen.add(title);
										notebooks.push({
											id: 'item-' + index,
											title: title,
											url: '',
											itemIndex: index,
											viewType: 'item'
										});
									}
								}
							});
						});
					}

					console.log('[Bridge] Found notebooks:', notebooks, 'View type:', notebooks[0]?.viewType);
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
					} else {
						// viewType에 따라 다른 클릭 방식 사용
						await view.webview.executeJavaScript(`
							(function() {
								const title = ${JSON.stringify(selected.title)};
								const viewType = ${JSON.stringify(selected.viewType || 'table')};

								// 방법 1: 테이블 행 클릭 (모바일 뷰)
								if (viewType === 'table') {
									const titleEls = document.querySelectorAll('.project-table-title');
									for (const el of titleEls) {
										if (el.textContent.trim() === title) {
											const row = el.closest('tr');
											if (row) {
												row.click();
												console.log('[Bridge] Clicked table row for:', title);
												return { success: true, method: 'table' };
											}
										}
									}
								}

								// 방법 2: project-button 클릭 (PC 뷰 카드)
								if (viewType === 'projectButton') {
									const projectButtons = document.querySelectorAll('project-button.project-button');
									for (const btn of projectButtons) {
										const titleEl = btn.querySelector('span.project-button-title, .project-button-title');
										if (titleEl && titleEl.textContent.trim() === title) {
											// mat-card 또는 primary-action-button 클릭
											const clickTarget = btn.querySelector('.primary-action-button, mat-card.project-button-card') || btn;
											clickTarget.click();
											console.log('[Bridge] Clicked project-button for:', title);
											return { success: true, method: 'projectButton' };
										}
									}
								}

								// 방법 3: mat-card 클릭 (PC 뷰)
								if (viewType === 'matcard') {
									const matCards = document.querySelectorAll('mat-card.project-button-card');
									for (const card of matCards) {
										const titleEl = card.querySelector('span.project-button-title, .project-button-title');
										if (titleEl && titleEl.textContent.trim() === title) {
											const clickTarget = card.querySelector('.primary-action-button') || card;
											clickTarget.click();
											console.log('[Bridge] Clicked mat-card for:', title);
											return { success: true, method: 'matcard' };
										}
									}
								}

								// 방법 4: 제목 텍스트로 클릭 가능한 요소 찾기 (폴백)
								const allElements = document.querySelectorAll('*');
								for (const el of allElements) {
									if (el.textContent.trim() === title &&
										(el.tagName === 'H2' || el.tagName === 'H3' ||
										 el.className.includes('title') || el.closest('[role="button"]'))) {
										// 클릭 가능한 부모 찾기
										const clickable = el.closest('[role="button"], a, button, [class*="card"], [class*="item"], tr') || el;
										clickable.click();
										console.log('[Bridge] Clicked element for:', title, clickable.tagName);
										return { success: true, method: 'fallback' };
									}
								}

								return { success: false, error: 'Notebook not found: ' + title };
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

		// 설정에 따라 방식 선택
		if (this.settings.sourceAddMethod === 'api') {
			await this.addSourceViaAPI(view, note);
			return;
		}

		// DOM 조작 방식 (기본)
		await this.addSourceViaDOM(view, note);
	}

	// API 직접 호출 방식으로 소스 추가
	// izAoDd RPC로 텍스트/URL 모두 지원!
	async addSourceViaAPI(view: NotebookLMView, note: NoteData) {
		if (!view.webview) return;

		// share_link가 있으면 URL 소스로 추가
		if (note.shareLink) {
			await this.addUrlSourceViaAPI(view, note);
			return;
		}

		// 텍스트 소스 API로 추가
		await this.addTextSourceViaAPI(view, note);
	}

	// 텍스트 소스 API 추가 (izAoDd RPC) - nlm-py에서 검증된 페이로드
	async addTextSourceViaAPI(view: NotebookLMView, note: NoteData) {
		if (!view.webview) return;

		const title = note.title;
		const content = note.content;
		new Notice(`"${title}" 텍스트 소스 API로 추가 중...`);

		try {
			// Step 1: 노트북 ID와 at 토큰 추출
			const pageInfo = await view.webview.executeJavaScript(`
				(function() {
					const match = window.location.pathname.match(/\\/notebook\\/([^/]+)/);
					const notebookId = match ? match[1] : null;

					let atToken = null;
					const scripts = document.querySelectorAll('script');
					for (const script of scripts) {
						const text = script.textContent || '';
						const tokenMatch = text.match(/"SNlM0e":"([^"]+)"/);
						if (tokenMatch) {
							atToken = tokenMatch[1];
							break;
						}
					}
					if (!atToken && window.WIZ_global_data && window.WIZ_global_data.SNlM0e) {
						atToken = window.WIZ_global_data.SNlM0e;
					}

					return { notebookId, atToken };
				})();
			`);

			console.log('[NotebookLM Bridge] Page info:', pageInfo);

			if (!pageInfo.notebookId) {
				new Notice('노트북을 먼저 선택해주세요.');
				await this.addSourceViaDOM(view, note);
				return;
			}

			if (!pageInfo.atToken) {
				new Notice('인증 토큰을 찾을 수 없습니다. DOM 방식으로 전환...');
				await this.addSourceViaDOM(view, note);
				return;
			}

			// Step 2: izAoDd RPC로 텍스트 소스 추가
			// 변수를 안전하게 전달하기 위해 Base64 인코딩 사용
			const encodedTitle = Buffer.from(title, 'utf-8').toString('base64');
			const encodedContent = Buffer.from(content, 'utf-8').toString('base64');
			const requestId = 'obsidian_api_' + Date.now();

			// API 호출 시작 (결과는 window 객체에 저장)
			await view.webview.executeJavaScript(`
				(function() {
					// UTF-8 Base64 디코딩 함수
					function decodeBase64UTF8(base64) {
						var binary = atob(base64);
						var bytes = new Uint8Array(binary.length);
						for (var i = 0; i < binary.length; i++) {
							bytes[i] = binary.charCodeAt(i);
						}
						return new TextDecoder('utf-8').decode(bytes);
					}

					var notebookId = "${pageInfo.notebookId}";
					var atToken = "${pageInfo.atToken}";
					var title = decodeBase64UTF8("${encodedTitle}");
					var content = decodeBase64UTF8("${encodedContent}");
					var requestId = "${requestId}";

					window['__obsidian_result_' + requestId] = { pending: true };

					var rpcId = 'izAoDd';

					// nlm-py에서 검증된 텍스트 소스 페이로드
					var requestPayload = [
						[
							[
								null,
								[title, content],
								null,
								2
							]
						],
						notebookId
					];

					var requestBody = [[[rpcId, JSON.stringify(requestPayload), null, "generic"]]];

					var formData = new URLSearchParams();
					formData.append('at', atToken);
					formData.append('f.req', JSON.stringify(requestBody));

					var xhr = new XMLHttpRequest();
					xhr.open('POST', '/_/LabsTailwindUi/data/batchexecute?rpcids=' + rpcId, true);
					xhr.setRequestHeader('Content-Type', 'application/x-www-form-urlencoded;charset=UTF-8');
					xhr.withCredentials = true;

					xhr.onload = function() {
						var text = xhr.responseText;
						console.log('[API Response]', text.substring(0, 300));
						if (xhr.status === 200 && text.includes('wrb.fr')) {
							window['__obsidian_result_' + requestId] = { success: true, pending: false };
						} else {
							window['__obsidian_result_' + requestId] = { success: false, pending: false, error: 'API error: ' + xhr.status };
						}
					};

					xhr.onerror = function() {
						window['__obsidian_result_' + requestId] = { success: false, pending: false, error: 'Network error' };
					};

					xhr.send(formData.toString());
				})();
			`);

			// 결과 폴링 (최대 10초)
			let result = null;
			for (let i = 0; i < 20; i++) {
				await new Promise(resolve => setTimeout(resolve, 500));
				result = await view.webview.executeJavaScript(`
					(function() {
						var r = window['__obsidian_result_${requestId}'];
						if (r && !r.pending) {
							delete window['__obsidian_result_${requestId}'];
							return r;
						}
						return null;
					})();
				`);
				if (result) break;
			}

			console.log('[NotebookLM Bridge] Text API result:', result);

			if (result?.success) {
				new Notice(`✅ "${title}" 텍스트 소스 추가 완료!`);
			} else {
				console.log('[NotebookLM Bridge] Text API failed, falling back to DOM');
				new Notice('API 실패. DOM 방식으로 재시도...');
				await this.addSourceViaDOM(view, note);
			}

		} catch (error) {
			console.error('[NotebookLM Bridge] Text API failed:', error);
			new Notice('API 실패. DOM 방식으로 재시도...');
			await this.addSourceViaDOM(view, note);
		}
	}

	// URL 소스 API 추가 (izAoDd RPC) - 테스트로 검증됨
	async addUrlSourceViaAPI(view: NotebookLMView, note: NoteData) {
		if (!view.webview || !note.shareLink) return;

		new Notice(`"${note.title}" URL 소스 API로 추가 중...`);

		try {
			// Step 1: 노트북 ID와 at 토큰 추출
			const pageInfo = await view.webview.executeJavaScript(`
				(function() {
					const match = window.location.pathname.match(/\\/notebook\\/([^/]+)/);
					const notebookId = match ? match[1] : null;

					let atToken = null;
					const scripts = document.querySelectorAll('script');
					for (const script of scripts) {
						const text = script.textContent || '';
						const tokenMatch = text.match(/"SNlM0e":"([^"]+)"/);
						if (tokenMatch) {
							atToken = tokenMatch[1];
							break;
						}
					}
					if (!atToken && window.WIZ_global_data && window.WIZ_global_data.SNlM0e) {
						atToken = window.WIZ_global_data.SNlM0e;
					}

					return { notebookId, atToken };
				})();
			`);

			console.log('[NotebookLM Bridge] Page info:', pageInfo);

			if (!pageInfo.notebookId) {
				new Notice('노트북을 먼저 선택해주세요.');
				return;
			}

			if (!pageInfo.atToken) {
				new Notice('인증 토큰을 찾을 수 없습니다. DOM 방식으로 전환...');
				await this.addLinkSourceToNotebook(view, note);
				return;
			}

			// Step 2: izAoDd RPC로 URL 소스 추가
			const shareLink = note.shareLink;
			const requestId = 'obsidian_url_api_' + Date.now();

			// API 호출 시작 (결과는 window 객체에 저장)
			await view.webview.executeJavaScript(`
				(function() {
					var notebookId = "${pageInfo.notebookId}";
					var atToken = "${pageInfo.atToken}";
					var url = "${shareLink}";
					var requestId = "${requestId}";

					window['__obsidian_result_' + requestId] = { pending: true };

					var rpcId = 'izAoDd';
					var requestPayload = [
						[[null, null, [url], null, null, null, null, null, null, null, 1]],
						notebookId,
						[2],
						[1, null, null, null, null, null, null, null, null, null, [1]]
					];
					var requestBody = [[[rpcId, JSON.stringify(requestPayload), null, "generic"]]];

					var formData = new URLSearchParams();
					formData.append('at', atToken);
					formData.append('f.req', JSON.stringify(requestBody));

					var xhr = new XMLHttpRequest();
					xhr.open('POST', '/_/LabsTailwindUi/data/batchexecute?rpcids=' + rpcId, true);
					xhr.setRequestHeader('Content-Type', 'application/x-www-form-urlencoded;charset=UTF-8');
					xhr.withCredentials = true;

					xhr.onload = function() {
						var text = xhr.responseText;
						console.log('[API Response]', text.substring(0, 300));
						if (xhr.status === 200 && text.includes('wrb.fr')) {
							window['__obsidian_result_' + requestId] = { success: true, pending: false };
						} else {
							window['__obsidian_result_' + requestId] = { success: false, pending: false, error: 'API error: ' + xhr.status };
						}
					};

					xhr.onerror = function() {
						window['__obsidian_result_' + requestId] = { success: false, pending: false, error: 'Network error' };
					};

					xhr.send(formData.toString());
				})();
			`);

			// 결과 폴링 (최대 10초)
			let result = null;
			for (let i = 0; i < 20; i++) {
				await new Promise(resolve => setTimeout(resolve, 500));
				result = await view.webview.executeJavaScript(`
					(function() {
						var r = window['__obsidian_result_${requestId}'];
						if (r && !r.pending) {
							delete window['__obsidian_result_${requestId}'];
							return r;
						}
						return null;
					})();
				`);
				if (result) break;
			}

			console.log('[NotebookLM Bridge] URL API result:', result);

			if (result?.success) {
				new Notice(`✅ "${note.title}" URL 소스 추가 완료!`);
			} else {
				new Notice('API 실패. DOM 방식으로 재시도...');
				await this.addLinkSourceToNotebook(view, note);
			}

		} catch (error) {
			console.error('[NotebookLM Bridge] URL API failed:', error);
			new Notice('API 실패. DOM 방식으로 재시도...');
			await this.addLinkSourceToNotebook(view, note);
		}
	}

	// DOM 조작 방식으로 소스 추가
	async addSourceViaDOM(view: NotebookLMView, note: NoteData) {
		if (!view.webview) return;

		const content = '# ' + note.title + '\n\n' + note.content;
		new Notice(`"${note.title}" DOM 방식으로 소스 추가 중...`);

		try {
			// Step 0: 모바일 뷰인 경우 "출처" 탭으로 전환
			await view.webview.executeJavaScript(`
				(function() {
					// 탭 버튼 찾기 (출처, Sources, 소스)
					const tabs = document.querySelectorAll('[role="tab"], button[class*="tab"], mat-tab-header button, .mat-mdc-tab');
					for (const tab of tabs) {
						const text = (tab.textContent || '').trim().toLowerCase();
						if (text.includes('출처') || text.includes('sources') || text.includes('소스')) {
							tab.click();
							console.log('[Bridge] Switched to Sources tab');
							return { success: true, tab: text };
						}
					}

					// 네비게이션 바에서 찾기
					const navItems = document.querySelectorAll('nav button, nav a, [class*="nav"] button');
					for (const item of navItems) {
						const text = (item.textContent || '').trim().toLowerCase();
						if (text.includes('출처') || text.includes('sources') || text.includes('소스')) {
							item.click();
							console.log('[Bridge] Clicked nav item:', text);
							return { success: true, nav: text };
						}
					}

					// bottom-nav나 tab-bar 형태일 수 있음
					const bottomNav = document.querySelectorAll('[class*="bottom-nav"] *, [class*="tab-bar"] *');
					for (const item of bottomNav) {
						const text = (item.textContent || '').trim().toLowerCase();
						if (text.includes('출처') || text.includes('sources')) {
							item.click();
							return { success: true, bottomNav: text };
						}
					}

					return { success: false, error: 'Sources tab not found (might be desktop view)' };
				})();
			`);

			// 탭 전환 후 잠시 대기
			await this.delay(800);

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

			// Step 2: 소스 업로드 모달에서 스크롤 후 "복사된 텍스트" 옵션 찾아 클릭
			await this.delay(1500);

			// 모달 내부 스크롤 - 여러 방법 시도
			await view.webview.executeJavaScript(`
				(function() {
					// mat-bottom-sheet-container 내부의 스크롤 가능 영역 찾기
					const bottomSheet = document.querySelector('mat-bottom-sheet-container');
					if (bottomSheet) {
						// bottom-sheet 자체를 스크롤
						bottomSheet.scrollTop = bottomSheet.scrollHeight;
						console.log('[Bridge] Scrolled mat-bottom-sheet-container');
					}

					// upload-dialog-panel 내부 스크롤
					const panel = document.querySelector('.upload-dialog-panel');
					if (panel) {
						panel.scrollTop = panel.scrollHeight;
						// 패널 내부의 모든 오버플로우 가능 요소 찾기
						const scrollables = panel.querySelectorAll('*');
						for (const el of scrollables) {
							const style = window.getComputedStyle(el);
							if (style.overflowY === 'auto' || style.overflowY === 'scroll') {
								el.scrollTop = el.scrollHeight;
								console.log('[Bridge] Scrolled inner element:', el.className);
							}
						}
					}

					// cdk-overlay-pane 스크롤
					const overlay = document.querySelector('.cdk-overlay-pane');
					if (overlay) {
						overlay.scrollTop = overlay.scrollHeight;
					}
				})();
			`);

			await this.delay(500);

			// "텍스트 붙여넣기" 요소를 찾아서 scrollIntoView
			await view.webview.executeJavaScript(`
				(function() {
					const allElements = document.querySelectorAll('*');
					for (const el of allElements) {
						const text = (el.textContent || '').trim();
						if (text === '텍스트 붙여넣기' || text === 'Paste text') {
							el.scrollIntoView({ behavior: 'smooth', block: 'center' });
							console.log('[Bridge] Scrolled to 텍스트 붙여넣기 via scrollIntoView');
							return;
						}
					}
					// 못 찾으면 "복사된 텍스트"로 시도
					for (const el of allElements) {
						const text = (el.textContent || '').trim();
						if (text === '복사된 텍스트' || text === 'Copied text') {
							el.scrollIntoView({ behavior: 'smooth', block: 'center' });
							console.log('[Bridge] Scrolled to 복사된 텍스트 via scrollIntoView');
							return;
						}
					}
				})();
			`);

			await this.delay(800);

			const step2 = await view.webview.executeJavaScript(`
				(function() {
					// "복사된 텍스트" 직접 클릭 시도
					const allElements = document.querySelectorAll('*');
					for (const el of allElements) {
						const text = (el.textContent || '').trim();
						// 정확히 "복사된 텍스트" 매칭
						if (text === '복사된 텍스트' || text === 'Copied text') {
							el.click();
							console.log('[Bridge] Clicked 복사된 텍스트:', el.tagName, el.className);
							return { success: true, clicked: text };
						}
					}

					// "텍스트 붙여넣기" 섹션 클릭 (확장 필요할 수 있음)
					for (const el of allElements) {
						const text = (el.textContent || '').trim();
						if (text === '텍스트 붙여넣기' || text === 'Paste text') {
							el.click();
							console.log('[Bridge] Clicked 텍스트 붙여넣기:', el.tagName);
							return { success: true, clicked: text, needsSecondClick: true };
						}
					}

					return { success: false, error: 'Text paste option not found in DOM' };
				})();
			`);
			console.log('[NotebookLM Bridge] Step 2 (복사된 텍스트 옵션):', step2);

			// Step 2.5: "텍스트 붙여넣기" 클릭 후 "복사된 텍스트" 클릭 필요
			if (step2?.needsSecondClick) {
				await this.delay(800);
				await view.webview.executeJavaScript(`
					(function() {
						const modal = document.querySelector('.upload-dialog-panel, mat-bottom-sheet-container, [role="dialog"]');
						if (!modal) return { success: false };
						const allElements = modal.querySelectorAll('*');
						for (const el of allElements) {
							const text = (el.textContent || '').trim();
							if (text === '복사된 텍스트' || text === 'Copied text') {
								el.click();
								console.log('[Bridge] Step 2.5: Clicked 복사된 텍스트');
								return { success: true };
							}
						}
						return { success: false };
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

	// 링크 소스 추가 (share_link가 있는 노트용)
	async addLinkSourceToNotebook(view: NotebookLMView, note: NoteData) {
		if (!view.webview || !note.shareLink) return;

		try {
			// Step 0: 모바일 뷰인 경우 "출처" 탭으로 전환
			await view.webview.executeJavaScript(`
				(function() {
					const tabs = document.querySelectorAll('[role="tab"], button[class*="tab"], .mat-mdc-tab');
					for (const tab of tabs) {
						const text = (tab.textContent || '').trim().toLowerCase();
						if (text.includes('출처') || text.includes('sources') || text.includes('소스')) {
							tab.click();
							return { success: true, tab: text };
						}
					}
					return { success: false };
				})();
			`);
			await this.delay(800);

			// Step 1: 소스 추가 버튼 클릭
			const step1 = await view.webview.executeJavaScript(`
				(function() {
					const selectors = [
						'button[aria-label="출처 추가"]',
						'button[aria-label="소스 추가"]',
						'button.add-source-button',
						'button[aria-label="업로드 소스 대화상자 열기"]'
					];
					for (const sel of selectors) {
						const btn = document.querySelector(sel);
						if (btn && !btn.disabled) {
							btn.click();
							return { success: true, selector: sel };
						}
					}
					// 텍스트로 찾기
					const buttons = document.querySelectorAll('button');
					for (const btn of buttons) {
						const text = (btn.textContent || '').trim();
						if (text.includes('소스 추가') || text.includes('소스 업로드')) {
							btn.click();
							return { success: true, text: text };
						}
					}
					return { success: false, error: 'Source add button not found' };
				})();
			`);
			console.log('[NotebookLM Bridge] Link Step 1 (소스 추가 버튼):', step1);

			await this.delay(1500);

			// Step 2: "링크" 섹션 클릭
			await view.webview.executeJavaScript(`
				(function() {
					const m = document.querySelector('mat-bottom-sheet-container, .upload-dialog-panel');
					if (m) m.scrollTop = m.scrollHeight;
					for (const el of document.querySelectorAll('*')) {
						const text = (el.textContent || '').trim();
						if (text === '링크' || text === '웹사이트') {
							el.scrollIntoView({ block: 'center' });
							break;
						}
					}
				})();
			`);
			await this.delay(500);

			const step2 = await view.webview.executeJavaScript(`
				(function() {
					for (const el of document.querySelectorAll('*')) {
						const text = (el.textContent || '').trim();
						if (text === '링크') {
							el.click();
							return { success: true, tag: el.tagName };
						}
					}
					return { success: false, error: '링크 option not found' };
				})();
			`);
			console.log('[NotebookLM Bridge] Link Step 2 (링크 클릭):', step2);

			await this.delay(1000);

			// Step 3: "웹사이트" 클릭
			const step3 = await view.webview.executeJavaScript(`
				(function() {
					for (const el of document.querySelectorAll('span, div, button, a')) {
						const text = (el.textContent || '').trim();
						if (text === '웹사이트' || text === 'Website') {
							el.click();
							return { success: true, tag: el.tagName };
						}
					}
					return { success: false, error: '웹사이트 option not found' };
				})();
			`);
			console.log('[NotebookLM Bridge] Link Step 3 (웹사이트 클릭):', step3);

			await this.delay(2000);

			// Step 4: URL textarea 찾아서 입력
			const shareLink = note.shareLink;
			const step4 = await view.webview.executeJavaScript(`
				(function() {
					const url = ${JSON.stringify(shareLink)};

					// textarea 찾기 (웹사이트 URL 다이얼로그)
					const dialogs = document.querySelectorAll('mat-dialog-container, [role="dialog"], .cdk-overlay-pane');
					for (const dialog of dialogs) {
						const text = (dialog.textContent || '');
						if (text.includes('웹사이트 URL') || text.includes('URL 붙여넣기')) {
							const ta = dialog.querySelector('textarea');
							if (ta && ta.offsetParent !== null) {
								ta.focus();
								ta.value = url;
								ta.dispatchEvent(new Event('input', { bubbles: true }));
								ta.dispatchEvent(new Event('change', { bubbles: true }));
								return { success: true, method: 'dialog textarea' };
							}
						}
					}

					// placeholder로 찾기
					const textareas = document.querySelectorAll('textarea');
					for (const ta of textareas) {
						const placeholder = (ta.placeholder || '').toLowerCase();
						if (placeholder.includes('url') || placeholder.includes('붙여넣기')) {
							if (ta.offsetParent !== null) {
								ta.focus();
								ta.value = url;
								ta.dispatchEvent(new Event('input', { bubbles: true }));
								ta.dispatchEvent(new Event('change', { bubbles: true }));
								return { success: true, method: 'placeholder textarea' };
							}
						}
					}

					// 아무 visible textarea
					for (const ta of textareas) {
						if (ta.offsetParent !== null) {
							ta.focus();
							ta.value = url;
							ta.dispatchEvent(new Event('input', { bubbles: true }));
							ta.dispatchEvent(new Event('change', { bubbles: true }));
							return { success: true, method: 'any visible textarea' };
						}
					}

					return { success: false, error: 'URL textarea not found' };
				})();
			`);
			console.log('[NotebookLM Bridge] Link Step 4 (URL 입력):', step4);

			await this.delay(1000);

			// Step 5: "삽입" 버튼 클릭
			const step5 = await view.webview.executeJavaScript(`
				(function() {
					const buttons = document.querySelectorAll('button');
					for (const btn of buttons) {
						const text = (btn.textContent || '').trim();
						if (text === '삽입' || text === 'Insert') {
							if (!btn.disabled) {
								btn.click();
								return { success: true };
							} else {
								return { success: false, error: '삽입 button is disabled' };
							}
						}
					}
					return { success: false, error: '삽입 button not found' };
				})();
			`);
			console.log('[NotebookLM Bridge] Link Step 5 (삽입 버튼):', step5);

			if (step4?.success && step5?.success) {
				new Notice(`✅ "${note.title}" 링크 소스가 추가되었습니다!\n(${note.shareLink})`, 5000);
			} else if (step4?.success) {
				new Notice(`📝 URL 입력 완료!\n"삽입" 버튼을 클릭해주세요.`, 5000);
			} else {
				await navigator.clipboard.writeText(note.shareLink);
				new Notice(`📋 자동 입력 실패. URL이 클립보드에 복사됨.\n\n${note.shareLink}`, 8000);
			}

		} catch (error) {
			console.error('[NotebookLM Bridge] Link source add failed:', error);
			try {
				await navigator.clipboard.writeText(note.shareLink!);
				new Notice(`📋 "${note.title}" URL이 클립보드에 복사됨.\n\n수동으로 붙여넣기 해주세요.`, 8000);
			} catch (e) {
				new Notice('링크 소스 추가에 실패했습니다.', 5000);
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

		// 소스 추가 방식 선택
		new Setting(containerEl)
			.setName('소스 추가 방식')
			.setDesc('NotebookLM에 소스를 추가하는 방식을 선택합니다')
			.addDropdown(dropdown => dropdown
				.addOption('api', 'API 직접 호출 (빠름, 권장)')
				.addOption('dom', 'DOM 조작 (안정적)')
				.setValue(this.plugin.settings.sourceAddMethod)
				.onChange(async (value: 'dom' | 'api') => {
					this.plugin.settings.sourceAddMethod = value;
					await this.plugin.saveSettings();
				}));

		// 사용법
		containerEl.createEl('h3', { text: '사용법' });
		containerEl.createEl('p', {
			text: '1. 리본의 📖 아이콘을 클릭하여 NotebookLM 패널을 엽니다.'
		});
		containerEl.createEl('p', {
			text: '2. Google 계정으로 로그인합니다.'
		});
		containerEl.createEl('p', {
			text: '3. 노트북을 선택하거나 새로 만듭니다.'
		});
		containerEl.createEl('p', {
			text: '4. 리본의 📤 아이콘을 클릭하여 현재 노트를 전송합니다.'
		});
	}
}
