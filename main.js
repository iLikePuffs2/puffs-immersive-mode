'use strict';

const obsidian = require('obsidian');

// ─── 默认设置 ─────────────────────────────────────────────────────────
const DEFAULT_SETTINGS = {
	hideLeftSidebar: true,
	hideRightSidebar: true,
	hideStatusBar: true,
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

		await this.loadSettings();

		// 注册切换命令（用户可自行绑定快捷键）
		this.addCommand({
			id: 'toggle-immersive-mode',
			name: 'Toggle Immersive Mode',
			callback: () => this.toggleImmersiveMode(),
		});

		// Ribbon 图标，点击切换沉浸模式
		this.ribbonIconEl = this.addRibbonIcon(
			'expand',
			'切换沉浸模式',
			() => this.toggleImmersiveMode()
		);

		// ESC 键退出沉浸模式（需在设置中开启）
		this.registerDomEvent(document, 'keydown', (evt) => {
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
		}, true); // useCapture = true，优先于 Obsidian 捕获

		// 设置选项卡
		this.addSettingTab(new ImmersiveModeSettingTab(this.app, this));
	}

	async onunload() {
		// 插件卸载时恢复正常状态
		if (this.isImmersive) {
			this.exitImmersiveMode();
		}
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
		if (this.settings.hideStatusBar) {
			document.body.classList.add('immersive-hide-statusbar');
		}

		// 5. 更新状态和图标
		this.isImmersive = true;
		this.ribbonIconEl.setAttribute('aria-label', '退出沉浸模式');
		this.ribbonIconEl.classList.add('is-active');
	}

	exitImmersiveMode() {
		// 1. 移除所有 CSS 类
		document.body.classList.remove(
			'immersive-mode',
			'immersive-hide-statusbar'
		);

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
