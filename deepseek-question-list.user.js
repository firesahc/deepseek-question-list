// ==UserScript==
// @name         deepseek-question-list
// @namespace    https://github.com/firesahc/webai-question-list
// @version      1.17.2
// @description  展示网页版deepseek当前对话的所有提问
// @author       firesahc
// @match        https://chat.deepseek.com/*
// @license      MIT
// @grant        GM_setValue
// @grant        GM_getValue
// ==/UserScript==

let observer = null;
let isObserving = false;
let debounceTimer = null;
let spaObserver = null;

function createParserInit() {
    const existingList = document.getElementById('xpath-parser-list');
    if (existingList) existingList.remove();

    const listContainer = document.createElement('div');
    listContainer.id = 'xpath-parser-list';
    listContainer.style.cssText = `
        position: static;
        top: 12px;
        right: 65px;
        width: 260px;
        flex-shrink: 0;
        z-index: 1005;
        background: var(--dsw-specific-sidebar-fill, #f9fafb);
        border-left: 1px solid var(--dsw-alias-border-l1, rgba(0,0,0,.04));
        overflow-y: auto;
        display: flex;
        flex-direction: column;
        font-family: Arial, sans-serif;
        font-size: 14px;
        padding: 6px 12px 10px;
        transition: width 0.3s var(--ds-ease-in-out, ease), box-shadow 0.3s ease;
        box-shadow: none;
        max-height: 100vh;
    `;

    const topButtonBar = document.createElement('div');
    topButtonBar.style.cssText = `
        display: flex;
        gap: 6px;
        flex-wrap: wrap;
        padding-bottom: 10px;
        margin-bottom: 4px;
        border-bottom: 1px solid var(--dsw-alias-border-l1, rgba(0,0,0,.04));
        flex-shrink: 0;
    `;

    const contentArea = document.createElement('div');
    contentArea.id = 'xpath-list-content';
    contentArea.style.cssText = `
        flex: 1;
        overflow-y: auto;
        padding: 4px 0;
        min-height: 0;
    `;
    
    addTopButtons(topButtonBar, listContainer, contentArea);
    
    listContainer.appendChild(topButtonBar);
    listContainer.appendChild(contentArea);
    
    // 延迟启动观察器
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
        addQuestionCollapseButtons();

        // 将列表框添加到 class="c3ecdb44" 的元素内部
        const targetContainer = document.querySelector('.c3ecdb44');
        if (targetContainer) {
            targetContainer.appendChild(listContainer);
            // SPA 导航检测：当 React 切换对话时，我们的元素会被移除，此时重新初始化
            setupSPAObserver(targetContainer);
        }
        else {
            console.warn("未找到框架元素class=\"c3ecdb44\"");
        }

        // 自动开始解析（首次加载时）
        const contentVisible = GM_getValue('isContentVisible', true);
        if (!isObserving && contentVisible) {
            const contentArea = document.getElementById('xpath-list-content');
            if (contentArea) {
                startObservation(contentArea);
            }
        }
    }, 500)
}

