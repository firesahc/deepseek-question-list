// ==UserScript==
// @name         抖音视频/图片批量解析下载器 (HelloTik)
// @namespace    http://tampermonkey.net/
// @version      1.9.1
// @description  在 HelloTik.app 上批量解析下载抖音无水印视频和图片。自动从分享文本中提取链接、自动选择最高画质（含超高清/4K）、支持图片下载。
// @author       Sisyphus
// @match        https://www.hellotik.app/*
// @icon         https://www.hellotik.app/favicon.ico
// @grant        GM_addStyle
// @grant        GM_download
// @grant        unsafeWindow
// @run-at       document-idle
// ==/UserScript==

(function() {
    'use strict';

    // ── Tampermonkey API 兼容（无 GM 环境也能运行） ──────────
    const _GM_addStyle = (typeof GM_addStyle !== 'undefined')
        ? GM_addStyle
        : function(css) {
            const s = document.createElement('style');
            s.textContent = css;
            (document.head || document.documentElement).appendChild(s);
        };
    const _unsafeWindow = (typeof unsafeWindow !== 'undefined') ? unsafeWindow : window;

    // ═══════════════════════════════════════════════════════════════
    //  工具
    // ═══════════════════════════════════════════════════════════════

    const sleep = ms => new Promise(r => setTimeout(r, ms));

    const COLORS = {
        primary: '#000', primaryHover: '#333',
        success: '#10b981', danger: '#ef4444', warning: '#f59e0b',
        bg: '#fff', bgDark: '#f8fafc', border: '#e2e8f0',
        text: '#1e293b', textLight: '#64748b',
    };

    // ── 从任意文本中提取抖音链接 ─────────────────────────────
    function extractDouyinUrls(text) {
        // 匹配各种抖音链接格式
        const patterns = [
            /https:\/\/v\.douyin\.com\/[a-zA-Z0-9_-]+/gi,
            /https:\/\/www\.douyin\.com\/(video|note)\/[0-9]+/gi,
            /https:\/\/www\.iesdouyin\.com\/[a-zA-Z0-9_\/-]+/gi,
            /https:\/\/www\.douyin\.com\/share\/[a-zA-Z0-9_-]+/gi,
            /https:\/\/m\.douyin\.com\/[0-9]+/gi,
        ];
        const found = new Set();
        for (const pat of patterns) {
            const matches = text.match(pat);
            if (matches) matches.forEach(m => found.add(m.replace(/[^a-zA-Z0-9/:._-]/g, '')));
        }
        // v.douyin.com 的短链接需要补全
        return [...found].map(u => {
            if (/^https:\/\/v\.douyin\.com\/[a-zA-Z0-9_-]+$/i.test(u) && !u.endsWith('/')) return u + '/';
            return u;
        });
    }

    // ── Toast ──────────────────────────────────────────────────
    function toast(msg, type = 'info', dur = 3000) {
        const el = document.createElement('div');
        el.className = 'ht-toast ' + type;
        el.textContent = msg;
        document.body.appendChild(el);
        setTimeout(() => el.remove(), dur);
    }

    // ── Log ────────────────────────────────────────────────────
    let logEl = null;
    function log(msg, level = 'info') {
        if (!logEl) return;
        const line = document.createElement('div');
        line.className = level;
        line.textContent = '[' + new Date().toLocaleTimeString() + '] ' + msg;
        logEl.appendChild(line);
        logEl.scrollTop = logEl.scrollHeight;
    }

    // ═══════════════════════════════════════════════════════════════
    //  画质评分 — 更智能的排序
    // ═══════════════════════════════════════════════════════════════

    function qualityScore(type) {
        const t = (type || '').toLowerCase();
        // 尝试提取数字分辨率
        const numMatch = t.match(/(\d{3,4})\s*[pPkK]/);
        if (numMatch) {
            const n = parseInt(numMatch[1]);
            if (n >= 2160) return 10;  // 4K/2160P
            if (n >= 1080) return 20;  // 1080P
            if (n >= 720)  return 30;  // 720P
            if (n >= 540)  return 40;  // 540P
            if (n >= 480)  return 50;  // 480P
            return 60;
        }
        // 关键词匹配
        if (t.includes('4k') || t.includes('2160') || t.includes('超高清') || t.includes('超清') || t.includes('4k超高清')) return 11;
        if (t.includes('1080') || t.includes('全高清') || t.includes('fhd')) return 21;
        if (t.includes('高清') || t.includes('hd')) return 25;
        if (t.includes('720')) return 31;
        if (t.includes('540')) return 41;
        if (t.includes('480')) return 51;
        if (t.includes('360')) return 61;
        if (t.includes('流畅') || t.includes('标清') || t.includes('sd')) return 70;
        return 99; // 未知
    }

    function bestQuality(videoEntry) {
        if (videoEntry.fullinfo && videoEntry.fullinfo.length > 0) {
            const sorted = [...videoEntry.fullinfo].sort((a, b) => qualityScore(a.type) - qualityScore(b.type));
            return sorted[0];
        }
        return { url: videoEntry.url || '', type: '原画', size: '' };
    }

    // ═══════════════════════════════════════════════════════════════
    //  截获 fetch — 捕获 /api/parse 响应
    // ═══════════════════════════════════════════════════════════════

    const origFetch = _unsafeWindow.fetch.bind(_unsafeWindow);
    let capturedParseResolve = null;

    _unsafeWindow.fetch = function(input, init) {
        const reqUrl = (typeof input === 'string' ? input : (input instanceof Request ? input.url : input && input.href)) || '';
        return origFetch(input, init).then(async response => {
            if (reqUrl.includes('/api/parse') && capturedParseResolve) {
                try {
                    const clone = response.clone();
                    const body = await clone.json();
                    if (body && body.encrypt) {
                        capturedParseResolve(body);
                        capturedParseResolve = null;
                    }
                } catch (_) {}
            }
            return response;
        });
    };

    function waitParseResponse(timeout = 35000) {
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => { capturedParseResolve = null; reject(new Error('解析超时')); }, timeout);
            capturedParseResolve = data => { clearTimeout(timer); resolve(data); };
        });
    }

    // ═══════════════════════════════════════════════════════════════
    //  从 React Fiber 取解密后数据
    // ═══════════════════════════════════════════════════════════════

    function findVideoState() {
        const root = document.querySelector('#__next') || document.querySelector('#root') || document.body;
        const key = Object.keys(root).find(k => k.startsWith('__reactFiber$') || k.startsWith('__reactInternalInstance$'));
        if (!key) return null;
        let found = null;
        (function walk(fiber) {
            if (!fiber || found) return;
            let hook = fiber.memoizedState;
            while (hook) {
                const st = hook.memoizedState;
                if (st && typeof st === 'object' && st.data && (st.data.videos || st.data.pics)) { found = st.data; return; }
                if (st && typeof st === 'object' && st.sourceUrl && st.data && (st.data.videos || st.data.pics)) { found = st.data; return; }
                hook = hook.next;
            }
            if (fiber.child) walk(fiber.child);
            if (fiber.sibling) walk(fiber.sibling);
        })(root[key]);
        return found;
    }

    // 备选：从页面 DOM 提取数据（当 React Fiber 找不到时）
    function extractFromDOM() {
        const result = { title: '', videos: [], pics: [] };

        // 找页面标题
        const titleEl = document.querySelector('h1, h2, h3, [class*="title"]');
        if (titleEl) result.title = titleEl.textContent.trim().substring(0, 200);

        // 找视频元素
        const videoEls = document.querySelectorAll('#__next video');
        videoEls.forEach(v => {
            if (v.src) result.videos.push({ url: v.src, video_fullinfo: [] });
        });
        // 也找 video source 标签
        document.querySelectorAll('#__next video source').forEach(s => {
            if (s.src) result.videos.push({ url: s.src, video_fullinfo: [] });
        });
        // 找下载按钮中的视频地址
        document.querySelectorAll('#__next a[href*=".mp4"], #__next a[href*="video/"]').forEach(a => {
            if (a.href) result.videos.push({ url: a.href, video_fullinfo: [] });
        });

        // 去重视频
        const seen = new Set();
        result.videos = result.videos.filter(v => { const k = v.url; return seen.has(k) ? false : seen.add(k); });

        // 找图片（排除图标/头像）
        document.querySelectorAll('#__next img[src*="http"]').forEach(img => {
            if (img.width < 80 && img.height < 80) return; // 跳过小图标
            if (img.src.includes('data:image')) return;
            if (img.closest('#ht-batch-panel')) return; // 跳过我们自己的面板
            result.pics.push(img.src);
        });

        if (result.videos.length > 0 || result.pics.length > 0) return result;
        return null;
    }

    // ═══════════════════════════════════════════════════════════════
    //  解析单条链接
    // ═══════════════════════════════════════════════════════════════

    async function parseOne(url, idx) {
        log(`[${idx+1}] 解析: ${url}`, 'info');
        // 重置捕获的解密数据，避免使用上一个 URL 的
        capturedDecryptedData = null;

        const input = document.querySelector('input[type="text"]');
        if (!input) throw new Error('找不到输入框');

        // 方法A：通过页面输入框提交（快速路径，因 React 状态问题只能覆盖 ~6/10）
        const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
        nativeSetter.call(input, url);
        input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: url }));
        await sleep(500);

        const submitBtn = document.querySelector('button[type="submit"]');
        if (!submitBtn) throw new Error('找不到解析按钮');
        submitBtn.click();

        await waitParseResponse();
        log(`[${idx+1}] 响应到达，等待页面渲染…`, 'info');

        let data = null;
        for (let retry = 0; retry < 12; retry++) {
            await sleep(1000);
            data = findVideoState();
            if (data && (data.videos || data.pics)) { log(`[${idx+1}] 从 React state 提取成功`, 'info'); break; }
            data = extractFromDOM();
            if (data && data.videos && data.videos.length > 0) { log(`[${idx+1}] 从页面 DOM 提取成功`, 'info'); break; }
            // 从 crypto 拦截的直接取解密数据
            if (capturedDecryptedData && (capturedDecryptedData.videos || capturedDecryptedData.pics)) {
                data = capturedDecryptedData;
                log(`[${idx+1}] 从 crypto 解密数据提取成功`, 'info');
                break;
            }
        }
        if (!data || (!data.videos && !data.pics)) {
            data = capturedDecryptedData;
        }
        if (!data || (!data.videos && !data.pics)) {
            throw new Error('在页面中未找到视频/图片数据');
        }

        // 如果从 DOM 提取的，构造标准格式
        if (!data.videos) data.videos = [];
        if (!data.pics) data.pics = data.pics || [];
        // 确保 videos 数组中每项都有完整的结构
        data.videos = data.videos.map(v => {
            if (typeof v === 'string') return { url: v, fullinfo: [] };
            if (v && v.url && !v.video_fullinfo) return { url: v.url, fullinfo: [] };
            return v;
        });

        const result = {
            url,
            title: data.title || `视频 ${idx+1}`,
            videos: [],
            pics: data.pics || [],
        };

        if (data.videos && data.videos.length > 0) {
            for (const v of data.videos) {
                const entry = {
                    url: (typeof v === 'string' ? v : v.url) || '',
                    fullinfo: [],
                };
                if (v.video_fullinfo && Array.isArray(v.video_fullinfo)) {
                    entry.fullinfo = v.video_fullinfo.map(fi => ({
                        url: fi.url,
                        type: fi.type || '',
                        size: fi.size || '',
                    }));
                }
                // 如果没有 fullinfo 但主 URL 存在，仍然保留
                result.videos.push(entry);
            }
        }

        log(`[${idx+1}] ✓ "${result.title}" — ${result.videos.length} 视频, ${result.pics.length} 图片`, 'success');
        // 下载状态追踪: null=未下载, true=成功, false=失败
        result.__dl = { v: new Array(result.videos.length).fill(null), p: new Array(result.pics.length).fill(null) };
        return result;
    }

    // ═══════════════════════════════════════════════════════════════
    //  下载
    // ═══════════════════════════════════════════════════════════════

    async function downloadOne(url, filename) {
        log('下载: ' + filename, 'info');
        // 方法1: fetch + blob（CORS 可用时优先），10s 超时
        try {
            const ac = typeof AbortController !== 'undefined' ? new AbortController() : null;
            const timer = ac ? setTimeout(() => ac.abort(), 10000) : null;
            const resp = await fetch(url, ac ? { signal: ac.signal } : {});
            if (timer) clearTimeout(timer);
            if (!resp.ok) throw new Error('HTTP ' + resp.status);
            const ct = resp.headers.get('content-type') || '';
            if (ct.includes('text/html') || ct.includes('application/json')) throw new Error('非文件响应');
            const blob = await resp.blob();
            const blobUrl = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = blobUrl; a.download = filename;
            document.body.appendChild(a); a.click();
            setTimeout(() => { document.body.removeChild(a); URL.revokeObjectURL(blobUrl); }, 1500);
            log('✓ ' + filename, 'success'); return true;
        } catch (e) {
            if (e.name === 'AbortError') log('fetch 超时', 'warning');
            else log('fetch 失败: ' + e.message, 'warning');
        }
        // 方法2: GM_download（移动端最可靠，绕过 CORS）
        if (typeof GM_download !== 'undefined') {
            try {
                await new Promise((resolve, reject) => {
                    GM_download({ url, name: filename, saveAs: false, onerror: reject, onload: resolve, ontimeout: reject, timeout: 60000 });
                });
                log('✓ ' + filename + ' (GM)', 'success'); return true;
            } catch (e) {
                log('GM_download 失败: ' + (e.message || e), 'warning');
            }
        }
        // 方法3: 隐藏 iframe（桌面备选）
        try {
            const iframe = document.createElement('iframe');
            iframe.style.display = 'none'; iframe.src = url;
            document.body.appendChild(iframe);
            log('→ ' + filename + ' (iframe)', 'info');
            setTimeout(() => { if (iframe.parentNode) iframe.remove(); }, 30000);
            return true;
        } catch (e2) {
            log('✗ 下载失败: ' + e2.message, 'error');
        }
        return false;
    }

    function sanitizeFilename(name) {
        // 限制文件名总长 <= 80
        return name.replace(/[<>:"/\\|?*]/g, '_').substring(0, 80) || 'download';
    }

    async function dlVideo(result, vi) {
        const v = result.videos[vi];
        if (!v) { toast('没有视频数据', 'error'); return; }
        const best = bestQuality(v);
        if (!best.url) { toast('没有视频地址', 'error'); return; }
        const selKey = result.url + ':v' + vi;
        const selFi = _selQuality[selKey];
        const target = selFi !== undefined && v.fullinfo && v.fullinfo[selFi] ? v.fullinfo[selFi] : best;
        const label = (target.type || 'best').replace(/[^a-zA-Z0-9\u4e00-\u9fff]/g, '');
        const fname = sanitizeFilename(`${result.title}_${label}.mp4`);
        const ok = await downloadOne(target.url, fname);
        if (result.__dl && result.__dl.v) result.__dl.v[vi] = ok;
        if (ok) render();
    }

    async function dlImage(result, pi) {
        const url = result.pics[pi];
        if (!url) { toast('没有图片地址', 'error'); return; }
        const ext = (url.match(/\.(jpg|jpeg|png|webp|gif|bmp)/i) || [])[1] || 'jpg';
        const fname = sanitizeFilename(`${result.title}_image_${pi+1}.${ext}`);
        const ok = await downloadOne(url, fname);
        if (result.__dl && result.__dl.p) result.__dl.p[pi] = ok;
        if (ok) render();
    }

    async function dlAll() {
        try {
            const items = S.results.filter(r => r.status === 'done');
            if (!items.length) { toast('没有已解析的项目', 'error'); return; }
            toast(`开始下载 ${items.length} 个项目…`, 'info');
            log(`dlAll: 共 ${items.length} 个项目`, 'info');
            let errCount = 0;
            for (let ri = 0; ri < items.length; ri++) {
                const r = items[ri];
                log(`dlAll: 项目 #${ri+1} "${(r.title||'').substring(0,30)}"`, 'info');
                toast(`[${ri+1}/${items.length}] ${(r.title||'').substring(0,20)}…`, 'info', 2000);
                // 防御性检查 videos
                const vids = Array.isArray(r.videos) ? r.videos : [];
                for (let vi = 0; vi < vids.length; vi++) {
                    try {
                        await dlVideo(r, vi);
                        await sleep(500);
                    } catch (e) { errCount++; log(`✗ 视频下载失败 #${ri+1}.${vi+1}: ${e.message}`, 'error'); }
                }
                // 防御性检查 pics
                const pics = Array.isArray(r.pics) ? r.pics : [];
                for (let pi = 0; pi < pics.length; pi++) {
                    try {
                        await dlImage(r, pi);
                        await sleep(300);
                    } catch (e) { errCount++; log(`✗ 图片下载失败 #${ri+1}.${pi+1}: ${e.message}`, 'error'); }
                }
            }
            if (errCount > 0) {
                toast(`下载完成，${errCount} 个失败（详见日志）`, 'warning');
            } else {
                toast('全部下载完成！', 'success');
            }
        } catch (e) {
            log('dlAll 意外崩溃: ' + (e.message || e), 'error');
            toast('批量下载意外中断: ' + (e.message || '未知错误'), 'error');
        }
    }

    // ═══════════════════════════════════════════════════════════════
    //  解密密钥捕获 — 从页面 JS 中拦截 Web Crypto API
    // ═══════════════════════════════════════════════════════════════

    let capturedDecryptedData = null;  // 最新完整解密数据

    if (_unsafeWindow.crypto?.subtle?.decrypt) {
        const origDecrypt = _unsafeWindow.crypto.subtle.decrypt.bind(_unsafeWindow.crypto.subtle);
        _unsafeWindow.crypto.subtle.decrypt = function(algorithm, key, data) {
            const result = origDecrypt(algorithm, key, data);
            result.then(decrypted => {
                try {
                    capturedDecryptedData = JSON.parse(new TextDecoder().decode(decrypted));
                } catch (_) {}
            }).catch(() => {});
            return result;
        };
    }

    // ═══════════════════════════════════════════════════════════════
    //  批量解析
    // ═══════════════════════════════════════════════════════════════

    const S = { results: [], isProcessing: false, drag: { x: 0, y: 0 } };
    _unsafeWindow.S = S;
    // 已选择的画质：_selQuality["url:v0"] = 0（fullinfo 索引）
    const _selQuality = {};

    async function batchParse(rawText) {
        if (S.isProcessing) { toast('正在处理…', 'warning'); return; }
        const urls = [...new Set(extractDouyinUrls(rawText))];
        if (!urls.length) { toast('未找到有效的抖音链接', 'error'); return; }

        S.isProcessing = true;
        S.results = urls.map(u => ({ url: u, title: '等待解析…', videos: [], pics: [], status: 'pending' }));
        render();

        for (let i = 0; i < urls.length; i++) {
            S.results[i].status = 'parsing';
            S.results[i].title = '解析中…';
            render();
            try {
                const d = await parseOne(urls[i], i);
                S.results[i] = { ...d, status: 'done' };
            } catch (e) {
                S.results[i] = { url: urls[i], title: '解析失败', videos: [], pics: [], status: 'error', error: e.message };
                log(`✗ ${e.message}`, 'error');
            }
            render();
            await sleep(500);
        }

        S.isProcessing = false;
        render();
        const ok = S.results.filter(r => r.status === 'done').length;
        toast(`完成: ${ok}/${urls.length} 个成功`, ok > 0 ? 'success' : 'error');
    }

    // ═══════════════════════════════════════════════════════════════
    //  UI
    // ═══════════════════════════════════════════════════════════════

    function render() {
        const body = document.querySelector('#ht-batch-body');
        if (!body) return;

        const done = S.results.filter(r => r.status === 'done').length;
        const total = S.results.length;

        let itemsHtml = '';
        for (let i = 0; i < total; i++) {
            const r = S.results[i];
            const cls = r.status === 'done' ? 'done' : r.status === 'error' ? 'error' : r.status === 'parsing' ? 'parsing' : 'pending';
            const fileCount = r.status === 'done' ? ((r.videos ? r.videos.length : 0) + (r.pics ? r.pics.length : 0)) : 0;
            const txt = r.status === 'done' ? ('✓ 已完成 (' + fileCount + ' 个文件)') : r.status === 'error' ? '✗ ' + (r.error || '失败') : r.status === 'parsing' ? '⟳ 解析中…' : '⏳ 等待';
            if (r._mediaExp === undefined) r._mediaExp = false;

            let extras = '';
            if (r.status === 'done') {
                extras = '<div style="margin-top:8px;border-top:1px solid ' + COLORS.border + ';padding-top:8px;">';

                // ── 视频 ──
                if (r.videos.length) {
                    const maxV = r._mediaExp ? r.videos.length : Math.min(3, r.videos.length);
                    for (let vi = 0; vi < maxV; vi++) {
                        const v = r.videos[vi];
                        const best = bestQuality(v);
                        const selKey = r.url + ':v' + vi;
                        const selFi = _selQuality[selKey];
                        const isSelected = (selFi !== undefined);
                        let curLabel = '最高画质';
                        if (isSelected && v.fullinfo && v.fullinfo[selFi]) {
                            curLabel = v.fullinfo[selFi].type || '画质' + (selFi+1);
                        }
                        let qHtml = '';
                        if (v.fullinfo && v.fullinfo.length) {
                            const bestUrl = best.url;
                            qHtml = v.fullinfo.map((fi, fiIdx) => {
                                const isActive = isSelected ? (fiIdx === selFi) : (fi.url === bestUrl);
                                return `<div class="ht-quality-option${isActive ? ' selected' : ''}" data-dl-vq="${i},${vi},${fiIdx}" style="cursor:pointer">` +
                                    `<span class="ht-qlabel">${fi.type || '原画'}</span>` +
                                    `<span class="ht-qsize">${fi.size || ''}</span>` +
                                    '</div>';
                            }).join('');
                        }
                        const btnLabel = isSelected ? ('⬇ 下载视频（' + curLabel + '）') : '⬇ 下载视频（最高画质）';
                        const dlSt = r.__dl && r.__dl.v ? r.__dl.v[vi] : null;
                        const stHtml = dlSt === true ? '<span style="color:#10b981;font-size:11px;margin-left:6px;">✓ 已下载</span>'
                            : dlSt === false ? '<span style="color:#ef4444;font-size:11px;margin-left:6px;">✗ 下载失败</span>'
                            : '';
                        extras += '<div class="ht-video-entry" style="margin-bottom:8px;">' +
                            '<div style="font-size:12px;font-weight:500;margin:2px 0;">视频' + (vi+1) + '</div>' +
                            qHtml +
                            '<div style="display:flex;align-items:center;margin-top:4px;">' +
                                '<button class="ht-btn ht-btn-primary ht-btn-sm" data-dl-v="' + i + ',' + vi + '">' + btnLabel + '</button>' +
                                stHtml +
                            '</div>' +
                        '</div>';
                    }
                    if (r.videos.length > 3) {
                        extras += '<div style="text-align:center;margin:4px 0;">' +
                            '<button class="ht-btn ht-btn-sm ht-btn-outline" data-ht-exp="' + i + '" style="font-size:11px;">' +
                            (r._mediaExp ? '▲ 收起视频' : '▼ 展开全部 ' + r.videos.length + ' 个视频') +
                            '</button></div>';
                    }
                }

                // ── 图片 ──
                if (r.pics && r.pics.length) {
                    extras += '<div style="margin-top:4px;">' +
                        '<div style="font-size:12px;font-weight:500;margin:2px 0;">图片 (' + r.pics.length + ' 张)</div>';
                    const maxP = r._mediaExp ? r.pics.length : Math.min(3, r.pics.length);
                    for (let pi = 0; pi < maxP; pi++) {
                        const dlSt = r.__dl && r.__dl.p ? r.__dl.p[pi] : null;
                        const stHtml = dlSt === true ? '<span style="color:#10b981;font-size:11px;">✓</span>'
                            : dlSt === false ? '<span style="color:#ef4444;font-size:11px;">✗</span>'
                            : '';
                        extras += '<div style="display:flex;align-items:center;gap:6px;margin:4px 0;">' +
                            '<img src="' + r.pics[pi] + '" style="width:36px;height:36px;object-fit:cover;border-radius:4px;flex-shrink:0;" onerror="this.style.display=\'none\'">' +
                            '<span style="font-size:11px;color:' + COLORS.textLight + ';flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">图片 ' + (pi+1) + '</span>' +
                            '<button class="ht-btn ht-btn-outline ht-btn-sm" data-dl-p="' + i + ',' + pi + '" style="flex-shrink:0;">下载</button>' +
                            stHtml +
                        '</div>';
                    }
                    if (r.pics.length > 3) {
                        extras += '<div style="text-align:center;margin:4px 0;">' +
                            '<button class="ht-btn ht-btn-sm ht-btn-outline" data-ht-exp="' + i + '" style="font-size:11px;">' +
                            (r._mediaExp ? '▲ 收起图片' : '▼ 展开全部 ' + r.pics.length + ' 张图片') +
                            '</button></div>';
                    }
                    extras += '</div>';
                }

                extras += '</div>';
            }

            itemsHtml +=
                '<div class="ht-result-item">' +
                    '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:4px;">' +
                        '<span class="ht-status-badge ' + cls + '">' + txt + '</span>' +
                        '<div style="display:flex;align-items:center;gap:6px;">' +
                            '<button class="ht-btn ht-btn-sm" data-ht-del="' + i + '" style="font-size:10px;padding:1px 6px;color:#ef4444;border:1px solid #fca5a5;border-radius:6px;background:transparent;cursor:pointer;">✕ 删除</button>' +
                            '<span style="font-size:11px;color:' + COLORS.textLight + ';">#' + (i+1) + '</span>' +
                        '</div>' +
                    '</div>' +
                    '<div class="ht-result-title">' + (r.title || r.url || '链接 ' + (i+1)) + '</div>' +
                    '<div class="ht-result-meta">' +
                        r.videos.length + ' 视频' +
                        (r.pics && r.pics.length ? ', ' + r.pics.length + ' 图片' : '') +
                    '</div>' +
                    extras +
                '</div>';
        }

        body.innerHTML =
            '<div style="margin-bottom:6px;display:flex;align-items:center;justify-content:space-between;">' +
                '<span style="font-size:12px;font-weight:500;color:' + COLORS.textLight + ';">粘贴抖音分享文本（自动提取链接）:</span>' +
                '<span style="font-size:11px;color:' + COLORS.textLight + ';">已提取 <strong id="ht-link-count">0</strong> 个链接</span>' +
            '</div>' +
            '<textarea id="ht-url-input" placeholder="直接粘贴抖音分享文本即可，会自动识别链接...&#10;&#10;如:&#10;4.15 复制打开抖音，看看【作者】的作品... https://v.douyin.com/xxxx/ :3pm ...&#10;5.82 画出属于我们的家... https://v.douyin.com/xxxx/ 复制此链接..."></textarea>' +
            '<div class="ht-toolbar">' +
                '<button class="ht-btn ht-btn-primary" id="ht-btn-start"' + (S.isProcessing ? ' disabled' : '') + '>' +
                    (S.isProcessing ? '⏳ 解析中…' : '🚀 从文本提取并解析') +
                '</button>' +
                '<button class="ht-btn ht-btn-success" id="ht-btn-dl-all"' + (done === 0 ? ' disabled' : '') + '>⬇ 下载全部</button>' +
                '<button class="ht-btn ht-btn-outline ht-btn-sm" id="ht-btn-clear">清空</button>' +
            '</div>' +
            (total ? '<div class="ht-progress"><div class="ht-progress-bar"><div class="ht-progress-fill" style="width:' + (done/total*100) + '%"></div></div><div class="ht-progress-text">' + done + '/' + total + ' 完成，共 ' + S.results.reduce((s,r) => s + r.videos.length + (r.pics ? r.pics.length : 0), 0) + ' 个文件</div></div>' : '') +
            '<div style="margin-top:10px;">' + itemsHtml + '</div>' +
            '<div class="ht-log" id="ht-log"></div>';

        logEl = body.querySelector('#ht-log');

        // ── 事件绑定 ──
        const ta = body.querySelector('#ht-url-input');
        const cnt = body.querySelector('#ht-link-count');

        ta.addEventListener('input', () => {
            const links = extractDouyinUrls(ta.value);
            if (cnt) cnt.textContent = links.length;
        });

        body.querySelector('#ht-btn-start').onclick = () => batchParse(ta.value);
        body.querySelector('#ht-btn-dl-all').onclick = dlAll;
        body.querySelector('#ht-btn-clear').onclick = () => {
            S.results = []; ta.value = '';
            if (cnt) cnt.textContent = '0';
            if (logEl) logEl.innerHTML = '';
            render();
        };
        ta.addEventListener('keydown', e => {
            if (e.ctrlKey && e.key === 'Enter') { e.preventDefault(); batchParse(ta.value); }
        });

        // ── 事件委托（仅绑定一次） ──
        if (!body._htInit) {
            body._htInit = true;

            // 画质选择
            body.addEventListener('click', (e) => {
                const qOpt = e.target.closest('[data-dl-vq]');
                if (qOpt) {
                    const [ri, vi, fi] = qOpt.getAttribute('data-dl-vq').split(',').map(Number);
                    const r = S.results[ri];
                    if (!r || !r.videos[vi] || !r.videos[vi].fullinfo) return;
                    const selKey = r.url + ':v' + vi;
                    if (_selQuality[selKey] === fi) delete _selQuality[selKey];
                    else _selQuality[selKey] = fi;
                    const parent = qOpt.closest('.ht-video-entry');
                    if (parent) {
                        parent.querySelectorAll('[data-dl-vq]').forEach(el => {
                            el.classList.toggle('selected', parseInt(el.getAttribute('data-dl-vq').split(',')[2]) === _selQuality[selKey]);
                        });
                        const btn = parent.querySelector('[data-dl-v]');
                        if (btn) {
                            const curFi = _selQuality[selKey];
                            btn.textContent = curFi !== undefined && r.videos[vi].fullinfo[curFi]
                                ? '⬇ 下载视频（' + r.videos[vi].fullinfo[curFi].type + '）'
                                : '⬇ 下载视频（最高画质）';
                        }
                    }
                    return;
                }

                // 删除按钮
                const delBtn = e.target.closest('[data-ht-del]');
                if (delBtn) {
                    const ri = parseInt(delBtn.getAttribute('data-ht-del'));
                    S.results.splice(ri, 1);
                    render();
                    return;
                }

                // 展开/收起项目内媒体
                const expBtn = e.target.closest('[data-ht-exp]');
                if (expBtn) {
                    const ri = parseInt(expBtn.getAttribute('data-ht-exp'));
                    const r = S.results[ri];
                    if (r) { r._mediaExp = !r._mediaExp; render(); }
                    return;
                }
            });
        }

        // ── 下载按钮 ──
        body.querySelectorAll('[data-dl-v]').forEach(el => {
            el.onclick = () => {
                const [ri, vi] = el.getAttribute('data-dl-v').split(',').map(Number);
                if (S.results[ri]) dlVideo(S.results[ri], vi);
            };
        });
        body.querySelectorAll('[data-dl-p]').forEach(el => {
            el.onclick = () => {
                const [ri, pi] = el.getAttribute('data-dl-p').split(',').map(Number);
                if (S.results[ri]) dlImage(S.results[ri], pi);
            };
        });
    }

    // ═══════════════════════════════════════════════════════════════
    //  面板
    // ═══════════════════════════════════════════════════════════════

    function createPanel() {
        if (document.querySelector('#ht-batch-panel')) return;
        const panel = document.createElement('div');
        panel.id = 'ht-batch-panel';
        panel.innerHTML =
            '<div id="ht-batch-header">' +
                '<h3>🎬 抖音批量解析下载</h3>' +
                '<div style="display:flex;gap:4px;">' +
                    '<button class="ht-header-btn" id="ht-minimize">─</button>' +
                    '<button class="ht-header-btn" id="ht-close">✕</button>' +
                '</div>' +
            '</div>' +
            '<div id="ht-batch-body"></div>';
        document.body.appendChild(panel);

        const hdr = panel.querySelector('#ht-batch-header');
        hdr.addEventListener('mousedown', e => {
            if (e.target.tagName === 'BUTTON') return;
            const rect = panel.getBoundingClientRect();
            S.drag = { x: e.clientX - rect.left, y: e.clientY - rect.top };
            const m = e => { panel.style.left = (e.clientX - S.drag.x) + 'px'; panel.style.top = (e.clientY - S.drag.y) + 'px'; panel.style.right = 'auto'; };
            const u = () => { document.removeEventListener('mousemove', m); document.removeEventListener('mouseup', u); };
            document.addEventListener('mousemove', m);
            document.addEventListener('mouseup', u);
        });

        panel.querySelector('#ht-minimize').onclick = () => {
            panel.remove();
            const reopen = document.createElement('button');
            reopen.textContent = '🎬';
            Object.assign(reopen.style, {
                position: 'fixed', bottom: '24px', right: '20px', zIndex: '999998',
                width: '48px', height: '48px', background: '#000', color: '#fff',
                border: 'none', borderRadius: '50%', fontSize: '20px', cursor: 'pointer',
                boxShadow: '0 4px 16px rgba(0,0,0,0.25)',
            });
            reopen.onmouseenter = () => { reopen.style.transform = 'scale(1.1)'; };
            reopen.onmouseleave = () => { reopen.style.transform = ''; };
            reopen.onclick = () => { reopen.remove(); createPanel(); };
            document.body.appendChild(reopen);
        };
        panel.querySelector('#ht-close').onclick = () => panel.remove();

        render();
        log('批量解析器就绪 ✓', 'info');
        log('直接粘贴分享文本（含链接和文字），自动识别链接', 'info');
        log('支持视频 + 图片下载，Ctrl+Enter 快速提交', 'info');
    }

    // ═══════════════════════════════════════════════════════════════
    //  样式
    // ═══════════════════════════════════════════════════════════════

    _GM_addStyle(`
        #ht-batch-panel {
            position: fixed; top: 80px; right: 20px;
            width: 460px; max-height: calc(100vh - 120px);
            background: ${COLORS.bg};
            border: 1px solid ${COLORS.border};
            border-radius: 16px;
            box-shadow: 0 20px 60px rgba(0,0,0,0.15);
            z-index: 999999;
            display: flex; flex-direction: column;
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            font-size: 14px; color: ${COLORS.text};
            overflow: hidden;
        }
        #ht-batch-header {
            display: flex; align-items: center; justify-content: space-between;
            padding: 12px 16px; background: ${COLORS.primary}; color: white;
            cursor: move; user-select: none; flex-shrink: 0;
        }
        #ht-batch-header h3 { margin: 0; font-size: 15px; font-weight: 600; }
        .ht-header-btn {
            background: rgba(255,255,255,0.2); border: none; color: white;
            width: 28px; height: 28px; border-radius: 8px; cursor: pointer;
            display: inline-flex; align-items: center; justify-content: center;
            font-size: 16px; transition: background 0.2s;
        }
        .ht-header-btn:hover { background: rgba(255,255,255,0.35); }
        #ht-batch-body { padding: 16px; overflow-y: auto; flex: 1; }
        #ht-url-input {
            width: 100%; height: 110px; padding: 10px 12px;
            border: 1px solid ${COLORS.border}; border-radius: 10px;
            font-size: 13px; font-family: inherit; resize: vertical;
            box-sizing: border-box; outline: none;
        }
        #ht-url-input:focus { border-color: ${COLORS.primary}; box-shadow: 0 0 0 3px rgba(0,0,0,0.08); }
        .ht-btn {
            display: inline-flex; align-items: center; justify-content: center; gap: 4px;
            padding: 8px 16px; border: none; border-radius: 10px;
            font-size: 13px; font-weight: 500; cursor: pointer;
            transition: all 0.2s; white-space: nowrap;
        }
        .ht-btn:disabled { opacity: 0.5; cursor: not-allowed; }
        .ht-btn-primary { background: ${COLORS.primary}; color: white; }
        .ht-btn-primary:hover:not(:disabled) { background: ${COLORS.primaryHover}; }
        .ht-btn-success { background: ${COLORS.success}; color: white; }
        .ht-btn-success:hover:not(:disabled) { background: #059669; }
        .ht-btn-sm { padding: 4px 10px; font-size: 12px; border-radius: 6px; }
        .ht-btn-outline { background: transparent; border: 1px solid ${COLORS.border}; color: ${COLORS.text}; }
        .ht-btn-outline:hover { background: ${COLORS.bgDark}; }
        .ht-toolbar { display: flex; gap: 8px; margin-top: 10px; flex-wrap: wrap; }
        .ht-progress { margin-top: 12px; }
        .ht-progress-bar { height: 4px; background: ${COLORS.border}; border-radius: 2px; overflow: hidden; }
        .ht-progress-fill { height: 100%; background: ${COLORS.primary}; border-radius: 2px; transition: width 0.5s ease; }
        .ht-progress-text { font-size: 12px; color: ${COLORS.textLight}; margin-top: 4px; }
        .ht-result-item {
            border: 1px solid ${COLORS.border}; border-radius: 10px;
            padding: 12px; margin-top: 10px; background: ${COLORS.bgDark};
        }
        .ht-result-title {
            font-weight: 600; font-size: 13px;
            display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical;
            overflow: hidden; margin-bottom: 4px;
        }
        .ht-result-meta { font-size: 12px; color: ${COLORS.textLight}; }
        .ht-status-badge { display: inline-block; padding: 2px 8px; border-radius: 10px; font-size: 11px; font-weight: 500; }
        .ht-status-badge.pending { background: #fef3c7; color: #92400e; }
        .ht-status-badge.parsing { background: #dbeafe; color: #1e40af; }
        .ht-status-badge.done    { background: #d1fae5; color: #065f46; }
        .ht-status-badge.error   { background: #fee2e2; color: #991b1b; }
        .ht-quality-option {
            display: flex; align-items: center; gap: 8px;
            padding: 4px 8px; margin: 3px 0; background: white;
            border: 1px solid ${COLORS.border}; border-radius: 6px;
            font-size: 12px;
        }
        .ht-quality-option.selected { border-color: ${COLORS.primary}; background: #f1f5f9; }
        .ht-qlabel { font-weight: 500; }
        .ht-qsize { color: ${COLORS.textLight}; margin-left: auto; }
        .ht-log {
            margin-top: 8px; padding: 8px;
            background: #1e293b; color: #e2e8f0;
            border-radius: 8px; font-size: 11px;
            font-family: 'Courier New', monospace;
            max-height: 120px; overflow-y: auto;
            white-space: pre-wrap; word-break: break-all;
        }
        .ht-log .info    { color: #60a5fa; }
        .ht-log .success { color: #34d399; }
        .ht-log .error   { color: #f87171; }
        .ht-log .warning { color: #fbbf24; }
        .ht-toast {
            position: fixed; bottom: 20px; right: 20px;
            padding: 12px 20px; border-radius: 10px; color: white;
            font-size: 13px; font-weight: 500; z-index: 1000000;
            animation: ht-slide-up 0.3s ease;
            box-shadow: 0 4px 12px rgba(0,0,0,0.15);
        }
        .ht-toast.success { background: ${COLORS.success}; }
        .ht-toast.error   { background: ${COLORS.danger}; }
        .ht-toast.info    { background: ${COLORS.primary}; }
        @keyframes ht-slide-up { from { transform: translateY(20px); opacity: 0; } to { transform: translateY(0); opacity: 1; } }
        @media (max-width: 768px) {
            #ht-batch-panel { top: 0; bottom: 0; left: 0; right: 0; width: 100%; max-height: 100vh; border-radius: 0; }
            #ht-batch-header { padding: 10px 14px; }
            #ht-batch-header h3 { font-size: 14px; }
            #ht-batch-body { padding: 12px; }
            #ht-url-input { height: 80px; font-size: 14px; }
            .ht-btn { padding: 10px 14px; font-size: 14px; }
            .ht-btn-sm { padding: 6px 10px; font-size: 13px; }
            #ht-log { max-height: 80px; font-size: 12px; }
        }
    `);

    // ═══════════════════════════════════════════════════════════════
    //  启动
    // ═══════════════════════════════════════════════════════════════

    function init() {
        if (location.pathname.includes('/douyin')) {
            setTimeout(createPanel, 1200);
        } else {
            const btn = document.createElement('button');
            btn.textContent = '🎬 批量解析下载';
            Object.assign(btn.style, {
                position: 'fixed', top: '80px', right: '20px', zIndex: '999998',
                padding: '10px 20px', background: '#000', color: '#fff',
                border: 'none', borderRadius: '12px', fontSize: '14px',
                fontWeight: '600', cursor: 'pointer',
                boxShadow: '0 4px 12px rgba(0,0,0,0.2)',
            });
            btn.onmouseenter = () => { btn.style.transform = 'translateY(-2px)'; btn.style.boxShadow = '0 6px 20px rgba(0,0,0,0.25)'; };
            btn.onmouseleave = () => { btn.style.transform = ''; btn.style.boxShadow = '0 4px 12px rgba(0,0,0,0.2)'; };
            btn.onclick = () => { if (document.querySelector('#ht-batch-panel')) document.querySelector('#ht-batch-panel').remove(); else createPanel(); btn.remove(); };
            setTimeout(() => { if (!document.querySelector('#ht-batch-panel')) document.body.appendChild(btn); }, 1500);
        }
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
    else init();

})();
