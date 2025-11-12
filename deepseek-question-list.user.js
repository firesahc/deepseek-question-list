// ==UserScript==
// @name         deepseek-question-list
// @namespace    https://github.com/firesahc/deepseek-question-list
// @version      1.1.0
// @description  展示网页版deepseek当前对话的所有提问
// @author       firesahc
// @match        https://chat.deepseek.com/*
// @grant        none
// ==/UserScript==

function createParserInterface() {
    const existingList = document.getElementById('xpath-parser-list');
    if (existingList) existingList.remove();

    const listContainer = document.createElement('div');
    listContainer.id = 'xpath-parser-list';
    listContainer.style.cssText = `
        position: fixed;
        top: 20px;
        right: 20px;
        width: 220px;
        max-height: 95vh;
        overflow-y: auto;
        background: white;
        border: 2px solid #4CAF50;
        border-radius: 8px;
        box-shadow: 0 4px 20px rgba(0,0,0,0.15);
        z-index: 10000;
        font-family: Arial, sans-serif;
        font-size: 14px;
        display: flex;
        flex-direction: column;
    `;

    const topButtonBar = document.createElement('div');
    topButtonBar.style.cssText = `
        display: flex;
        gap: 8px;
        padding: 10px;
        background: #f5f5f5;
        border-bottom: 1px solid #ddd;
        border-radius: 8px 8px 0 0;
        flex-wrap: wrap;
    `;

    const contentArea = document.createElement('div');
    contentArea.id = 'xpath-list-content';
    contentArea.style.cssText = 'flex: 1; overflow-y: auto; padding: 8px; display: none;';

    listContainer.appendChild(topButtonBar);
    listContainer.appendChild(contentArea);
    addTopButtons(topButtonBar, listContainer, contentArea);
    document.body.appendChild(listContainer);
}

function parseTargetAndUpdateList(contentArea) {
    try {
        contentArea.innerHTML = '';
        const targetElements = document.getElementsByClassName('dad65929');

        if (targetElements.length === 0) {
            showContentErrorMessage(contentArea, '未找到class="dad65929"的元素。');
            return;
        }

        const targetElement = targetElements[0];
        const firstLevelDivs = Array.from(targetElement.children).filter(child =>
            child.tagName.toLowerCase() === 'div' && child.classList.contains('_9663006')
        );

        if (firstLevelDivs.length === 0) {
            showContentInfoMessage(contentArea, '未找到class="_9663006"的第一层div');
            return;
        }

        const messageElements = [];
        firstLevelDivs.forEach(div => {
            const messageElementsInDiv = div.querySelectorAll('.d29f3d7d.ds-message');
            messageElementsInDiv.forEach(messageElement => {
                const targetElements = messageElement.querySelectorAll('.fbb737a4');
                targetElements.forEach(element => {
                    messageElements.push({
                        container: div,
                        messageElement: messageElement,
                        targetElement: element
                    });
                });
            });
        });

        if (messageElements.length === 0) {
            showContentInfoMessage(contentArea, '未找到符合条件的元素');
            return;
        }

        contentArea.innerHTML = '';
        displayResults(contentArea, messageElements);
        
        // 为每个目标元素添加收起按钮（仅当内容较长时）
        addCollapseButtonsToElements(messageElements);
    } catch (error) {
        console.error('解析时出错:', error);
        showContentErrorMessage(contentArea, `解析错误: ${error.message}`);
    }
}

