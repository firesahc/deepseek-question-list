// ==UserScript==
// @name         DeepSeek 会话文件夹管理
// @namespace    https://github.com/firesahc/webai-question-list
// @version      1.0.0
// @description  为 DeepSeek 左侧会话列表添加文件夹分类管理功能，支持自定义文件夹、展开收起、拖拽归类
// @author       firesahc
// @match        https://chat.deepseek.com/*
// @license      MIT
// @grant        GM_setValue
// @grant        GM_getValue
// ==/UserScript==

/**
 * DeepSeek 会话文件夹管理器
 *
 * DOM 结构分析 (基于 2026 年 6 月实际渲染版本):
 *
 *   #root
 *     └── .cb86951c                               ← 页面根容器
 *           ├── .cddfb2ed (空 div，flex-shrink:0 占位符)
 *           └── .c3ecdb44                         ← 主内容区
 *                 ├── .dc04ec1d                   ← 侧边栏面板外层
 *                 │     └── .b8812f16             ← ⭐ 侧边栏面板 (261px，flex 列)
 *                 │           ├── ._262baab       ← Logo + 搜索按钮
 *                 │           ├── ._5a8ac7a       ← "新对话" 按钮
 *                 │           ├── ._3586175       ← 滚动区域容器
 *                 │           │     └── ._6d215eb ← 滚动条
 *                 │           │           └── ._77cdc67._8a693f3 ← ⭐ 对话列表
 *                 │           │                 ├── ._3098d02         ← 日期分组
 *                 │           │                 │     ├── .f3d18f6a   ← 日期标签 (今天/7天前等)
 *                 │           │                 │     ├── a._546d736  ← ⭐ 会话项 (<a>标签)
 *                 │           │                 │     │     ├── .ds-focus-ring
 *                 │           │                 │     │     ├── .c08e6e93  ← 标题文本
 *                 │           │                 │     │     └── ._254829d  ← 右边缘遮罩
 *                 │           │                 │     └── a._546d736 ...
 *                 │           │                 └── ._3098d02 ...
 *                 │           └── ._2afd28d     ← 底部用户区域
 *                 └── ._7780f2e / ._765a5cd     ← 消息区域
 *
 * 关键发现:
 * - 会话项是 <a> 标签 (class="_546d736")，不是 div
 * - 会话 ID 存储在 href 属性中: /a/chat/s/{uuid}
 * - 会话标题在 .c08e6e93 子元素中
 * - 无 data-* 属性，无 React fiber 可用 ID
 * - 侧边栏不使用虚拟列表（所有会话项始终在 DOM 中）
 * - 日期通过 ._3098d02 > .f3d18f6a 组织
 */

