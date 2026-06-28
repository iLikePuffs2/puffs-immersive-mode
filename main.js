'use strict';

const obsidian = require('obsidian');

// ─── 默认设置 ─────────────────────────────────────────────────────────
const DEFAULT_SETTINGS = {
	hideLeftSidebar: true,
	hideRightSidebar: true,
	hideTopNavBar: true,
	hideTopNavBarNormally: false,
	hideStatusBar: true,
	hideScrollbar: true,
	autoHideCursorDelay: 500,
	cursorBlinkCount: 10,
	preserveTopBottomSpace: false,
	standardPageTurn: true,
	exitOnEsc: true,
};

// ─── 获取 Electron 窗口实例 ───────────────────────────────────────────
function getElectronWindow() {
	try {
		const electron = require('electron');
		if (electron && electron.remote) {
			return electron.remote.getCurrentWindow();
		}
	} catch (e) {
		// electron.remote 不可用
	}
	return null;
}

// ─── 插件主类 ─────────────────────────────────────────────────────────
class ImmersiveModePlugin extends obsidian.Plugin {

	async onload() {
		this.isImmersive = false;
		this.wasLeftOpen = false;
		this.wasRightOpen = false;
		this.wasFullScreen = false;
		this.cursorHideTimeout = null;
		this.standardPageScrollerEl = null;
		this.standardPageHistory = [];

		await this.loadSettings();
		this.updateNormalTopNavBarClass();

		// 注册切换命令（用户可自行绑定快捷键）
		this.addCommand({
			id: 'toggle-immersive-mode',
			name: 'Toggle Immersive Mode',
			callback: () => this.toggleImmersiveMode(),
		});

		this.addCommand({
			id: 'toggle-preserve-top-bottom-space',
			name: '切换：隐藏顶栏和底栏时依旧占位',
			callback: () => this.togglePreserveTopBottomSpace(),
		});

		this.addCommand({
			id: 'toggle-hide-top-nav-normally',
			name: '切换：常规时隐藏顶部导航栏',
			callback: () => this.toggleHideTopNavNormally(),
		});

		// Ribbon 图标，点击切换沉浸模式
		this.ribbonIconEl = this.addRibbonIcon(
			'expand',
			'切换沉浸模式',
			() => this.toggleImmersiveMode()
		);

		// ESC 键退出沉浸模式（需在设置中开启）
		this.keydownHandler = (evt) => {
			if (
				this.settings.standardPageTurn &&
				this.isImmersive &&
				!this.hasOpenModal() &&
				(evt.key === 'PageDown' || evt.key === 'PageUp') &&
				!evt.altKey &&
				!evt.ctrlKey &&
				!evt.metaKey
			) {
				if (this.standardPageTurn(evt.key === 'PageDown' ? 1 : -1)) {
					evt.preventDefault();
					evt.stopPropagation();
				}
				return;
			}

			if (
				this.settings.exitOnEsc &&
				evt.key === 'Escape' &&
				this.isImmersive &&
				!this.hasOpenModal()
			) {
				evt.preventDefault();
				evt.stopPropagation();
				this.exitImmersiveMode();
			}
		};
		document.addEventListener('keydown', this.keydownHandler, true);
		this.register(() => document.removeEventListener('keydown', this.keydownHandler, true));

		this.registerDomEvent(document, 'mousemove', () => {
			this.resetCursorHideTimer();
		});

		this.registerDomEvent(document, 'pointerdown', () => {
			this.restartCursorBlink();
		}, true);

		this.registerDomEvent(window, 'resize', () => {
			if (this.isImmersive && this.settings.standardPageTurn) {
				this.clearStandardPageHistory();
				this.applyStandardPageTrim(this.getStandardPageScroller());
			}
		});

		// 设置选项卡
		this.addSettingTab(new ImmersiveModeSettingTab(this.app, this));
	}

	async onunload() {
		// 插件卸载时恢复正常状态
		if (this.isImmersive) {
			this.exitImmersiveMode();
		}
		document.body.classList.remove('puffs-hide-top-nav-normal');
	}