function addCollapseButtonsToElements(messageElements) {
    messageElements.forEach((item, index) => {
        const element = item.targetElement;

        // 检查是否已经添加过按钮
        if (element.hasAttribute('data-collapse-button-added')) {
            return;
        }

        // 检查内容是否足够长，需要收起功能
        const scrollHeight = element.scrollHeight;
        const clientHeight = element.clientHeight;

        // 如果内容高度不超过400px，不需要添加收起按钮
        if (scrollHeight <= 400) {
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

function displayResults(contentArea, messageElements) {
    const list = document.createElement('ul');
    list.style.cssText = 'list-style: none; margin: 0; padding: 0;';

    messageElements.forEach((item, index) => {
        const listItem = createListItem(item, index);
        list.appendChild(listItem);
    });

    contentArea.appendChild(list);
}

function createListItem(item, index) {
    const listItem = document.createElement('li');
    listItem.style.cssText = `
        margin-bottom: 4px;
        padding: 4px;
        border: 1px solid #e0e0e0;
        border-radius: 6px;
        background: #fafafa;
        cursor: pointer;
        transition: all 0.2s ease;
    `;

    listItem.addEventListener('mouseenter', () => {
        listItem.style.background = '#f0f8ff';
        listItem.style.borderColor = '#4CAF50';
    });

    listItem.addEventListener('mouseleave', () => {
        listItem.style.background = '#fafafa';
        listItem.style.borderColor = '#e0e0e0';
    });

    const indexInfo = document.createElement('div');
    indexInfo.style.cssText = 'font-weight: bold; color: #2196F3; margin-bottom: 4px; font-size: 14px;';
    indexInfo.textContent = `问题 ${index + 1}`;

    const contentPreview = document.createElement('div');
    contentPreview.style.cssText = 'color: #333; font-size: 13px; margin-bottom: 4px; line-height: 1.4; background: white; padding: 4px; border-radius: 4px; border: 1px solid #e0e0e0;';

    const textContent = item.targetElement.textContent?.trim() || '';
    contentPreview.textContent = textContent ?
        (textContent.length > 120 ? textContent.substring(0, 120) + '...' : textContent) :
        '[空内容]';

    listItem.appendChild(indexInfo);
    listItem.appendChild(contentPreview);

    //点击跳转到问题起始
    listItem.addEventListener('click', () => {
        item.targetElement.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });

    return listItem;
}

function addTopButtons(buttonContainer, listContainer, contentArea) {
    const buttonStyle = `
        padding: 6px 6px;
        border: none;
        border-radius: 4px;
        cursor: pointer;
        font-size: 12px;
        font-weight: bold;
        transition: all 0.2s ease;
        flex: 1;
        min-width: 30px;
    `;

    const parseButton = createButton('开始解析', '#2196F3', '#1976D2', () => {
        const toggleButton = buttonContainer.querySelector('button:nth-child(2)');
        toggleButton.textContent = '隐藏列表';
        isContentVisible = true;
        contentArea.style.display = 'block';
        listContainer.style.maxHeight = '95vh';
        parseTargetAndUpdateList(contentArea);
    });

    let isContentVisible = true;
    const toggleButton = createButton('隐藏列表', '#FF9800', '#F57C00', () => {
        isContentVisible = !isContentVisible;
        contentArea.style.display = isContentVisible ? 'block' : 'none';
        toggleButton.textContent = isContentVisible ? '隐藏列表' : '显示列表';
        listContainer.style.maxHeight = isContentVisible ? '95vh' : 'auto';
        listContainer.style.height = isContentVisible ? '' : 'auto';
    });

    const closeButton = createButton('关闭', '#f44336', '#D32F2F', () => {
        if (document.body.contains(listContainer)) {
            document.body.removeChild(listContainer);
        }
    });

    buttonContainer.appendChild(parseButton);
    buttonContainer.appendChild(toggleButton);
    buttonContainer.appendChild(closeButton);
}

function createButton(text, bgColor, hoverColor, clickHandler) {
    const button = document.createElement('button');
    button.textContent = text;
    button.style.cssText = `
        padding: 6px 6px;
        border: none;
        border-radius: 4px;
        cursor: pointer;
        font-size: 12px;
        font-weight: bold;
        transition: all 0.2s ease;
        flex: 1;
        min-width: 30px;
        background: ${bgColor};
        color: white;
    `;

    button.addEventListener('mouseenter', () => {
        button.style.background = hoverColor;
    });

    button.addEventListener('mouseleave', () => {
        button.style.background = bgColor;
    });

    button.addEventListener('click', clickHandler);
    return button;
}

function showContentErrorMessage(contentArea, message) {
    contentArea.innerHTML = '';

    const errorDiv = document.createElement('div');
    errorDiv.style.cssText = `
        background: #ffebee;
        color: #c62828;
        border: 2px solid #f44336;
        padding: 4px;
        border-radius: 8px;
        margin-bottom: 4px;
        font-family: Arial, sans-serif;
        white-space: pre-line;
    `;

    const title = document.createElement('h3');
    title.textContent = '解析错误';
    title.style.cssText = 'margin: 0 0 10px 0; color: #c62828;';
    errorDiv.appendChild(title);

    const messageDiv = document.createElement('div');
    messageDiv.textContent = message;
    errorDiv.appendChild(messageDiv);
    contentArea.appendChild(errorDiv);
}

function showContentInfoMessage(contentArea, message) {
    contentArea.innerHTML = '';

    const infoDiv = document.createElement('div');
    infoDiv.style.cssText = `
        background: #e3f2fd;
        color: #1565c0;
        border: 2px solid #2196F3;
        padding: 4px;
        border-radius: 8px;
        margin-bottom: 4px;
        font-family: Arial, sans-serif;
        text-align: center;
    `;

    const title = document.createElement('h3');
    title.textContent = '解析结果';
    title.style.cssText = 'margin: 0 0 10px 0; color: #1565c0;';
    infoDiv.appendChild(title);

    const messageDiv = document.createElement('div');
    messageDiv.textContent = message;
    infoDiv.appendChild(messageDiv);
    contentArea.appendChild(infoDiv);
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', createParserInterface);
} else {
    createParserInterface();
}

window.createParser = createParserInterface;
window.parseTarget = function() {
    const contentArea = document.getElementById('xpath-list-content');
    if (contentArea) {
        contentArea.style.display = 'block';
        parseTargetAndUpdateList(contentArea);
    }
};

console.log('解析器已加载。使用 createParser() 创建界面，使用 parseTarget() 开始解析');