(function () {
    'use strict';

    // ===================== 常量 =====================
    const SCRIPT_ID = 'ds-folder-manager';
    const STORAGE_KEY_FOLDERS = 'dsfm_folders';
    const STORAGE_KEY_MAP = 'dsfm_conv_map';
    const STORAGE_KEY_MODE = 'dsfm_mode_enabled';
    const FOLDER_ALL = '__all__';
    const FOLDER_UNCATEGORIZED = '__uncategorized__';
    const DEBOUNCE_DELAY = 300;

    // ===================== 全局状态 =====================
    let folders = [];                    // { id, name, color }
    let convFolderMap = {};             // { conversationId: folderId | null }
    let folderModeEnabled = false;
    let currentFilterFolder = FOLDER_ALL;

    let sidebarEl = null;
    let virtualListEl = null;
    let folderUIEl = null;
    let convObserver = null;
    let spaObserver = null;
    let debounceTimer = null;

    // ===================== 存储操作 =====================
    function loadData() {
        try {
            folders = JSON.parse(GM_getValue(STORAGE_KEY_FOLDERS, '[]'));
            convFolderMap = JSON.parse(GM_getValue(STORAGE_KEY_MAP, '{}'));
            folderModeEnabled = GM_getValue(STORAGE_KEY_MODE, false);
        } catch (e) {
            console.warn('[DSFM] 数据加载失败，重置', e);
            folders = [];
            convFolderMap = {};
            folderModeEnabled = false;
        }
    }

    function saveFolders() {
        GM_setValue(STORAGE_KEY_FOLDERS, JSON.stringify(folders));
    }

    function saveMap() {
        GM_setValue(STORAGE_KEY_MAP, JSON.stringify(convFolderMap));
    }

    function saveMode() {
        GM_setValue(STORAGE_KEY_MODE, folderModeEnabled);
    }

    // ===================== DOM 定位 =====================
    /**
     * 定位侧边栏面板和对话列表容器。
     *
     * 真实 DOM (2026年6月):
     *   .dc04ec1d > .b8812f16 (侧边栏面板, 261px)
     *     > ._3586175 > ._6d215eb > ._77cdc67._8a693f3 (对话列表)
     *
     * 策略:
     * 1. 使用 ._77cdc67._8a693f3 定位列表容器 (双类选择器更精确)
     * 2. 使用 .b8812f16 定位侧边栏面板 (用于注入 UI)
     * 3. 回退方案: 通过 ._546d736 (会话项) 向上查找
     */
    function findSidebarElements() {
        // 主要目标: 对话列表容器
        virtualListEl = document.querySelector('._77cdc67._8a693f3');

        // 如果双类选择器失败，尝试单个类名
        if (!virtualListEl) {
            virtualListEl = document.querySelector('._77cdc67');
        }

        // 定位侧边栏面板 (b8812f16)
        // 从列表容器向上查找，或直接选择
        if (virtualListEl) {
            sidebarEl = virtualListEl.closest('.b8812f16');
        }
        if (!sidebarEl) {
            sidebarEl = document.querySelector('.b8812f16');
        }
        // 最后回退: 通过会话项向上查找
        if (!sidebarEl) {
            const firstItem = document.querySelector('a._546d736');
            if (firstItem) {
                // 向上查找: a._546d736 → ._3098d02 → ._77cdc67 → ._6d215eb → .b8812f16
                sidebarEl = firstItem.closest('.b8812f16');
            }
        }
        // 如果还是找不到，尝试 dc04ec1d 内的第二个子元素
        if (!sidebarEl) {
            const dcEl = document.querySelector('.dc04ec1d');
            if (dcEl) {
                sidebarEl = dcEl.querySelector('.b8812f16');
            }
        }

        return !!sidebarEl;
    }

    // ===================== 会话项识别 =====================
    /**
     * 从会话项 <a> 标签中提取会话 UUID。
     *
     * 实际结构: <a class="_546d736" href="https://chat.deepseek.com/a/chat/s/{uuid}">
     * 从 href 属性中提取 /a/chat/s/ 后面的 UUID 部分。
     *
     * 回退方案: 使用 href 本身作为标识符。
     */
    function extractConversationId(el) {
        // 主要方法: 从 href 提取 UUID
        const href = el.getAttribute('href') || '';
        const match = href.match(/\/a\/chat\/s\/([a-zA-Z0-9_-]+)/);
        if (match) return match[1];

        // 回退: 使用完整 href
        if (href && href.length > 0) return 'href_' + simpleHash(href);

        // 最后回退: 标题哈希
        const title = getConversationTitle(el);
        if (title) return 'conv_' + simpleHash(title);

        return null;
    }

    /**
     * 从会话项 DOM 元素中提取标题文本。
     *
     * 实际结构: <a class="_546d736"><div class=c08e6e93>标题文本</div></a>
     */
    function getConversationTitle(el) {
        // 主选择器: .c08e6e93
        const titleEl = el.querySelector('.c08e6e93');
        if (titleEl) {
            const text = titleEl.textContent?.trim();
            if (text) return text;
        }
        // 回退1: 找任何 class 含 "title" 或 "name" 或 "text" 的元素
        const altEl = el.querySelector('[class*="title"],[class*="name"],[class*="text"]');
        if (altEl) {
            const text = altEl.textContent?.trim();
            if (text && text.length < 200) return text;
        }
        // 回退2: 获取第一个有文本的 span/div
        const spans = el.querySelectorAll('span, div');
        for (const s of spans) {
            const text = s.textContent?.trim();
            if (text && text.length > 1 && text.length < 200) return text;
        }
        // 回退3: 使用 a 标签的全部文本内容（去掉多余空白）
        const text = el.textContent?.trim();
        return text && text.length < 200 ? text : '';
    }

    /**
     * 获取侧边栏中所有会话项 DOM 元素列表。
     * 注意: DeepSeek 侧边栏不使用虚拟列表，所有会话项始终在 DOM 中。
     *
     * 选择策略（多层回退）:
     * 1. a._546d736[href*="/a/chat/s/"] - 精确类名匹配
     * 2. a[href*="/a/chat/s/"] - 宽松匹配（类名变化时仍有效）
     * 3. 在侧边栏面板内查找所有指向 /a/chat/s/ 的链接
     */
    function getVisibleConversationItems() {
        // 策略1: 精确匹配
        let items = document.querySelectorAll('a._546d736[href*="/a/chat/s/"]');
        if (items.length > 0) return Array.from(items);

        // 策略2: 宽松匹配（限制在侧边栏范围内）
        const sidebar = document.querySelector('.b8812f16');
        if (sidebar) {
            items = sidebar.querySelectorAll('a[href*="/a/chat/s/"]');
            if (items.length > 0) return Array.from(items);
        }

        // 策略3: 全局匹配
        items = document.querySelectorAll('a[href*="/a/chat/s/"]');
        return Array.from(items);
    }

    function simpleHash(str) {
        let hash = 0;
        for (let i = 0; i < str.length; i++) {
            const chr = str.charCodeAt(i);
            hash = ((hash << 5) - hash) + chr;
            hash |= 0;
        }
        return Math.abs(hash).toString(36);
    }

    // ===================== 文件夹数据操作 =====================
    function createFolder(name) {
        const folder = {
            id: 'folder_' + Date.now(),
            name: name.trim() || '未命名文件夹',
            color: '#4a6cf7'
        };
        folders.push(folder);
        saveFolders();
        return folder;
    }

    function deleteFolder(folderId) {
        folders = folders.filter(f => f.id !== folderId);
        // 清除被删除文件夹中的会话映射
        for (const convId in convFolderMap) {
            if (convFolderMap[convId] === folderId) {
                convFolderMap[convId] = null;
            }
        }
        saveFolders();
        saveMap();
    }

    function renameFolder(folderId, newName) {
        const folder = folders.find(f => f.id === folderId);
        if (folder && newName.trim()) {
            folder.name = newName.trim();
            saveFolders();
        }
    }

    function setConversationFolder(convId, folderId) {
        convFolderMap[convId] = folderId || null;
        saveMap();
    }

    function getFolderConversationCount(folderId) {
        let count = 0;
        for (const convId in convFolderMap) {
            if (convFolderMap[convId] === folderId) count++;
        }
        return count;
    }

    // 可选颜色色板（点击色点可切换）
    const COLOR_PALETTE = [
        '#4a6cf7', '#22c55e', '#f59e0b', '#ef4444', '#8b5cf6',
        '#06b6d4', '#ec4899', '#f97316', '#14b8a6', '#6366f1',
        '#6b7280', '#84cc16'
    ];

    function setFolderColor(folderId, color) {
        const folder = folders.find(f => f.id === folderId);
        if (folder) {
            folder.color = color;
            saveFolders();
        }
    }

    /**
     * 弹出颜色选择色板，点击色块即可切换文件夹颜色。
     */
    function showColorPicker(event, folderId, currentColor, dotEl) {
        // 移除已有
        const existing = document.getElementById('dsfm-color-picker');
        if (existing) existing.remove();

        const picker = document.createElement('div');
        picker.id = 'dsfm-color-picker';
        const rect = dotEl.getBoundingClientRect();
        picker.style.cssText = `
            position: fixed;
            left: ${rect.right + 6}px;
            top: ${rect.top - 4}px;
            z-index: 10001;
            background: var(--dsw-specific-menu, #fff);
            border: 1px solid var(--dsw-alias-border-l2, rgba(0,0,0,.08));
            border-radius: 8px;
            box-shadow: var(--dsw-shadow-lv3, 0 12px 32px rgba(0,0,0,.08));
            padding: 6px;
            display: flex;
            flex-wrap: wrap;
            gap: 4px;
            width: 192px;
        `;

        COLOR_PALETTE.forEach(color => {
            const swatch = document.createElement('span');
            const isCurrent = color === currentColor;
            swatch.style.cssText = `
                width: 24px;
                height: 24px;
                border-radius: 50%;
                background: ${color};
                cursor: pointer;
                border: 2px solid ${isCurrent ? 'var(--dsw-alias-label-primary, #1a1a2e)' : 'transparent'};
                transition: transform 0.1s;
            `;
            swatch.title = color;
            swatch.addEventListener('mouseenter', () => { swatch.style.transform = 'scale(1.2)'; });
            swatch.addEventListener('mouseleave', () => { swatch.style.transform = 'scale(1)'; });
            swatch.addEventListener('click', (e) => {
                e.stopPropagation();
                setFolderColor(folderId, color);
                picker.remove();
                updateConversationBadges();
                renderFolderList();
            });
            picker.appendChild(swatch);
        });

        document.body.appendChild(picker);

        // 点击外部关闭
        const closeHandler = (e) => {
            if (!picker.contains(e.target) && e.target !== dotEl) {
                picker.remove();
                document.removeEventListener('click', closeHandler);
            }
        };
        setTimeout(() => document.addEventListener('click', closeHandler), 0);
    }

    // ===================== UI 渲染 =====================
    /**
     * 在侧边栏"新对话"按钮下方注入文件夹管理 UI。
     *
     * 侧边栏面板结构:
     *   .b8812f16
     *     ├── ._262baab  (Logo)
     *     ├── ._5a8ac7a  ("新对话"按钮) ← 注入点之后
     *     ├── ._3586175  (滚动区域)
     *     └── ._2afd28d  (用户区域)
     *
     * folderUIEl 内部结构:
     *   #ds-folder-manager-ui
     *     ├── .dsfm-toolbar    ← 工具栏容器 (renderFolderToolbar 操作)
     *     └── .dsfm-folder-list ← 文件夹列表容器 (renderFolderList 操作)
     */
    function injectFolderUI() {
        // 移除旧的 UI
        if (folderUIEl) folderUIEl.remove();

        folderUIEl = document.createElement('div');
        folderUIEl.id = SCRIPT_ID + '-ui';
        folderUIEl.style.cssText = `
            flex-shrink: 0;
            border-bottom: 1px solid var(--dsw-alias-border-l1, rgba(0,0,0,.04));
            padding: 6px 8px 8px;
            font-size: 13px;
            user-select: none;
        `;

        // 创建独立的工具栏容器
        const toolbarEl = document.createElement('div');
        toolbarEl.className = 'dsfm-toolbar';
        toolbarEl.style.cssText = `
            display: flex;
            align-items: center;
            gap: 6px;
            margin-bottom: 6px;
        `;
        folderUIEl.appendChild(toolbarEl);

        // 创建独立的文件夹列表容器
        const listEl = document.createElement('div');
        listEl.className = 'dsfm-folder-list';
        folderUIEl.appendChild(listEl);

        // 渲染内容到各自容器
        renderFolderToolbar();
        renderFolderList();

        // 插入位置: "新对话"按钮 (._5a8ac7a) 之后，滚动区域 (._3586175) 之前
        const newChatBtn = sidebarEl?.querySelector('._5a8ac7a');
        const scrollArea = sidebarEl?.querySelector('._3586175');

        if (newChatBtn && scrollArea) {
            newChatBtn.after(folderUIEl);
        } else if (scrollArea) {
            scrollArea.before(folderUIEl);
        } else if (sidebarEl) {
            const firstChild = sidebarEl.firstElementChild;
            const secondChild = firstChild?.nextElementSibling;
            if (secondChild) {
                secondChild.after(folderUIEl);
            } else {
                sidebarEl.prepend(folderUIEl);
            }
        }
    }

    function renderFolderToolbar() {
        const toolbarEl = folderUIEl?.querySelector('.dsfm-toolbar');
        if (!toolbarEl) return;

        // 只清空工具栏部分
        toolbarEl.innerHTML = '';

        // 模式切换按钮
        const modeBtn = createFolderButton(
            folderModeEnabled ? '📁' : '📋',
            folderModeEnabled ? '文件夹模式 (开)' : '列表模式',
            () => {
                folderModeEnabled = !folderModeEnabled;
                // 打开时默认显示未分组，关闭时恢复全部
                currentFilterFolder = folderModeEnabled ? FOLDER_UNCATEGORIZED : FOLDER_ALL;
                saveMode();
                updateConversationBadges();
                renderFolderToolbar();
                renderFolderList();
                applyFolderFilter();
            }
        );

        // 新建文件夹按钮 (仅在文件夹模式下显示)
        const newFolderBtn = createFolderButton('＋', '新建文件夹', () => {
            const name = prompt('请输入文件夹名称:');
            if (name && name.trim()) {
                createFolder(name.trim());
                renderFolderToolbar();
                renderFolderList();
            }
        });
        newFolderBtn.style.display = folderModeEnabled ? '' : 'none';

        toolbarEl.appendChild(modeBtn);
        toolbarEl.appendChild(newFolderBtn);

        // "全部"筛选按钮
        const allBtn = createEl('button', {
            className: 'dsfm-filter-btn',
            textContent: '全部',
            style: getFilterBtnStyle(FOLDER_ALL === currentFilterFolder),
            onclick: () => {
                currentFilterFolder = FOLDER_ALL;
                renderFolderToolbar();
                renderFolderList();
                applyFolderFilter();
            }
        });
        toolbarEl.appendChild(allBtn);

        // "未分组"筛选按钮（文件夹模式下显示）
        const uncatCount = Object.values(convFolderMap).filter(v => !v).length;
        const uncatBtn = createEl('button', {
            className: 'dsfm-filter-btn',
            textContent: `未分组${uncatCount > 0 ? '(' + uncatCount + ')' : ''}`,
            style: getFilterBtnStyle(FOLDER_UNCATEGORIZED === currentFilterFolder),
            onclick: () => {
                currentFilterFolder = FOLDER_UNCATEGORIZED;
                renderFolderToolbar();
                renderFolderList();
                applyFolderFilter();
            }
        });
        uncatBtn.style.display = folderModeEnabled ? '' : 'none';
        toolbarEl.appendChild(uncatBtn);
    }

    function renderFolderList() {
        if (!folderUIEl) return;

        const listEl = folderUIEl.querySelector('.dsfm-folder-list');
        if (!listEl) return;

        try {
            // 只清空列表部分
            listEl.innerHTML = '';

            // 非文件夹模式：隐藏列表区域
            if (!folderModeEnabled) {
                listEl.style.display = 'none';
                return;
            }
            listEl.style.display = '';

            // 空文件夹提示
            if (folders.length === 0) {
                const emptyHint = createEl('div', {
                    style: `
                        text-align: center;
                        padding: 12px 8px;
                        color: var(--dsw-alias-label-tertiary, #8b95a1);
                        font-size: 12px;
                        line-height: 1.6;
                    `,
                    textContent: '暂无文件夹\n点击上方 ＋ 按钮创建'
                });
                listEl.appendChild(emptyHint);
            }

            folders.forEach(folder => {
            const count = getFolderConversationCount(folder.id);
            const isActive = currentFilterFolder === folder.id;
            const folderColor = folder.color;

            const folderItem = createEl('div', {
                style: `
                    display: flex;
                    align-items: center;
                    padding: 4px 8px;
                    margin: 2px 0;
                    border-radius: 6px;
                    cursor: pointer;
                    transition: background 0.15s ease;
                    background: ${isActive ? 'var(--dsw-specific-sidebar-nav-item-active, rgba(0,0,0,0.06))' : 'transparent'};
                    color: var(--dsw-alias-label-primary, #1a1a2e);
                    font-weight: 400;
                `,
                onmouseenter: function () {
                    if (!isActive) this.style.background = 'var(--dsw-specific-sidebar-nav-item-hover, rgba(0,0,0,.04))';
                },
                onmouseleave: function () {
                    if (!isActive) this.style.background = 'transparent';
                }
            });

            // 文件夹颜色标识（选中时变红，点击可换色）
            const colorDot = createEl('span', {
                style: `
                    width: ${isActive ? '10px' : '8px'};
                    height: ${isActive ? '10px' : '8px'};
                    border-radius: 50%;
                    background: ${isActive ? '#ef4444' : folderColor};
                    flex-shrink: 0;
                    margin: 0 6px 0 2px;
                    transition: all 0.2s ease;
                    cursor: pointer;
                `
            });
            colorDot.title = '点击更换颜色';
            colorDot.addEventListener('click', (e) => {
                e.stopPropagation();
                showColorPicker(e, folder.id, folderColor, colorDot);
            });

            // 文件夹名称
            const nameSpan = createEl('span', {
                style: `
                    flex: 1;
                    overflow: hidden;
                    text-overflow: ellipsis;
                    white-space: nowrap;
                    font-size: 13px;
                    line-height: 1.4;
                `,
                textContent: folder.name
            });

            // 数量标记
            if (count > 0) {
                const countSpan = createEl('span', {
                    style: `
                        font-size: 11px;
                        color: var(--dsw-alias-label-tertiary, #8b95a1);
                        margin-left: 4px;
                        flex-shrink: 0;
                    `,
                    textContent: `(${count})`
                });
                nameSpan.appendChild(countSpan);
            }

            // 操作按钮容器
            const actions = createEl('div', {
                style: `
                    display: flex;
                    gap: 2px;
                    flex-shrink: 0;
                    opacity: 0.6;
                    margin-left: 4px;
                `
            });

            // 重命名按钮
            const renameBtn = createMiniButton('✎', '重命名', (e) => {
                e.stopPropagation();
                const newName = prompt('重命名文件夹:', folder.name);
                if (newName && newName.trim() && newName.trim() !== folder.name) {
                    renameFolder(folder.id, newName.trim());
                    renderFolderList();
                }
            });

            // 删除按钮
            const deleteBtn = createMiniButton('✕', '删除文件夹', (e) => {
                e.stopPropagation();
                if (confirm(`确定删除文件夹"${folder.name}"？其中的会话不会被删除，只会移出文件夹。`)) {
                    deleteFolder(folder.id);
                    if (currentFilterFolder === folder.id) {
                        currentFilterFolder = FOLDER_ALL;
                    }
                    renderFolderList();
                    applyFolderFilter();
                }
            });

            actions.appendChild(renameBtn);
            actions.appendChild(deleteBtn);

            // 组装文件夹项
            folderItem.appendChild(colorDot);
            folderItem.appendChild(nameSpan);
            folderItem.appendChild(actions);

            // 点击文件夹 → 进入该文件夹（筛选会话）
            folderItem.addEventListener('click', () => {
                currentFilterFolder = folder.id;
                renderFolderToolbar();
                renderFolderList();
                applyFolderFilter();
            });

            listEl.appendChild(folderItem);
        });

        // "未分类"项
        const uncategorizedCount = Object.values(convFolderMap).filter(v => !v).length;
        if (uncategorizedCount > 0 || Object.keys(convFolderMap).length === 0) {
            const uncatItem = createEl('div', {
                style: `
                    display: flex;
                    align-items: center;
                    padding: 4px 8px;
                    margin: 2px 0;
                    border-radius: 6px;
                    cursor: pointer;
                    font-size: 13px;
                    color: var(--dsw-alias-label-tertiary, #8b95a1);
                    background: ${currentFilterFolder === FOLDER_UNCATEGORIZED ? 'var(--dsw-specific-sidebar-nav-item-active, rgba(0,0,0,.04))' : 'transparent'};
                `,
                textContent: `📂 未分类 (${uncategorizedCount})`,
                onclick: () => {
                    currentFilterFolder = FOLDER_UNCATEGORIZED;
                    renderFolderToolbar();
                    renderFolderList();
                    applyFolderFilter();
                }
            });
            listEl.appendChild(uncatItem);
        }
        } catch (err) {
            console.error('[DSFM] renderFolderList 错误:', err);
            // 错误时显示简单提示
            listEl.innerHTML = '';
            const errHint = createEl('div', {
                style: 'text-align:center;padding:8px;color:var(--dsw-alias-label-tertiary,#8b95a1);font-size:12px;',
                textContent: '加载出错，请刷新页面'
            });
            listEl.appendChild(errHint);
        }
    }

    /**
     * 根据当前筛选条件，显示/隐藏会话项。
     * 同时处理日期分组: 如果分组内所有项都被隐藏，也隐藏日期标签。
     */
    function applyFolderFilter() {
        const items = getVisibleConversationItems();

        items.forEach(item => {
            const convId = extractConversationId(item);
            if (!convId) return;

            if (!folderModeEnabled || currentFilterFolder === FOLDER_ALL) {
                item.style.display = '';
                return;
            }

            const assignedFolder = convFolderMap[convId] || null;

            if (currentFilterFolder === FOLDER_UNCATEGORIZED) {
                item.style.display = assignedFolder ? 'none' : '';
            } else {
                item.style.display = (assignedFolder === currentFilterFolder) ? '' : 'none';
            }
        });
    }

    // ===================== 会话项右键菜单 =====================
    /**
     * 为会话项添加文件夹选择功能
     * 通过右键菜单或悬停按钮实现
     */
    function enhanceConversationItem(item) {
        // 避免重复处理
        if (item.dataset.dsfmEnhanced === 'true') return;
        item.dataset.dsfmEnhanced = 'true';

        // 添加右键菜单
        item.addEventListener('contextmenu', (e) => {
            if (!folderModeEnabled) return;
            e.preventDefault();
            e.stopPropagation();
            showFolderContextMenu(e.clientX, e.clientY, item);
        });
    }

    function showFolderContextMenu(x, y, convItem) {
        // 移除已有菜单
        const existing = document.getElementById('dsfm-context-menu');
        if (existing) existing.remove();

        const convId = extractConversationId(convItem);
        if (!convId) return;

        const menu = createEl('div', {
            id: 'dsfm-context-menu',
            style: `
                position: fixed;
                left: ${x}px;
                top: ${y}px;
                z-index: 10000;
                background: var(--dsw-specific-menu, #fff);
                border: 1px solid var(--dsw-alias-border-l2, rgba(0,0,0,.08));
                border-radius: 8px;
                box-shadow: var(--dsw-shadow-lv3, 0 12px 32px rgba(0,0,0,.08));
                padding: 4px;
                min-width: 180px;
                max-height: 300px;
                overflow-y: auto;
                font-size: 13px;
            `
        });

        // 标题
        const titleEl = createEl('div', {
            style: `
                padding: 6px 10px;
                color: var(--dsw-alias-label-tertiary, #8b95a1);
                font-size: 11px;
                border-bottom: 1px solid var(--dsw-alias-border-l1, rgba(0,0,0,.04));
                margin-bottom: 4px;
            `,
            textContent: '移动到文件夹'
        });
        menu.appendChild(titleEl);

        // "无" (移除分类)
        const noneItem = createMenuOption('📂 取消分类', () => {
            setConversationFolder(convId, null);
            menu.remove();
            updateConversationBadges();
            renderFolderList();
            applyFolderFilter();
        });
        menu.appendChild(noneItem);

        // 分隔线
        menu.appendChild(createEl('div', {
            style: `
                height: 1px;
                background: var(--dsw-alias-border-l1, rgba(0,0,0,.04));
                margin: 4px 0;
            `
        }));

        // 已有文件夹列表
        folders.forEach(folder => {
            const isCurrent = convFolderMap[convId] === folder.id;
            const colorDot = createEl('span', {
                style: `
                    display: inline-block;
                    width: 8px;
                    height: 8px;
                    border-radius: 50%;
                    background: ${folder.color};
                    margin-right: 6px;
                `
            });
            const opt = createEl('div', {
                style: `
                    padding: 6px 10px;
                    cursor: pointer;
                    border-radius: 4px;
                    display: flex;
                    align-items: center;
                    color: ${isCurrent ? 'var(--dsw-alias-brand-primary, #4a6cf7)' : 'inherit'};
                    font-weight: ${isCurrent ? '600' : '400'};
                    background: ${isCurrent ? 'var(--dsw-specific-sidebar-nav-item-active, rgba(74,108,247,0.1))' : 'transparent'};
                `,
                onmouseenter: function () { if (!isCurrent) this.style.background = 'var(--dsw-specific-sidebar-nav-item-hover, rgba(0,0,0,.04))'; },
                onmouseleave: function () { if (!isCurrent) this.style.background = 'transparent'; },
                onclick: () => {
                    setConversationFolder(convId, folder.id);
                    menu.remove();
                    updateConversationBadges();
                    renderFolderList();
                    applyFolderFilter();
                }
            });
            opt.appendChild(colorDot);
            opt.appendChild(document.createTextNode(folder.name));
            if (isCurrent) {
                opt.appendChild(createEl('span', {
                    style: 'margin-left: auto; font-size: 11px;',
                    textContent: '✓'
                }));
            }
            menu.appendChild(opt);
        });

        // 新建文件夹选项
        menu.appendChild(createEl('div', {
            style: `
                height: 1px;
                background: var(--dsw-alias-border-l1, rgba(0,0,0,.04));
                margin: 4px 0;
            `
        }));
        const newFolderOpt = createEl('div', {
            style: `
                padding: 6px 10px;
                cursor: pointer;
                border-radius: 4px;
                color: var(--dsw-alias-brand-primary, #4a6cf7);
            `,
            textContent: '＋ 新建文件夹并移入',
            onmouseenter: function () { this.style.background = 'var(--dsw-specific-sidebar-nav-item-hover, rgba(0,0,0,.04))'; },
            onmouseleave: function () { this.style.background = 'transparent'; },
            onclick: () => {
                const name = prompt('请输入文件夹名称:');
                if (name && name.trim()) {
                    const folder = createFolder(name.trim());
                    setConversationFolder(convId, folder.id);
                    updateConversationBadges();
                    renderFolderList();
                    applyFolderFilter();
                }
                menu.remove();
            }
        });
        menu.appendChild(newFolderOpt);

        document.body.appendChild(menu);

        // 点击其他地方关闭菜单
        const closeHandler = (e) => {
            if (!menu.contains(e.target)) {
                menu.remove();
                document.removeEventListener('click', closeHandler);
                document.removeEventListener('contextmenu', closeHandler);
            }
        };
        setTimeout(() => {
            document.addEventListener('click', closeHandler);
            document.addEventListener('contextmenu', closeHandler);
        }, 0);
    }

    // ===================== 观察器 =====================
    /**
     * 监听对话列表变化。
     * DeepSeek 侧边栏不使用虚拟列表，所有会话项始终在 DOM 中，
     * 但 React 会在切换对话或列表更新时增删 DOM 节点。
     *
     * 观察目标: ._77cdc67 (对话列表容器) 的子节点变化。
     */
    function startConversationObserver() {
        if (convObserver) convObserver.disconnect();

        // 目标: 对话列表容器 ._77cdc67
        const targetEl = virtualListEl || document.querySelector('._77cdc67');
        if (!targetEl) return;

        convObserver = new MutationObserver(() => {
            clearTimeout(debounceTimer);
            debounceTimer = setTimeout(() => {
                scanConversationItems();
            }, DEBOUNCE_DELAY);
        });

        convObserver.observe(targetEl, {
            childList: true,
            subtree: true
        });

        // 首次扫描
        scanConversationItems();
    }

    function scanConversationItems() {
        const items = getVisibleConversationItems();

        items.forEach(item => {
            enhanceConversationItem(item);
        });

        // 更新文件夹标识
        updateConversationBadges();

        // 应用筛选（含日期分组处理）
        if (folderModeEnabled) {
            applyFolderFilter();
        }
    }

    /**
     * 为已分配文件夹的会话项添加颜色标识点。
     * 在标题文字前面插入一个小色点，颜色对应文件夹颜色。
     * 未分配则移除标识。
     */
    function updateConversationBadges() {
        // 非文件夹模式：移除所有标识
        if (!folderModeEnabled) {
            document.querySelectorAll('.dsfm-badge').forEach(b => b.remove());
            return;
        }

        const items = getVisibleConversationItems();
        items.forEach(item => {
            const convId = extractConversationId(item);
            if (!convId) return;

            const folderId = convFolderMap[convId];
            const existingBadge = item.querySelector('.dsfm-badge');

            if (!folderId) {
                // 未分配：移除已有标识
                if (existingBadge) existingBadge.remove();
                return;
            }

            const folder = folders.find(f => f.id === folderId);
            const color = folder ? folder.color : '#8b95a1';

            if (existingBadge) {
                // 已存在标识：更新颜色
                existingBadge.style.background = color;
            } else {
                // 创建新标识
                const badge = document.createElement('span');
                badge.className = 'dsfm-badge';
                badge.style.cssText = `
                    display: inline-block;
                    width: 6px;
                    height: 6px;
                    border-radius: 50%;
                    background: ${color};
                    flex-shrink: 0;
                    margin-right: 5px;
                    vertical-align: middle;
                    position: relative;
                    top: -1px;
                `;
                // 插入到标题元素前面，或 a 标签的第一个子元素之前
                const titleEl = item.querySelector('.c08e6e93');
                if (titleEl) {
                    titleEl.insertBefore(badge, titleEl.firstChild);
                } else {
                    item.insertBefore(badge, item.firstChild);
                }
            }
        });
    }

    // ===================== SPA 导航检测 =====================
    /**
     * 监听 DeepSeek SPA 导航导致 DOM 重建。
     *
     * 当 React 切换对话或重建侧边栏时，
     * .b8812f16 (侧边栏面板) 或其子元素可能会被移除并重新创建。
     */
    function startSPAObserver() {
        if (spaObserver) spaObserver.disconnect();

        // 监听页面根容器或主内容区
        const mainContainer = document.querySelector('.c3ecdb44')
            || document.querySelector('.cb86951c')
            || document.querySelector('#root');

        if (!mainContainer) return;

        spaObserver = new MutationObserver((mutations) => {
            for (const m of mutations) {
                // 检测侧边栏面板是否被移除
                for (const node of m.removedNodes) {
                    if (node.nodeType !== Node.ELEMENT_NODE) continue;

                    const isFolderUI = node.id === SCRIPT_ID + '-ui';
                    const containsSidebar = node.classList && node.classList.contains('b8812f16');
                    const containsChatList = node.classList && (node.classList.contains('_77cdc67') || node.classList.contains('_8a693f3'));
                    const hasChatItems = node.querySelector && node.querySelector('a._546d736');
                    const hasFolderUI = node.querySelector && node.querySelector('#' + SCRIPT_ID + '-ui');

                    if (isFolderUI || containsSidebar || containsChatList || hasFolderUI || hasChatItems) {
                        scheduleReinit();
                        return;
                    }
                }

                // 检测大量新增节点（整页替换的标志）
                if (m.addedNodes.length > 5) {
                    for (const node of m.addedNodes) {
                        if (node.nodeType === Node.ELEMENT_NODE && node.querySelector) {
                            if (node.querySelector('.b8812f16') || node.querySelector('._77cdc67')) {
                                scheduleReinit();
                                return;
                            }
                        }
                    }
                }
            }
        });

        spaObserver.observe(mainContainer, { childList: true, subtree: true });
    }

    let reinitTimer = null;
    function scheduleReinit() {
        clearTimeout(reinitTimer);
        reinitTimer = setTimeout(() => {
            cleanup();
            init();
        }, 500);
    }

    // ===================== 辅助函数 =====================
    function createEl(tag, opts = {}) {
        const el = document.createElement(tag);
        if (opts.className) el.className = opts.className;
        if (opts.id) el.id = opts.id;
        if (opts.textContent) el.textContent = opts.textContent;
        if (opts.style) el.style.cssText = opts.style;
        if (opts.onclick) el.addEventListener('click', opts.onclick);
        if (opts.onmouseenter) el.addEventListener('mouseenter', opts.onmouseenter);
        if (opts.onmouseleave) el.addEventListener('mouseleave', opts.onmouseleave);
        return el;
    }

    function createFolderButton(icon, title, onClick) {
        const btn = createEl('button', {
            style: `
                height: 28px;
                padding: 0 10px;
                border: 1px solid var(--dsw-alias-border-l2, rgba(0,0,0,.08));
                border-radius: 4096px;
                cursor: pointer;
                display: inline-flex;
                align-items: center;
                gap: 4px;
                font-size: 12px;
                font-weight: 400;
                line-height: 1;
                white-space: nowrap;
                box-sizing: border-box;
                transition: background 0.15s ease;
                color: var(--dsw-alias-label-primary, #1a1a2e);
                background: transparent;
                outline: none;
            `,
            textContent: icon,
            title: title,
            onclick: onClick
        });
        btn.addEventListener('mouseenter', () => {
            btn.style.background = 'var(--dsw-alias-interactive-bg-hover, rgba(0,0,0,.05))';
        });
        btn.addEventListener('mouseleave', () => {
            btn.style.background = 'transparent';
        });
        return btn;
    }

    function createMiniButton(text, title, onClick) {
        const btn = createEl('button', {
            style: `
                width: 20px;
                height: 20px;
                padding: 0;
                border: none;
                border-radius: 4px;
                cursor: pointer;
                display: inline-flex;
                align-items: center;
                justify-content: center;
                font-size: 10px;
                background: transparent;
                color: var(--dsw-alias-label-tertiary, #8b95a1);
                transition: all 0.15s;
            `,
            textContent: text,
            title: title,
            onclick: onClick
        });
        btn.addEventListener('mouseenter', () => {
            btn.style.background = 'var(--dsw-alias-interactive-bg-hover, rgba(0,0,0,.05))';
            btn.style.color = 'var(--dsw-alias-label-primary, #1a1a2e)';
        });
        btn.addEventListener('mouseleave', () => {
            btn.style.background = 'transparent';
            btn.style.color = 'var(--dsw-alias-label-tertiary, #8b95a1)';
        });
        return btn;
    }

    function createMenuOption(text, onClick) {
        return createEl('div', {
            style: `
                padding: 6px 10px;
                cursor: pointer;
                border-radius: 4px;
                font-size: 13px;
                color: var(--dsw-alias-label-primary, #1a1a2e);
            `,
            textContent: text,
            onmouseenter: function () { this.style.background = 'var(--dsw-specific-sidebar-nav-item-hover, rgba(0,0,0,.04))'; },
            onmouseleave: function () { this.style.background = 'transparent'; },
            onclick: onClick
        });
    }

    function getFilterBtnStyle(isActive) {
        return `
            height: 28px;
            padding: 0 10px;
            border: 1px solid ${isActive ? 'var(--dsw-alias-brand-primary, #4a6cf7)' : 'var(--dsw-alias-border-l2, rgba(0,0,0,.08))'};
            border-radius: 4096px;
            cursor: pointer;
            font-size: 12px;
            font-weight: ${isActive ? '600' : '400'};
            color: ${isActive ? 'var(--dsw-alias-brand-primary, #4a6cf7)' : 'var(--dsw-alias-label-primary, #1a1a2e)'};
            background: ${isActive ? 'var(--dsw-specific-sidebar-nav-item-active, rgba(74,108,247,0.1))' : 'transparent'};
            transition: all 0.15s ease;
            outline: none;
        `;
    }

    function cleanup() {
        if (convObserver) { convObserver.disconnect(); convObserver = null; }
        if (spaObserver) { spaObserver.disconnect(); spaObserver = null; }
        clearTimeout(debounceTimer);
        clearTimeout(reinitTimer);
        if (folderUIEl) { folderUIEl.remove(); folderUIEl = null; }
        const contextMenu = document.getElementById('dsfm-context-menu');
        if (contextMenu) contextMenu.remove();
        sidebarEl = null;
        virtualListEl = null;
    }

    // ===================== 等待 DOM 就绪 =====================
    function waitForElement(selector, timeout = 15000) {
        return new Promise((resolve, reject) => {
            const el = document.querySelector(selector);
            if (el) return resolve(el);

            const observer = new MutationObserver(() => {
                const el = document.querySelector(selector);
                if (el) {
                    observer.disconnect();
                    resolve(el);
                }
            });

            observer.observe(document.body, {
                childList: true,
                subtree: true
            });

            setTimeout(() => {
                observer.disconnect();
                reject(new Error(`等待元素 "${selector}" 超时`));
            }, timeout);
        });
    }

    function injectCompactStyle() {
        if (document.getElementById('dsfm-compact-style')) return;
        const style = document.createElement('style');
        style.id = 'dsfm-compact-style';
        style.textContent = `
            /* 隐藏日期标签 */
            .f3d18f6a { display: none !important; }
            /* 减小日期分组间距 */
            ._3098d02 { margin-top: 4px !important; }
        `;
        document.head.appendChild(style);
    }

    // ===================== 初始化 =====================
    async function init() {
        // 加载存储数据
        loadData();

        try {
            // 等待侧边栏渲染 - 等待对话列表容器出现
            await waitForElement('._77cdc67', 20000);

            // 定位 DOM 元素
            if (!findSidebarElements()) {
                console.warn('[DSFM] 无法定位侧边栏元素，1秒后重试...');
                setTimeout(init, 1000);
                return;
            }

            console.log('[DSFM] 侧边栏定位成功，初始化文件夹管理器...');

            // 注入紧凑样式（隐藏日期标签）
            injectCompactStyle();

            // 注入文件夹 UI
            injectFolderUI();

            // 启动会话观察器
            startConversationObserver();

            // 启动 SPA 导航检测
            startSPAObserver();

            // 应用初始筛选（文件夹模式下默认显示未分组）
            if (folderModeEnabled) {
                currentFilterFolder = FOLDER_UNCATEGORIZED;
                renderFolderToolbar();
                applyFolderFilter();
            }

            console.log('[DSFM] 初始化完成');
        } catch (err) {
            console.error('[DSFM] 初始化失败:', err);
            // 重试
            setTimeout(init, 2000);
        }
    }

    // ===================== 启动 =====================
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }

    // 暴露调试接口
    window.DSFolderManager = {
        init,
        cleanup,
        getState: () => ({ folders, convFolderMap, folderModeEnabled, currentFilterFolder }),
        reset: () => {
            GM_setValue(STORAGE_KEY_FOLDERS, '[]');
            GM_setValue(STORAGE_KEY_MAP, '{}');
            GM_setValue(STORAGE_KEY_MODE, false);
            cleanup();
            init();
        }
    };

    console.log('[DSFM] DeepSeek 会话文件夹管理器已加载 (v1.0.0)');
    console.log('[DSFM] 调试接口: window.DSFolderManager');
})();