	// ── 状态辅助方法 ───────────────────────────────────────────────────

	/** 检查是否有弹窗/菜单处于打开状态 */
	hasOpenModal() {
		return !!document.querySelector('.modal-container, .menu, .suggestion-container.is-open');
	}

	/** 检测当前是否处于全屏状态 */
	isCurrentlyFullScreen() {
		const win = getElectronWindow();
		if (win) {
			return win.isFullScreen();
		}
		// 回退：通过窗口尺寸判断
		return (
			window.innerHeight === screen.height &&
			window.innerWidth === screen.width
		);
	}

	/** 设置全屏状态 */
	setFullScreenState(value) {
		const win = getElectronWindow();
		if (win) {
			win.setFullScreen(value);
			return;
		}
		// 回退：调用 Obsidian 内置的全屏切换命令
		const currentlyFS = this.isCurrentlyFullScreen();
		if (currentlyFS !== value) {
			this.app.commands.executeCommandById('app:toggle-fullscreen');
		}
	}

	// ── 核心逻辑 ───────────────────────────────────────────────────────

	getAutoHideCursorDelay() {
		const delay = Number(this.settings.autoHideCursorDelay);
		return Number.isFinite(delay) && delay > 0 ? delay : 0;
	}

	clearCursorHideTimer() {
		if (this.cursorHideTimeout !== null) {
			window.clearTimeout(this.cursorHideTimeout);
			this.cursorHideTimeout = null;
		}
		document.body.classList.remove('immersive-hide-cursor');
	}

	resetCursorHideTimer() {
		this.clearCursorHideTimer();

		const delay = this.getAutoHideCursorDelay();
		if (!this.isImmersive || delay === 0) {
			return;
		}

		this.cursorHideTimeout = window.setTimeout(() => {
			if (this.isImmersive && this.getAutoHideCursorDelay() > 0) {
				document.body.classList.add('immersive-hide-cursor');
			}
			this.cursorHideTimeout = null;
		}, delay);
	}

	getCursorBlinkCount() {
		const count = Number.parseInt(this.settings.cursorBlinkCount, 10);
		if (!Number.isFinite(count)) {
			return DEFAULT_SETTINGS.cursorBlinkCount;
		}
		return Math.min(10, Math.max(0, count));
	}

	updateCursorBlinkClass() {
		const count = this.getCursorBlinkCount();
		document.body.style.setProperty('--puffs-cursor-blink-count', String(count));
		document.body.classList.toggle(
			'immersive-caret-no-blink',
			this.isImmersive && count === 0
		);
		document.body.classList.toggle(
			'immersive-caret-limited-blink',
			this.isImmersive && count > 0 && count < 10
		);
	}

	restartCursorBlink() {
		if (!this.isImmersive || this.getCursorBlinkCount() < 1 || this.getCursorBlinkCount() >= 10) {
			return;
		}

		document.body.classList.remove('immersive-caret-limited-blink');
		document.body.offsetHeight;
		document.body.classList.add('immersive-caret-limited-blink');
	}

	updatePreserveTopBottomSpaceClass() {
		document.body.classList.toggle(
			'immersive-preserve-top-bottom-space',
			this.isImmersive && this.settings.preserveTopBottomSpace
		);
	}

	updateNormalTopNavBarClass() {
		document.body.classList.toggle(
			'puffs-hide-top-nav-normal',
			this.settings.hideTopNavBarNormally
		);
	}

	async togglePreserveTopBottomSpace() {
		this.settings.preserveTopBottomSpace = !this.settings.preserveTopBottomSpace;
		this.updatePreserveTopBottomSpaceClass();
		await this.saveSettings();
	}

	async toggleHideTopNavNormally() {
		this.settings.hideTopNavBarNormally = !this.settings.hideTopNavBarNormally;
		this.updateNormalTopNavBarClass();
		await this.saveSettings();
	}

