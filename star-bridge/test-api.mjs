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

		// 텍스트 소스 추가 API 테스트
		console.log('\n4.2 Testing addTextSource API...');

		// 다양한 RPC ID 시도
		const rpcIdsToTry = ['aJdXGd', 'izAoDd', 'VrwPLd', 'Vq0Xad'];

		for (const rpcId of rpcIdsToTry) {
			console.log(`\nTrying RPC ID: ${rpcId}`);

			const testContent = "Test content from Playwright API test - " + new Date().toISOString();

			const addSourceResult = await page.evaluate(async ({ atToken, notebookId, rpcId, content }) => {
				// 다양한 페이로드 형식 시도
				let requestPayload;

				if (rpcId === 'izAoDd') {
					// URL 소스용 - 테스트 URL
					requestPayload = [
						[[null, null, ["https://example.com"], null, null, null, null, null, null, null, 1]],
						notebookId,
						[2],
						[1, null, null, null, null, null, null, null, null, null, [1]]
					];
				} else {
					// 텍스트 소스용 추정
					requestPayload = [
						[[null, content, null, null, null, null, null, null, null, null, 2]],
						notebookId,
						[2],
						[1, null, null, null, null, null, null, null, null, null, [1]]
					];
				}

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
						preview: text.substring(0, 500),
						hasError: text.toLowerCase().includes('error'),
						hasSuccess: text.includes('wrb.fr')
					};
				} catch (error) {
					return { success: false, error: error.message };
				}
			}, { atToken: tokenInfo.atToken, notebookId: tokenInfo.notebookId, rpcId, content: testContent });

			console.log(`Result for ${rpcId}:`, JSON.stringify(addSourceResult, null, 2));

			if (addSourceResult.hasSuccess && !addSourceResult.hasError) {
				console.log(`\n✅ RPC ID ${rpcId} seems to work!`);
			}
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