function startObservation(contentArea) {
    if (isObserving) return true;

    observer = new MutationObserver((mutations) => {
        let shouldParse = false;
        for (const mutation of mutations) {
            // 检查目标元素的类名
            const targetClass = mutation.target.className;
            
            // 情况1: 直接检测到 ds-virtual-list-visible-items 的变化
            if (mutation.type === 'childList' &&
                typeof targetClass === 'string' &&
                targetClass.includes('ds-virtual-list-visible-items')) {
                shouldParse = true;
                break;
            }
            
            // 情况2: 检测到滚动区域的变化，且涉及 ds-virtual-list-visible-items 节点
            if (mutation.type === 'childList' &&
                typeof targetClass === 'string' &&
                targetClass.includes('ds-virtual-list-items')) {
                // 检查添加的节点
                if (mutation.addedNodes.length > 0) {
                    for (const node of mutation.addedNodes) {
                        if (node.nodeType === Node.ELEMENT_NODE &&
                            node.classList &&
                            node.classList.contains('ds-virtual-list-visible-items')) {
                            shouldParse = true;
                            break;
                        }
                    }
                }
                // 检查移除的节点
                else if (mutation.removedNodes.length > 0) {
                    for (const node of mutation.removedNodes) {
                        if (node.nodeType === Node.ELEMENT_NODE &&
                            node.classList &&
                            node.classList.contains('ds-virtual-list-visible-items')) {
                            shouldParse = true;
                            break;
                        }
                    }
                }
                if (shouldParse) break;
            }
        }

        if (shouldParse) {
            clearTimeout(debounceTimer);
            debounceTimer = setTimeout(() => {
                const messageElements = parseElements();
                if (messageElements.length === 0) return;
                contentArea.innerHTML = '';
                addListMessages(contentArea, messageElements);

                // 为每个目标元素添加收起按钮（仅当内容较长时）
                addElementCollapseButtons(messageElements);
            }, 300);
        }
    });

    // 获取目标元素（._765a5cd 不含 ds-scroll-area 类，该类位于其子元素 _2bd7b35 上）
    const targetElement = document.querySelector('._765a5cd');
    if (!targetElement) {
        console.error("未找到监听元素class=\"_765a5cd\"");
        return false;
    }
    
    try {
        // 开始观察目标元素（仅监听子节点变化，不监听属性）
        observer.observe(targetElement, {
            childList: true,
            subtree: true
        });
        isObserving = true;
        return true;
    } catch (error) {
        isObserving = false;
        return false;
    }
}

function stopObservation() {
    if (observer) {
        observer.disconnect();
        observer = null;
        isObserving = false;
        clearTimeout(debounceTimer);
    }
}

function setupSPAObserver(targetContainer) {
    // 清理旧的 SPA 观察器
    if (spaObserver) spaObserver.disconnect();
    // 监听 .c3ecdb44 的子节点移除 → React 切换对话时重建整个脚本
    spaObserver = new MutationObserver((mutations) => {
        for (const m of mutations) {
            for (const node of m.removedNodes) {
                if (node.nodeType === Node.ELEMENT_NODE && node.id === 'xpath-parser-list') {
                    spaObserver.disconnect();
                    spaObserver = null;
                    stopObservation();
                    createParserInit();
                    return;
                }
            }
        }
    });
    spaObserver.observe(targetContainer, { childList: true });
}

function parseElements() {
    try {
        const targetElements = document.querySelectorAll('.fbb737a4');
        if (targetElements.length === 0) {
            return [];
        }
        return Array.from(targetElements);
    } catch (error) {
        console.warn("parseElements error:", error);
        return [];
    }
}

function addElementCollapseButtons(messageElements) {
    messageElements.forEach((element) => {
        // 检查是否已经添加过按钮
        if (element.hasAttribute('data-collapse-button-added')) {
            return;
        }

        // 如果内容高度不超过400px，不需要添加收起按钮
        if (element.scrollHeight <= 400) {
            return;
        }

        // 标记已添加按钮
        element.setAttribute('data-collapse-button-added', 'true');

        // 确保元素有相对定位，以便按钮可以绝对定位
        const originalPosition = element.style.position;
        if (!originalPosition || originalPosition === 'static') {
            element.style.position = 'relative';
        }

        // 创建收起按钮
        const collapseButton = document.createElement('button');
        collapseButton.textContent = '收起';
        collapseButton.style.cssText = `
            position: absolute;
            top: 5px;
            left: 5px;
            z-index: 1000;
            background: rgba(100, 100, 100, 0.8);
            color: white;
            border: none;
            border-radius: 4px;
            padding: 4px 8px;
            font-size: 12px;
            cursor: pointer;
            opacity: 0.8;
            transition: opacity 0.2s;
        `;

        // 存储原始高度和溢出状态
        const originalHeight = element.style.height;
        const originalOverflow = element.style.overflow;
        let isCollapsed = false;

        collapseButton.addEventListener('mouseenter', () => {
            collapseButton.style.opacity = '1';
        });

        collapseButton.addEventListener('mouseleave', () => {
            collapseButton.style.opacity = '0.8';
        });

        collapseButton.addEventListener('click', (e) => {
            e.stopPropagation();
            if (isCollapsed) {
                // 展开
                element.style.height = originalHeight || '';
                element.style.overflow = originalOverflow || '';
                collapseButton.textContent = '收起';
                isCollapsed = false;
            } else {
                // 收起
                element.style.height = '110px';
                element.style.overflow = 'hidden';
                collapseButton.textContent = '展开';
                isCollapsed = true;
            }
        });

        // 添加按钮到元素
        element.appendChild(collapseButton);
    });
}

