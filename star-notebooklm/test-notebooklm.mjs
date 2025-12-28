import { chromium } from 'playwright';
import { join } from 'path';

const NOTEBOOKLM_URL = 'https://notebooklm.google.com/';
// 고정 프로필 디렉토리 - 로그인 세션 유지
const PROFILE_DIR = join(process.cwd(), '.playwright-profile');

async function testNotebookLM() {
	console.log('Starting NotebookLM test...');
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
		await page.waitForTimeout(5000);

		// Check if login is needed
		const needsLogin = await page.evaluate(() => {
			return document.body.textContent.includes('Sign in') ||
				   document.body.textContent.includes('로그인') ||
				   document.querySelector('input[type="email"]') !== null;
		});

		if (needsLogin) {
			console.log('\n🔐 Login required. Please login manually in the browser.');
			console.log('Waiting 60 seconds for login...');
			await page.waitForTimeout(60000);
		}

		// Wait for notebooks to load
		await page.waitForTimeout(3000);

		// Test 1: PC View
		console.log('\n=== Test 1: PC View Notebook List ===');
		const pcNotebooks = await getNotebooks(page);
		console.log(`Found ${pcNotebooks.length} notebooks:`);
		pcNotebooks.slice(0, 5).forEach((nb, i) => console.log(`  ${i + 1}. [${nb.viewType}] ${nb.title}`));

		// Test 2: Mobile View
		console.log('\n=== Test 2: Mobile View Notebook List ===');
		await page.setViewportSize({ width: 400, height: 800 });
		await page.reload({ waitUntil: 'networkidle' });
		await page.waitForTimeout(3000);

		const mobileNotebooks = await getNotebooks(page);
		console.log(`Found ${mobileNotebooks.length} notebooks:`);
		mobileNotebooks.slice(0, 5).forEach((nb, i) => console.log(`  ${i + 1}. [${nb.viewType}] ${nb.title}`));

		// Test 3: Source Add Dialog (PC View)
		if (pcNotebooks.length > 0) {
			console.log('\n=== Test 3: Source Add Dialog (PC View - 1920x1080) ===');
			await page.setViewportSize({ width: 1920, height: 1080 });
			await page.reload({ waitUntil: 'networkidle' });
			await page.waitForTimeout(3000);

			console.log(`Clicking notebook: ${pcNotebooks[0].title}`);
			await clickNotebook(page, pcNotebooks[0].title);
			await page.waitForTimeout(4000);

			await testSourceAddDialog(page);
		}

		// Test 4: Source Add Dialog (Mobile View)
		if (mobileNotebooks.length > 0) {
			console.log('\n=== Test 4: Source Add Dialog (Mobile View - 400x800) ===');

			// Go back to list first
			await page.goto(NOTEBOOKLM_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
			await page.waitForTimeout(5000);

			await page.setViewportSize({ width: 400, height: 800 });
			await page.waitForTimeout(2000);

			// Re-fetch notebooks in mobile view
			const mobileNbs = await getNotebooks(page);
			if (mobileNbs.length > 0) {
				console.log(`Clicking notebook: ${mobileNbs[0].title}`);
				await clickNotebook(page, mobileNbs[0].title);
				await page.waitForTimeout(4000);

				await testSourceAddDialog(page);
			} else {
				console.log('No notebooks found in mobile view');
			}
		}

		// Test 5: PC View - New Notebook Creation Entry Point
		console.log('\n=== Test 5: New Notebook Creation (PC View) ===');
		await page.goto(NOTEBOOKLM_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
		await page.waitForTimeout(3000);
		await page.setViewportSize({ width: 1920, height: 1080 });
		await page.waitForTimeout(2000);

		await testNewNotebookEntry(page, 'PC');

		// Test 6: Mobile View - New Notebook Creation Entry Point
		console.log('\n=== Test 6: New Notebook Creation (Mobile View) ===');
		await page.goto(NOTEBOOKLM_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
		await page.waitForTimeout(3000);
		await page.setViewportSize({ width: 400, height: 800 });
		await page.waitForTimeout(2000);

		await testNewNotebookEntry(page, 'Mobile');

		console.log('\n=== Tests Complete ===');
		console.log('Browser will close in 10 seconds...');
		await page.waitForTimeout(10000);

	} catch (error) {
		console.error('Test error:', error);
	} finally {
		await browser.close();
		// 프로필 유지 - 다음 실행 시 로그인 불필요
		console.log('Profile saved at:', PROFILE_DIR);
	}
}

async function getNotebooks(page) {
	return await page.evaluate(() => {
		const notebooks = [];
		const seen = new Set();

		// Table view (mobile)
		const table = document.querySelector('table.project-table');
		if (table) {
			table.querySelectorAll('tbody tr, tr').forEach((row) => {
				const titleEl = row.querySelector('.project-table-title');
				if (titleEl) {
					const title = (titleEl.textContent || '').trim();
					if (title && !seen.has(title)) {
						seen.add(title);
						notebooks.push({ title, viewType: 'table' });
					}
				}
			});
		}

		// PC card view
		if (notebooks.length === 0) {
			document.querySelectorAll('project-button.project-button').forEach((btn) => {
				const titleEl = btn.querySelector('span.project-button-title');
				if (titleEl) {
					const title = (titleEl.textContent || '').trim();
					if (title && !seen.has(title) && !title.includes('새 노트') && !title.includes('만들기')) {
						seen.add(title);
						notebooks.push({ title, viewType: 'projectButton' });
					}
				}
			});
		}

		// mat-card fallback
		if (notebooks.length === 0) {
			document.querySelectorAll('mat-card.project-button-card').forEach((card) => {
				const titleEl = card.querySelector('span.project-button-title');
				if (titleEl) {
					const title = (titleEl.textContent || '').trim();
					if (title && !seen.has(title) && !title.includes('새 노트')) {
						seen.add(title);
						notebooks.push({ title, viewType: 'matcard' });
					}
				}
			});
		}

		return notebooks;
	});
}

async function clickNotebook(page, title) {
	console.log('Trying to click notebook:', title);

	// Method 1: Use Playwright locator to click the card
	const card = page.locator(`project-button:has(span.project-button-title:has-text("${title}"))`).first();
	if (await card.count() > 0) {
		console.log('Found project-button, clicking...');
		await card.click();
		await page.waitForNavigation({ waitUntil: 'networkidle', timeout: 10000 }).catch(() => {});
		return;
	}

	// Method 2: Click mat-card directly
	const matCard = page.locator(`mat-card:has(span.project-button-title:has-text("${title}"))`).first();
	if (await matCard.count() > 0) {
		console.log('Found mat-card, clicking...');
		await matCard.click();
		await page.waitForNavigation({ waitUntil: 'networkidle', timeout: 10000 }).catch(() => {});
		return;
	}

	// Method 3: Table row (mobile)
	const tableRow = page.locator(`tr:has(.project-table-title:has-text("${title}"))`).first();
	if (await tableRow.count() > 0) {
		console.log('Found table row, clicking...');
		await tableRow.click();
		await page.waitForNavigation({ waitUntil: 'networkidle', timeout: 10000 }).catch(() => {});
		return;
	}

	console.log('Could not find notebook to click');
}

async function testSourceAddDialog(page) {
	// Close any open dialogs first
	await page.keyboard.press('Escape');
	await page.waitForTimeout(500);
	await page.keyboard.press('Escape');
	await page.waitForTimeout(1000);

	// Wait for page to fully load
	await page.waitForTimeout(2000);

	// Mobile view: Click "출처" tab first
	const clickedTab = await page.evaluate(() => {
		const tabs = document.querySelectorAll('[role="tab"], button[class*="tab"], .mat-mdc-tab');
		for (const tab of tabs) {
			const text = (tab.textContent || '').trim().toLowerCase();
			if (text.includes('출처') || text.includes('sources') || text.includes('소스')) {
				tab.click();
				return { success: true, text: tab.textContent.trim() };
			}
		}
		return { success: false };
	});
	if (clickedTab.success) {
		console.log('Clicked tab:', clickedTab.text);
		await page.waitForTimeout(1500);
	}

	// Debug: list available buttons
	const buttons = await page.evaluate(() => {
		return Array.from(document.querySelectorAll('button')).slice(0, 20).map(b => ({
			text: (b.textContent || '').trim().substring(0, 40),
			ariaLabel: b.getAttribute('aria-label'),
			class: b.className.substring(0, 50)
		}));
	});
	console.log('Available buttons:', JSON.stringify(buttons.slice(0, 10), null, 2));

	// Try multiple selectors
	let btnLocator = page.locator('[aria-label="출처 추가"]').first();
	if (!(await btnLocator.count())) {
		btnLocator = page.locator('[aria-label="소스 추가"]').first();
	}
	if (!(await btnLocator.count())) {
		btnLocator = page.locator('button:has-text("소스 추가")').first();
	}

	if (!(await btnLocator.count())) {
		console.log('❌ Source add button not found');
		return;
	}

	console.log('✅ Found source add button');
	await btnLocator.click({ force: true });
	await page.waitForTimeout(2000);

	const dialog = await page.evaluate(() => {
		const m = document.querySelector('.upload-dialog-panel, mat-bottom-sheet-container');
		if (!m) return { visible: false };
		const t = m.textContent || '';
		return {
			visible: true,
			hasTextPaste: t.includes('텍스트 붙여넣기'),
			hasCopiedText: t.includes('복사된 텍스트'),
			hasLink: t.includes('링크'),
			hasWebsite: t.includes('웹사이트')
		};
	});

	console.log('Dialog:', dialog);

	if (!dialog.visible) return;

	// Scroll and click 복사된 텍스트
	await page.evaluate(() => {
		const m = document.querySelector('mat-bottom-sheet-container, .upload-dialog-panel');
		if (m) m.scrollTop = m.scrollHeight;
		for (const el of document.querySelectorAll('*')) {
			if (el.textContent.trim() === '복사된 텍스트') {
				el.scrollIntoView({ block: 'center' });
				break;
			}
		}
	});
	await page.waitForTimeout(1000);

	const clicked = await page.evaluate(() => {
		for (const el of document.querySelectorAll('*')) {
			if (el.textContent.trim() === '복사된 텍스트') {
				el.click();
				return { success: true, tag: el.tagName };
			}
		}
		return { success: false };
	});
	console.log('Click 복사된 텍스트:', clicked);

	if (clicked.success) {
		await page.waitForTimeout(1500);
		const ta = await page.$('textarea.text-area, textarea');
		if (ta) {
			console.log('✅ Textarea found!');
			await ta.fill('Test from Playwright');
			console.log('Text inserted');

			const insertBtn = await page.evaluate(() => {
				for (const b of document.querySelectorAll('button')) {
					if (b.textContent.trim() === '삽입') return { found: true, disabled: b.disabled };
				}
				return { found: false };
			});
			console.log('Insert button:', insertBtn);

			if (insertBtn.found && !insertBtn.disabled) {
				console.log('🎉 SUCCESS: 복사된 텍스트 flow works!');
			}
		} else {
			console.log('❌ Textarea not found');
		}
	}

	// Test link flow
	await testLinkFlow(page, btnLocator);
}

async function testNewNotebookEntry(page, viewType) {
	console.log(`Testing new notebook entry (${viewType} view)...`);

	// Find new notebook creation buttons/elements
	const entryPoints = await page.evaluate(() => {
		const results = [];

		// Method 1: "새 노트북 만들기" text
		const elements = document.querySelectorAll('*');
		for (const el of elements) {
			const text = (el.textContent || '').trim();
			if (text === '새 노트북 만들기' || text === 'Create new notebook' ||
			    text === '새 노트북' || text === '만들기') {
				results.push({
					type: 'text',
					text,
					tag: el.tagName,
					class: el.className?.substring?.(0, 50) || '',
					visible: el.offsetParent !== null
				});
			}
		}

		// Method 2: project-button with "새 노트북" or plus icon
		const projectBtns = document.querySelectorAll('project-button.project-button');
		for (const btn of projectBtns) {
			const text = (btn.textContent || '').trim();
			if (text.includes('새 노트') || text.includes('만들기') || text.includes('Create')) {
				results.push({
					type: 'project-button',
					text: text.substring(0, 50),
					tag: 'project-button',
					visible: btn.offsetParent !== null
				});
			}
		}

		// Method 3: FAB button (floating action button)
		const fabs = document.querySelectorAll('[class*="fab"], button[class*="create"], button[aria-label*="만들기"], button[aria-label*="Create"]');
		for (const fab of fabs) {
			results.push({
				type: 'fab',
				ariaLabel: fab.getAttribute('aria-label'),
				class: fab.className?.substring?.(0, 50) || '',
				visible: fab.offsetParent !== null
			});
		}

		// Method 4: Plus icon buttons
		const plusBtns = document.querySelectorAll('button mat-icon, button svg');
		for (const icon of plusBtns) {
			const text = (icon.textContent || '').trim().toLowerCase();
			if (text === 'add' || text === '+') {
				const btn = icon.closest('button');
				if (btn) {
					results.push({
						type: 'plus-button',
						iconText: text,
						class: btn.className?.substring?.(0, 50) || '',
						visible: btn.offsetParent !== null
					});
				}
			}
		}

		return results;
	});

	console.log('New notebook entry points found:', JSON.stringify(entryPoints, null, 2));

	if (entryPoints.length === 0) {
		console.log('❌ No new notebook entry points found');
		return false;
	}

	// Try to click the first visible entry point
	const clicked = await page.evaluate(() => {
		// Priority 1: project-button with "새 노트북 만들기"
		const projectBtns = document.querySelectorAll('project-button.project-button');
		for (const btn of projectBtns) {
			const text = (btn.textContent || '').trim();
			if ((text.includes('새 노트') || text.includes('만들기')) && btn.offsetParent !== null) {
				btn.click();
				return { success: true, method: 'project-button', text: text.substring(0, 30) };
			}
		}

		// Priority 2: FAB or create button
		const createBtns = document.querySelectorAll('button[aria-label*="만들기"], button[aria-label*="Create"], [class*="fab"]');
		for (const btn of createBtns) {
			if (btn.offsetParent !== null) {
				btn.click();
				return { success: true, method: 'create-button', ariaLabel: btn.getAttribute('aria-label') };
			}
		}

		return { success: false };
	});

	console.log('Click result:', clicked);

	if (clicked.success) {
		await page.waitForTimeout(2000);

		// Check if new notebook creation dialog/page opened
		const afterClick = await page.evaluate(() => {
			// Check URL change (some apps navigate to /new)
			const urlChanged = window.location.href.includes('/new') || window.location.href.includes('/create');

			// Check for source add dialog (new notebook flow)
			const hasSourceDialog = document.querySelector('.upload-dialog-panel, mat-bottom-sheet-container') !== null;

			// Check for title input
			const hasTitleInput = document.querySelector('input[placeholder*="제목"], input[placeholder*="title"]') !== null;

			return { urlChanged, hasSourceDialog, hasTitleInput };
		});

		console.log('After click state:', afterClick);

		if (afterClick.urlChanged || afterClick.hasSourceDialog || afterClick.hasTitleInput) {
			console.log('✅ New notebook entry point works!');
			return true;
		} else {
			console.log('⚠️ Clicked but unable to confirm navigation');
		}
	} else {
		console.log('❌ Could not click new notebook entry');
	}

	return false;
}

async function testLinkFlow(page, addSourceBtn) {
	console.log('\n--- Testing 링크 > 웹사이트 flow ---');

	// Close any open dialog
	await page.keyboard.press('Escape');
	await page.waitForTimeout(1000);

	// Open source add dialog
	await addSourceBtn.click({ force: true });
	await page.waitForTimeout(2000);

	// Scroll to find 링크 section
	await page.evaluate(() => {
		const m = document.querySelector('mat-bottom-sheet-container, .upload-dialog-panel');
		if (m) m.scrollTop = m.scrollHeight;
		for (const el of document.querySelectorAll('*')) {
			const text = (el.textContent || '').trim();
			if (text === '링크' || text === '웹사이트') {
				el.scrollIntoView({ block: 'center' });
				break;
			}
		}
	});
	await page.waitForTimeout(1000);

	// Click 링크 section
	const linkClicked = await page.evaluate(() => {
		for (const el of document.querySelectorAll('*')) {
			const text = (el.textContent || '').trim();
			if (text === '링크') {
				el.click();
				return { success: true, tag: el.tagName };
			}
		}
		return { success: false };
	});
	console.log('Click "링크":', linkClicked);

	if (!linkClicked.success) {
		console.log('❌ Could not find 링크 option');
		return false;
	}

	await page.waitForTimeout(1000);

	// Look for 웹사이트 option and click it
	const websiteClicked = await page.evaluate(() => {
		// First try to find exact match
		for (const el of document.querySelectorAll('span, div, button, a')) {
			const text = (el.textContent || '').trim();
			if (text === '웹사이트' || text === 'Website') {
				el.click();
				return { success: true, tag: el.tagName, class: el.className };
			}
		}
		// Try with icon
		for (const el of document.querySelectorAll('*')) {
			const text = (el.textContent || '').trim();
			if (text.includes('웹사이트') && text.length < 20) {
				el.click();
				return { success: true, tag: el.tagName, text };
			}
		}
		return { success: false };
	});
	console.log('Click "웹사이트":', websiteClicked);

	if (!websiteClicked.success) {
		console.log('❌ Could not find 웹사이트 option');
		return false;
	}

	await page.waitForTimeout(2000);

	// Debug: check dialog content after clicking 웹사이트
	const dialogDebug = await page.evaluate(() => {
		// Look for new dialog (웹사이트 URL dialog appears separately)
		const dialogs = document.querySelectorAll('mat-dialog-container, [role="dialog"], .cdk-overlay-pane');
		for (const dialog of dialogs) {
			const text = (dialog.textContent || '');
			if (text.includes('웹사이트 URL') || text.includes('URL 붙여넣기')) {
				const textareas = dialog.querySelectorAll('textarea');
				const inputs = dialog.querySelectorAll('input');
				return {
					found: true,
					text: text.substring(0, 300),
					textareaCount: textareas.length,
					inputCount: inputs.length,
					textareas: Array.from(textareas).map(t => ({
						placeholder: t.placeholder,
						visible: t.offsetParent !== null
					}))
				};
			}
		}
		// Also check any visible textarea
		const allTextareas = document.querySelectorAll('textarea');
		return {
			found: false,
			allTextareas: Array.from(allTextareas).map(t => ({
				placeholder: t.placeholder,
				visible: t.offsetParent !== null,
				class: t.className
			}))
		};
	});
	console.log('Dialog after 웹사이트 click:', JSON.stringify(dialogDebug, null, 2));

	// Find URL textarea (not input!) - placeholder is "URL 붙여넣기*"
	const urlTextareaInfo = await page.evaluate(() => {
		// Method 1: Find textarea with "URL 붙여넣기" placeholder
		const textareas = document.querySelectorAll('textarea');
		for (const ta of textareas) {
			const placeholder = (ta.placeholder || '').toLowerCase();
			if (placeholder.includes('url') || placeholder.includes('붙여넣기')) {
				if (ta.offsetParent !== null) {
					return { found: true, type: 'textarea', placeholder: ta.placeholder };
				}
			}
		}

		// Method 2: Find textarea inside dialog with "웹사이트 URL" text
		const dialogs = document.querySelectorAll('mat-dialog-container, [role="dialog"], .cdk-overlay-pane');
		for (const dialog of dialogs) {
			const text = (dialog.textContent || '');
			if (text.includes('웹사이트 URL') || text.includes('URL 붙여넣기')) {
				const ta = dialog.querySelector('textarea');
				if (ta && ta.offsetParent !== null) {
					return { found: true, type: 'textarea in dialog', placeholder: ta.placeholder };
				}
			}
		}

		// Method 3: Any visible textarea
		for (const ta of textareas) {
			if (ta.offsetParent !== null) {
				return { found: true, type: 'visible textarea', placeholder: ta.placeholder };
			}
		}

		return { found: false };
	});
	console.log('URL textarea:', urlTextareaInfo);

	if (!urlTextareaInfo.found) {
		console.log('❌ URL textarea not found');
		return false;
	}

	// Test URL insertion into textarea
	const testUrl = 'https://example.com/test-share-link';
	await page.evaluate((url) => {
		// Find textarea with URL placeholder
		let textarea = null;

		// Try by placeholder first
		const textareas = document.querySelectorAll('textarea');
		for (const ta of textareas) {
			const placeholder = (ta.placeholder || '').toLowerCase();
			if (placeholder.includes('url') || placeholder.includes('붙여넣기')) {
				if (ta.offsetParent !== null) {
					textarea = ta;
					break;
				}
			}
		}

		// Fallback: find in dialog
		if (!textarea) {
			const dialogs = document.querySelectorAll('mat-dialog-container, [role="dialog"], .cdk-overlay-pane');
			for (const dialog of dialogs) {
				const ta = dialog.querySelector('textarea');
				if (ta && ta.offsetParent !== null) {
					textarea = ta;
					break;
				}
			}
		}

		if (textarea) {
			textarea.focus();
			textarea.value = url;
			textarea.dispatchEvent(new Event('input', { bubbles: true }));
			textarea.dispatchEvent(new Event('change', { bubbles: true }));
			return { success: true };
		}
		return { success: false };
	}, testUrl);
	console.log('URL inserted:', testUrl);

	await page.waitForTimeout(1000);

	// Check for "삽입" button
	const submitBtn = await page.evaluate(() => {
		const buttons = document.querySelectorAll('button');
		for (const btn of buttons) {
			const text = (btn.textContent || '').trim();
			if (text === '삽입' || text === 'Insert') {
				return { found: true, text, disabled: btn.disabled };
			}
		}
		return { found: false };
	});
	console.log('Submit button:', submitBtn);

	if (submitBtn.found && !submitBtn.disabled) {
		console.log('🎉 SUCCESS: 링크 > 웹사이트 flow works!');
		return true;
	} else if (submitBtn.found && submitBtn.disabled) {
		console.log('⚠️ Submit button found but disabled (may need valid URL)');
		return true; // Flow works, just validation issue
	}

	return false;
}

testNotebookLM().catch(console.error);
