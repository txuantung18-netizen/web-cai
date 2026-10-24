// ==UserScript==
// @name         Trợ lý học tập - IOE / VioEdu / Violympic
// @namespace    https://ioe.vn/
// @version      10.2.7
// @description  Screenshot and paste images, transcribe with Groq Vision, chat, and scrape questions
// @updateURL    https://raw.githubusercontent.com/txuantung18-netizen/web-cai/main/hey_guys.user.js
// @downloadURL  https://raw.githubusercontent.com/txuantung18-netizen/web-cai/main/hey_guys.user.js
// @match        *://ioe.vn/*
// @match        *://*.ioe.vn/*
// @match        *://vio.edu.vn/*
// @match        *://*.vio.edu.vn/*
// @match        *://violympic.vn/*
// @match        *://*.violympic.vn/*
// @require      https://cdnjs.cloudflare.com/ajax/libs/html2canvas/1.4.1/html2canvas.min.js
// @require      https://cdn.jsdelivr.net/npm/katex@0.16.9/dist/katex.min.js
// @require      https://cdn.jsdelivr.net/npm/katex@0.16.9/dist/contrib/auto-render.min.js
// @run-at       document-idle
// @noframes
// @grant        none
// ==/UserScript==

(function () {
    'use strict';

    if (window.__IOE_AI_V10__) return;
    window.__IOE_AI_V10__ = true;

    console.log('[IOE AI V10.1] Script bắt đầu load...');

    const BACKEND_URL = 'https://api-groq-two.vercel.app';
    const TOKEN_KEY = 'ioe_ai_auth_token';
    const AUTH_LOCK_KEY = 'ioe_ai_auth_lock_until';
    const AUTH_LOCK_MS = 24 * 60 * 60 * 1000;

    const MODELS = [
        ['openai/gpt-oss-120b', 'GPT-OSS 120B'],
        ['qwen/qwen3.8-27b', 'Qwen 3.8 27B'],
        ['openai/gpt-oss-20b', 'GPT-OSS 20B'],
    ];
    // Keep the dropdown order unchanged, but use Qwen as the initial model.
    const DEFAULT_MODEL = 'qwen/qwen3.8-27b';
    const MULTI_AGENT_DAILY_LIMIT = 3;
    const CHAT_HISTORY_KEY = 'ioeai_chat_history_v1';
    const CHAT_HISTORY_MAX = 40;
    const CHAT_CONTEXT_MAX = 10;
    const VISION_MODELS = [
        ['qwen/qwen3.8-27b', 'Qwen 3.8 27B Vision'],
    ];

    const SYSTEM_PROMPT = "You are a careful study assistant. Identify the subject and follow the language and instructions of the question: for English exercises, answer in natural English; for Vietnamese questions, answer in Vietnamese. Give the answer first, then a brief explanation appropriate to the subject. Do not assume every question is mathematics. For math only, use LaTeX for all expressions and geometry notation, with \\(...\\) inline and \\[...\\] for display equations. Never split words or labels into separate lines.";

    const PROMPT = "Answer the question below according to its subject and the language of its instructions. Give the answer first, then a brief explanation:";

    const wait = ms => new Promise(r => setTimeout(r, ms));

    // ═══════════════════════════════════════════════════════════════
    // TOKEN HELPERS
    // ═══════════════════════════════════════════════════════════════
    function getToken() {
        try { return localStorage.getItem(TOKEN_KEY) || ''; } catch (_) { return ''; }
    }
    function setToken(t) {
        try { localStorage.setItem(TOKEN_KEY, t); } catch (_) {}
    }
    function clearToken() {
        try { localStorage.removeItem(TOKEN_KEY); } catch (_) {}
    }
    function isTokenValid(token) {
        if (!token || typeof token !== 'string') return false;
        const parts = token.split('.');
        if (parts.length !== 2) return false;
        try {
            let p = parts[0].replace(/-/g, '+').replace(/_/g, '/');
            while (p.length % 4) p += '=';
            const payload = JSON.parse(atob(p));
            return payload.exp && (payload.exp * 1000) > (Date.now() + 60000);
        } catch (_) { return false; }
    }

    // ═══════════════════════════════════════════════════════════════
    // STORAGE HELPERS
    // ═══════════════════════════════════════════════════════════════
    function readFlag(k, d) { try { return localStorage.getItem(k) === '1'; } catch (_) { return d; } }
    function writeFlag(k, v) { try { localStorage.setItem(k, v ? '1' : '0'); } catch (_) {} }
    function loadChatHistory() {
        try {
            const saved = JSON.parse(localStorage.getItem(CHAT_HISTORY_KEY) || '[]');
            if (!Array.isArray(saved)) return [];
            return saved.filter(m => m && ['user', 'assistant'].includes(m.role) && typeof m.content === 'string').slice(-CHAT_HISTORY_MAX);
        } catch (_) { return []; }
    }
    function saveChatHistory(items) {
        try { localStorage.setItem(CHAT_HISTORY_KEY, JSON.stringify(items.slice(-CHAT_HISTORY_MAX))); } catch (_) {}
    }
    function multiAgentUsageKey() { return 'ioeai_multi_agent_uses_' + new Date().toISOString().slice(0, 10); }
    function multiAgentUsageCount() { try { return Number(localStorage.getItem(multiAgentUsageKey())) || 0; } catch (_) { return 0; } }
    function recordMultiAgentUse() { try { localStorage.setItem(multiAgentUsageKey(), String(multiAgentUsageCount() + 1)); } catch (_) {} }

    const KATEX_OPTS = {
        delimiters: [
            { left: '$$', right: '$$', display: true },
            { left: '\\[', right: '\\]', display: true },
            { left: '$', right: '$', display: false },
            { left: '\\(', right: '\\)', display: false }
        ],
        throwOnError: false, errorColor: '#cc0000', strict: false,
        ignoredTags: ['script', 'noscript', 'style', 'textarea', 'pre', 'code']
    };

    function renderMath(el) {
        if (typeof renderMathInElement !== 'function') {
            renderMathFallback(el);
            return;
        }
        // Auto-rendering the whole message at once lets one malformed formula
        // abort rendering every formula that follows it. Isolate paragraphs and
        // list/table cells so a bad expression cannot hide the rest of the math.
        const chunks = el.querySelectorAll('p, li, td, th, h1, h2, h3, h4, h5, h6, blockquote');
        if (!chunks.length) {
            try { renderMathInElement(el, KATEX_OPTS); } catch (_) { renderMathFallback(el); }
            renderMathFallback(el);
            return;
        }
        chunks.forEach(chunk => {
            try { renderMathInElement(chunk, KATEX_OPTS); } catch (_) { renderMathFallback(chunk); }
            // Catch formulas auto-render left untouched, while skipping formulas
            // already converted into KaTeX markup.
            renderMathFallback(chunk);
        });
    }

    function renderMathFallback(root) {
        if (typeof katex === 'undefined' || typeof katex.renderToString !== 'function') return;
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
        const nodes = [];
        while (walker.nextNode()) {
            const node = walker.currentNode;
            if (!node.nodeValue || !/\\\[|\\\(|\$\$|\$[^$\n]+\$/.test(node.nodeValue)) continue;
            if (node.parentElement && node.parentElement.closest('pre, code, textarea, script, style, .katex')) continue;
            nodes.push(node);
        }
        const delimiter = /\\\[([\s\S]+?)\\\]|\\\(([\s\S]+?)\\\)|\$\$([\s\S]+?)\$\$|\$([^$\n]+)\$/g;
        nodes.forEach(node => {
            const source = node.nodeValue;
            delimiter.lastIndex = 0;
            let match, cursor = 0, found = false;
            const fragment = document.createDocumentFragment();
            while ((match = delimiter.exec(source))) {
                found = true;
                if (match.index > cursor) fragment.appendChild(document.createTextNode(source.slice(cursor, match.index)));
                const displayMode = match[1] !== undefined || match[3] !== undefined;
                const latex = match[1] ?? match[2] ?? match[3] ?? match[4];
                const span = document.createElement('span');
                try {
                    span.innerHTML = katex.renderToString(latex.trim(), { ...KATEX_OPTS, displayMode, output: 'html' });
                    fragment.appendChild(span);
                } catch (_) {
                    fragment.appendChild(document.createTextNode(match[0]));
                }
                cursor = delimiter.lastIndex;
            }
            if (found) {
                if (cursor < source.length) fragment.appendChild(document.createTextNode(source.slice(cursor)));
                node.parentNode.replaceChild(fragment, node);
            }
        });
    }

    // ═══════════════════════════════════════════════════════════════
    // SCRAPER (giữ nguyên)
    // ═══════════════════════════════════════════════════════════════
    const SCRAPER_SELECTORS = {
        questionBlocks: [
            '.panel.panel-question', '.panel-question',
            '[id^="MathjaxArea"] .panel-question', '.box--practice__content',
            '.panel-body-question',
            // New question-bank layout: the MathJax area itself is the question
            // container, with prompt and answer grid as sibling children.
            '.panel-question-bank', '[id^="MathjaxArea"][class*="panel-question-bank"]'
        ],
        questionText: [
            '.padding-question-text', '.panel-body-question .padding-question-text',
            '.panel-body-question', '.practice-question-text .panel-body',
            '.practice-question-text'
        ],
        questionHeader: ['.panel-heading', '._32e9b'],
        optionBlocks: [
            '.choice-answer-grid-2026 > div', '.answer-padding > div',
            '.specialAnswert', '.option', '.answer', '[class*="answer-item"]'
        ],
        optionText: ['._29Lfm', '._1b_g- ._29Lfm', '._1b_g-', 'p'],
        optionInput: [
            'input[name^="select_answer"]', 'input[name^="single-choice"]',
            'input._2tMXb', 'input[type="checkbox"]', 'input[type="radio"]'
        ],
        matchContainer: ['._3s8XY'],
        matchPrompt:    ['._36nqK > ._3wk9F > ._1-wBd', '._36nqK ._1-wBd', '._3wk9F ._1-wBd'],
        matchAnswer:    ['#sourceCtn ._3VAJB > .QVzBx', '._3VAJB > .QVzBx']
    };

    const MO_MAP = {
        '−': '-', '–': '-', '×': '\\times ', '÷': '\\div ', '·': '\\cdot ', '⋅': '\\cdot ',
        '≤': '\\le ', '≥': '\\ge ', '≠': '\\ne ', '±': '\\pm ', '∞': '\\infty ', '√': '\\sqrt ',
        '∑': '\\sum ', '∏': '\\prod ', '∫': '\\int ', 'π': '\\pi ', 'α': '\\alpha ', 'β': '\\beta ',
        'γ': '\\gamma ', 'δ': '\\delta ', 'θ': '\\theta ', 'λ': '\\lambda ', 'μ': '\\mu ',
        'σ': '\\sigma ', 'φ': '\\phi ', 'ω': '\\omega ', 'Δ': '\\Delta ', 'Ω': '\\Omega ',
        '∠': '\\angle ', '°': '^{\\circ}', '→': '\\to ', '←': '\\leftarrow ',
        '⇔': '\\Leftrightarrow ', '∈': '\\in ', '∉': '\\notin ', '⊂': '\\subset ',
        '⊆': '\\subseteq ', '∪': '\\cup ', '∩': '\\cap ', '∅': '\\emptyset ',
        '∀': '\\forall ', '∃': '\\exists '
    };

    function mathMLToLatex(node) {
        if (!node) return '';
        if (node.nodeType === 3) return node.textContent;
        if (node.nodeType !== 1) return '';
        const tag = (node.localName || '').toLowerCase();
        const all = () => Array.from(node.children).map(mathMLToLatex).join('');
        const child = (i) => mathMLToLatex(node.children[i]);
        switch (tag) {
            case 'math': case 'mrow': case 'mstyle': case 'mpadded':
            case 'merror': case 'mphantom': case 'menclose': case 'semantics':
            case 'mtable': case 'mtr': case 'mlabeledtr': case 'mtd':
                return all();
            case 'mi': case 'mn': case 'mtext': return node.textContent.trim();
            case 'mo': {
                const t = node.textContent.trim();
                if (!t) return ' ';
                return MO_MAP[t] !== undefined ? MO_MAP[t] : t;
            }
            case 'mspace': return '\\,';
            case 'mfrac': return `\\frac{${child(0)}}{${child(1)}}`;
            case 'msup': return `{${child(0)}}^{${child(1)}}`;
            case 'msub': return `{${child(0)}}_{${child(1)}}`;
            case 'msubsup': return `{${child(0)}}_{${child(1)}}^{${child(2)}}`;
            case 'msqrt': return `\\sqrt{${all()}}`;
            case 'mroot': return `\\sqrt[${child(1)}]{${child(0)}}`;
            case 'mover': return `\\overset{${child(1)}}{${child(0)}}`;
            case 'munder': return `\\underset{${child(1)}}{${child(0)}}`;
            case 'munderover': return `\\underset{${child(1)}}{\\overset{${child(2)}}{${child(0)}}}`;
            case 'annotation': return node.getAttribute('encoding') === 'application/x-tex' ? node.textContent : '';
            case 'annotation-xml': return '';
            default: return all();
        }
    }

    function extractLatexFromMathTex(el) {
        const mjxMath = el.querySelector('.mjx-math[aria-label]');
        if (mjxMath) {
            const lbl = mjxMath.getAttribute('aria-label');
            if (lbl && lbl.trim()) return lbl.trim();
        }
        const scripts = el.querySelectorAll('script[type="math/tex"], script[type="math/tex; mode=display"]');
        if (scripts.length) return Array.from(scripts).map(s => s.textContent.trim()).join(' ');
        const mathEls = el.querySelectorAll('math');
        if (mathEls.length) return Array.from(mathEls).map(m => mathMLToLatex(m).trim()).filter(Boolean).join(' ');
        if (!el.querySelector('mjx-container') && !el.querySelector('.mjx-chtml') &&
            !el.querySelector('.mjx-math') && !el.querySelector('.MathJax')) {
            return el.textContent.trim();
        }
        return el.innerText.trim();
    }

    function textWithMath(container, excludeSelectors) {
        if (!container) return '';
        const clone = container.cloneNode(true);
        if (excludeSelectors && excludeSelectors.length) {
            excludeSelectors.forEach(sel => {
                clone.querySelectorAll(sel).forEach(el => el.remove());
            });
        }
        clone.querySelectorAll('.math-tex').forEach(el => {
            const latex = extractLatexFromMathTex(el);
            if (latex) el.replaceWith(document.createTextNode(` $${latex}$ `));
        });
        clone.querySelectorAll('.display-inlineblock-select').forEach(el => {
            if (el.querySelector('.Select, select')) el.replaceWith(document.createTextNode(' [Chọn] '));
        });
        clone.querySelectorAll('.display-inlinegrid').forEach(el => {
            if (el.querySelector('input')) el.replaceWith(document.createTextNode(' [___] '));
        });
        const hidden = document.createElement('div');
        hidden.style.cssText = 'position:absolute;left:-9999px;top:-9999px;white-space:pre-wrap;';
        hidden.appendChild(clone);
        document.body.appendChild(hidden);
        let text = hidden.innerText || hidden.textContent || '';
        document.body.removeChild(hidden);
        return text.replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
    }

    function queryFirstIn(parent, selectors) {
        for (const sel of selectors) {
            const el = parent.querySelector(sel);
            if (el && (el.innerText || '').trim()) return el;
        }
        return null;
    }
    function queryAllIn(parent, selectors) {
        for (const sel of selectors) {
            const els = parent.querySelectorAll(sel);
            if (els.length) return Array.from(els);
        }
        return [];
    }
    function detectMatching(block) {
        if (block.querySelector('._3s8XY')) return true;
        return !!(block.querySelector('._3wk9F') && block.querySelector('._3VAJB'));
    }

    function scrapeQuestions(region) {
        const results = [];
        const seen = new Set();
        const blocks = document.querySelectorAll(SCRAPER_SELECTORS.questionBlocks.join(','));
        if (!blocks.length) return results;

        blocks.forEach((block, idx) => {
            if (block.parentElement && block.parentElement.closest('.panel-question, .panel-body-question, .box--practice__content, .panel-question-bank')) return;
            if (region) {
                const br = block.getBoundingClientRect();
                const intersects = !(br.right < region.x || br.left > region.x + region.w ||
                                     br.bottom < region.y || br.top > region.y + region.h);
                if (!intersects) return;
            }
            const headerEl = queryFirstIn(block, SCRAPER_SELECTORS.questionHeader);
            let number = idx + 1;
            if (headerEl) {
                const m = headerEl.textContent.match(/Câu\s*hỏi\s*số\s*(\d+)/i);
                if (m) number = parseInt(m[1], 10);
            }
            const qEl = queryFirstIn(block, SCRAPER_SELECTORS.questionText);
            if (!qEl) return;
            const isMatching = detectMatching(block);
            const questionText = isMatching
                ? textWithMath(qEl, ['._3s8XY', '._2kMZ3', '#sourceCtn'])
                : textWithMath(qEl);
            if (!questionText) return;
            const sig = `${number}::${questionText}`;
            if (seen.has(sig)) return;
            seen.add(sig);

            if (isMatching) {
                const promptEls = queryAllIn(block, SCRAPER_SELECTORS.matchPrompt);
                const prompts = promptEls.map(el => textWithMath(el)).filter(Boolean);
                const answerEls = queryAllIn(block, SCRAPER_SELECTORS.matchAnswer);
                const options = answerEls.map(el => ({ id: '', text: textWithMath(el) })).filter(o => o.text);
                if (prompts.length >= 1 && options.length >= 2) {
                    results.push({ index: number, question: questionText, type: 'matching', prompts, options, correct: '' });
                    return;
                }
            }

            const optionEls = queryAllIn(block, SCRAPER_SELECTORS.optionBlocks);
            const options = [];
            const typeSet = new Set();
            optionEls.forEach(optEl => {
                const tEl = queryFirstIn(optEl, SCRAPER_SELECTORS.optionText);
                const text = tEl ? textWithMath(tEl) : '';
                if (!text) return;
                const input = optEl.querySelector(SCRAPER_SELECTORS.optionInput.join(','));
                const id = input ? (input.value || '') : '';
                if (input && (input.type === 'checkbox' || input.type === 'radio')) typeSet.add(input.type);
                options.push({ id, text });
            });
            if (options.length >= 2) {
                const type = typeSet.has('checkbox') ? 'multiple'
                           : typeSet.has('radio')    ? 'single' : 'unknown';
                results.push({ index: number, question: questionText, type, options, correct: '' });
                return;
            }
            if (block.querySelector('.display-inlineblock-select')) {
                results.push({ index: number, question: questionText, type: 'fill-select', options: [], correct: '' });
                return;
            }
            if (block.querySelector('.display-inlinegrid input[type="text"], input._1wQlZ')) {
                results.push({ index: number, question: questionText, type: 'fill-input', options: [], correct: '' });
                return;
            }
        });
        return results;
    }

    // ═══════════════════════════════════════════════════════════════
    // REGION SELECTOR (giữ nguyên)
    // ═══════════════════════════════════════════════════════════════
    function selectRegionResizable(canvas) {
        return new Promise(resolve => {
            const ov = document.createElement('div');
            ov.style.cssText = 'position:fixed;inset:0;z-index:2147483646;cursor:crosshair;user-select:none;touch-action:none;' +
                (canvas ? 'background:#000;' : 'background:rgba(0,0,0,0.15);');
            if (canvas) {
                canvas.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;pointer-events:none;';
                ov.appendChild(canvas);
            }
            const box = document.createElement('div');
            box.style.cssText = 'position:absolute;border:2px solid #10a37f;display:none;box-shadow:0 0 0 9999px rgba(0,0,0,0.45);pointer-events:auto;cursor:move;';
            ov.appendChild(box);
            const handleStyle = 'position:absolute;width:14px;height:14px;background:#10a37f;border:2px solid #fff;border-radius:3px;pointer-events:auto;';
            const positions = {
                nw: 'left:-7px;top:-7px;cursor:nwse-resize;', n: 'left:calc(50% - 7px);top:-7px;cursor:ns-resize;',
                ne: 'right:-7px;top:-7px;cursor:nesw-resize;', e: 'right:-7px;top:calc(50% - 7px);cursor:ew-resize;',
                se: 'right:-7px;bottom:-7px;cursor:nwse-resize;', s: 'left:calc(50% - 7px);bottom:-7px;cursor:ns-resize;',
                sw: 'left:-7px;bottom:-7px;cursor:nesw-resize;', w: 'left:-7px;top:calc(50% - 7px);cursor:ew-resize;'
            };
            Object.entries(positions).forEach(([pos, style]) => {
                const h = document.createElement('div');
                h.dataset.handle = pos;
                h.style.cssText = handleStyle + style;
                box.appendChild(h);
            });
            const toolbar = document.createElement('div');
            toolbar.style.cssText = 'position:absolute;left:50%;bottom:20px;transform:translateX(-50%);display:flex;gap:10px;align-items:center;background:#1a1a2e;color:#fff;padding:10px 16px;border-radius:10px;box-shadow:0 4px 24px rgba(0,0,0,0.6);font:13px Arial,sans-serif;pointer-events:auto;z-index:1;';
            const info = document.createElement('span');
            info.textContent = 'Kéo chuột chọn vùng · Enter = xác nhận · Esc = huỷ · Dblclick = cả màn hình';
            info.style.cssText = 'opacity:0.9;';
            const okBtn = document.createElement('button');
            okBtn.textContent = '✓ Xác nhận';
            okBtn.style.cssText = 'padding:8px 16px;background:#10a37f;color:#fff;border:0;border-radius:6px;cursor:pointer;font:bold 13px Arial,sans-serif;';
            const cancelBtn = document.createElement('button');
            cancelBtn.textContent = '✕ Huỷ';
            cancelBtn.style.cssText = 'padding:8px 16px;background:#d33;color:#fff;border:0;border-radius:6px;cursor:pointer;font:bold 13px Arial,sans-serif;';
            toolbar.appendChild(info); toolbar.appendChild(okBtn); toolbar.appendChild(cancelBtn);
            ov.appendChild(toolbar);
            document.documentElement.appendChild(ov);
            const prevOverflow = document.body.style.overflow;
            document.body.style.overflow = 'hidden';

            let rect = null, state = 'idle', startX = 0, startY = 0, startRect = null, activeHandle = null;

            function updateBox() {
                if (!rect || rect.w < 4 || rect.h < 4) { box.style.display = 'none'; return; }
                box.style.display = 'block';
                box.style.left = rect.x + 'px'; box.style.top = rect.y + 'px';
                box.style.width = rect.w + 'px'; box.style.height = rect.h + 'px';
            }
            function clamp(r) {
                const x = Math.max(0, Math.min(innerWidth - 4, r.x));
                const y = Math.max(0, Math.min(innerHeight - 4, r.y));
                const w = Math.max(4, Math.min(innerWidth - x, r.w));
                const h = Math.max(4, Math.min(innerHeight - y, r.h));
                return { x, y, w, h };
            }

            ov.addEventListener('pointerdown', e => {
                if (e.target.closest('button')) return;
                const handle = e.target.dataset.handle;
                if (handle) {
                    state = 'resizing'; activeHandle = handle;
                    startX = e.clientX; startY = e.clientY; startRect = { ...rect };
                } else if (e.target === box || box.contains(e.target)) {
                    state = 'moving'; startX = e.clientX; startY = e.clientY; startRect = { ...rect };
                } else if (e.target === ov || e.target === canvas) {
                    state = 'drawing'; startX = e.clientX; startY = e.clientY;
                    rect = { x: startX, y: startY, w: 0, h: 0 }; updateBox();
                }
                try { ov.setPointerCapture(e.pointerId); } catch (_) {}
            });
            ov.addEventListener('pointermove', e => {
                if (state === 'idle') return;
                const dx = e.clientX - startX, dy = e.clientY - startY;
                if (state === 'drawing') {
                    rect = clamp({ x: Math.min(startX, e.clientX), y: Math.min(startY, e.clientY), w: Math.abs(dx), h: Math.abs(dy) });
                } else if (state === 'moving') {
                    rect = clamp({ x: startRect.x + dx, y: startRect.y + dy, w: startRect.w, h: startRect.h });
                } else if (state === 'resizing') {
                    let r = { ...startRect };
                    if (activeHandle.includes('w')) { r.x = startRect.x + dx; r.w = startRect.w - dx; }
                    if (activeHandle.includes('e')) { r.w = startRect.w + dx; }
                    if (activeHandle.includes('n')) { r.y = startRect.y + dy; r.h = startRect.h - dy; }
                    if (activeHandle.includes('s')) { r.h = startRect.h + dy; }
                    if (r.w < 0) { r.x += r.w; r.w = -r.w; }
                    if (r.h < 0) { r.y += r.h; r.h = -r.h; }
                    rect = clamp(r);
                }
                updateBox();
                if (rect) info.textContent = `Vùng: ${Math.round(rect.w)}×${Math.round(rect.h)}  ·  Enter = xác nhận`;
            });
            ov.addEventListener('pointerup', () => { if (state !== 'idle') state = 'idle'; });

            function finish(result) {
                window.removeEventListener('keydown', onKey, true);
                document.body.style.overflow = prevOverflow || '';
                ov.remove();
                resolve(result);
            }
            function confirm() {
                if (!rect || rect.w < 4 || rect.h < 4) return;
                finish({ x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.w), h: Math.round(rect.h) });
            }
            function onKey(e) {
                if (e.key === 'Escape') { e.preventDefault(); finish(null); }
                else if (e.key === 'Enter') { e.preventDefault(); confirm(); }
            }
            window.addEventListener('keydown', onKey, true);
            ov.addEventListener('dblclick', e => {
                if (e.target.closest('button') || e.target.dataset.handle) return;
                rect = { x: 0, y: 0, w: innerWidth, h: innerHeight }; updateBox();
                info.textContent = 'Cả màn hình  ·  Enter = xác nhận';
            });
            okBtn.onclick = confirm;
            cancelBtn.onclick = () => finish(null);
        });
    }

    // ═══════════════════════════════════════════════════════════════
    // FATAL
    // ═══════════════════════════════════════════════════════════════
    function showFatal(msg) {
        try {
            let bar = document.getElementById('ioe-ai-fatal');
            if (!bar) {
                bar = document.createElement('div');
                bar.id = 'ioe-ai-fatal';
                bar.style.cssText = 'position:fixed;left:0;top:0;right:0;z-index:2147483647;background:#c00;color:#fff;font:13px/1.4 Arial;padding:8px 12px;white-space:pre-wrap;';
                (document.body || document.documentElement).appendChild(bar);
            }
            bar.textContent = 'Trợ lý học tập lỗi: ' + msg;
        } catch (_) {}
        console.error('[IOE AI V10.1]', msg);
    }

    // ═══════════════════════════════════════════════════════════════
    // MAIN
    // ═══════════════════════════════════════════════════════════════
    function start() {
        try {
            if (!document.documentElement) { setTimeout(start, 300); return; }

            // Xử lý stale root từ version cũ hoặc lần load lỗi trước
            const staleRoot = document.getElementById('ioe-ai-root');
            if (staleRoot) {
                const staleShadow = staleRoot.shadowRoot;
                const hasV10UI = staleShadow && (
                    staleShadow.getElementById('lockView') ||
                    (staleShadow.querySelector && staleShadow.querySelector('#lockView'))
                );
                if (hasV10UI) {
                    console.log('[IOE AI V10.1] UI đã tồn tại, bỏ qua');
                    return;
                }
                console.log('[IOE AI V10.1] Xoá stale root từ version cũ');
                try { staleRoot.remove(); } catch (_) {}
            }

            console.log('[IOE AI V10.1] Tạo UI...');

            const root = document.createElement('div');
            root.id = 'ioe-ai-root';
            root.style.cssText = 'position:fixed;inset:0;width:0;height:0;z-index:2147483647;pointer-events:none;';
            (document.body || document.documentElement).appendChild(root);

            let container;
            try {
                container = root.attachShadow({ mode: 'open' });
                console.log('[IOE AI V10.1] Shadow root OK');
            } catch (e) {
                console.warn('[IOE AI V10.1] attachShadow fail, dùng fallback:', e.message);
                container = root;
            }

            const $ = id => {
                if (typeof container.getElementById === 'function') return container.getElementById(id);
                return container.querySelector ? container.querySelector('#' + id) : null;
            };

            const modelOptions = MODELS.map(([v, n]) => `<option value="${v}">${n}</option>`).join('');
            const visionOptions = VISION_MODELS.map(([v, n]) => `<option value="${v}">${n}</option>`).join('');

            container.innerHTML = `
            <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/katex@0.16.9/dist/katex.min.css">
            <style>
              :host { all: initial; }
              * { box-sizing:border-box; }

              /* ═══ Lock view ═══ */
              #lockView {
                position:fixed;inset:0;z-index:2147483647;
                background:rgba(0,0,0,0.7);
                display:none;
                align-items:center;justify-content:center;
                padding:20px;
                pointer-events:auto;
                font:14px/1.5 Arial,sans-serif;
              }
              #lockView.visible { display:flex; }
              #lockBox {
                width:340px;max-width:100%;
                background:#fff;border-radius:16px;
                box-shadow:0 20px 60px rgba(0,0,0,0.5);
                padding:24px 22px 20px;color:#222;
                border:1px solid #e5e5e5;
              }
              #lockTitle { font-weight:700;font-size:18px;margin-bottom:6px;color:#111; }
              #lockSub { font-size:13px;color:#666;margin-bottom:16px;line-height:1.5; }
              #codeHelp { margin-top:12px;text-align:center;font-size:13px;color:#666; }
              #codeHelp a { color:#087f67;font-weight:600;text-decoration:underline; }
              #codeInput {
                width:100%;padding:12px 14px;border:2px solid #ddd;border-radius:10px;
                outline:none;font:14px Arial;margin-bottom:12px;
                transition:border-color .15s;
              }
              #codeInput:focus { border-color:#10a37f; }
              #codeInput:disabled { background:#f5f5f5;color:#888; }
              #unlockBtn {
                width:100%;padding:12px;border:0;border-radius:10px;
                background:#10a37f;color:#fff;font:600 14px Arial;
                cursor:pointer;transition:opacity .15s;
              }
              #unlockBtn:hover:not(:disabled) { opacity:.9; }
              #unlockBtn:disabled { opacity:.55;cursor:wait; }
              #lockMsg {
                margin-top:12px;font-size:12px;min-height:0;overflow-wrap:anywhere;
                color:#d33;line-height:1.4;
              }
              #lockMsg:empty { display:none; }
              #lockMsg.ok { color:#10a37f; }

              /* ═══ App view ═══ */
              #appView { display:none; }
              #launcher { position:fixed;right:18px;bottom:18px;z-index:2147483647;width:54px;height:54px;border-radius:50%;background:#10a37f;color:#fff;border:0;font-size:24px;cursor:pointer;box-shadow:0 5px 22px #0004;pointer-events:auto; }
              #panel { position:fixed;right:18px;bottom:82px;width:440px;height:720px;min-width:320px;min-height:420px;max-width:calc(100vw - 20px);max-height:calc(100vh - 100px);z-index:2147483647;background:#fff;color:#222;border:1px solid #ddd;border-radius:16px;box-shadow:0 10px 40px #0004;display:flex;flex-direction:column;overflow:hidden;font:14px/1.5 Arial,sans-serif;pointer-events:auto; }
              #panel.hidden {display:none}
              #head { background:linear-gradient(110deg,#10a37f,#087f67);color:#fff;padding:10px 12px;display:flex;align-items:center;justify-content:space-between;cursor:move;user-select:none; }
              #head > div:last-child { display:flex;gap:4px;align-items:center; }
              #head button {border:0;background:transparent;color:#fff;font-size:20px;cursor:pointer;padding:0 4px;}
              #advancedControls .row { margin-top:3px; }
              #logoutBtn { font-size:16px !important; opacity:0.85; }
              #logoutBtn:hover { opacity:1; }
              #infoBtn { font-size:18px !important; }
              #infoModal { display:none;position:fixed;inset:0;z-index:2147483647;background:#0008;align-items:center;justify-content:center;padding:14px;pointer-events:auto;font:14px/1.55 Arial,sans-serif; }
              #infoModal.visible { display:flex; }
              #infoBox { width:620px;max-width:100%;max-height:86vh;display:flex;flex-direction:column;background:#fff;color:#222;border-radius:14px;box-shadow:0 18px 60px #0005;overflow:hidden; }
              #infoHeader { display:flex;align-items:center;justify-content:space-between;padding:12px 16px;background:#10a37f;color:#fff; }
              #infoHeader strong { font-size:16px; }
              #closeInfoBtn { border:0;background:transparent;color:#fff;font-size:22px;cursor:pointer; }
              #infoTabs { display:flex;gap:6px;padding:8px 12px 0;border-bottom:1px solid #e5e7eb; }
              .infoTab { border:0;border-bottom:2px solid transparent;background:transparent;padding:8px 10px;color:#555;cursor:pointer;font:600 13px Arial; }
              .infoTab.active { color:#087f67;border-color:#10a37f; }
              #infoBody { overflow:auto;padding:10px 18px 18px; }
              .infoSection { display:none; }
              .infoSection.active { display:block; }
              .infoSection h3 { margin:10px 0 5px;font-size:15px; }
              .infoSection p,.infoSection ul,.infoSection ol { margin:6px 0; }
              #messages {flex:1;min-height:0;overflow:auto;padding:12px;background:#f7f7f8}
              .msg { padding:10px 12px;margin:8px 0;border-radius:12px;white-space:pre-wrap;overflow-wrap:anywhere;max-width:96%; }
              .user {margin-left:auto;background:#10a37f;color:#fff}
              .bot {background:#fff;border:1px solid #e5e5e5}
              .msg .katex-display { margin: 8px 0; }
              .msg .katex { font-size: 1.05em; }
              .msg h1,.msg h2,.msg h3,.msg h4 { margin:10px 0 6px;line-height:1.3; }
              .msg h1 {font-size:1.3em}.msg h2 {font-size:1.2em}.msg h3,.msg h4 {font-size:1.08em}
              .msg p {margin:5px 0}.msg ul,.msg ol {margin:5px 0;padding-left:24px}
              .msg li {margin:2px 0}.msg hr {border:0;border-top:1px solid #ddd;margin:10px 0}
              .msg blockquote {margin:7px 0;padding:3px 10px;border-left:3px solid #10a37f;color:#555;background:#f3f5f6}
              .msg code {font:12px/1.5 Consolas,monospace;background:#eef0f2;padding:1px 4px;border-radius:4px}
              .msg pre {margin:7px 0;padding:10px;background:#1f2937;color:#f9fafb;border-radius:8px;overflow:auto;white-space:pre}
              .msg pre code {padding:0;background:none;color:inherit;border-radius:0;font:12px/1.55 Consolas,monospace}
              .msg .code-lang {display:block;margin:-2px 0 5px;color:#a7f3d0;font:11px Arial,sans-serif}
              .msg table {border-collapse:collapse;margin:7px 0;max-width:100%;display:block;overflow:auto}
              .msg th,.msg td {border:1px solid #d1d5db;padding:5px 8px;text-align:left}
              .msg th {background:#f0f2f3}.msg a {color:#2563eb;text-decoration:underline}
              #inputArea {padding:5px 8px;background:#fff}
              #preview { display:none;max-width:100%;max-height:90px;object-fit:contain;margin:0 auto 6px;border:1px solid #eee;border-radius:6px; }
              .row {display:flex;gap:4px;margin-top:4px;align-items:center}
              button.b { flex:1;border:0;border-radius:8px;padding:6px 4px;background:#10a37f;color:#fff;cursor:pointer;font:600 12px Arial; }
              #stopBtn {background:#d33;display:none}
              #clearBtn {background:#777}
              #sendBtn {background:#4769e8}
              #scrapeBtn {background:#8b5cf6}
              button:disabled {opacity:.55;cursor:wait}
              select { flex:1;border:1px solid #ddd;border-radius:8px;padding:6px;font:12px Arial;background:#fff;color:#222;outline:none; }
              .lbl {font-size:12px;color:#555;white-space:nowrap}
              .chk { display:flex;align-items:center;gap:6px;font-size:12px;color:#444;cursor:pointer;user-select:none; }
              .chk input {margin:0;cursor:pointer}
              .chk input:disabled + span {opacity:.55}
              textarea { width:100%;height:64px;resize:vertical;min-height:42px;max-height:160px;border:1px solid #ddd;border-radius:8px;padding:8px;font:inherit;outline:none;margin-top:6px; }
              #status {font-size:12px;color:#666;overflow-wrap:anywhere}
              #scrapeActions { display:none; gap:6px; margin-top:6px; padding:8px 10px;
                                background:#f3f0ff; border:1px solid #d8ccff; border-radius:8px; align-items:center; }
              @media(max-width:450px){#panel{right:8px;bottom:72px;width:calc(100vw - 16px)}}
            </style>

            <div id="lockView">
              <div id="lockBox">
                <div id="lockTitle">🔒 Trợ lý học tập</div>
                <div id="lockSub">Vui lòng nhập mã khóa để sử dụng. Phiên đăng nhập được lưu 30 ngày.</div>
                <input type="password" id="codeInput" name="ioe_ai_access_code" placeholder="Nhập mã khóa..." autocomplete="new-password" data-lpignore="true" data-1p-ignore="true" spellcheck="false">
                <button id="unlockBtn">Xác nhận</button>
                <div id="codeHelp">Bạn chưa có mã? <a href="https://www.facebook.com/tranxuantung123/" target="_blank" rel="noopener noreferrer">Ấn vào đây</a></div>
                <div id="lockMsg"></div>
              </div>
            </div>

            <div id="appView">
              <button id="launcher" title="Mở Trợ lý học tập (Alt+A)">🤖</button>
              <section id="panel" class="hidden">
                <div id="head">
                  <b>🤖 Trợ lý học tập</b>
                  <div>
                    <button id="logoutBtn" title="Đăng xuất">🔓</button>
                    <button id="infoBtn" title="Cập nhật, hướng dẫn sử dụng và điều khoản" aria-label="Thông tin">ⓘ</button>
                    <button id="closeBtn" title="Đóng">×</button>
                  </div>
                </div>
                <div id="messages"></div>
                <div id="inputArea">
                  <img id="preview" alt="">
                  <div id="status">Screenshot ? Groq Vision transcription ? question scraper ? Ctrl+V to paste an image.</div>
                  <div id="advancedControls">
                  <div class="row">
                    <span class="lbl">Model:</span>
                    <select id="modelSel">${modelOptions}</select>
                  </div>
                  <div class="row">
                    <span class="lbl">Vision:</span>
                    <select id="visionSel">${visionOptions}</select>
                  </div>
                  <div class="row">
                    <span class="lbl">Image mode:</span>
                    <select id="imageModeSel" title="Choose what Vision does with an image">
                      <option value="solve">Send image to Vision and solve</option>
                      <option value="transcribe">Transcribe into chat</option>
                    </select>
                  </div>
                  <div class="row">
                    <label class="chk" title="Collaborative review loop, maximum 3 runs per day">
                      <input type="checkbox" id="multiAgent"> <span>Multi-agent (3/day)</span>
                    </label>
                    <select id="multiAgentRounds" title="Maximum revision rounds">
                      <option value="1">1 revision</option>
                      <option value="2">2 revisions</option>
                    </select>
                  </div>
                  <div class="row">
                    <button class="b" id="capBtn" title="Alt+S">📸 Chụp & Hỏi AI</button>
                  </div>
                  <div class="row">
                    <button class="b" id="scrapeBtn" title="Quét toàn bộ câu hỏi">📚 Lấy cả trang</button>

                  </div>
                  </div>
                  <textarea id="question" placeholder="Type a question or paste Vision-transcribed text..."></textarea>
                  <div id="scrapeActions">
                    <span id="scrapeInfo" style="flex:1;font-size:12px;color:#5b21b6;font-weight:600;"></span>
                    <button id="copyScrapedBtn" style="flex:0 0 auto;background:#6b7280;color:#fff;border:0;border-radius:6px;padding:6px 10px;cursor:pointer;font:600 12px Arial;">📋 Copy</button>
                    <button id="sendScrapedBtn" style="flex:0 0 auto;background:#4769e8;color:#fff;border:0;border-radius:6px;padding:6px 10px;cursor:pointer;font:600 12px Arial;">🤖 Gửi AI</button>
                    <button id="hideScrapeBtn" style="flex:0 0 auto;background:#9ca3af;color:#fff;border:0;border-radius:6px;padding:6px 8px;cursor:pointer;font:600 12px Arial;">✕</button>
                  </div>
                  <div class="row">
                    <button class="b" id="sendBtn">Gửi ↗</button>
                    <button class="b" id="stopBtn">⏹ Dừng</button>
                    <button class="b" id="clearBtn">Xóa trò chuyện</button>
                  </div>
                </div>
              </section>
              <div id="infoModal" role="dialog" aria-modal="true" aria-labelledby="infoTitle">
                <section id="infoBox">
                  <div id="infoHeader"><strong id="infoTitle">Trợ lý học tập · Thông tin</strong><button id="closeInfoBtn" aria-label="Đóng">×</button></div>
                  <nav id="infoTabs" aria-label="Thông tin trợ lý">
                    <button class="infoTab active" data-info-tab="updates">Cập nhật</button>
                    <button class="infoTab" data-info-tab="guide">Hướng dẫn</button>
                    <button class="infoTab" data-info-tab="terms">Điều khoản</button>
                  </nav>
                  <div id="infoBody">
                    <section class="infoSection active" id="info-updates">
                      <h3>Bản hiện tại 10.2.7</h3>
                      <ul>
                        <li>Nhận diện hộp thoại câu hỏi Violympic và gửi trọn câu hỏi cùng đáp án ảnh qua Vision từ nút “Lấy cả trang”.</li>
                        <li>Cải thiện chụp GameCanvas trên IOE và nhận diện một số bố cục câu hỏi VioEdu.</li>
                        <li>Sửa hiển thị LaTeX và điều chỉnh AI theo ngôn ngữ, môn học của đề.</li>
                      </ul>
                    </section>
                    <section class="infoSection" id="info-guide">
                      <h3>Bắt đầu</h3>
                      <ol>
                        <li>Nhập mã truy cập được cấp để mở trợ lý. Phiên đăng nhập được lưu trên trình duyệt tối đa 30 ngày.</li>
                        <li>Chọn model trong danh sách. Qwen là lựa chọn mặc định; có thể đổi model bất cứ lúc nào.</li>
                        <li>Nhập câu hỏi vào khung chat rồi bấm “Gửi”, hoặc nhấn Enter. Lịch sử gần đây được lưu trên thiết bị.</li>
                      </ol>
                      <h3>Lấy câu hỏi và dùng Vision</h3>
                      <ul>
                        <li>“Lấy cả trang”: tự lấy câu hỏi từ bố cục được hỗ trợ; nếu đang mở hộp thoại câu hỏi Violympic, trợ lý chụp toàn hộp thoại gồm cả đáp án dạng ảnh.</li>
                        <li>“Chụp & Hỏi AI”: chụp trang, kéo chọn vùng cần đọc rồi gửi ảnh cho Vision.</li>
                        <li>Ở chế độ ảnh “Giải”, Vision trả lời câu hỏi trong ảnh. Ở chế độ “Chép đề”, Vision chuyển nội dung nhận diện được vào khung chat để bạn xem và sửa.</li>
                        <li>Nếu nội dung trang không được nhận diện, dùng “Chụp & Hỏi AI” hoặc dán ảnh vào khung chat.</li>
                      </ul>
                      <h3>Multi-agent</h3>
                      <p>Bật Multi-agent để model tạo đáp án rồi nhận phản biện và lượt sửa có giới hạn. Tối đa 3 lần cộng tác mỗi ngày trên trình duyệt; số lượt sửa chọn ở danh sách bên cạnh.</p>
                    </section>
                    <section class="infoSection" id="info-terms">
                      <h3>Điều khoản sử dụng</h3>
                      <ol>
                        <li>Công cụ dành cho tự học, ôn tập và tham khảo; không sử dụng trong bài thi hoặc hoạt động bị cấm công cụ hỗ trợ.</li>
                        <li>AI có thể đọc sai đề hoặc trả lời sai. Người dùng cần tự kiểm tra lời giải và đáp án.</li>
                        <li>Không chia sẻ mã truy cập. Câu hỏi và ảnh gửi lên sẽ được xử lý qua server của dịch vụ và nhà cung cấp AI.</li>
                        <li>Dịch vụ, model và tính năng có thể thay đổi hoặc tạm ngừng; không cam kết hoạt động liên tục hay kết quả luôn chính xác.</li>
                      </ol>
                    </section>
                  </div>
                </section>
              </div>
            </div>`;

            console.log('[IOE AI V10.1] UI đã render');

            const lockView = $('lockView'), appView = $('appView');
            const lockMsg = $('lockMsg'), codeInput = $('codeInput'), unlockBtn = $('unlockBtn');
            const panel = $('panel'), messages = $('messages'), question = $('question');
            const preview = $('preview'), modelSel = $('modelSel'), visionSel = $('visionSel'), imageModeSel = $('imageModeSel'), multiAgentEl = $('multiAgent'), multiAgentRoundsEl = $('multiAgentRounds');

            if (!lockView || !appView) {
                showFatal('Không tìm thấy lockView/appView — innerHTML có thể lỗi');
                return;
            }

            // ── AUTH ──────────────────────────────────────────
            let authState = 'locked';

            function showLock() {
                authState = 'locked';
                try { lockView.classList.add('visible'); } catch (_) {}
                try { appView.style.display = 'none'; } catch (_) {}
                try { codeInput.value = ''; } catch (_) {}
                const locallyLocked = (Number(localStorage.getItem(AUTH_LOCK_KEY)) || 0) > Date.now();
                try {
                    codeInput.disabled = locallyLocked;
                    unlockBtn.disabled = locallyLocked;
                    lockMsg.textContent = locallyLocked ? TOO_MANY_ATTEMPTS : '';
                    lockMsg.classList.remove('ok');
                } catch (_) {}
                if (!locallyLocked) setTimeout(() => { try { codeInput.focus(); } catch (_) {} }, 150);
                console.log('[IOE AI V10.1] Hiện lock view');
            }

            function showApp() {
                authState = 'unlocked';
                try { lockView.classList.remove('visible'); } catch (_) {}
                try { appView.style.display = 'block'; } catch (_) {}
                console.log('[IOE AI V10.1] Hiện app view');
            }

            function handleAuthFailure(msg) {
                clearToken();
                showLock();
                if (msg) {
                    try {
                        lockMsg.textContent = msg;
                        lockMsg.classList.remove('ok');
                    } catch (_) {}
                }
            }

            const TOO_MANY_ATTEMPTS = 'B\u1ea1n \u0111\u00e3 th\u1eed qu\u00e1 nhi\u1ec1u l\u1ea7n';
            let authLockTimer = null;
            function clearLocalAuthLock() {
                try { localStorage.removeItem(AUTH_LOCK_KEY); } catch (_) {}
                if (authLockTimer) clearTimeout(authLockTimer);
                authLockTimer = null;
                codeInput.disabled = false;
                unlockBtn.disabled = false;
                if (lockMsg.textContent === TOO_MANY_ATTEMPTS) lockMsg.textContent = '';
            }
            function applyLocalAuthLock(until) {
                try { localStorage.setItem(AUTH_LOCK_KEY, String(until)); } catch (_) {}
                codeInput.disabled = true;
                unlockBtn.disabled = true;
                lockMsg.textContent = TOO_MANY_ATTEMPTS;
                lockMsg.classList.remove('ok');
                if (authLockTimer) clearTimeout(authLockTimer);
                authLockTimer = setTimeout(clearLocalAuthLock, Math.max(0, until - Date.now()));
            }
            const savedLockUntil = Number(localStorage.getItem(AUTH_LOCK_KEY)) || 0;
            if (savedLockUntil > Date.now()) applyLocalAuthLock(savedLockUntil);
            else if (savedLockUntil) clearLocalAuthLock();

            async function doUnlock() {
                const localLockUntil = Number(localStorage.getItem(AUTH_LOCK_KEY)) || 0;
                if (localLockUntil > Date.now()) {
                    lockMsg.textContent = TOO_MANY_ATTEMPTS;
                    return;
                }
                const code = codeInput.value.trim();
                if (!code) {
                    lockMsg.textContent = 'Vui lòng nhập mã.';
                    lockMsg.classList.remove('ok');
                    return;
                }
                unlockBtn.disabled = true;
                unlockBtn.textContent = '⏳ Đang kiểm tra...';
                lockMsg.textContent = '';
                lockMsg.classList.remove('ok');

                try {
                    const res = await fetch(BACKEND_URL + '/api/auth', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ code }),
                    });
                    const data = await res.json().catch(() => ({}));

                    if (res.status === 429) {
                        if (data.limitType === 'lockout') applyLocalAuthLock(Date.now() + AUTH_LOCK_MS);
                        else lockMsg.textContent = TOO_MANY_ATTEMPTS;
                        lockMsg.classList.remove('ok');
                        return;
                    }

                    if (!res.ok || !data.token) {
                        throw new Error(data.error || `Lỗi ${res.status}`);
                    }

                    setToken(data.token);
                    lockMsg.textContent = '✅ Đăng nhập thành công!';
                    lockMsg.classList.add('ok');
                    await wait(400);
                    showApp();
                } catch (e) {
                    lockMsg.textContent = '❌ ' + (e.message || 'Không thể kết nối server');
                    lockMsg.classList.remove('ok');
                } finally {
                    const stillLocked = (Number(localStorage.getItem(AUTH_LOCK_KEY)) || 0) > Date.now();
                    codeInput.disabled = stillLocked;
                    unlockBtn.disabled = stillLocked;
                    unlockBtn.textContent = 'Xác nhận';
                }
            }

            unlockBtn.addEventListener('click', doUnlock);
            codeInput.addEventListener('keydown', e => {
                if (e.key === 'Enter') { e.preventDefault(); doUnlock(); }
            });

            // Khởi động auth
            try {
                const token = getToken();
                if (isTokenValid(token)) {
                    showApp();
                } else {
                    clearToken();
                    showLock();
                }
            } catch (e) {
                console.error('[IOE AI V10.1] initAuth failed:', e);
                showLock();
            }

            // ── APP LOGIC ─────────────────────────────────────
            if (!panel || !messages || !question) {
                console.warn('[IOE AI V10.1] Thiếu panel/messages/question');
                return;
            }

            const storedModel = localStorage.getItem('ioeai_model');
            modelSel.value = MODELS.some(([id]) => id === storedModel) ? storedModel : DEFAULT_MODEL;
            modelSel.addEventListener('change', () => localStorage.setItem('ioeai_model', modelSel.value));
            const storedVision = localStorage.getItem('ioeai_vision_model');
            visionSel.value = VISION_MODELS.some(([id]) => id === storedVision) ? storedVision : VISION_MODELS[0][0];
            visionSel.addEventListener('change', () => localStorage.setItem('ioeai_vision_model', visionSel.value));
            const savedImageMode = localStorage.getItem('ioeai_image_mode');
            imageModeSel.value = savedImageMode === 'transcribe' ? 'transcribe' : 'solve';
            imageModeSel.addEventListener('change', () => localStorage.setItem('ioeai_image_mode', imageModeSel.value));
            multiAgentEl.checked = readFlag('ioeai_multi_agent', false);
            multiAgentEl.addEventListener('change', () => writeFlag('ioeai_multi_agent', multiAgentEl.checked));
            const savedRounds = localStorage.getItem('ioeai_multi_agent_rounds');
            multiAgentRoundsEl.value = savedRounds === '2' ? '2' : '1';
            multiAgentRoundsEl.addEventListener('change', () => localStorage.setItem('ioeai_multi_agent_rounds', multiAgentRoundsEl.value));



            let busy = false, history = loadChatHistory(), controller = null;
            const setStatus = t => {
                const el = $('status');
                if (el) el.textContent = t;
            };

            let previewUrl = null;
            function showPreview(file) {
                clearPreview();
                if (!preview) return;
                previewUrl = URL.createObjectURL(file);
                preview.src = previewUrl;
                preview.style.display = 'block';
            }
            function clearPreview() {
                if (previewUrl) { URL.revokeObjectURL(previewUrl); previewUrl = null; }
                if (!preview) return;
                preview.removeAttribute('src');
                preview.style.display = 'none';
            }

            function escapeMarkdownHtml(text) {
                return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;')
                    .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
            }

            function renderInlineMarkdown(text) {
                const saved = [];
                const hold = html => `MDHOLDTOKEN${saved.push(html) - 1}END`;
                let source = String(text).replace(/\$\$[\s\S]+?\$\$|\\\[[\s\S]+?\\\]|\\\([\s\S]+?\\\)|\$[^$\n]+\$/g,
                    math => hold(escapeMarkdownHtml(math)));
                source = source.replace(/`([^`\n]+)`/g, (_, code) => hold(`<code>${escapeMarkdownHtml(code)}</code>`));
                let html = escapeMarkdownHtml(source);
                html = html.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+|mailto:[^\s)]+)\)/g, (whole, label, href) => {
                    const safeHref = href.replace(/&amp;/g, '&');
                    if (!/^(https?:\/\/|mailto:)/i.test(safeHref)) return whole;
                    return `<a href="${escapeMarkdownHtml(safeHref)}" target="_blank" rel="noopener noreferrer">${label}</a>`;
                });
                html = html.replace(/\*\*(.+?)\*\*|__(.+?)__/g, '<strong>$1$2</strong>');
                html = html.replace(/~~(.+?)~~/g, '<del>$1</del>');
                html = html.replace(/\*([^*\n]+)\*/g, '<em>$1</em>');
                html = html.replace(/(^|[\s(])_([^_\n]+)_($|[\s).,!?])/g, '$1<em>$2</em>$3');
                html = html.replace(/MDHOLDTOKEN(\d+)END/g, (_, index) => saved[Number(index)] || '');
                return html;
            }

            function renderMarkdown(text) {
                const lines = String(text).replace(/\r\n?/g, '\n').split('\n');
                const out = [];
                const isHr = line => /^\s*(?:---+|___+|\*\*\*+)\s*$/.test(line);
                const isBlockStart = line => /^\s*(```|~~~|#{1,6}\s|>\s?|[-+*]\s+|\d+[.)]\s+)/.test(line) || isHr(line);
                const cells = line => line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(c => c.trim());
                for (let i = 0; i < lines.length;) {
                    const line = lines[i];
                    if (!line.trim()) { i++; continue; }
                    const fence = line.match(/^\s*(```+|~~~+)\s*([\w.+-]*)\s*$/);
                    if (fence) {
                        const marker = fence[1][0], lang = fence[2];
                        const body = [];
                        i++;
                        while (i < lines.length && !new RegExp('^\\s*' + marker + '{3,}\\s*$').test(lines[i])) body.push(lines[i++]);
                        if (i < lines.length) i++;
                        out.push(`<pre>${lang ? `<span class="code-lang">${escapeMarkdownHtml(lang)}</span>` : ''}<code>${escapeMarkdownHtml(body.join('\n'))}</code></pre>`);
                        continue;
                    }
                    const heading = line.match(/^\s{0,3}(#{1,6})\s+(.+?)\s*#*\s*$/);
                    if (heading) { const level = heading[1].length; out.push(`<h${level}>${renderInlineMarkdown(heading[2])}</h${level}>`); i++; continue; }
                    if (isHr(line)) { out.push('<hr>'); i++; continue; }
                    if (/^\s*>/.test(line)) {
                        const quote = [];
                        while (i < lines.length && /^\s*>/.test(lines[i])) quote.push(lines[i++].replace(/^\s*> ?/, ''));
                        out.push(`<blockquote>${renderMarkdown(quote.join('\n'))}</blockquote>`);
                        continue;
                    }
                    const list = line.match(/^\s*(?:([-+*])|(\d+)[.)])\s+(.+)$/);
                    if (list) {
                        const ordered = !!list[2], tag = ordered ? 'ol' : 'ul', items = [];
                        while (i < lines.length) {
                            const item = lines[i].match(/^\s*(?:([-+*])|(\d+)[.)])\s+(.+)$/);
                            if (!item || (!!item[2]) !== ordered) break;
                            items.push(`<li>${renderInlineMarkdown(item[3])}</li>`); i++;
                        }
                        out.push(`<${tag}>${items.join('')}</${tag}>`);
                        continue;
                    }
                    if (i + 1 < lines.length && line.includes('|') && /^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(lines[i + 1])) {
                        const headers = cells(line), aligns = cells(lines[i + 1]);
                        i += 2;
                        const rows = [];
                        while (i < lines.length && lines[i].includes('|') && lines[i].trim()) { rows.push(cells(lines[i++])); }
                        const th = headers.map((c, n) => `<th>${renderInlineMarkdown(c)}</th>`).join('');
                        const body = rows.map(row => `<tr>${headers.map((_, n) => `<td>${renderInlineMarkdown(row[n] || '')}</td>`).join('')}</tr>`).join('');
                        out.push(`<table><thead><tr>${th}</tr></thead><tbody>${body}</tbody></table>`);
                        continue;
                    }
                    const para = [line]; i++;
                    while (i < lines.length && lines[i].trim() && !isBlockStart(lines[i])) para.push(lines[i++]);
                    out.push(`<p>${renderInlineMarkdown(para.join('\n')).replace(/\n/g, '<br>')}</p>`);
                }
                return out.join('');
            }

            function normalizeMathOutput(text) {
                return String(text)
                    // Some model responses escape display delimiters twice.
                    .replace(/\\\\\[/g, '\\[').replace(/\\\\\]/g, '\\]')
                    .replace(/\\\\\(/g, '\\(').replace(/\\\\\)/g, '\\)')
                    // Remove a stray escaped newline immediately after a display opener.
                    .replace(/\\\[\\(?=\r?\n)/g, '\\[')
                    // Convert common HTML-encoded whitespace emitted as plain text.
                    .replace(/&#x0*20;|&#0*32;|&nbsp;/gi, ' ');
            }

            function renderAssistantMessage(element, text) {
                element.innerHTML = renderMarkdown(normalizeMathOutput(text));
                renderMath(element);
            }

            function addMessage(role, text) {
                const d = document.createElement('div');
                d.className = 'msg ' + (role === 'user' ? 'user' : 'bot');
                // Scraped questions and user-entered prompts can contain LaTeX too.
                // Render both roles consistently so `$...$` is never shown raw.
                renderAssistantMessage(d, text);
                messages.appendChild(d);
                messages.scrollTop = messages.scrollHeight;
                return d;
            }

            history.forEach(item => addMessage(item.role, item.content));

            function setBusy(v) {
                busy = v;
                ['capBtn','sendBtn','scrapeBtn'].forEach(id => {
                    const el = $(id);
                    if (el) el.disabled = v;
                });
                if (modelSel) modelSel.disabled = v;
                if (visionSel) visionSel.disabled = v;
                if (imageModeSel) imageModeSel.disabled = v;
                if (multiAgentEl) multiAgentEl.disabled = v;
                if (multiAgentRoundsEl) multiAgentRoundsEl.disabled = v;
            }

            const openPanel = () => {
                panel.classList.remove('hidden');
                const l = $('launcher');
                if (l) l.style.display = 'none';
            };
            const closePanel = () => {
                panel.classList.add('hidden');
                const l = $('launcher');
                if (l) l.style.display = 'block';
            };

            const launcherEl = $('launcher');
            const closeBtnEl = $('closeBtn');
            const logoutBtnEl = $('logoutBtn');
            const infoBtnEl = $('infoBtn'), infoModalEl = $('infoModal'), closeInfoBtnEl = $('closeInfoBtn');
            if (launcherEl) launcherEl.onclick = openPanel;
            if (closeBtnEl) closeBtnEl.onclick = closePanel;
            const closeInfo = () => infoModalEl && infoModalEl.classList.remove('visible');
            if (infoBtnEl) infoBtnEl.onclick = () => infoModalEl && infoModalEl.classList.add('visible');
            if (closeInfoBtnEl) closeInfoBtnEl.onclick = closeInfo;
            if (infoModalEl) {
                infoModalEl.addEventListener('click', e => { if (e.target === infoModalEl) closeInfo(); });
                infoModalEl.querySelectorAll('.infoTab').forEach(tab => {
                    tab.addEventListener('click', () => {
                        infoModalEl.querySelectorAll('.infoTab').forEach(item => item.classList.toggle('active', item === tab));
                        infoModalEl.querySelectorAll('.infoSection').forEach(section => {
                            section.classList.toggle('active', section.id === 'info-' + tab.dataset.infoTab);
                        });
                    });
                });
            }
            window.addEventListener('keydown', e => { if (e.key === 'Escape') closeInfo(); });
            const savePanelSize = () => {
                localStorage.setItem('ioeai_panel_size', JSON.stringify({ width: panel.style.width, height: panel.style.height }));
            };
            try {
                const savedSize = JSON.parse(localStorage.getItem('ioeai_panel_size') || 'null');
                if (savedSize && savedSize.width && savedSize.height) {
                    panel.style.width = savedSize.width;
                    panel.style.height = savedSize.height;
                }
            } catch (_) {}
            if (logoutBtnEl) logoutBtnEl.onclick = () => {
                if (busy) return;
                if (!confirm('Đăng xuất khỏi trợ lý AI?')) return;
                clearToken();
                showLock();
            };

            window.addEventListener('keydown', e => {
                if (authState !== 'unlocked') return;
                if (!e.altKey || e.ctrlKey || e.metaKey) return;
                if (e.code === 'KeyA') {
                    e.preventDefault();
                    panel.classList.contains('hidden') ? openPanel() : closePanel();
                } else if (e.code === 'KeyS') {
                    e.preventDefault(); openPanel(); captureAndAsk();
                }
            });

            // Drag any panel edge or corner to resize.
            const getResizeEdges = e => {
                const r = panel.getBoundingClientRect(), edge = 8;
                if (e.target.closest('button, input, select, textarea')) return null;
                const edges = {
                    left: e.clientX - r.left <= edge,
                    right: r.right - e.clientX <= edge,
                    top: e.clientY - r.top <= edge,
                    bottom: r.bottom - e.clientY <= edge,
                };
                return Object.values(edges).some(Boolean) ? edges : null;
            };
            let resizeState = null;
            panel.addEventListener('pointerdown', e => {
                const edges = getResizeEdges(e);
                if (!edges) return;
                e.preventDefault(); e.stopPropagation();
                const r = panel.getBoundingClientRect();
                resizeState = { edges, x: e.clientX, y: e.clientY, left: r.left, top: r.top, width: r.width, height: r.height };
                panel.style.left = r.left + 'px'; panel.style.top = r.top + 'px';
                panel.style.right = 'auto'; panel.style.bottom = 'auto';
                panel.setPointerCapture(e.pointerId);
                panel.style.userSelect = 'none';
            });
            panel.addEventListener('pointermove', e => {
                if (!resizeState) {
                    const edges = getResizeEdges(e);
                    if (edges) {
                        const horizontal = edges.left || edges.right, vertical = edges.top || edges.bottom;
                        panel.style.cursor = horizontal && vertical ? ((edges.left === edges.top) ? 'nwse-resize' : 'nesw-resize') : horizontal ? 'ew-resize' : 'ns-resize';
                    } else panel.style.cursor = '';
                    return;
                }
                const d = resizeState, dx = e.clientX - d.x, dy = e.clientY - d.y;
                const minW = 320, minH = 420;
                const maxW = Math.max(minW, innerWidth - 20), maxH = Math.max(minH, innerHeight - 100);
                const width = Math.max(minW, Math.min(maxW, d.width + (d.edges.right ? dx : d.edges.left ? -dx : 0)));
                const height = Math.max(minH, Math.min(maxH, d.height + (d.edges.bottom ? dy : d.edges.top ? -dy : 0)));
                panel.style.width = width + 'px'; panel.style.height = height + 'px';
                panel.style.left = (d.edges.left ? d.left + d.width - width : d.left) + 'px';
                panel.style.top = (d.edges.top ? d.top + d.height - height : d.top) + 'px';
            });
            const finishResize = () => {
                if (!resizeState) return;
                resizeState = null;
                panel.style.userSelect = '';
                savePanelSize();
            };
            panel.addEventListener('pointerup', finishResize);
            panel.addEventListener('pointercancel', finishResize);

            // Panel drag
            const headEl = $('head');
            if (headEl) {
                let drag = false, ox = 0, oy = 0;
                headEl.addEventListener('pointerdown', e => {
                    if (e.target.closest('button') || getResizeEdges(e)) return;
                    drag = true;
                    const r = panel.getBoundingClientRect();
                    ox = e.clientX - r.left; oy = e.clientY - r.top;
                    panel.style.left = r.left + 'px'; panel.style.top = r.top + 'px';
                    panel.style.right = 'auto'; panel.style.bottom = 'auto';
                    try { headEl.setPointerCapture(e.pointerId); } catch (_) {}
                });
                headEl.addEventListener('pointermove', e => {
                    if (!drag) return;
                    panel.style.left = Math.max(0, Math.min(innerWidth - panel.offsetWidth, e.clientX - ox)) + 'px';
                    panel.style.top = Math.max(0, Math.min(innerHeight - panel.offsetHeight, e.clientY - oy)) + 'px';
                });
                headEl.addEventListener('pointerup', () => drag = false);
                headEl.addEventListener('pointercancel', () => drag = false);
            }

            // ── SCREENSHOT ────────────────────────────────────
            async function captureGameCanvasFrame() {
                const gameCanvas = document.getElementById('GameCanvas');
                if (!(gameCanvas instanceof HTMLCanvasElement) || !gameCanvas.width || !gameCanvas.height) return null;
                // Capture in the next animation frame while the latest game frame
                // is available in the WebGL canvas drawing buffer.
                const dataUrl = await new Promise(resolve => {
                    requestAnimationFrame(() => {
                        try { resolve(gameCanvas.toDataURL('image/png')); }
                        catch (_) { resolve(null); }
                    });
                });
                if (!dataUrl || dataUrl === 'data:,') return null;
                const image = new Image();
                image.src = dataUrl;
                try { await image.decode(); } catch (_) { return null; }
                return { image, rect: gameCanvas.getBoundingClientRect() };
            }

            async function overlayGameCanvasFrame(target) {
                const frame = await captureGameCanvasFrame();
                if (!frame || !frame.rect.width || !frame.rect.height) return;
                const sx = target.width / innerWidth, sy = target.height / innerHeight;
                target.getContext('2d').drawImage(frame.image,
                    frame.rect.left * sx, frame.rect.top * sy,
                    frame.rect.width * sx, frame.rect.height * sy);
            }

            async function takeShot() {
                root.style.visibility = 'hidden';
                await wait(200);
                try {
                    if (typeof html2canvas === 'function') {
                        try {
                            const shot = await html2canvas(document.documentElement, {
                                useCORS: true, logging: false, backgroundColor: '#ffffff',
                                scale: Math.min(window.devicePixelRatio || 1, 2),
                                x: window.scrollX, y: window.scrollY,
                                width: window.innerWidth, height: window.innerHeight,
                                ignoreElements: el => el === root
                            });
                            await overlayGameCanvasFrame(shot);
                            return shot;
                        } catch (_) {}
                    }
                    const stream = await navigator.mediaDevices.getDisplayMedia({
                        video: true, audio: false, preferCurrentTab: true
                    });
                    try {
                        const v = document.createElement('video');
                        v.srcObject = stream; v.muted = true;
                        await v.play(); await wait(300);
                        const c = document.createElement('canvas');
                        c.width = v.videoWidth; c.height = v.videoHeight;
                        c.getContext('2d').drawImage(v, 0, 0);
                        await overlayGameCanvasFrame(c);
                        return c;
                    } finally {
                        stream.getTracks().forEach(t => t.stop());
                    }
                } finally {
                    root.style.visibility = 'visible';
                }
            }

            const toBlob = (c, q) => new Promise(r => c.toBlob(r, 'image/jpeg', q));
            async function canvasToFile(src) {
                // Keep Vision input at a predictable size to reduce image tokens and request payload.
                const MAX_EDGE = 1280;
                const MAX_BYTES = 600 * 1024;
                const scale = Math.min(1, MAX_EDGE / Math.max(src.width, src.height));
                let c = document.createElement('canvas');
                c.width = Math.max(1, Math.round(src.width * scale));
                c.height = Math.max(1, Math.round(src.height * scale));
                let g = c.getContext('2d');
                g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height);
                g.imageSmoothingEnabled = true;
                g.imageSmoothingQuality = 'high';
                g.drawImage(src, 0, 0, c.width, c.height);

                let q = 0.82;
                let blob = await toBlob(c, q);
                while (blob && blob.size > MAX_BYTES && q > 0.62) {
                    q = Math.max(0.62, q - 0.08);
                    blob = await toBlob(c, q);
                }
                while (blob && blob.size > MAX_BYTES && c.width > 640) {
                    const reduced = document.createElement('canvas');
                    reduced.width = Math.max(1, Math.round(c.width * 0.85));
                    reduced.height = Math.max(1, Math.round(c.height * 0.85));
                    g = reduced.getContext('2d');
                    g.fillStyle = '#fff'; g.fillRect(0, 0, reduced.width, reduced.height);
                    g.imageSmoothingEnabled = true;
                    g.imageSmoothingQuality = 'high';
                    g.drawImage(c, 0, 0, reduced.width, reduced.height);
                    c = reduced;
                    blob = await toBlob(c, q);
                }
                if (!blob) throw new Error('Could not encode image.');
                return new File([blob], 'vision-input.jpg', { type: 'image/jpeg' });
            }

            const fileToDataURL = f => new Promise((res, rej) => {
                const r = new FileReader();
                r.onload = () => res(r.result);
                r.onerror = () => rej(new Error('Không thể đọc được ảnh.'));
                r.readAsDataURL(f);
            });

            const loadImageFromFile = f => new Promise((res, rej) => {
                const url = URL.createObjectURL(f);
                const img = new Image();
                img.onload = () => { URL.revokeObjectURL(url); res(img); };
                img.onerror = () => { URL.revokeObjectURL(url); rej(new Error('Không thể đọc được ảnh.')); };
                img.src = url;
            });

            async function apiFetch(path, body) {
                const headers = { 'Content-Type': 'application/json' };
                const token = getToken();
                if (token) headers['Authorization'] = 'Bearer ' + token;
                return fetch(BACKEND_URL + path, {
                    method: 'POST',
                    headers,
                    body: JSON.stringify(body),
                });
            }
            // GROQ VISION TRANSCRIPTION
            async function transcribeImageWithVision(file) {
                const dataUrl = await fileToDataURL(file);
                setStatus('Transcribing image with Groq Vision...');
                const res = await apiFetch('/api/vision', { image: dataUrl });
                if (res.status === 401) {
                    handleAuthFailure('Session expired. Please enter the access code again.');
                    throw new Error('AUTH');
                }
                const data = await res.json().catch(() => ({}));
                if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
                if (data.text) return data.text;
                throw new Error('Vision API returned no text');
            }

            // CHAT
            async function callGroq(userContent, historyText, model, imageDataUrl = null) {
                const useMultiAgent = multiAgentEl.checked && !imageDataUrl;
                if (useMultiAgent && multiAgentUsageCount() >= MULTI_AGENT_DAILY_LIMIT) {
                    setStatus('Daily multi-agent limit reached (3 runs). Use a single model or try again tomorrow.');
                    return;
                }
                if (useMultiAgent) recordMultiAgentUse();
                setBusy(true);
                const stopBtn = $('stopBtn');
                if (stopBtn) stopBtn.style.display = 'block';
                const answer = addMessage('assistant', '⏳ Đang suy nghĩ...');
                let fullText = '';
                controller = new AbortController();

                const messagesForBackend = [
                    { role: 'system', content: SYSTEM_PROMPT },
                    ...history.slice(-CHAT_CONTEXT_MAX),
                    { role: 'user', content: typeof userContent === 'string' ? userContent : '' },
                ];

                const body = {
                    messages: messagesForBackend,
                    model,
                    multiAgent: useMultiAgent,
                    ...(useMultiAgent ? { multiAgentMaxRevisions: Number(multiAgentRoundsEl.value) || 1 } : {}),
                    ...(imageDataUrl ? { image: imageDataUrl } : {}),
                };

                let lastRender = 0;
                const RENDER_MS = 350;

                try {
                    const headers = { 'Content-Type': 'application/json' };
                    const token = getToken();
                    if (token) headers['Authorization'] = 'Bearer ' + token;

                    const response = await fetch(BACKEND_URL + '/api/chat', {
                        method: 'POST',
                        headers,
                        body: JSON.stringify(body),
                        signal: controller.signal,
                    });

                    if (response.status === 401) {
                        answer.textContent = '❌ Phiên đăng nhập đã hết hạn.';
                        handleAuthFailure('Phiên đăng nhập đã hết hạn. Vui lòng nhập lại mã.');
                        return;
                    }

                    if (!response.ok) {
                        const errText = await response.text();
                        throw new Error(`Backend HTTP ${response.status}: ${errText.slice(0, 300)}`);
                    }

                    const reader = response.body.getReader();
                    const decoder = new TextDecoder();
                    let buffer = '';
                    let ended = false;

                    const processLine = line => {
                        if (!line.startsWith('data:')) return false;
                        const data = line.slice(5).trim();
                        if (!data) return false;
                        if (data === '[DONE]') return true;
                        let obj;
                        try { obj = JSON.parse(data); } catch (_) { return false; }
                        const c = obj.choices && obj.choices[0]?.delta?.content;
                        if (typeof c === 'string' && c) {
                            fullText += c;
                            const now = Date.now();
                            if (now - lastRender >= RENDER_MS) {
                                lastRender = now;
                                renderAssistantMessage(answer, fullText);
                            }
                            messages.scrollTop = messages.scrollHeight;
                        }
                        return false;
                    };

                    while (!ended) {
                        const r = await reader.read();
                        buffer += decoder.decode(r.value || new Uint8Array(), { stream: !r.done });
                        const lines = buffer.split('\n');
                        buffer = lines.pop() || '';
                        for (const line of lines) {
                            try {
                                if (processLine(line.trimEnd())) { ended = true; break; }
                            } catch (_) {}
                        }
                        if (r.done) {
                            if (buffer.trim()) { try { processLine(buffer.trimEnd()); } catch (_) {} }
                            break;
                        }
                    }

                    if (!fullText) throw new Error('Model không trả về nội dung.');

                    renderAssistantMessage(answer, fullText);

                    history.push(
                        { role: 'user', content: historyText },
                        { role: 'assistant', content: fullText }
                    );
                    if (history.length > CHAT_HISTORY_MAX) history = history.slice(-CHAT_HISTORY_MAX);
                    saveChatHistory(history);
                    setStatus('Done. Recent conversation history is saved on this device.');
                } catch (err) {
                    if (err.name === 'AbortError') {
                        renderAssistantMessage(answer, (fullText || '') + '\n\nStopped.');
                        if (fullText) {
                            history.push(
                                { role: 'user', content: historyText },
                                { role: 'assistant', content: fullText }
                            );
                            if (history.length > CHAT_HISTORY_MAX) history = history.slice(-CHAT_HISTORY_MAX);
                            saveChatHistory(history);
                        }
                    } else {
                        answer.textContent = '❌ Lỗi: ' + err.message;
                        setStatus('Có lỗi, xem trong khung chat.');
                    }
                } finally {
                    controller = null;
                    if (stopBtn) stopBtn.style.display = 'none';
                    setBusy(false);
                }
            }

            const stopBtnEl = $('stopBtn');
            if (stopBtnEl) stopBtnEl.onclick = () => { if (controller) controller.abort(); };

            // ── Helpers ───────────────────────────────────────
            function appendToQuestion(text) {
                const cur = question.value;
                question.value = (cur && cur.trim())
                    ? cur.replace(/\s+$/, '') + '\n\n' + text
                    : text;
                question.focus();
                question.selectionStart = question.selectionEnd = question.value.length;
                question.scrollTop = question.scrollHeight;
            }

            async function transcribeImageToInput(file) {
                showPreview(file);
                try {
                    const text = await transcribeImageWithVision(file);
                    clearPreview();
                    setBusy(false);
                    appendToQuestion(text);
                    setStatus('Vision transcription added to the input.');
                } catch (err) {
                    if (err.message === 'AUTH') return;
                    clearPreview();
                    setBusy(false);
                    setStatus('Vision transcription failed: ' + (err.message || err));
                }
            }

            async function handleImageWithVision(file, label) {
                if (imageModeSel.value !== 'solve') {
                    await transcribeImageToInput(file);
                    return;
                }
                showPreview(file);
                setStatus('Sending image to ' + visionSel.value + ' for solving...');
                try {
                    const dataUrl = await fileToDataURL(file);
                    clearPreview();
                    const prompt = "Read the question in the image carefully and answer the actual task, whatever its subject; do not assume it is a math problem. For English exercises, answer in natural English; otherwise follow the language of the question. Give the answer first, then a brief explanation. If it is mathematics, use LaTeX for formulas and geometry notation. Read labels carefully, and say when a diagram mark is unclear instead of guessing.";
                    addMessage('user', prompt + ' [' + label + ']');
                    await callGroq(prompt, prompt, visionSel.value, dataUrl);
                } catch (err) {
                    clearPreview();
                    if (err.message === 'AUTH') return;
                    setBusy(false);
                    setStatus('Could not send image to Vision: ' + (err.message || err));
                }
            }

            async function captureAndAsk() {
                if (busy || authState !== 'unlocked') return;
                setBusy(true);
                setStatus('Capturing screen...');

                let file;
                try {
                    const shot = await takeShot();
                    setStatus('Select the area to capture...');
                    const r = await selectRegionResizable(shot);
                    if (!r) { setStatus('Cancelled.'); setBusy(false); return; }

                    const rx = shot.width / innerWidth;
                    const ry = shot.height / innerHeight;
                    const out = document.createElement('canvas');
                    out.width = Math.round(r.w * rx);
                    out.height = Math.round(r.h * ry);
                    const g = out.getContext('2d');
                    g.fillStyle = '#fff'; g.fillRect(0, 0, out.width, out.height);
                    g.drawImage(shot,
                        Math.round(r.x * rx), Math.round(r.y * ry),
                        out.width, out.height,
                        0, 0, out.width, out.height);
                    file = await canvasToFile(out);
                } catch (err) {
                    setStatus('Capture failed: ' + (err.message || err));
                    setBusy(false);
                    return;
                }

                await handleImageWithVision(file, 'screenshot');
            }

            const capBtnEl = $('capBtn');
            if (capBtnEl) capBtnEl.onclick = () => captureAndAsk();

            // ── Scraper UI ────────────────────────────────────
            function typeLabel(type) {
                switch (type) {
                    case 'multiple':    return ' (chọn nhiều đáp án)';
                    case 'single':      return ' (chọn 1 đáp án)';
                    case 'fill-select': return ' (điền vào ô trống — chọn từ danh sách)';
                    case 'fill-input':  return ' (điền vào ô trống — nhập giá trị)';
                    case 'matching':    return ' (kéo đáp án vào ô trống — ghép cặp)';
                    default:            return '';
                }
            }

            function formatScrapeAsText(questions) {
                let s = '';
                questions.forEach(q => {
                    s += `Câu ${q.index}${typeLabel(q.type)}:\n`;
                    s += `${q.question}\n`;
                    if (q.type === 'matching' && q.prompts && q.prompts.length) {
                        q.prompts.forEach((p, i) => { s += `  ${i + 1}) ${p} [___]\n`; });
                        s += `Đáp án để kéo: `;
                        q.options.forEach((opt, i) => {
                            s += `${String.fromCharCode(65 + i)}. ${opt.text}`;
                            if (i < q.options.length - 1) s += '   ';
                        });
                        s += '\n\n';
                    } else {
                        q.options.forEach((opt, i) => {
                            s += `${String.fromCharCode(65 + i)}. ${opt.text}\n`;
                        });
                        s += '\n';
                    }
                });
                return s.trim();
            }

            function showScrapeActions(count) {
                const bar = $('scrapeActions');
                if (!bar) return;
                $('scrapeInfo').textContent = `📚 Đã điền ${count} câu hỏi`;
                bar.style.display = 'flex';
            }
            function hideScrapeActions() {
                const bar = $('scrapeActions');
                if (bar) bar.style.display = 'none';
            }

            function findVisibleQuestionDialog() {
                return Array.from(document.querySelectorAll('.MuiDialogContent-root')).find(el => {
                    const rect = el.getBoundingClientRect();
                    return rect.width > 0 && rect.height > 0 &&
                        el.querySelector('.tiptapRender.questionRender') &&
                        el.querySelectorAll('button').length >= 2;
                }) || null;
            }

            async function captureQuestionDialog(dialog) {
                if (typeof html2canvas !== 'function') throw new Error('html2canvas is unavailable');
                root.style.visibility = 'hidden';
                try {
                    await wait(80);
                    const shot = await html2canvas(dialog, {
                        useCORS: true, allowTaint: false, logging: false,
                        backgroundColor: '#ffffff',
                        scale: Math.min(window.devicePixelRatio || 1, 2),
                        imageTimeout: 5000,
                    });
                    return await canvasToFile(shot);
                } finally {
                    root.style.visibility = 'visible';
                }
            }

            async function doScrape(mode) {
                if (busy || authState !== 'unlocked') return;
                setBusy(true);
                try {
                    if (mode === 'all') {
                        const dialog = findVisibleQuestionDialog();
                        if (dialog) {
                            setStatus('Capturing the full question dialog...');
                            try {
                                const file = await captureQuestionDialog(dialog);
                                await handleImageWithVision(file, 'full Violympic question');
                            } catch (err) {
                                setStatus('Could not capture the dialog; switching to manual region selection.');
                                setBusy(false);
                                await captureAndAsk();
                            }
                            return;
                        }
                    }

                    let region = null;
                    if (mode === 'region') {
                        setStatus('Kéo chuột chọn vùng chứa câu hỏi...');
                        region = await selectRegionResizable(null);
                        if (!region) { setStatus('Đã huỷ chọn vùng.'); return; }
                    }

                    setStatus('Đang quét câu hỏi...');
                    const questions = scrapeQuestions(region);

                    if (!questions.length) {
                        setStatus(region ? '⚠️ Không tìm thấy câu hỏi trong vùng.' : '⚠️ Không tìm thấy câu hỏi trên trang.');
                        hideScrapeActions();
                        return;
                    }

                    const text = formatScrapeAsText(questions);
                    appendToQuestion(text);
                    showScrapeActions(questions.length);
                    setStatus(`✅ Đã lấy ${questions.length} câu hỏi.`);
                } catch (e) {
                    setStatus('Lỗi scrape: ' + (e.message || e));
                } finally {
                    setBusy(false);
                }
            }

            const scrapeBtnEl = $('scrapeBtn');
            if (scrapeBtnEl) scrapeBtnEl.onclick = () => doScrape('all');

            const copyScrapedBtnEl = $('copyScrapedBtn');
            if (copyScrapedBtnEl) copyScrapedBtnEl.onclick = () => {
                const text = question.value.trim();
                if (!text) { setStatus('Ô nhập đang trống.'); return; }
                navigator.clipboard.writeText(text)
                    .then(() => setStatus('✅ Đã copy.'))
                    .catch(() => setStatus('❌ Copy lỗi.'));
            };

            const sendScrapedBtnEl = $('sendScrapedBtn');
            if (sendScrapedBtnEl) sendScrapedBtnEl.onclick = () => {
                if (busy) return;
                hideScrapeActions();
                sendText();
            };

            const hideScrapeBtnEl = $('hideScrapeBtn');
            if (hideScrapeBtnEl) hideScrapeBtnEl.onclick = () => hideScrapeActions();

            // ── Paste image ───────────────────────────────────
            async function processPastedImage(blob) {
                if (busy || authState !== 'unlocked') return;
                setBusy(true);
                setStatus('Transcribing pasted image with Vision...');

                let file;
                try {
                    const img = await loadImageFromFile(blob);
                    const c = document.createElement('canvas');
                    c.width = img.naturalWidth || img.width;
                    c.height = img.naturalHeight || img.height;
                    if (!c.width || !c.height) throw new Error('Ảnh không hợp lệ.');
                    const g = c.getContext('2d');
                    g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height);
                    g.drawImage(img, 0, 0);
                    file = await canvasToFile(c);
                } catch (err) {
                    setBusy(false);
                    setStatus('Lỗi đọc ảnh dán: ' + (err.message || err));
                    return;
                }

                await handleImageWithVision(file, 'pasted image');
            }

            document.addEventListener('paste', e => {
                if (authState !== 'unlocked') return;
                if (busy) return;
                const cd = e.clipboardData;
                if (!cd) return;
                const items = cd.items || [];
                let imgFile = null;
                for (const it of items) {
                    if (it.kind === 'file' && it.type && it.type.startsWith('image/')) {
                        imgFile = it.getAsFile();
                        if (imgFile) break;
                    }
                }
                if (!imgFile) return;
                e.preventDefault(); e.stopPropagation();
                openPanel();
                processPastedImage(imgFile);
            }, true);

            // ── Send text ─────────────────────────────────────
            function sendText() {
                if (busy || authState !== 'unlocked') return;
                hideScrapeActions();
                const raw = question.value.trim();
                if (!raw) return;
                clearPreview();
                addMessage('user', raw);
                question.value = '';
                callGroq(raw, raw, modelSel.value);
            }
            const sendBtnEl = $('sendBtn');
            if (sendBtnEl) sendBtnEl.onclick = sendText;
            question.addEventListener('keydown', e => {
                if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendText(); }
            });

            const clearBtnEl = $('clearBtn');
            if (clearBtnEl) clearBtnEl.onclick = () => {
                if (busy) return;
                hideScrapeActions();
                history = [];
                saveChatHistory(history);
                messages.replaceChildren();
                clearPreview();
                setStatus('Đã xóa cuộc trò chuyện.');
            };

            // ── MutationObserver ──────────────────────────────
            try {
                const mo = new MutationObserver(() => {
                    if (!document.documentElement.contains(root)) {
                        try { (document.body || document.documentElement).appendChild(root); } catch (_) {}
                    }
                });
                mo.observe(document.documentElement, { childList: true, subtree: false });
            } catch (_) {}

            console.log('[IOE AI V10.1] Khởi tạo hoàn tất · Auth:', authState,
                '· KaTeX:', typeof renderMathInElement === 'function' ? 'OK' : 'FAIL',
                '· html2canvas:', typeof html2canvas === 'function' ? 'OK' : 'FAIL');
        } catch (e) {
            console.error('[IOE AI V10.1] start() FATAL:', e);
            showFatal('start() failed: ' + (e.message || e));
        }
    }

    function boot() {
        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', start, { once: true });
        } else {
            start();
        }
        window.addEventListener('load', start, { once: true });
        setTimeout(() => {
            if (!document.getElementById('ioe-ai-root')) start();
        }, 2000);
    }
    boot();
})();