	getStandardPageScroller() {
		const activeEl = document.activeElement;
		const activeScroller = activeEl && activeEl.closest('.cm-scroller, .markdown-preview-view');
		if (this.isScrollable(activeScroller)) {
			return activeScroller;
		}

		const leaf = activeEl?.closest('.workspace-leaf') || document.querySelector('.workspace-leaf.mod-active');
		const selectors = [
			'.cm-scroller',
			'.markdown-preview-view',
			'.puffs-reader-content',
			'.puffs-reader-main',
			'.view-content',
		];

		for (const selector of selectors) {
			const el = leaf?.querySelector(selector);
			if (this.isScrollable(el)) {
				return el;
			}
		}

		return Array.from(leaf?.querySelectorAll('*') || []).find((el) => this.isScrollable(el)) || null;
	}

	isScrollable(el) {
		if (!el) {
			return false;
		}

		const style = getComputedStyle(el);
		return (
			el.clientHeight > 0 &&
			el.scrollHeight > el.clientHeight + 1 &&
			style.overflowY !== 'hidden' &&
			style.display !== 'none'
		);
	}

	getStandardPageLineElements(scroller) {
		if (scroller.classList.contains('cm-scroller')) {
			return Array.from(scroller.querySelectorAll('.cm-content .cm-line'));
		}

		const elements = Array.from(scroller.querySelectorAll(
			'.puffs-reader-line, .puffs-reader-paragraph, p, li, .markdown-preview-section > div'
		));

		return elements.length ? elements : Array.from(scroller.children);
	}

	getStandardPageLines(scroller) {
		const scrollerRect = scroller.getBoundingClientRect();
		const lines = [];

		for (const el of this.getStandardPageLineElements(scroller)) {
			if (!el.textContent.trim()) {
				continue;
			}

			const range = document.createRange();
			range.selectNodeContents(el);
			for (const rect of Array.from(range.getClientRects())) {
				if (
					rect.width > 0 &&
					rect.height > 0 &&
					rect.bottom >= scrollerRect.top - scrollerRect.height &&
					rect.top <= scrollerRect.bottom + scrollerRect.height
				) {
					lines.push({
						top: rect.top,
						bottom: rect.bottom,
						height: rect.height,
					});
				}
			}
			range.detach();
		}

		return lines
			.sort((a, b) => a.top - b.top)
			.filter((line, index, sorted) => index === 0 || Math.abs(line.top - sorted[index - 1].top) > 1);
	}

	getStandardPageFallbackStep(scroller) {
		const style = getComputedStyle(scroller);
		const lineHeight = Number.parseFloat(style.lineHeight) || 24;
		const lineCount = Math.max(1, Math.floor(scroller.clientHeight / lineHeight));
		return lineCount * lineHeight;
	}

	getStandardPageTrim(scroller) {
		return Number.parseFloat(scroller.style.getPropertyValue('--puffs-standard-page-bottom-trim')) || 0;
	}

	getStandardPageRect(scroller) {
		const rect = scroller.getBoundingClientRect();
		const trim = this.getStandardPageTrim(scroller);
		return {
			top: rect.top,
			bottom: rect.bottom - trim,
			height: rect.height - trim,
			rawBottom: rect.bottom,
		};
	}

	clearStandardPageTrim() {
		const scrollers = new Set(document.querySelectorAll('.immersive-standard-page-scroller'));
		if (this.standardPageScrollerEl) {
			scrollers.add(this.standardPageScrollerEl);
		}

		for (const scroller of scrollers) {
			scroller.classList.remove('immersive-standard-page-scroller');
			scroller.style.removeProperty('--puffs-standard-page-bottom-trim');
		}
		this.standardPageScrollerEl = null;
	}

	clearStandardPageHistory() {
		this.standardPageHistory = [];
	}

	popStandardPageHistory(scroller) {
		const last = this.standardPageHistory[this.standardPageHistory.length - 1];
		if (!last || last.scroller !== scroller || Math.abs(scroller.scrollTop - last.to) > 2) {
			return null;
		}

		this.standardPageHistory.pop();
		return last.from;
	}

	pushStandardPageHistory(scroller, from, to) {
		if (Math.abs(to - from) <= 1) {
			return;
		}

		this.standardPageHistory.push({ scroller, from, to });
		if (this.standardPageHistory.length > 50) {
			this.standardPageHistory.shift();
		}
	}