function addQuestionCollapseButtons(){
    // 检查是否已添加过按钮
    if (document.getElementById('question-collapse-toggle')) {
        return;
    }

    // 尝试查找目标元素
    const questionElement = document.querySelector('._871cbca');
    if (!questionElement) {
        console.error("未找到输入框框架元素class=\"_871cbca\"");
        return;
    }
    
    // 保存原始 display 值（CSS 中为 flex），供展开时恢复
    const originalDisplay = getComputedStyle(questionElement).display;

    const toggleButton = document.createElement('button');
    toggleButton.id = 'question-collapse-toggle';
    // 获取目标容器元素
    const containerElement = document.querySelector('._7780f2e');
    if (!containerElement) {
        console.error("未找到输入框元素class=\"_7780f2e\"");
        return;
    } else {
        toggleButton.textContent = '▼';
        // 设置容器元素为相对定位，以便按钮可以相对于它定位
        containerElement.style.position = 'relative';
        // 将按钮添加到容器元素内部
        containerElement.appendChild(toggleButton);
        // 设置按钮样式 - 在容器内水平居中
        toggleButton.style.cssText = `
            position: absolute;
            bottom: 0; 
            left: 50%;
            transform: translateX(-50%);
            z-index: 1000;
            padding: 8px 20px;
            background-color: rgba(255, 255, 255, 0.3);
            color: #000;
            border: 1px solid rgba(0, 0, 0, 0.1);
            border-bottom: none;
            border-radius: 8px 8px 0 0;
            cursor: pointer;
            backdrop-filter: blur(12px);
            -webkit-backdrop-filter: blur(12px);
            font-size: 10px;
            font-weight: bold;
            box-shadow: 0 -2px 10px rgba(0, 0, 0, 0.1);
            transition: all 0.3s ease;
        `;
    }

    // 添加点击事件
    toggleButton.addEventListener('click', function () {
        if (questionElement.style.display === 'none') {
            // 展开：恢复原始 display 值 (flex)
            questionElement.style.display = originalDisplay;
            toggleButton.textContent = '▼';
        } else {
            // 收起：保存当前 inline display 并设为 none
            questionElement.style.display = 'none';
            toggleButton.textContent = '▲';
        };
    });
}

function addListMessages(contentArea, messageElements) {
    const list = document.createElement('ul');
    list.style.cssText = `
        list-style: none;
        margin: 0;
        padding: 0;
    `;

    messageElements.forEach((item, index) => {
        const listItem = createListItem(item, index);
        list.appendChild(listItem);
    });

    contentArea.appendChild(list);
}

function createListItem(item, index) {
    const listItem = document.createElement('li');
    listItem.style.cssText = `
        margin-bottom: 6px;
        padding: 6px 8px;
        border: 1px solid var(--dsw-alias-border-l1, #d0d5dd);
        border-left: 3px solid var(--dsw-alias-brand-primary, #4a6cf7);
        border-radius: 6px;
        background: var(--dsw-alias-bg-base, #f8f9fb);
        cursor: pointer;
        transition: all 0.2s ease;
    `;

    listItem.addEventListener('mouseenter', () => {
        listItem.style.background = 'var(--dsw-specific-sidebar-nav-item-hover, #eef1f6)';
        listItem.style.borderColor = 'var(--dsw-specific-sidebar-nav-item-active-accent, #4a6cf7)';
        listItem.style.borderLeftColor = 'var(--dsw-specific-sidebar-nav-item-active-accent, #2d4cc8)';
    });

    listItem.addEventListener('mouseleave', () => {
        listItem.style.background = 'var(--dsw-alias-bg-base, #f8f9fb)';
        listItem.style.borderColor = 'var(--dsw-alias-border-l1, #d0d5dd)';
        listItem.style.borderLeftColor = 'var(--dsw-alias-brand-primary, #4a6cf7)';
    });

    const indexInfo = document.createElement('div');
    indexInfo.style.cssText = `
        font-weight: 700;
        color: #1a1a2e;
        font-size: 13px;
        margin-bottom: 2px;
    `;
    indexInfo.textContent = `问题 ${index + 1}`;

    const contentPreview = document.createElement('div');
    contentPreview.style.cssText = `
        color: #2d2d3f;
        font-size: 13px;
        line-height: 1.45;
        font-weight: 450;
        background: #fff;
        padding: 5px 7px;
        border-radius: 4px;
        border: 1px solid var(--dsw-alias-border-l1, #e8ecf1);
    `;
    
    const textContent = item.textContent?.trim() || '';
    contentPreview.textContent = textContent ?
        (textContent.length > 120 ? 
             textContent.substring(0, 120) + '...' : 
             textContent
        ) :
        '[空内容]';

    listItem.appendChild(indexInfo);
    listItem.appendChild(contentPreview);

    //点击跳转到问题起始
    listItem.addEventListener('click', () => {
        item.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });

    return listItem;
}

