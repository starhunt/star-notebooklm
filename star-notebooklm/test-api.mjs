import { chromium } from 'playwright';
import { join } from 'path';

const NOTEBOOKLM_URL = 'https://notebooklm.google.com/';
const PROFILE_DIR = join(process.cwd(), '.playwright-profile');

async function testAPIMethod() {
	console.log('=== NotebookLM API Method Test ===\n');
	console.log('Profile directory:', PROFILE_DIR);

	const browser = await chromium.launchPersistentContext(PROFILE_DIR, {
		headless: false,
		args: [
			'--disable-blink-features=AutomationControlled',
			'--no-first-run',
			'--no-default-browser-check'
		],
		viewport: { width: 1920, height: 1080 },
		ignoreDefaultArgs: ['--enable-automation']
	});

	const page = browser.pages()[0] || await browser.newPage();

	try {
		console.log('Navigating to NotebookLM...');
		await page.goto(NOTEBOOKLM_URL, { waitUntil: 'networkidle', timeout: 60000 });
		await page.waitForTimeout(3000);

		// Check if login is needed
		const needsLogin = await page.evaluate(() => {
			return document.body.textContent.includes('Sign in') ||
				   document.body.textContent.includes('로그인') ||
				   document.querySelector('input[type="email"]') !== null;
		});

		if (needsLogin) {
			console.log('\n🔐 Login required. Please login manually.');
			console.log('Waiting 60 seconds for login...');
			await page.waitForTimeout(60000);
		}

		// Step 1: 노트북 목록 가져오기
		console.log('\n--- Step 1: Get notebooks ---');
		const notebooks = await page.evaluate(() => {
			const notebooks = [];
			document.querySelectorAll('project-button.project-button').forEach((btn) => {
				const titleEl = btn.querySelector('span.project-button-title');
				if (titleEl) {
					const title = (titleEl.textContent || '').trim();
					if (title && !title.includes('새 노트') && !title.includes('만들기')) {
						notebooks.push({ title });
					}
				}
			});
			return notebooks;
		});
		console.log(`Found ${notebooks.length} notebooks`);

		if (notebooks.length === 0) {
			console.log('No notebooks found. Create one first.');
			await browser.close();
			return;
		}

		// Step 2: 첫 번째 노트북 클릭 (새로 만든 노트북이 아닌 것 선택)
		const targetNotebook = notebooks.find(n => !n.title.includes('New') && !n.title.includes('Untitled')) || notebooks[0];
		console.log(`\n--- Step 2: Click notebook "${targetNotebook.title}" ---`);

		// Playwright locator 사용
		const card = page.locator(`project-button:has(span.project-button-title:has-text("${targetNotebook.title}"))`).first();
		if (await card.count() > 0) {
			await card.click();
			console.log('Clicked via Playwright locator');
		} else {
			// fallback
			await page.evaluate((title) => {
				const projectButtons = document.querySelectorAll('project-button.project-button');
				for (const btn of projectButtons) {
					const titleEl = btn.querySelector('span.project-button-title');
					if (titleEl && titleEl.textContent.trim() === title) {
						btn.click();
						return true;
					}
				}
				return false;
			}, targetNotebook.title);
			console.log('Clicked via evaluate fallback');
		}

		// 페이지 이동 대기
		console.log('Waiting for navigation...');
		await page.waitForURL(/\/notebook\//, { timeout: 15000 }).catch((e) => {
			console.log('Navigation timeout, checking current URL...');
		});
		await page.waitForTimeout(3000);
		console.log('Current URL after wait:', page.url());

		// Step 3: at 토큰 추출 테스트
		console.log('\n--- Step 3: Extract AT token ---');
		const tokenInfo = await page.evaluate(() => {
			let atToken = null;

			// Method 1: script 태그에서 찾기
			const scripts = document.querySelectorAll('script');
			for (const script of scripts) {
				const text = script.textContent || '';
				const tokenMatch = text.match(/"SNlM0e":"([^"]+)"/);
				if (tokenMatch) {
					atToken = tokenMatch[1];
					break;
				}
			}

			// Method 2: WIZ_global_data
			if (!atToken && window.WIZ_global_data && window.WIZ_global_data.SNlM0e) {
				atToken = window.WIZ_global_data.SNlM0e;
			}

			// Method 3: 페이지 소스에서 직접 찾기
			if (!atToken) {
				const pageText = document.documentElement.innerHTML;
				const match = pageText.match(/SNlM0e['"]\s*:\s*['"]([\w:-]+)['"]/);
				if (match) atToken = match[1];
			}

			// 노트북 ID
			const pathMatch = window.location.pathname.match(/\/notebook\/([^/]+)/);
			const notebookId = pathMatch ? pathMatch[1] : null;

			return { atToken, notebookId, url: window.location.href };
		});

		console.log('Notebook ID:', tokenInfo.notebookId);
		console.log('AT Token:', tokenInfo.atToken ? tokenInfo.atToken.substring(0, 30) + '...' : 'NOT FOUND');
		console.log('Current URL:', tokenInfo.url);

		if (!tokenInfo.atToken) {
			console.log('\n❌ AT token not found. Trying alternative methods...');

			// 대안: 네트워크 요청에서 가로채기
			const altToken = await page.evaluate(() => {
				// AF_initDataCallback에서 찾기
				const pageHtml = document.documentElement.outerHTML;
				const patterns = [
					/at=([A-Za-z0-9_:-]+)/,
					/"at":"([^"]+)"/,
					/SNlM0e.*?:.*?"([^"]+)"/
				];
				for (const pattern of patterns) {
					const match = pageHtml.match(pattern);
					if (match) return match[1];
				}
				return null;
			});
			console.log('Alternative token search:', altToken ? 'Found' : 'Not found');
		}

		if (!tokenInfo.notebookId) {
			console.log('\n❌ Not inside a notebook. Please navigate to a notebook first.');
			await page.waitForTimeout(10000);
			await browser.close();
			return;
		}

		// Step 4: API 호출 테스트
		console.log('\n--- Step 4: Test API calls ---');

		// 먼저 노트북 목록 API 테스트 (wXbhsf)
		console.log('\n4.1 Testing getNotebooks API (wXbhsf)...');
		const notebooksApiResult = await page.evaluate(async (atToken) => {
			const rpcId = 'wXbhsf';
			const requestBody = [[[rpcId, JSON.stringify([null, 500]), null, "generic"]]];

			const formData = new URLSearchParams();
			formData.append('at', atToken);
			formData.append('f.req', JSON.stringify(requestBody));

			try {
				const response = await fetch('/_/LabsTailwindUi/data/batchexecute?rpcids=' + rpcId, {
					method: 'POST',
					headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' },
					body: formData.toString(),
					credentials: 'include'
				});
				const text = await response.text();
				return {
					success: response.ok,
					status: response.status,
					preview: text.substring(0, 300),
					hasData: text.includes('wrb.fr')
				};
			} catch (error) {
				return { success: false, error: error.message };
			}
		}, tokenInfo.atToken);

		console.log('Notebooks API result:', notebooksApiResult);

		// 텍스트 소스 추가 API 테스트 - ref/nlm-py에서 발견한 올바른 페이로드 형식
		console.log('\n4.2 Testing addTextSource API (correct payload from nlm-py)...');

		const testTitle = "Playwright API Test";
		const testContent = "This is a test content from Playwright API test.\n\nCreated at: " + new Date().toISOString();

		// nlm-py에서 발견한 올바른 텍스트 소스 페이로드:
		// args = [[[None, [title, content], None, 2]], project_id]
		const textSourceResult = await page.evaluate(async ({ atToken, notebookId, title, content }) => {
			const rpcId = 'izAoDd';

			// 올바른 페이로드 형식 (nlm-py 참조)
			const requestPayload = [
				[
					[
						null,
						[title, content],  // [제목, 내용] 배열!
						null,
						2  // 소스 타입: 텍스트
					]
				],
				notebookId
			];

			const requestBody = [[[rpcId, JSON.stringify(requestPayload), null, "generic"]]];

			const formData = new URLSearchParams();
			formData.append('at', atToken);
			formData.append('f.req', JSON.stringify(requestBody));

			console.log('[Test] Text source payload:', JSON.stringify(requestPayload));

			try {
				const response = await fetch('/_/LabsTailwindUi/data/batchexecute?rpcids=' + rpcId, {
					method: 'POST',
					headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' },
					body: formData.toString(),
					credentials: 'include'
				});
				const text = await response.text();
				return {
					success: response.ok,
					status: response.status,
					preview: text.substring(0, 600),
					hasError: text.toLowerCase().includes('"er"'),
					hasSuccess: text.includes('wrb.fr')
				};
			} catch (error) {
				return { success: false, error: error.message };
			}
		}, { atToken: tokenInfo.atToken, notebookId: tokenInfo.notebookId, title: testTitle, content: testContent });

		console.log('Text source result:', JSON.stringify(textSourceResult, null, 2));

		if (textSourceResult.hasSuccess && !textSourceResult.hasError) {
			console.log('\n🎉 SUCCESS: Text source added via API!');
		} else {
			console.log('\n❌ Text source failed');
		}

		// URL 소스 테스트 (이미 작동 확인됨)
		console.log('\n4.3 Testing URL source (already verified)...');
		const urlSourceResult = await page.evaluate(async ({ atToken, notebookId }) => {
			const rpcId = 'izAoDd';

			// URL 소스 페이로드
			const requestPayload = [
				[[null, null, ["https://httpbin.org/html"]]],
				notebookId
			];

			const requestBody = [[[rpcId, JSON.stringify(requestPayload), null, "generic"]]];

			const formData = new URLSearchParams();
			formData.append('at', atToken);
			formData.append('f.req', JSON.stringify(requestBody));

			try {
				const response = await fetch('/_/LabsTailwindUi/data/batchexecute?rpcids=' + rpcId, {
					method: 'POST',
					headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' },
					body: formData.toString(),
					credentials: 'include'
				});
				const text = await response.text();
				return {
					success: response.ok,
					status: response.status,
					preview: text.substring(0, 400),
					hasSuccess: text.includes('wrb.fr')
				};
			} catch (error) {
				return { success: false, error: error.message };
			}
		}, { atToken: tokenInfo.atToken, notebookId: tokenInfo.notebookId });

		console.log('URL source result:', JSON.stringify(urlSourceResult, null, 2));

		if (urlSourceResult.hasSuccess) {
			console.log('✅ URL source works!');
		}

		console.log('\n--- Test Complete ---');
		console.log('Browser will stay open for 30 seconds for inspection...');
		await page.waitForTimeout(30000);

	} catch (error) {
		console.error('Test error:', error);
	} finally {
		await browser.close();
		console.log('Browser closed.');
	}
}

testAPIMethod().catch(console.error);