	applyStandardPageTrim(scroller) {
		this.clearStandardPageTrim();
		if (!this.isImmersive || !this.settings.standardPageTurn || !scroller) {
			return;
		}

		const rect = scroller.getBoundingClientRect();
		const lines = this.getStandardPageLines(scroller);
		const fullLines = lines.filter((line) => (
			line.top >= rect.top - 1 &&
			line.bottom <= rect.bottom + 1
		));
		const lastFullLine = fullLines[fullLines.length - 1];
		const trim = lastFullLine
			? Math.max(0, Math.floor(rect.bottom - lastFullLine.bottom))
			: 0;

		scroller.classList.add('immersive-standard-page-scroller');
		scroller.style.setProperty('--puffs-standard-page-bottom-trim', `${trim}px`);
		this.standardPageScrollerEl = scroller;
	}

	scheduleStandardPageTrim(scroller) {
		window.requestAnimationFrame(() => {
			if (this.isImmersive && this.settings.standardPageTurn) {
				this.applyStandardPageTrim(scroller || this.getStandardPageScroller());
			}
		});
	}

	standardPageTurn(direction) {
		const scroller = this.getStandardPageScroller();
		if (!scroller) {
			return false;
		}

		if (direction < 0) {
			const historyTarget = this.popStandardPageHistory(scroller);
			if (historyTarget !== null) {
				scroller.scrollTop = historyTarget;
				this.scheduleStandardPageTrim(scroller);
				this.resetCursorHideTimer();
				return true;
			}
		}

		const originalScrollTop = scroller.scrollTop;
		this.applyStandardPageTrim(scroller);
		const scrollerRect = this.getStandardPageRect(scroller);
		const lines = this.getStandardPageLines(scroller);
		let targetTop = null;

		if (direction > 0) {
			const nextLine = lines.find((line) => line.top >= scrollerRect.bottom - 1);
			targetTop = nextLine
				? scroller.scrollTop + nextLine.top - scrollerRect.top
				: scroller.scrollTop + this.getStandardPageFallbackStep(scroller);
		} else {
			const visibleLines = lines.filter((line) => (
				line.top >= scrollerRect.top - 1 &&
				line.top < scrollerRect.bottom - 1
			));
			const firstVisible = visibleLines[0] || lines.find((line) => line.top >= scrollerRect.top - 1);
			const previousLines = firstVisible
				? lines.filter((line) => line.top < firstVisible.top - 1)
				: [];
			const targetLine = previousLines[Math.max(0, previousLines.length - Math.max(1, visibleLines.length))];
			targetTop = targetLine
				? scroller.scrollTop + targetLine.top - scrollerRect.top
				: scroller.scrollTop - this.getStandardPageFallbackStep(scroller);
		}

		const maxScrollTop = scroller.scrollHeight - scroller.clientHeight;
		scroller.scrollTop = Math.min(maxScrollTop, Math.max(0, targetTop));
		if (direction > 0) {
			this.pushStandardPageHistory(scroller, originalScrollTop, scroller.scrollTop);
		}
		this.scheduleStandardPageTrim(scroller);
		this.resetCursorHideTimer();
		return true;
	}

	toggleImmersiveMode() {
		if (this.isImmersive) {
			this.exitImmersiveMode();
		} else {
			this.enterImmersiveMode();
		}
	}