function addTopButtons(buttonContainer, listContainer, contentArea) {
    // 从油猴存储中读取 isContentVisible 的值，默认值为 true（显示状态）
    let isContentVisible = GM_getValue('isContentVisible', true);

    // 根据存储的值初始化布局状态
    if (isContentVisible) {
        applyExpandedState(listContainer, contentArea, buttonContainer);
    } else {
        applyCollapsedState(listContainer, contentArea, buttonContainer);
    }

    // ── 解析按钮：仿 DeepSeek capsule 样式（primary 标签色）──
    const playIcon = '<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><circle cx="8" cy="8" r="7" stroke="currentColor" stroke-width="1.2"/><path d="M6.2 4.8L11 8L6.2 11.2V4.8Z" fill="currentColor"/></svg>';
    const stopIcon = '<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><circle cx="8" cy="8" r="7" stroke="currentColor" stroke-width="1.2"/><rect x="4.8" y="4.8" width="6.4" height="6.4" rx="1.2" fill="currentColor"/></svg>';

    const parseButton = createCapsuleButton(
        isObserving ? stopIcon : playIcon,
        true,
        () => {
            if (isObserving) {
                stopObservation();
                parseButton.innerHTML = playIcon;
            } else {
                const success = startObservation(contentArea);
                if (success) {
                    parseButton.innerHTML = stopIcon;
                    const messageElements = parseElements();
                    if (messageElements.length > 0) {
                        contentArea.innerHTML = '';
                        addListMessages(contentArea, messageElements);
                        addElementCollapseButtons(messageElements);
                    }
                }
            }
        }
    );
    parseButton.title = isObserving ? '停止解析' : '开始解析';

    // ── 折叠按钮：仿 DeepSeek capsule 样式（tertiary 标签色，更低调）──
    // 展开态 → 点击收起（双右箭头 »）
    const closeIcon = '<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M4.5 3.5L9 8L4.5 12.5" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/><path d="M9 3.5L12 8L9 12.5" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>';
    // 收起态 → 点击展开（双左箭头 «）
    const openIcon  = '<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M11.5 3.5L7 8L11.5 12.5" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/><path d="M7 3.5L4 8L7 12.5" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>';

    const toggleButton = createCapsuleButton(
        isContentVisible ? closeIcon : openIcon,
        false,
        () => {
            isContentVisible = !isContentVisible;
            toggleButton.innerHTML = isContentVisible ? closeIcon : openIcon;
            if (isContentVisible) {
                applyExpandedState(listContainer, contentArea, buttonContainer);
            } else {
                applyCollapsedState(listContainer, contentArea, buttonContainer);
            }
            GM_setValue('isContentVisible', isContentVisible);
        }
    );
    toggleButton.title = isContentVisible ? '收起列表' : '展开列表';

    buttonContainer.appendChild(parseButton);
    buttonContainer.appendChild(toggleButton);
}