	enterImmersiveMode() {
		// 1. 保存当前侧边栏状态
		this.wasLeftOpen = !this.app.workspace.leftSplit.collapsed;
		this.wasRightOpen = !this.app.workspace.rightSplit.collapsed;

		// 2. 根据设置收起侧边栏
		if (this.settings.hideLeftSidebar) {
			this.app.workspace.leftSplit.collapse();
		}
		if (this.settings.hideRightSidebar) {
			this.app.workspace.rightSplit.collapse();
		}

		// 3. 进入全屏（隐藏 Windows 任务栏）
		this.wasFullScreen = this.isCurrentlyFullScreen();
		if (!this.wasFullScreen) {
			this.setFullScreenState(true);
		}

		// 4. 根据设置添加 CSS 类
		document.body.classList.add('immersive-mode');
		if (this.settings.hideTopNavBar) {
			document.body.classList.add('immersive-hide-top-nav');
		}
		if (this.settings.hideStatusBar) {
			document.body.classList.add('immersive-hide-statusbar');
		}
		if (this.settings.hideScrollbar) {
			document.body.classList.add('immersive-hide-scrollbar');
		}

		// 5. 更新状态和图标
		this.isImmersive = true;
		this.updatePreserveTopBottomSpaceClass();
		this.updateCursorBlinkClass();
		if (this.settings.standardPageTurn) {
			this.scheduleStandardPageTrim(this.getStandardPageScroller());
		}
		this.resetCursorHideTimer();
		this.ribbonIconEl.setAttribute('aria-label', '退出沉浸模式');
		this.ribbonIconEl.classList.add('is-active');
	}

	exitImmersiveMode() {
		// 1. 移除所有 CSS 类
		document.body.classList.remove(
			'immersive-mode',
			'immersive-hide-top-nav',
			'immersive-hide-statusbar',
			'immersive-hide-scrollbar',
			'immersive-hide-cursor',
			'immersive-preserve-top-bottom-space',
			'immersive-caret-no-blink',
			'immersive-caret-limited-blink'
		);
		document.body.style.removeProperty('--puffs-cursor-blink-count');
		this.clearCursorHideTimer();
		this.clearStandardPageTrim();
		this.clearStandardPageHistory();

		// 2. 恢复侧边栏
		if (this.wasLeftOpen) {
			this.app.workspace.leftSplit.expand();
		}
		if (this.wasRightOpen) {
			this.app.workspace.rightSplit.expand();
		}

		// 3. 退出全屏（仅当进入沉浸模式时不是全屏才恢复）
		if (!this.wasFullScreen) {
			this.setFullScreenState(false);
		}

		// 4. 更新状态和图标
		this.isImmersive = false;
		this.ribbonIconEl.setAttribute('aria-label', '切换沉浸模式');
		this.ribbonIconEl.classList.remove('is-active');
	}

	// ── 设置持久化 ─────────────────────────────────────────────────────

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}
}

// ─── 设置选项卡 ───────────────────────────────────────────────────────
class ImmersiveModeSettingTab extends obsidian.PluginSettingTab {
	constructor(app, plugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display() {
		const { containerEl } = this;
		containerEl.empty();

		new obsidian.Setting(containerEl)
			.setName('隐藏左侧边栏')
			.setDesc('进入沉浸模式时收起左侧边栏（文件管理器、搜索等）。')
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.hideLeftSidebar)
					.onChange(async (value) => {
						this.plugin.settings.hideLeftSidebar = value;
						await this.plugin.saveSettings();
					})
			);

		new obsidian.Setting(containerEl)
			.setName('隐藏右侧边栏')
			.setDesc('进入沉浸模式时收起右侧边栏（大纲、反向链接等）。')
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.hideRightSidebar)
					.onChange(async (value) => {
						this.plugin.settings.hideRightSidebar = value;
						await this.plugin.saveSettings();
					})
			);

		new obsidian.Setting(containerEl)
			.setName('隐藏顶部导航栏')
			.setDesc('进入沉浸模式时隐藏顶部标签页导航栏。')
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.hideTopNavBar)
					.onChange(async (value) => {
						this.plugin.settings.hideTopNavBar = value;
						document.body.classList.toggle(
							'immersive-hide-top-nav',
							this.plugin.isImmersive && value
						);
						if (this.plugin.isImmersive && this.plugin.settings.standardPageTurn) {
							this.plugin.clearStandardPageHistory();
							this.plugin.scheduleStandardPageTrim(this.plugin.getStandardPageScroller());
						}
						await this.plugin.saveSettings();
					})
			);

		new obsidian.Setting(containerEl)
			.setName('常规时隐藏顶部导航栏')
			.setDesc('即使没有进入沉浸模式，依旧隐藏顶部标签页导航栏，且保持空白占位')
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.hideTopNavBarNormally)
					.onChange(async (value) => {
						this.plugin.settings.hideTopNavBarNormally = value;
						this.plugin.updateNormalTopNavBarClass();
						await this.plugin.saveSettings();
					})
			);

		new obsidian.Setting(containerEl)
			.setName('隐藏底部状态栏')
			.setDesc('进入沉浸模式时隐藏底部状态栏。')
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.hideStatusBar)
					.onChange(async (value) => {
						this.plugin.settings.hideStatusBar = value;
						await this.plugin.saveSettings();
					})
			);

		new obsidian.Setting(containerEl)
			.setName('隐藏右侧滚动条')
			.setDesc('进入沉浸模式时隐藏右侧可上下拖动的滚动条。')
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.hideScrollbar)
					.onChange(async (value) => {
						this.plugin.settings.hideScrollbar = value;
						document.body.classList.toggle(
							'immersive-hide-scrollbar',
							this.plugin.isImmersive && value
						);
						await this.plugin.saveSettings();
					})
			);

		new obsidian.Setting(containerEl)
			.setName('自动隐藏鼠标延迟 (ms)')
			.setDesc('鼠标不动超过该时间后隐藏光标。单位：ms；设为 0 则不自动隐藏。默认 500ms。')
			.addText((text) =>
				text
					.setPlaceholder('500')
					.setValue(String(this.plugin.settings.autoHideCursorDelay))
					.onChange(async (value) => {
						const delay = Math.max(0, Number.parseInt(value, 10) || 0);
						this.plugin.settings.autoHideCursorDelay = delay;
						this.plugin.resetCursorHideTimer();
						await this.plugin.saveSettings();
					})
			);

		new obsidian.Setting(containerEl)
			.setName('光标闪烁次数')
			.setDesc('每次点击后光标闪烁的次数。输入 0 到 10 的整数；0 为完全不闪烁，10 为一直闪烁。默认 10。')
			.addText((text) =>
				text
					.setPlaceholder('10')
					.setValue(String(this.plugin.settings.cursorBlinkCount))
					.onChange(async (value) => {
						const parsed = Number.parseInt(value, 10);
						const count = Number.isFinite(parsed)
							? Math.min(10, Math.max(0, parsed))
							: DEFAULT_SETTINGS.cursorBlinkCount;
						this.plugin.settings.cursorBlinkCount = count;
						this.plugin.updateCursorBlinkClass();
						await this.plugin.saveSettings();
					})
			);

		new obsidian.Setting(containerEl)
			.setName('隐藏顶栏和底栏时依旧占位')
			.setDesc('进入沉浸模式后，顶栏和底栏仍会隐藏，但保留它们原本占用的空间。')
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.preserveTopBottomSpace)
					.onChange(async (value) => {
						this.plugin.settings.preserveTopBottomSpace = value;
						this.plugin.updatePreserveTopBottomSpaceClass();
						await this.plugin.saveSettings();
					})
			);

		new obsidian.Setting(containerEl)
			.setName('标准翻页')
			.setDesc('进入沉浸模式后，Page Down 翻到当前视口底部下一行，Page Up 按同样的行数向上翻页。')
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.standardPageTurn)
					.onChange(async (value) => {
						this.plugin.settings.standardPageTurn = value;
						if (value && this.plugin.isImmersive) {
							this.plugin.scheduleStandardPageTrim(this.plugin.getStandardPageScroller());
						} else if (!value) {
							this.plugin.clearStandardPageTrim();
							this.plugin.clearStandardPageHistory();
						}
						await this.plugin.saveSettings();
					})
			);

		new obsidian.Setting(containerEl)
			.setName('ESC 退出')
			.setDesc('在沉浸模式中按 Escape 键退出。')
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.exitOnEsc)
					.onChange(async (value) => {
						this.plugin.settings.exitOnEsc = value;
						await this.plugin.saveSettings();
					})
			);
	}
}

module.exports = ImmersiveModePlugin;