function applyCollapsedState(listContainer, contentArea, buttonContainer) {
    // ── 仿 DeepSeek .e5bf614e 胶囊容器 ──
    listContainer.style.position = 'fixed';
    listContainer.style.top = '12px';
    listContainer.style.right = '65px';
    listContainer.style.width = 'auto';
    listContainer.style.minWidth = '';
    listContainer.style.maxHeight = 'none';
    listContainer.style.height = '40px';
    listContainer.style.padding = '0 4px';
    listContainer.style.borderRadius = '100px';
    listContainer.style.border = '1px solid var(--dsw-alias-border-l2, rgba(0,0,0,.08))';
    listContainer.style.background = 'var(--dsw-alias-bg-layer-3, #fff)';
    listContainer.style.boxShadow = '0 4px 12px rgba(0,0,0,.04)';
    listContainer.style.overflowY = 'visible';
    listContainer.style.backdropFilter = '';
    listContainer.style.webkitBackdropFilter = '';
    listContainer.style.display = 'flex';
    listContainer.style.flexDirection = 'row';
    listContainer.style.alignItems = 'center';
    contentArea.style.display = 'none';
    buttonContainer.style.flexDirection = 'row';
    buttonContainer.style.borderBottom = 'none';
    buttonContainer.style.paddingBottom = '0';
    buttonContainer.style.marginBottom = '0';
    buttonContainer.style.gap = '2px';
    // 调整按钮内边距（更紧凑的图标按钮）
    if (buttonContainer.children[0]) buttonContainer.children[0].style.padding = '0 6px';
    if (buttonContainer.children[1]) buttonContainer.children[1].style.padding = '0 5px';
}

function applyExpandedState(listContainer, contentArea, buttonContainer) {
    // 回到文档流 → flex 子元素，占据右侧栏位
    listContainer.style.position = '';
    listContainer.style.top = '';
    listContainer.style.right = '';
    listContainer.style.width = '260px';
    listContainer.style.minWidth = '';
    listContainer.style.maxHeight = '100vh';
    listContainer.style.height = '';
    listContainer.style.padding = '6px 12px 10px';
    listContainer.style.boxShadow = 'none';
    listContainer.style.borderRadius = '';
    listContainer.style.border = '';
    listContainer.style.overflowY = 'auto';
    listContainer.style.display = '';
    listContainer.style.flexDirection = '';
    listContainer.style.alignItems = '';
    listContainer.style.background = 'var(--dsw-specific-sidebar-fill, #f9fafb)';
    listContainer.style.backdropFilter = '';
    listContainer.style.webkitBackdropFilter = '';
    contentArea.style.display = 'block';
    buttonContainer.style.flexDirection = 'row';
    buttonContainer.style.borderBottom = '1px solid var(--dsw-alias-border-l1, rgba(0,0,0,.04))';
    buttonContainer.style.paddingBottom = '10px';
    buttonContainer.style.marginBottom = '4px';
    buttonContainer.style.gap = '6px';
    // 恢复默认内边距
    if (buttonContainer.children[0]) buttonContainer.children[0].style.padding = '';
    if (buttonContainer.children[1]) buttonContainer.children[1].style.padding = '';
}

// ── DeepSeek 风格胶囊按钮 ──
function createCapsuleButton(innerHTML, isPrimary, clickHandler) {
    const btn = document.createElement('button');
    btn.innerHTML = innerHTML;
    const labelVar = isPrimary ? 'primary' : 'tertiary';
    btn.style.cssText = `
        height: 34px;
        padding: 0 12px;
        border: none;
        border-radius: 4096px;
        cursor: pointer;
        display: inline-flex;
        align-items: center;
        gap: 4px;
        font-size: 14px;
        font-weight: 400;
        line-height: 1;
        white-space: nowrap;
        box-sizing: border-box;
        transition: background 0.2s ease;
        color: var(--dsw-alias-label-${labelVar}, ${isPrimary ? '#1a1a2e' : '#8b95a1'});
        background: transparent;
        outline: none;
    `;
    btn.addEventListener('mouseenter', () => {
        btn.style.background = 'var(--dsw-alias-interactive-bg-hover, rgba(0,0,0,0.05))';
    });
    btn.addEventListener('mouseleave', () => {
        btn.style.background = 'transparent';
    });
    btn.addEventListener('click', clickHandler);
    return btn;
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', createParserInit);
} else {
    createParserInit();
}

window.createParser = createParserInit;
window.parseTarget = function() {
    const contentArea = document.getElementById('xpath-list-content');
    if (contentArea) {
        const messageElements = parseElements();
        if (messageElements.length > 0) {
            contentArea.innerHTML = '';
            addListMessages(contentArea, messageElements);

            // 为每个目标元素添加收起按钮（仅当内容较长时）
            addElementCollapseButtons(messageElements);
        }
    }
};
