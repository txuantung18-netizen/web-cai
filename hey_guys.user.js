// ==UserScript==
// @name         Trợ lý học tập - IOE / VioEdu / Violympic
// @namespace    https://ioe.vn/
// @version      14.1.0
// @description  Qwen/Gemini Vision, side-by-side image review, study commands, notebooks and readable chat
// @updateURL    https://raw.githubusercontent.com/txuantung18-netizen/web-cai/main/hey_guys.user.js
// @downloadURL  https://raw.githubusercontent.com/txuantung18-netizen/web-cai/main/hey_guys.user.js
// @match        *://ioe.vn/*
// @match        *://*.ioe.vn/*
// @match        *://vio.edu.vn/*
// @match        *://*.vio.edu.vn/*
// @match        *://violympic.vn/*
// @match        *://*.violympic.vn/*
// @match        https://api-groq-two.vercel.app/user*
// @require      https://cdnjs.cloudflare.com/ajax/libs/html2canvas/1.4.1/html2canvas.min.js
// @require      https://cdn.jsdelivr.net/npm/katex@0.19.1/dist/katex.min.js
// @require      https://cdn.jsdelivr.net/npm/katex@0.19.1/dist/contrib/auto-render.min.js
// @run-at       document-idle
// @noframes
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_xmlhttpRequest
// @connect      images1.violympic.vn
// ==/UserScript==

(function () {
    'use strict';

    if (window.__IOE_AI_V10__) return;
    window.__IOE_AI_V10__ = true;

    console.log('[IOE AI V10.1] Script bắt đầu load...');

    const BACKEND_URL = 'https://api-groq-two.vercel.app';
    const APP_VERSION = '14.1.0';
    const STUDY_COMMANDS = [
        { name: 'gợi-ý', mode: 'hint', label: 'Chỉ gợi ý', description: 'Một vài gợi mở, không đưa đáp án hay lời giải đầy đủ.' },
        { name: 'giải-thích', mode: 'explain', label: 'Giải thích', description: 'Làm rõ khái niệm bằng lời dễ hiểu và ví dụ.' },
        { name: 'kiểm-tra', mode: 'check', label: 'Kiểm tra bài làm', description: 'Tìm bước sai trong lời giải bạn đã thử.' },
        { name: 'tóm-tắt', mode: 'summarize', label: 'Tóm tắt', description: 'Rút ra các ý chính từ nội dung bạn cung cấp.' },
        { name: 'giải', mode: 'solve', label: 'Giải bài', description: 'Đưa kết quả và các bước giải chính.' },
    ];
    const commandKey = text => String(text).normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/đ/g, 'd').toLowerCase();
    function parseStudyCommand(text) {
        const raw = String(text).trim();
        if (!raw.startsWith('/')) return { mode: 'normal', content: raw };
        const match = raw.match(/^\/([^\s]*)\s*([\s\S]*)$/);
        const command = STUDY_COMMANDS.find(item => commandKey(item.name) === commandKey(match?.[1] || ''));
        if (!command) return { error: 'Lệnh chưa được hỗ trợ. Gõ / để chọn gợi ý, giải thích, kiểm tra, tóm tắt hoặc giải.' };
        if (!match[2].trim()) return { error: `Nhập nội dung sau /${command.name}.`, command };
        return { mode: command.mode, content: match[2].trim(), command };
    }
    const TOKEN_KEY = 'ioe_ai_auth_token_v2';
    const DEVICE_ID_KEY = 'ioe_ai_installation_id_v1';
    const SIGNED_OUT_MARKER = '__IOE_AI_SIGNED_OUT__';
    const AUTH_LOCK_KEY = 'ioe_ai_auth_lock_until';
    const AUTH_LOCK_MS = 24 * 60 * 60 * 1000;

    let deviceIdPromise;
    function makeDeviceId() {
        if (crypto.randomUUID) return crypto.randomUUID();
        return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
            const r = crypto.getRandomValues(new Uint8Array(1))[0] & 15;
            return (c === 'x' ? r : (r & 3) | 8).toString(16);
        });
    }
    function getInstallationId() {
        if (!deviceIdPromise) deviceIdPromise = (async () => {
            const valid = value => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value);
            let id = '';
            try {
                if (typeof GM_getValue === 'function') id = await GM_getValue(DEVICE_ID_KEY, '');
            } catch (_) {}
            if (!valid(id)) {
                try { id = localStorage.getItem(DEVICE_ID_KEY) || ''; } catch (_) {}
            }
            if (!valid(id)) id = makeDeviceId();
            try {
                if (typeof GM_setValue !== 'function') throw new Error('Cần cài bằng Tampermonkey để lưu phiên an toàn.');
                await GM_setValue(DEVICE_ID_KEY, id);
                try { localStorage.removeItem(DEVICE_ID_KEY); } catch (_) {}
            } catch (error) { throw new Error('Không thể lưu thiết bị an toàn. Kiểm tra Tampermonkey.'); }
            return id;
        })();
        return deviceIdPromise;
    }

    const MODELS = [
        ['openai/gpt-oss-120b', 'GPT-OSS 120B'],
        ['qwen/qwen3.8-27b', 'Qwen 3.8 27B'],
        ['openai/gpt-oss-20b', 'GPT-OSS 20B'],
        ['gemini-3.8-flash', 'Gemini 3.8 Flash'],
    ];
    // Keep the dropdown order unchanged, but use Qwen as the initial model.
    const DEFAULT_MODEL = 'qwen/qwen3.8-27b';
    const MULTI_AGENT_DAILY_LIMIT = 3;
    const CHAT_HISTORY_KEY = 'ioeai_chat_history_v1';
    const CHAT_HISTORY_MAX = 40;
    const CHAT_CONTEXT_MAX = 10;
    const STUDY_DATA_KEY = 'ioeai_study_space_v1';
    const MAX_SESSIONS = 20;
    const MAX_MISTAKES = 100;
    const safeThumbnail = image => typeof image === 'string' && image.length < 300000 && /^data:image\/jpeg;base64,/i.test(image) ? image : '';

    function freshSession(title = 'Hội thoại mới', messages = [], draft = '') {
        return { id: makeDeviceId(), title, subject: 'Khác', pinned: false, messages, draft, updatedAt: Date.now() };
    }
    function loadStudySpace() {
        try {
            const saved = JSON.parse(localStorage.getItem(STUDY_DATA_KEY) || 'null');
            if (saved && saved.version === 1 && Array.isArray(saved.sessions) && saved.sessions.length) {
                const sessions = saved.sessions.filter(s => s && typeof s.id === 'string' && typeof s.title === 'string' && Array.isArray(s.messages))
                    .slice(0, MAX_SESSIONS).map(s => ({ ...s, title: s.title.slice(0, 80), subject: String(s.subject || 'Khác').slice(0, 40),
                        draft: typeof s.draft === 'string' ? s.draft.slice(0, 16000) : '', draftImage: safeThumbnail(s.draftImage),
                        messages: s.messages.filter(m => m && ['user', 'assistant'].includes(m.role) && typeof m.content === 'string').slice(-CHAT_HISTORY_MAX)
                            .map(m => ({ role: m.role, content: m.content.slice(0, 60000), ...(safeThumbnail(m.image) ? { image: m.image, caption: String(m.caption || '').slice(0, 16000) } : {}) })) }));
                if (sessions.length) return { version: 1, activeId: sessions.some(s => s.id === saved.activeId) ? saved.activeId : sessions[0].id,
                    sessions, mistakes: Array.isArray(saved.mistakes) ? saved.mistakes.filter(m => m && typeof m.id === 'string' && typeof m.question === 'string' && typeof m.answer === 'string').slice(0, MAX_MISTAKES) : [] };
            }
        } catch (_) {}
        // The legacy history and draft remain untouched as a migration backup.
        const legacy = loadChatHistory();
        const session = freshSession(legacy.length ? 'Lịch sử trước đây' : 'Hội thoại mới', legacy, localStorage.getItem('ioeai_draft') || '');
        return { version: 1, activeId: session.id, sessions: [session], mistakes: [] };
    }
    const VISION_MODELS = [
        ['qwen/qwen3.8-27b', 'Qwen 3.8 27B Vision'],
        ['gemini-3.8-flash', 'Gemini 3.8 Flash Vision'],
    ];

    const SYSTEM_PROMPT = `You are a helpful study assistant and conversational partner. First identify what the user wants. Solve a problem only when the user asks to solve/calculate/prove/answer an exercise, or the image clearly contains a school exercise. For concept questions (for example, “What is F?”), general questions, greetings, opinions, and ordinary conversation, respond naturally to that request; do not turn it into a fabricated exercise or force an answer-plus-solution format. If intent is ambiguous, answer the most likely conversational request and ask a brief clarifying question only when needed. When solving an exercise, give the result first and then the key reasoning at an appropriate level.

Identify the subject and follow the language and instructions of the question: answer English exercises in natural English and Vietnamese questions in Vietnamese.

Mathematics and notation:
- Write formulas as math, never inline code or fenced code. Use a single backslash for LaTeX commands and delimiters; do not append a lone backslash at the end of a line.
- Use correct LaTeX for every mathematical expression and geometry symbol: \\(...\\) inline, \\[...\\] on a separate display line. Keep ordinary prose outside math delimiters.
- Explain unfamiliar notation when it first matters. State what a function's input means, its domain, and which symbols are fixed parameters versus variables. For example, in F(n)=2T_n(t), n is the integer input/index, t is a fixed real parameter, T_n is the degree-n Chebyshev polynomial, and F is the function of n obtained by evaluating 2T_n at t.
- Check domains, absolute values, indices, and conditions before manipulating formulas. Do not silently change a-b into |a-b| unless the stated definition or a justified property permits it; if extending Chebyshev indices to negative integers, explicitly use and justify T_{-n}=T_n.

Diagrams and geometry:
- When a diagram matters, give a compact, structured description of its labels, objects, incidences, and explicitly marked properties before relying on it. Name the figure correctly: three vertices make a triangle (for example, triangle ABC); four make a quadrilateral ABCD. Do not call ABCD a triangle.
- Separate what the text/diagram explicitly states from what follows by a valid theorem. Never infer equal lengths, equal angles, parallelism, perpendicularity, cyclicity, or a special quadrilateral merely because the drawing looks that way. Equality needs matching marks, stated data, or a theorem whose hypotheses have been established.
- Use precise notation such as \\angle ABC, \\overline{AB}, AB\\perp CD, and AB\\parallel CD. If a label, incidence, or mark is unclear, say it is unclear and do not guess.

Presentation:
- Use a Markdown table for aligned data, comparing several cases, or showing a multi-step value table; keep a short answer in prose when a table would add clutter.
- Use headings and numbered steps for multi-part reasoning, and concise bullets for lists. Preserve the question's symbols and units. Never split labels or words into one character per line.`;

    const PROMPT = "Respond to the user's actual intent in their language. Solve only when they ask for an exercise to be solved; answer concept questions and ordinary chat naturally. Define unfamiliar symbols/functions when relevant. For diagrams, use only supported labels and properties; never infer equality from appearance. Use a Markdown table when it clarifies comparisons or data.";

    const wait = ms => new Promise(r => setTimeout(r, ms));

    // ═══════════════════════════════════════════════════════════════
    // TOKEN HELPERS
    // ═══════════════════════════════════════════════════════════════
    async function getToken() {
        try {
            if (typeof GM_getValue === 'function') {
                const shared = await GM_getValue(TOKEN_KEY, null);
                if (shared === SIGNED_OUT_MARKER) return '';
                if (shared) { try { localStorage.removeItem(TOKEN_KEY); } catch (_) {} return shared; }
            }
        } catch (_) {}
        try {
            const local = localStorage.getItem(TOKEN_KEY) || '';
            // Migrate existing per-site sessions to Tampermonkey's shared script storage.
            if (local && typeof GM_setValue === 'function') {
                await GM_setValue(TOKEN_KEY, local);
                localStorage.removeItem(TOKEN_KEY);
                return local;
            }
            return '';
        } catch (_) { return ''; }
    }
    async function setToken(t) {
        if (typeof GM_setValue !== 'function') throw new Error('Cần Tampermonkey để lưu phiên an toàn.');
        await GM_setValue(TOKEN_KEY, t);
        try { localStorage.removeItem(TOKEN_KEY); } catch (_) {}
    }
    async function clearToken() {
        try {
            if (typeof GM_setValue === 'function') await GM_setValue(TOKEN_KEY, SIGNED_OUT_MARKER);
        } catch (_) {}
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
            return saved.filter(m => m && ['user', 'assistant'].includes(m.role) && typeof m.content === 'string')
                .slice(-CHAT_HISTORY_MAX)
                .map(m => ({
                    role: m.role,
                    content: m.role === 'user' && /^Read the question in the image carefully[\s\S]*\[(?:screenshot|pasted image|full Violympic question)\]$/i.test(m.content)
                        ? 'Ảnh câu hỏi đã gửi.' : m.content,
                    ...(typeof m.image === 'string' && /^data:image\/jpeg;base64,/i.test(m.image) ? { image: m.image } : {}),
                    ...(typeof m.caption === 'string' ? { caption: m.caption.slice(0, 4000) } : {}),
                }));
        } catch (_) { return []; }
    }

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
    async function start() {
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
            <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/katex@0.19.1/dist/katex.min.css">
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
              .msg-image { display:block;width:auto;max-width:min(100%,360px);max-height:320px;object-fit:contain;border-radius:8px;background:#ffffff24; }
              .msg-caption { margin-top:7px;white-space:pre-wrap;overflow-wrap:anywhere; }
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
              /* Taipei study room: warm paper, jade ink and a small vermilion seal. */
              #panel,#lockBox,#infoBox{--paper:#f7f4ed;--surface:#fffdf8;--ink:#253e35;--muted:#747e72;--edge:#dedfd2;--jade:#315c4d;--soft:#e8eee4;--seal:#bf6248;font-family:Inter,"Segoe UI",system-ui,sans-serif}
              #panel[data-theme="dark"],#infoBox[data-theme="dark"]{--paper:#18251f;--surface:#203028;--ink:#e9eee1;--muted:#a5b29f;--edge:#3b4b3d;--jade:#9dc6a3;--soft:#2b3c30;--seal:#e49a79;color-scheme:dark}
              #panel{width:470px;height:760px;border:1px solid var(--edge);border-radius:24px;background:var(--paper);color:var(--ink);box-shadow:0 24px 80px #1d352b30;font-size:14px}
              #head{padding:19px 20px 15px;background:var(--surface);color:var(--ink);border-bottom:1px solid var(--edge);gap:8px}
              .studio-brand{display:flex;align-items:center;gap:11px}.studio-seal{display:grid;place-items:center;width:36px;height:39px;border:1px solid var(--seal);border-radius:7px;color:var(--seal);font:700 22px Georgia,serif;transform:rotate(-4deg)}
              .studio-brand b{display:block;font-size:16px;letter-spacing:-.4px}.studio-brand small{display:block;color:var(--muted);font-size:9px;letter-spacing:1.7px;margin-top:3px}
              #head button{color:var(--ink);width:28px;height:30px;font-size:17px;border-radius:8px}#head button:hover{background:var(--soft)}
              .studio-tools{padding:10px 16px;display:flex;gap:6px;border-bottom:1px solid var(--edge);align-items:center;background:var(--surface)}
              .studio-tools button,.quick-prompts button,.copy-answer{border:1px solid var(--edge);background:var(--surface);color:var(--ink);border-radius:8px;padding:6px 9px;cursor:pointer;font:11px "Segoe UI",sans-serif}
              .studio-tools button:hover,.quick-prompts button:hover,.copy-answer:hover{background:var(--soft);border-color:var(--jade)}
              #accountUsage{margin-left:auto;color:var(--muted);font-size:10px;max-width:150px;text-align:right;line-height:1.45}
              #historySearch{width:calc(100% - 32px);margin:10px 16px 0;border:1px solid var(--edge);border-radius:9px;background:var(--surface);color:var(--ink);padding:9px 11px;font:12px "Segoe UI",sans-serif;outline:none}
              #messages{padding:14px 18px;background:var(--paper);scroll-behavior:smooth;scrollbar-width:thin;scrollbar-color:var(--edge) transparent}
              .welcome{padding:20px 4px 12px}.welcome .eyebrow{font-size:10px;letter-spacing:2px;color:var(--seal)}.welcome h2{font:500 34px/1.12 Georgia,"Times New Roman",serif;letter-spacing:-1px;color:var(--ink);margin:12px 0}.welcome p{font-size:12px;line-height:1.8;color:var(--muted);max-width:300px}
              .quick-prompts{display:flex;flex-wrap:wrap;gap:7px;margin-top:14px}.welcome-rule{height:1px;background:var(--edge);margin:20px 0 0}
              .msg{max-width:98%;padding:13px 14px;border-radius:14px;margin:12px 0;line-height:1.7;font-size:13px;white-space:normal}
              .user{background:var(--soft);color:var(--ink);border:1px solid var(--edge);border-bottom-right-radius:4px;margin-left:26px}
              .bot{background:var(--surface);border:1px solid var(--edge);border-bottom-left-radius:4px;margin-right:8px}
              .msg th,.msg td{border-color:var(--edge)}.msg th,.msg code,.msg blockquote{background:var(--soft);color:var(--ink)}.msg a{color:var(--seal)}.copy-answer{display:block;margin-top:10px;padding:3px 8px;color:var(--muted);font-size:10px}
              #inputArea{padding:12px 15px 13px;background:var(--surface);border-top:1px solid var(--edge)}
              #status{font-size:10px;color:var(--muted);min-height:17px;margin-bottom:5px}#advancedControls{background:var(--paper);border:1px solid var(--edge);padding:9px;border-radius:12px;margin:8px 0}#advancedControls[hidden]{display:none}
              #panel .lbl,#panel .chk{color:var(--muted);font-size:11px}#panel select{background:var(--surface);color:var(--ink);border-color:var(--edge);font:11px "Segoe UI",sans-serif;padding:8px}
              #panel textarea{background:var(--paper);color:var(--ink);border:1px solid var(--edge);border-radius:12px;min-height:74px;padding:12px;font:13px/1.6 "Segoe UI",sans-serif;resize:vertical;margin-top:4px}#panel textarea:focus,#historySearch:focus{border-color:var(--jade);box-shadow:0 0 0 3px #84a78c20}
              #panel button.b{background:var(--soft);color:var(--ink);font:600 11px "Segoe UI",sans-serif;padding:10px 7px;border:1px solid var(--edge);border-radius:9px}#panel #sendBtn{background:#315c4d;color:#fff;border-color:#315c4d;flex:1.5}#panel #stopBtn{background:#bf6248;color:white}#panel #clearBtn{background:transparent;color:var(--muted)}
              .composer-note{display:flex;justify-content:space-between;margin-top:7px;color:var(--muted);font-size:9px;letter-spacing:.15px}#launcher{background:#315c4d;border:1px solid #73917b;border-radius:18px;font:700 25px Georgia,serif;box-shadow:0 8px 30px #203c3540;width:54px;height:54px}
              #lockView{background:#15282090;backdrop-filter:blur(7px)}#lockBox{width:380px;border-radius:22px;background:var(--paper);color:var(--ink);padding:30px;border-color:var(--edge)}#lockTitle{font:500 29px Georgia,serif;color:var(--ink)}#lockSub{color:var(--muted);margin-top:13px;font-family:"Segoe UI",sans-serif}#unlockBtn{background:#315c4d}#codeInput{background:var(--surface);border:1px solid var(--edge);font-family:"Segoe UI",sans-serif}
              #infoModal{background:#15282090;backdrop-filter:blur(8px);padding:20px}
              #infoBox{width:660px;max-height:88dvh;border:1px solid var(--edge);border-radius:24px;background:var(--paper);color:var(--ink);font:13px/1.75 "Segoe UI",system-ui,sans-serif;box-shadow:0 28px 90px #12291e40}
              #infoHeader{padding:20px 24px;background:var(--surface);color:var(--ink);border-bottom:1px solid var(--edge)}#infoHeader strong{display:block;font-size:16px;letter-spacing:-.3px}.info-eyebrow{font-size:9px;letter-spacing:2px;color:var(--seal);margin-bottom:3px}#closeInfoBtn{width:32px;height:32px;color:var(--ink);border:1px solid var(--edge);border-radius:9px;font-size:21px}#closeInfoBtn:hover{background:var(--soft)}
              #infoTabs{gap:8px;padding:12px 24px;background:var(--surface);border-color:var(--edge)}.infoTab{border:1px solid transparent;border-radius:8px;padding:7px 12px;color:var(--muted);font:600 12px "Segoe UI",sans-serif}.infoTab.active{background:var(--soft);border-color:var(--edge);color:var(--ink)}
              #infoBody{padding:24px;scrollbar-width:thin;scrollbar-color:var(--edge) transparent}.release-meta{display:flex;gap:8px;align-items:center;flex-wrap:wrap;font-size:10px;color:var(--muted)}.release-version{border:1px solid var(--edge);background:var(--soft);color:var(--jade);border-radius:6px;padding:3px 8px;font-weight:700}.release-hero h3{font:500 34px/1.18 Georgia,"Times New Roman",serif;letter-spacing:-.7px;margin:16px 0 10px;color:var(--ink)}.release-hero p{color:var(--muted);max-width:460px;line-height:1.85}
              .release-grid{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin:22px 0}.release-card{border:1px solid var(--edge);border-radius:13px;padding:16px;background:var(--surface)}.release-card .release-number{font-size:10px;letter-spacing:1px;color:var(--seal)}.release-card h4{font-size:13px;margin:7px 0 5px;color:var(--ink)}.release-card p{font-size:12px;color:var(--muted);line-height:1.75;margin:0}
              .release-note{border-left:2px solid var(--seal);padding:5px 12px;color:var(--muted);font-size:11px;margin:18px 0}.release-history{border-top:1px solid var(--edge);padding-top:16px;margin-top:20px}.release-history summary{cursor:pointer;font-weight:600;font-size:12px;color:var(--ink)}.release-history ul{padding-left:20px;color:var(--muted);font-size:12px}.infoSection>h3{font-size:17px;color:var(--ink);margin:8px 0 12px}.infoSection>ul,.infoSection>ol,.infoSection>p{color:var(--muted)}.infoSection li{margin:8px 0}.info-footer{padding:12px 24px;border-top:1px solid var(--edge);background:var(--surface);display:flex;justify-content:space-between;gap:12px;color:var(--muted);font-size:10px}
              @media(max-width:520px){#infoModal{padding:10px}#infoBox{border-radius:18px;max-height:92dvh}#infoHeader{padding:16px}#infoTabs{padding:10px 16px}#infoBody{padding:18px 16px}.release-grid{grid-template-columns:1fr}.release-hero h3{font-size:29px}.info-footer{padding:12px 16px}}
              .session-bar{display:flex;gap:6px;padding:8px 15px;background:var(--surface);border-bottom:1px solid var(--edge);align-items:center}.session-bar select{min-width:0!important;font:11px "Segoe UI",sans-serif!important}.session-bar button,.study-button{border:1px solid var(--edge);background:var(--soft);color:var(--ink);border-radius:8px;padding:7px 9px;cursor:pointer;font:11px "Segoe UI",sans-serif;white-space:nowrap}
              #libraryPane{flex:1;min-height:0;overflow:auto;background:var(--paper);padding:16px}#libraryPane[hidden],.review-pane[hidden]{display:none}.library-head{display:flex;align-items:center;justify-content:space-between;margin-bottom:13px}.library-head h3{margin:0;font-size:17px;letter-spacing:-.5px}.study-muted{font-size:11px;color:var(--muted);line-height:1.7}.study-card{border:1px solid var(--edge);background:var(--surface);border-radius:12px;padding:13px;margin:10px 0}.study-card h4{font-size:13px;margin:0 0 5px;overflow-wrap:anywhere}.study-form label{display:block;font-size:11px;color:var(--muted);margin:9px 0 4px}.study-form input,.study-form select,.study-search{width:100%;background:var(--surface);color:var(--ink);border:1px solid var(--edge);border-radius:8px;padding:9px;font:12px "Segoe UI",sans-serif}.study-form textarea{height:90px!important;min-height:70px!important;max-height:240px!important}.study-actions{display:flex;gap:6px;flex-wrap:wrap;margin-top:10px}.study-button.primary{background:#315c4d;color:white;border-color:#315c4d}.study-button.danger{color:var(--seal)}.study-card details{font-size:12px;overflow-wrap:anywhere}.study-card summary{cursor:pointer;color:var(--jade)}.study-card pre{white-space:pre-wrap;font:12px/1.7 "Segoe UI",sans-serif;color:var(--ink)}.mistake-image{display:block;max-width:100%;max-height:130px;border-radius:8px;margin:8px 0}.message-actions{display:flex;gap:6px;flex-wrap:wrap}.message-actions .copy-answer{display:inline-block}
              .review-pane{position:absolute;inset:0;z-index:4;background:var(--paper);color:var(--ink);display:flex;flex-direction:column;padding:18px;overflow:auto}.review-pane h3{font:500 25px Georgia,serif;margin:0}.review-pane img{display:block;max-width:100%;max-height:210px;object-fit:contain;flex-shrink:0;background:white;border:1px solid var(--edge);border-radius:10px;margin:12px 0}.review-pane label{font-size:11px;color:var(--muted)}#panel #reviewText{flex:1;min-height:120px;max-height:none;resize:none;background:var(--surface)}#reviewMessage{color:var(--seal);font-size:11px;min-height:18px;margin-top:6px}
              .study-exercise{font-size:12px;overflow-wrap:anywhere;line-height:1.75}.study-exercise p{margin:7px 0}.study-exercise .katex-display{overflow-x:auto;overflow-y:hidden;padding:4px 0}.message-actions{align-items:center}
              #inputArea{position:relative}.composer-status-row{display:flex;align-items:center;gap:8px}.composer-status-row #status{flex:1}.command-trigger{border:1px solid var(--edge);border-radius:7px;background:var(--soft);color:var(--ink);font:11px "Segoe UI",sans-serif;padding:4px 8px;cursor:pointer}.mode-pill{display:inline-flex;border:1px solid var(--edge);color:var(--jade);background:var(--soft);padding:3px 7px;border-radius:6px;font-size:10px;margin:5px 0}.mode-pill[hidden]{display:none}
              #advancedControls{max-height:240px;overflow:auto;scrollbar-width:thin}.row select{min-width:0}
              #panel{width:680px;height:840px;max-width:calc(100vw - 28px);max-height:calc(100dvh - 102px)}#panel.expanded{left:18px!important;right:18px!important;top:16px!important;bottom:84px!important;width:auto!important;height:auto!important;max-width:none!important;max-height:none!important;margin:0 auto}#panel.expanded #messages{padding-left:max(24px,calc((100% - 960px)/2));padding-right:max(24px,calc((100% - 960px)/2))}#panel.expanded #inputArea{padding-left:max(18px,calc((100% - 960px)/2));padding-right:max(18px,calc((100% - 960px)/2))}#panel.expanded #commandMenu{left:max(18px,calc((100% - 960px)/2));right:max(18px,calc((100% - 960px)/2))}
              .review-columns{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:16px;flex:1;min-height:0;margin-top:12px}.review-source,.review-editor{min-width:0;display:flex;flex-direction:column;min-height:0}.review-source{overflow:auto}.review-column-label{font-size:10px;letter-spacing:1px;color:var(--muted);margin-bottom:8px}.review-pane .review-source img{max-height:none;width:100%;height:auto;object-fit:contain;margin:0;background:#fff}.review-editor #reviewText{width:100%;height:100%;margin:0;flex:1;min-height:180px}#panel .msg table{display:table;width:auto;min-width:40%;max-width:100%;font-size:inherit}.msg{overflow-x:auto}.review-pane{padding:22px}
              .review-editor-toolbar{display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap;margin-bottom:8px}.review-editor-toolbar .review-column-label{margin:0}.review-formatted{flex:1;min-height:180px;overflow:auto;border:1px solid var(--edge);background:var(--surface);padding:12px;border-radius:12px}.review-formatted[hidden]{display:none}.review-formatted table{border-collapse:collapse;min-width:100%;font-size:inherit}.review-formatted th,.review-formatted td{border:1px solid var(--edge);padding:8px;text-align:left}.review-formatted th{background:var(--soft)}
              @media(max-width:700px){#panel{width:calc(100vw - 16px);max-width:calc(100vw - 16px);right:8px;bottom:78px;min-width:0;max-height:calc(100dvh - 90px)}#panel.expanded{left:8px!important;right:8px!important;top:8px!important;bottom:78px!important}.review-columns{display:flex;flex-direction:column;overflow:auto;min-height:210px}.review-source{flex:none;max-height:180px}.review-pane .review-source img{max-height:150px;object-fit:contain}.review-editor{flex:1;min-height:180px}.review-pane{padding:14px}#panel.expanded #messages{padding:12px}#panel.expanded #inputArea{padding:12px}#panel.expanded #commandMenu{left:12px;right:12px}}
              #commandMenu{position:absolute;left:15px;right:15px;bottom:calc(100% - 5px);z-index:6;padding:7px;background:var(--surface);border:1px solid var(--edge);border-radius:13px;box-shadow:0 14px 40px #18342625;max-height:min(390px,50dvh);overflow:auto}#commandMenu[hidden]{display:none}.command-menu-note{font-size:9px;color:var(--muted);padding:5px 8px}.command-option{display:block;width:100%;text-align:left;border:1px solid transparent;border-radius:8px;background:transparent;color:var(--ink);padding:9px;cursor:pointer}.command-option strong{display:block;font:600 12px "Segoe UI",sans-serif}.command-option small{display:block;color:var(--muted);font:10px/1.6 "Segoe UI",sans-serif;margin-top:3px}.command-option[aria-selected="true"]{background:var(--soft);border-color:var(--edge)}
              #panel .msg,#panel .study-exercise,#panel #question,#panel #reviewText,#panel .study-form textarea{font-size:var(--reader-size,14px)}
              .corner-scene{position:fixed;right:14px;bottom:14px;width:90px;height:112px;pointer-events:none;z-index:2147483647}.corner-scene[hidden]{display:none}.corner-scene #launcher{position:absolute;right:4px;bottom:4px;width:60px;height:58px;padding:7px;border-radius:19px;background:#fffaf0;border:1px solid #9fb29c;box-shadow:0 8px 28px #244c3933;transition:transform .2s ease,box-shadow .2s ease}.corner-scene #launcher:hover{transform:translateY(-3px);box-shadow:0 12px 30px #244c3944}.book-icon{width:44px;height:44px;display:block;margin:auto;transform-origin:50% 85%;animation:book-sway 4.2s ease-in-out infinite}.book-spark{position:absolute;right:5px;top:2px;color:#bf6248;font-size:13px;animation:spark-breathe 3s ease-in-out infinite}
              .petal{position:absolute;left:17px;top:5px;width:11px;height:7px;border-radius:90% 12% 85% 15%;background:#e9a7ac;opacity:0;animation:petal-drift 8s linear infinite}.petal:nth-child(2){left:50px;top:0;width:9px;height:6px;background:#f1c4c3;animation-delay:-2.2s;animation-duration:10s}.petal:nth-child(3){left:34px;top:12px;animation-delay:-4.6s;animation-duration:9s}.petal:nth-child(4){left:70px;top:4px;width:8px;height:5px;background:#d88d99;animation-delay:-6s;animation-duration:11s}.petal:nth-child(5){left:5px;top:23px;width:8px;height:5px;background:#f1c4c3;animation-delay:-3.7s;animation-duration:9.5s}
              .petal:nth-child(6){left:61px;top:20px;width:7px;height:5px;background:#efb6bd;animation-delay:-7.2s;animation-duration:12s}
              @keyframes petal-drift{0%{opacity:0;transform:translate(12px,-8px) rotate(-20deg)}15%{opacity:.7}45%{transform:translate(-9px,30px) rotate(100deg)}80%{opacity:.45}100%{opacity:0;transform:translate(15px,83px) rotate(230deg)}}@keyframes book-sway{0%,100%{transform:rotate(-5deg) translateY(0)}50%{transform:rotate(5deg) translateY(-2px)}}@keyframes spark-breathe{0%,100%{opacity:.45;transform:scale(.85)}50%{opacity:1;transform:scale(1.1)}}@keyframes paper-appear{from{opacity:0;transform:translateY(5px)}to{opacity:1;transform:translateY(0)}}
              #panel .msg,.welcome,#libraryPane,#infoBox,#commandMenu{animation:paper-appear .2s ease-out}.study-card,.study-button,.studio-tools button{transition:background .16s ease,border-color .16s ease,transform .16s ease}.study-card:hover{border-color:var(--jade)}
              #head{position:relative;isolation:isolate;background:linear-gradient(125deg,var(--surface),var(--soft));border-bottom:1px solid var(--edge)}#head:after{content:'';position:absolute;right:100px;top:9px;width:64px;height:2px;border-radius:100%;background:var(--jade);opacity:.35;animation:ink-line 1s ease-out both;pointer-events:none}
              #panel{box-shadow:0 24px 80px #173e3426,0 2px 12px #173e3414}#inputArea{background:linear-gradient(180deg,var(--surface),var(--paper))}#panel textarea{transition:border-color .2s ease,box-shadow .2s ease}#panel textarea:focus{box-shadow:0 0 0 3px #84a78c24,0 5px 20px #18342609}
              #commandMenu{counter-reset:command;background:var(--paper)}.command-option{position:relative;padding:11px 12px 11px 48px;min-height:62px;transition:background .18s ease,border-color .18s ease,transform .18s ease;animation:command-arrive .22s ease-out both}.command-option:before{counter-increment:command;content:'0' counter(command);position:absolute;left:12px;top:15px;width:26px;height:26px;border:1px solid var(--edge);border-radius:8px;display:grid;place-items:center;font:12px Georgia,serif;color:var(--jade);background:var(--surface)}.command-option:nth-child(2){animation-delay:.025s}.command-option:nth-child(3){animation-delay:.05s}.command-option:nth-child(4){animation-delay:.075s}.command-option:nth-child(5){animation-delay:.1s}.command-option:hover{background:var(--soft)}.command-option[aria-selected="true"]:before{background:var(--jade);color:var(--paper)}
              .study-button:active,.studio-tools button:active,.command-trigger:active{transform:scale(.97)}.review-pane{animation:review-arrive .25s ease-out}.review-source img{animation:paper-appear .3s ease-out}button:focus-visible,select:focus-visible,a:focus-visible{outline:2px solid var(--jade);outline-offset:3px}.session-bar{gap:7px}.session-bar select{min-width:0;flex:1}
              @keyframes command-arrive{from{opacity:0;transform:translateY(5px)}to{opacity:1;transform:translateY(0)}}@keyframes review-arrive{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:translateY(0)}}@keyframes ink-line{from{opacity:0;transform:scaleX(.2)}to{opacity:.35;transform:scaleX(1)}}
              :host([data-motion="off"]) *,:host([data-motion="off"]) *::before,:host([data-motion="off"]) *::after,#ioe-ai-root[data-motion="off"] *,#ioe-ai-root[data-motion="off"] *::before,#ioe-ai-root[data-motion="off"] *::after{animation:none!important;transition:none!important}:host([data-motion="off"]) .petal,#ioe-ai-root[data-motion="off"] .petal{display:none}
              @media(prefers-reduced-motion:reduce){.petal{display:none}*,*::before,*::after{animation:none!important;transition:none!important}}@media(max-width:520px){#commandMenu{max-height:35dvh;left:12px;right:12px}.corner-scene{right:7px;bottom:8px}}
              button:focus-visible{outline:2px solid var(--seal);outline-offset:3px}button:disabled{cursor:not-allowed}#messages .search-hidden{display:none!important}
              @media(prefers-reduced-motion:reduce){*{scroll-behavior:auto!important;transition:none!important}}
              @media(max-width:520px){#panel{right:8px;bottom:76px;width:calc(100vw - 16px);min-width:0;border-radius:18px;max-height:calc(100dvh - 90px)}#head{padding:14px}#messages{padding:10px 12px}.studio-tools{padding:8px 12px;flex-wrap:wrap}#accountUsage{max-width:135px}.welcome h2{font-size:30px}}
            </style>

            <div id="lockView">
              <div id="lockBox">
                <div class="studio-seal" aria-hidden="true">學</div>
                <div id="lockTitle" style="margin-top:18px">Một góc để học.</div>
                <div id="lockSub">Vui lòng nhập mã khóa để sử dụng. Phiên đăng nhập được lưu 30 ngày.</div>
                <input type="password" id="codeInput" name="ioe_ai_access_code" placeholder="Nhập mã khóa..." autocomplete="new-password" data-lpignore="true" data-1p-ignore="true" spellcheck="false">
                <button id="unlockBtn">Xác nhận</button>
                <div id="codeHelp">Bạn chưa có mã? <a href="https://www.facebook.com/tranxuantung123/" target="_blank" rel="noopener noreferrer">Ấn vào đây</a></div>
                <div id="lockMsg"></div>
              </div>
            </div>

            <div id="appView">
              <div id="cornerScene" class="corner-scene">
                <span class="petal" aria-hidden="true"></span><span class="petal" aria-hidden="true"></span><span class="petal" aria-hidden="true"></span><span class="petal" aria-hidden="true"></span><span class="petal" aria-hidden="true"></span><span class="petal" aria-hidden="true"></span>
                <button id="launcher" title="Mở Trợ lý học tập (Alt+A)" aria-label="Mở trợ lý học tập" aria-controls="panel" aria-expanded="false"><svg class="book-icon" viewBox="0 0 48 48" aria-hidden="true"><path d="M24 13C18 8 9 8 4 10v27c7-2 14-1 20 3Z" fill="#e4ecda" stroke="#315c4d" stroke-width="1.5" stroke-linejoin="round"/><path d="M24 13c6-5 15-5 20-3v27c-7-2-14-1-20 3Z" fill="#f6e5de" stroke="#315c4d" stroke-width="1.5" stroke-linejoin="round"/><path d="M24 14v25M8 16c5-1 9 0 12 2m-12 4c5-1 9 0 12 2m-12 4c5-1 9 0 12 2m8-12c3-2 7-3 12-2m-12 8c3-2 7-3 12-2m-12 8c3-2 7-3 12-2" stroke="#6c8d71" stroke-width="1.2" fill="none" stroke-linecap="round"/></svg><span class="book-spark" aria-hidden="true">✦</span></button>
              </div>
              <section id="panel" class="hidden" aria-label="Trợ lý học tập">
                <div id="head">
                  <div class="studio-brand"><span class="studio-seal" aria-hidden="true">學</span><div><b>Góc học tập</b><small>TAIPEI INSPIRED · STUDY ROOM</small></div></div>
                  <div>
                    <button id="themeBtn" title="Đổi giao diện sáng / tối" aria-label="Đổi giao diện">◐</button>
                    <button id="expandBtn" title="Mở rộng khung đọc" aria-label="Mở rộng khung đọc" aria-pressed="false">⛶</button>
                    <button id="logoutBtn" title="Đăng xuất">🔓</button>
                    <button id="infoBtn" title="Cập nhật, hướng dẫn sử dụng và điều khoản" aria-label="Thông tin">ⓘ</button>
                    <button id="closeBtn" title="Đóng">×</button>
                  </div>
                </div>
                <div class="studio-tools">
                  <button id="settingsBtn" aria-expanded="false" aria-controls="advancedControls">Tùy chỉnh</button>
                  <button id="userStudioBtn" title="Mở hồ sơ và tính cách trợ lý trên server">Góc của tôi ↗</button>
                  <button id="searchBtn" aria-label="Tìm trong cuộc trò chuyện" aria-expanded="false">Tìm</button>
                  <button id="exportChatBtn" title="Tải cuộc trò chuyện dạng Markdown">Xuất .md</button>
                  <span id="accountUsage" role="status">Hạn mức: chưa tải</span>
                </div>
                <input id="historySearch" type="search" placeholder="Tìm nội dung trong cuộc trò chuyện…" aria-label="Tìm trong cuộc trò chuyện" hidden>
                <div class="session-bar"><select id="sessionSel" aria-label="Chọn hội thoại"></select><button id="newSessionBtn" title="Tạo hội thoại mới">＋ Mới</button><button id="sessionsBtn">Hội thoại</button><button id="mistakesBtn">Bài sai <span id="mistakeCount">0</span></button></div>
                <div id="studyStorageWarning" class="release-note" role="alert" hidden></div>
                <section id="libraryPane" hidden aria-label="Sổ học tập"><div class="library-head"><h3 id="libraryTitle">Hội thoại</h3><button id="closeLibraryBtn" class="study-button">Về chat</button></div><div id="libraryContent"></div></section>
                <div id="messages"></div>
                <div id="inputArea">
                  <img id="preview" alt="">
                  <div id="commandMenu" role="listbox" aria-label="Lệnh học tập" hidden></div>
                  <div class="composer-status-row"><div id="status" role="status" aria-live="polite">Hỏi một câu. Mở thêm một cách hiểu.</div><button id="commandHelpBtn" class="command-trigger" title="Chọn chế độ trả lời">/ Lệnh</button></div>
                  <div id="commandMode" class="mode-pill" hidden></div>
                  <div class="row"><button class="b" id="quickCaptureBtn" title="Chụp vùng đề bài (Alt+S)">Chụp đề</button><button class="b" id="quickScrapeBtn">Lấy câu hỏi</button><button class="b" id="uploadImageBtn">Tải ảnh</button><input type="file" id="imageFileInput" accept="image/png,image/jpeg,image/webp,image/gif" hidden></div>
                  <div id="advancedControls" hidden>
                  <div class="row"><label class="lbl" for="fontSizeSel">Cỡ chữ nội dung:</label><select id="fontSizeSel"><option value="12">Nhỏ · 12</option><option value="14">Vừa · 14</option><option value="16">Lớn · 16</option><option value="18">Rất lớn · 18</option><option value="20">Dễ đọc · 20</option></select></div>
                  <div class="row"><label class="chk"><input id="motionEffects" type="checkbox"><span>Hiệu ứng nhẹ · tự tắt khi hệ thống giảm chuyển động</span></label></div>
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
                      <option value="review">Đọc ảnh → kiểm tra 2 cột → giải</option>
                      <option value="transcribe">Chỉ chép đề vào bản nháp</option>
                      <option value="analyze">Phân tích ảnh, chưa giải</option>
                      <option value="direct-solve">Giải trực tiếp ảnh (bỏ bước sửa)</option>
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
                  <textarea id="question" aria-label="Câu hỏi" placeholder="Bạn đang muốn hiểu điều gì?" maxlength="16000"></textarea>
                  <div id="scrapeActions">
                    <span id="scrapeInfo" style="flex:1;font-size:12px;color:#5b21b6;font-weight:600;"></span>
                    <button id="copyScrapedBtn" style="flex:0 0 auto;background:#6b7280;color:#fff;border:0;border-radius:6px;padding:6px 10px;cursor:pointer;font:600 12px Arial;">📋 Copy</button>
                    <button id="sendScrapedBtn" style="flex:0 0 auto;background:#4769e8;color:#fff;border:0;border-radius:6px;padding:6px 10px;cursor:pointer;font:600 12px Arial;">🤖 Gửi AI</button>
                    <button id="hideScrapeBtn" style="flex:0 0 auto;background:#9ca3af;color:#fff;border:0;border-radius:6px;padding:6px 8px;cursor:pointer;font:600 12px Arial;">✕</button>
                  </div>
                  <div class="composer-note"><span>Enter gửi · Shift+Enter xuống dòng · Ctrl+V dán ảnh</span><span id="draftState">Bản nháp tự lưu</span></div>
                  <div class="row">
                    <button class="b" id="sendBtn">Gửi ↗</button>
                    <button class="b" id="stopBtn">⏹ Dừng</button>
                    <button class="b" id="clearBtn">Xóa trò chuyện</button>
                  </div>
                </div>
                <section id="imageReview" class="review-pane" hidden role="dialog" aria-modal="true" aria-labelledby="reviewTitle">
                  <div class="library-head"><h3 id="reviewTitle">Kiểm tra đề trước khi giải</h3><div class="study-actions" style="margin:0;flex-wrap:nowrap"><button id="reviewExpandBtn" class="study-button" aria-label="Mở rộng phần đối chiếu ảnh" aria-pressed="false">⛶</button><button id="discardReviewBtn" class="study-button" aria-label="Hủy bản chép đề">×</button></div></div>
                  <p class="study-muted">Đối chiếu số, dấu và ký hiệu với ảnh. Nội dung bạn sửa bên dưới sẽ được gửi cho AI giải; AI chưa giải đề này.</p>
                  <div class="review-columns"><div class="review-source"><div class="review-column-label">ẢNH GỐC · <a id="reviewOriginalLink" target="_blank" rel="noopener noreferrer" style="color:var(--jade)">Xem ảnh lớn</a></div><img id="reviewImage" alt="Ảnh đề gốc để đối chiếu"></div><div class="review-editor"><div class="review-editor-toolbar"><label for="reviewText" class="review-column-label">ĐỀ BÀI & GHI CHÚ HÌNH VẼ</label><button id="reviewPreviewBtn" class="study-button" aria-pressed="false">Xem định dạng</button></div><textarea id="reviewText" maxlength="16000"></textarea><div id="reviewFormatted" class="study-exercise review-formatted" tabindex="0" aria-label="Bản chép đã định dạng" hidden></div></div></div>
                  <div id="reviewMessage" role="status"></div>
                  <div class="study-actions"><button id="reviewSolveBtn" class="study-button primary">Xác nhận và giải</button><button id="reviewDraftBtn" class="study-button">Đưa vào bản nháp</button></div>
                  <p class="study-muted">Đọc ảnh dùng một lượt Vision. Xác nhận giải dùng thêm một lượt chat.</p>
                </section>
              </section>
              <div id="infoModal" role="dialog" aria-modal="true" aria-labelledby="infoTitle">
                <section id="infoBox">
                  <div id="infoHeader"><div><div class="info-eyebrow">學習室 / SỔ TAY GÓC HỌC</div><strong id="infoTitle">Mỗi lần mở, thêm một điều mới.</strong></div><button id="closeInfoBtn" aria-label="Đóng thông tin">×</button></div>
                  <nav id="infoTabs" aria-label="Thông tin trợ lý">
                    <button class="infoTab active" data-info-tab="updates">Cập nhật</button>
                    <button class="infoTab" data-info-tab="guide">Hướng dẫn</button>
                    <button class="infoTab" data-info-tab="terms">Điều khoản</button>
                  </nav>
                  <div id="infoBody">
                    <section class="infoSection active" id="info-updates">
                      <div class="release-hero">
                        <div class="release-meta"><span class="release-version">v${APP_VERSION} · Đang chạy</span><time datetime="2026-10-27">27 tháng 10, 2026</time></div>
                        <h3>Một góc riêng.<br>Một cách học của bạn.</h3>
                        <p>Mở Góc của tôi để chọn tính cách trợ lý, cách giải thích và nhịp học. Tùy chỉnh áp dụng cho câu trả lời tiếp theo.</p>
                      </div>
                      <div class="release-grid">
                        <article class="release-card"><span class="release-number">01 / CÁ TÍNH</span><h4>Một người bạn hợp ý</h4><p>Thân thiện, kiên nhẫn, thẳng vào ý hoặc gợi mở; chọn mẫu nhanh rồi chỉnh theo cách bạn thích.</p></article>
                        <article class="release-card"><span class="release-number">02 / NHỊP HỌC</span><h4>Chủ động cách học</h4><p>Chọn độ chi tiết, ngôn ngữ, ví dụ, giải nghĩa ký hiệu và chế độ chỉ gợi ý mặc định.</p></article>
                        <article class="release-card"><span class="release-number">03 / ĐỒNG BỘ</span><h4>Mang theo tùy chỉnh</h4><p>Hồ sơ lưu trên server theo mã truy cập. Mở từ userscript để dùng lại phiên, không chiếm thêm thiết bị.</p></article>
                        <article class="release-card"><span class="release-number">04 / QUYỀN CHỦ ĐỘNG</span><h4>Bạn giữ quyền quyết định</h4><p>Xem trước không dùng lượt, nhập/xuất tùy chỉnh, bỏ thay đổi hoặc xóa hồ sơ để về mặc định.</p></article>
                      </div>
                      <div class="release-note">Mới trong v14.1: nhập mã tại /user rồi chọn “Xác nhận cùng thiết bị” để dùng lại phiên Tampermonkey trên cùng hồ sơ trình duyệt, kể cả mã chỉ có 1 HWID. Không thêm hoặc reset thiết bị.</div>
                      <details class="release-history"><summary>v13.1.0 · Gemini, ảnh và khung đọc</summary><ul><li>Chọn Qwen/Gemini cho đọc ảnh, phân tích hoặc giải.</li><li>Đối chiếu ảnh và bản chép hai cột; xem trước bảng và LaTeX.</li><li>Khung chat rộng, mở toàn khung; menu lệnh và hiệu ứng nhẹ hơn.</li></ul></details>
                      <details class="release-history"><summary>v12.1.0 · Lệnh, cỡ chữ và cánh đào</summary><ul><li>Thanh lệnh /gợi-ý, /giải-thích, /kiểm-tra, /tóm-tắt và /giải.</li><li>Cỡ chữ nội dung 12–20; cuốn sách đung đưa, cánh đào và tùy chọn tắt chuyển động.</li></ul></details>
                      <details class="release-history"><summary>v12.0.0 · Sổ bài sai và hội thoại</summary><ul><li>Đọc ảnh, sửa đề rồi mới xác nhận giải; có thể lưu bản nháp để gửi sau.</li><li>Sổ bài sai có ghi chú, trạng thái ôn tập, tìm kiếm và xuất JSON.</li><li>Hội thoại theo môn/bài, ghim, lịch sử và bản nháp độc lập.</li></ul></details>
                      <details class="release-history"><summary>Các cải tiến trong dòng v11</summary>
                      <ul>
                        <li>Giao diện mới lấy cảm hứng từ góc học Đài Loan: nền giấy ấm, xanh ngọc, chế độ sáng/tối và bố cục cho điện thoại.</li>
                        <li>Thêm tìm lịch sử, xuất Markdown, sao chép đáp án, tự lưu bản nháp, tải ảnh và xem hạn mức từ server.</li>
                        <li>Phiên đăng nhập được lưu trong bộ nhớ riêng của Tampermonkey; quota cộng tác dùng chung theo mã truy cập.</li>
                        <li>Chỉ giải khi người dùng yêu cầu giải bài; câu hỏi khái niệm và trò chuyện thường được trả lời tự nhiên.</li>
                        <li>Ảnh chụp, ảnh dán và ảnh đề gửi cho AI hiện hiển thị trực tiếp trong khung chat; không còn hiện prompt kỹ thuật hoặc nhãn nguồn ảnh.</li>
                        <li>Cải thiện giải thích ký hiệu/hàm số; mô tả hình học có căn cứ, không đoán tính chất từ hình vẽ; trình bày bảng khi phù hợp.</li>
                        <li>Mỗi mã có giới hạn thiết bị riêng; cần quản trị viên reset khi đã đủ số thiết bị. Phiên được chia sẻ giữa các website trong cùng hồ sơ Tampermonkey.</li>
                        <li>Nhận diện hộp thoại câu hỏi Violympic và gửi trọn câu hỏi cùng đáp án ảnh qua Vision từ nút “Lấy cả trang”.</li>
                        <li>Cải thiện chụp GameCanvas trên IOE và nhận diện một số bố cục câu hỏi VioEdu.</li>
                        <li>Sửa hiển thị LaTeX và điều chỉnh AI theo ngôn ngữ, môn học của đề.</li>
                      </ul>
                      </details>
                    </section>
                    <section class="infoSection" id="info-guide">
                      <h3>Thanh lệnh và tùy chỉnh</h3>
                      <ul><li>Gõ / ở đầu câu hỏi hoặc bấm “/ Lệnh”. Dùng ↑ ↓ để chọn, Enter/Tab để chèn và Esc để đóng danh sách. Có thể gõ không dấu, ví dụ /goi-y.</li><li>/gợi-ý: chỉ gợi mở; /giải-thích: làm rõ khái niệm; /kiểm-tra: xem bài làm bạn đã thử; /tóm-tắt: rút ý chính; /giải: giải đầy đủ. Nhập câu hỏi hoặc nội dung sau lệnh.</li><li>Trong Tùy chỉnh, đổi cỡ chữ nội dung hoặc bật/tắt hiệu ứng nhẹ. Hiệu ứng tự tắt khi hệ thống bật giảm chuyển động.</li></ul>
                      <h3>Bắt đầu</h3>
                      <ol>
                        <li>Nhập mã truy cập được cấp để mở trợ lý. Phiên đăng nhập được lưu trên trình duyệt tối đa 30 ngày.</li>
                        <li>Chọn model trong danh sách. Qwen là lựa chọn mặc định; có thể đổi model bất cứ lúc nào.</li>
                        <li>Nhập câu hỏi vào khung chat rồi bấm “Gửi”, hoặc nhấn Enter. Lịch sử gần đây được lưu trên thiết bị.</li>
                      </ol>
                      <h3>Lấy câu hỏi và dùng Vision</h3>
                      <ul>
                        <li>Chọn Qwen hoặc Gemini ở mục Vision. Chọn riêng model chat để giải đề đã kiểm tra. Gemini chạy độc lập; nhóm cộng tác nhiều AI vẫn dùng các model Groq.</li>
                        <li>Nút ⛶ trên đầu khung hoặc màn hình đối chiếu mở rộng không gian đọc. “Xem ảnh lớn” mở ảnh gốc để kiểm tra chữ nhỏ.</li>
                        <li>“Lấy cả trang”: tự lấy câu hỏi từ bố cục được hỗ trợ; nếu đang mở hộp thoại câu hỏi Violympic, trợ lý chụp toàn hộp thoại gồm cả đáp án dạng ảnh.</li>
                        <li>“Chụp & Hỏi AI”: chụp trang, kéo chọn vùng cần đọc rồi gửi ảnh cho Vision.</li>
                        <li>Mặc định ảnh đi qua bước “Kiểm tra đề”: sửa bản chép khi cần rồi chọn “Xác nhận và giải”. Đọc ảnh dùng một lượt Vision, giải dùng thêm một lượt chat.</li>
                        <li>Chế độ “Chỉ chép đề” đưa nội dung vào bản nháp; chưa gửi cho AI giải cho đến khi bạn bấm Gửi.</li>
                        <li>“Phân tích ảnh” mô tả dữ kiện và bố cục, chưa giải. “Giải trực tiếp ảnh” bỏ bước sửa đề và dùng một lượt chat. Hai chế độ này gửi ảnh thẳng cho model Vision đã chọn.</li>
                        <li>Nếu nội dung trang không được nhận diện, dùng “Chụp & Hỏi AI” hoặc dán ảnh vào khung chat.</li>
                      </ul>
                      <h3>Hội thoại và sổ bài sai</h3>
                      <ul><li>Dùng “＋ Mới” để mở hội thoại; đặt tên, môn học và ghim trong mục “Hội thoại”. AI chỉ nhận lịch sử của hội thoại đang mở.</li><li>Nút “Lưu bài sai” dưới câu trả lời mở sổ ghi chú. Bạn có thể sửa lời giải tham khảo, ghi nguyên nhân sai, đánh dấu đã ôn hoặc mở buổi ôn với AI.</li><li>Dữ liệu lưu trong trình duyệt trên từng website, chưa đồng bộ giữa các website hoặc thiết bị. Tối đa 20 hội thoại, 40 tin gần nhất mỗi hội thoại và 100 bài trong sổ. Hãy xuất bản sao trước khi xóa dữ liệu trình duyệt.</li></ul>
                      <h3>Multi-agent</h3>
                      <p>Bật Multi-agent để model tạo đáp án rồi nhận phản biện và lượt sửa có giới hạn. Tối đa 3 lần cộng tác mỗi ngày theo mã truy cập, đặt lại lúc 07:00 giờ Việt Nam; số lượt sửa chọn ở danh sách bên cạnh.</p>
                    </section>
                    <section class="infoSection" id="info-terms">
                      <h3>Điều khoản sử dụng</h3>
                      <ol>
                        <li>Công cụ dành cho tự học, ôn tập và tham khảo; không sử dụng trong bài thi hoặc hoạt động bị cấm công cụ hỗ trợ.</li>
                        <li>Mỗi mã có giới hạn thiết bị theo gói được cấp. Khi đã đủ, cần quản trị viên reset trước khi đổi thiết bị; trong cùng hồ sơ Tampermonkey, phiên được dùng chung giữa IOE, VioEdu và Violympic.</li>
                        <li>AI có thể đọc sai đề hoặc trả lời sai. Người dùng cần tự kiểm tra lời giải và đáp án.</li>
                        <li>Không chia sẻ mã truy cập. Câu hỏi và ảnh gửi lên sẽ được xử lý qua server của dịch vụ và nhà cung cấp AI.</li>
                        <li>Dịch vụ, model và tính năng có thể thay đổi hoặc tạm ngừng; không cam kết hoạt động liên tục hay kết quả luôn chính xác.</li>
                      </ol>
                    </section>
                  </div>
                  <div class="info-footer"><span>GÓC HỌC TẬP · v${APP_VERSION}</span><span>Chậm một chút. Hiểu thêm một chút.</span></div>
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
                setTimeout(refreshAccount, 0);
                console.log('[IOE AI V10.1] Hiện app view');
            }

            async function handleAuthFailure(msg) {
                await clearToken();
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
                    const deviceId = await getInstallationId();
                    const res = await fetch(BACKEND_URL + '/api/auth', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ code, deviceId }),
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

                    await setToken(data.token);
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
                const token = await getToken();
                if (isTokenValid(token)) {
                    showApp();
                } else {
                    await clearToken();
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
            modelSel.addEventListener('change', () => { localStorage.setItem('ioeai_model', modelSel.value); syncMultiAgentModel(); });
            const storedVision = localStorage.getItem('ioeai_vision_model');
            visionSel.value = VISION_MODELS.some(([id]) => id === storedVision) ? storedVision : VISION_MODELS[0][0];
            visionSel.addEventListener('change', () => localStorage.setItem('ioeai_vision_model', visionSel.value));
            const savedImageMode = localStorage.getItem('ioeai_image_mode');
            imageModeSel.value = ['transcribe', 'analyze', 'direct-solve'].includes(savedImageMode) ? savedImageMode : 'review';
            imageModeSel.addEventListener('change', () => localStorage.setItem('ioeai_image_mode', imageModeSel.value));
            multiAgentEl.checked = readFlag('ioeai_multi_agent', false);
            multiAgentEl.addEventListener('change', () => writeFlag('ioeai_multi_agent', multiAgentEl.checked));
            function syncMultiAgentModel() {
                const gemini = modelSel.value === 'gemini-3.8-flash';
                if (gemini) multiAgentEl.checked = false;
                multiAgentEl.disabled = gemini;
                multiAgentEl.title = gemini ? 'Gemini chạy độc lập; cộng tác nhiều AI dùng nhóm model Groq.' : '';
            }
            syncMultiAgentModel();
            const savedRounds = localStorage.getItem('ioeai_multi_agent_rounds');
            multiAgentRoundsEl.value = savedRounds === '2' ? '2' : '1';
            multiAgentRoundsEl.addEventListener('change', () => localStorage.setItem('ioeai_multi_agent_rounds', multiAgentRoundsEl.value));



            const study = loadStudySpace();
            const currentSession = () => study.sessions.find(s => s.id === study.activeId);
            let busy = false, history = currentSession().messages, controller = null;
            let pendingReview = null;
            let libraryMode = '';
            function persistStudy() {
                try { localStorage.setItem(STUDY_DATA_KEY, JSON.stringify(study)); $('studyStorageWarning').hidden = true; return true; }
                catch (_) {
                    $('studyStorageWarning').hidden = false;
                    $('studyStorageWarning').textContent = 'Chưa lưu được dữ liệu. Hãy xuất hội thoại/sổ bài sai trước khi đóng trang. Dữ liệu cũ trong bộ nhớ vẫn được giữ.';
                    $('draftState').textContent = 'Chưa lưu được dữ liệu';
                    $('status').textContent = 'Bộ nhớ trình duyệt không đủ hoặc bị chặn. Hãy xuất hội thoại/sổ bài sai để giữ dữ liệu trước khi đóng trang.';
                    return false;
                }
            }
            function saveChatHistory(items) {
                currentSession().messages = items.slice(-CHAT_HISTORY_MAX);
                currentSession().draft = question.value.slice(0, 16000);
                currentSession().draftImage = pendingChatImagePreview || '';
                currentSession().updatedAt = Date.now();
                return persistStudy();
            }
            function renderSessionOptions() {
                $('sessionSel').replaceChildren();
                [...study.sessions].sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.updatedAt - a.updatedAt).forEach(session => {
                    const option = document.createElement('option'); option.value = session.id;
                    option.textContent = `${session.pinned ? '★ ' : ''}${session.subject} · ${session.title}`;
                    $('sessionSel').appendChild(option);
                });
                $('sessionSel').value = study.activeId;
                $('mistakeCount').textContent = String(study.mistakes.filter(m => !m.reviewed).length);
            }
            function closeLibrary() {
                libraryMode = ''; $('libraryPane').hidden = true; messages.hidden = false; $('inputArea').hidden = false;
            }
            function showLibrary(mode) {
                if (busy || pendingReview) return;
                libraryMode = mode; $('libraryPane').hidden = false; messages.hidden = true; $('inputArea').hidden = true;
                $('libraryTitle').textContent = mode === 'sessions' ? 'Hội thoại theo môn / bài' : 'Sổ bài sai';
                if (mode === 'sessions') renderSessions(); else renderMistakes();
            }
            function renderConversation() {
                messages.replaceChildren();
                history.forEach(item => item.image ? addImageMessage(item.image, item.caption || item.content) : addMessage(item.role, item.content));
                showWelcome();
                $('historySearch').value = '';
                followLatest = true;
                updateCommandMenu();
            }
            function switchSession(id) {
                if (busy || pendingReview || !study.sessions.some(s => s.id === id)) { $('sessionSel').value = study.activeId; return; }
                currentSession().draft = question.value;
                if (!saveChatHistory(history)) { $('sessionSel').value = study.activeId; return; }
                study.activeId = id; history = currentSession().messages;
                question.value = currentSession().draft || '';
                pendingChatImagePreview = currentSession().draftImage || null; clearPreview();
                if (pendingChatImagePreview) { preview.src = pendingChatImagePreview; preview.style.display = 'block'; }
                hideScrapeActions();
                persistStudy(); renderSessionOptions(); renderConversation(); closeLibrary();
                setStatus('Đã mở ' + currentSession().title + '. Ngữ cảnh AI chỉ dùng hội thoại này.');
            }
            function makeStudyButton(label, action, extraClass = '') {
                const button = document.createElement('button'); button.className = 'study-button ' + extraClass;
                button.type = 'button'; button.textContent = label; button.onclick = action; return button;
            }
            function studyText(tag, text, className = '') {
                const node = document.createElement(tag); node.textContent = text; node.className = className; return node;
            }
            function newConversation() {
                if (busy || pendingReview) return false;
                if (study.sessions.length >= MAX_SESSIONS) { setStatus('Tối đa 20 hội thoại. Hãy xuất và xóa hội thoại không cần nữa.'); return false; }
                if (!saveChatHistory(history)) return false;
                const session = freshSession(); study.sessions.push(session); study.activeId = session.id; history = session.messages;
                question.value = ''; pendingChatImagePreview = null; clearPreview(); persistStudy(); renderSessionOptions(); renderConversation();
                showLibrary('sessions'); $('sessionTitleInput')?.focus();
                return true;
            }
            function renderSessions() {
                const target = $('libraryContent'); target.replaceChildren();
                target.appendChild(studyText('p', 'Mỗi hội thoại có lịch sử và bản nháp riêng. Dữ liệu lưu trong trình duyệt trên website này; lịch sử cũ được giữ trong “Lịch sử trước đây”.', 'study-muted'));
                const form = document.createElement('form'); form.className = 'study-form study-card';
                form.innerHTML = '<label for="sessionTitleInput">Tên hội thoại</label><input id="sessionTitleInput" maxlength="80" required><label for="sessionSubjectInput">Môn học</label><input id="sessionSubjectInput" maxlength="40" placeholder="Toán, Tiếng Anh, Vật lý…" required><div class="study-actions"><button class="study-button primary" type="submit">Lưu tên và môn</button></div>';
                form.querySelector('#sessionTitleInput').value = currentSession().title;
                form.querySelector('#sessionSubjectInput').value = currentSession().subject;
                form.onsubmit = event => {
                    event.preventDefault(); const title = form.querySelector('#sessionTitleInput').value.trim(); const subject = form.querySelector('#sessionSubjectInput').value.trim();
                    if (!title || !subject) return;
                    Object.assign(currentSession(), { title, subject }); persistStudy(); renderSessionOptions(); renderSessions();
                };
                target.appendChild(form);
                [...study.sessions].sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.updatedAt - a.updatedAt).forEach(session => {
                    const card = document.createElement('article'); card.className = 'study-card'; card.dataset.sessionId = session.id;
                    card.appendChild(studyText('h4', `${session.pinned ? '★ ' : ''}${session.title}${session.id === study.activeId ? ' · Đang mở' : ''}`));
                    card.appendChild(studyText('p', `${session.subject} · ${session.messages.length} tin nhắn`, 'study-muted'));
                    const actions = document.createElement('div'); actions.className = 'study-actions';
                    actions.append(makeStudyButton('Mở', () => switchSession(session.id)), makeStudyButton(session.pinned ? 'Bỏ ghim' : 'Ghim', () => {
                        session.pinned = !session.pinned; persistStudy(); renderSessionOptions(); renderSessions();
                    }), makeStudyButton('Xóa', () => {
                        if (!confirm(`Xóa hội thoại “${session.title}”? Lịch sử và bản nháp của hội thoại này sẽ bị xóa.`)) return;
                        study.sessions = study.sessions.filter(s => s.id !== session.id);
                        if (!study.sessions.length) study.sessions.push(freshSession());
                        if (study.activeId === session.id) {
                            study.activeId = study.sessions[0].id; history = currentSession().messages; question.value = currentSession().draft || '';
                            pendingChatImagePreview = currentSession().draftImage || null; clearPreview(); renderConversation();
                        }
                        persistStudy(); renderSessionOptions(); renderSessions();
                    }, 'danger'));
                    card.appendChild(actions); target.appendChild(card);
                });
            }
            function exportMistakes() {
                const data = { format: 'study-mistakes-v1', exportedAt: new Date().toISOString(), mistakes: study.mistakes };
                const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
                const link = document.createElement('a'); link.href = url; link.download = 'so-bai-sai.json'; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
            }
            function editMistake(record) {
                showLibrary('mistakes');
                const target = $('libraryContent'); target.replaceChildren();
                target.appendChild(studyText('p', 'Lời giải AI chỉ là tài liệu tham khảo. Ghi rõ lỗi bạn gặp và cách sửa để lần ôn sau có ích hơn.', 'study-muted'));
                const form = document.createElement('form'); form.id = 'mistakeForm'; form.className = 'study-form study-card';
                form.innerHTML = '<label for="mistakeSubject">Môn học</label><input id="mistakeSubject" maxlength="40" required><label for="mistakeQuestion">Đề bài</label><textarea id="mistakeQuestion" maxlength="16000" required></textarea><label for="mistakeAnswer">Lời giải tham khảo (có thể sửa)</label><textarea id="mistakeAnswer" maxlength="16000"></textarea><label for="mistakeNote">Mình sai ở đâu? Cách tránh lần sau?</label><textarea id="mistakeNote" maxlength="4000" placeholder="Ví dụ: quên đổi dấu khi chuyển vế…"></textarea><div class="study-actions"><button class="study-button primary" type="submit">Lưu vào sổ</button><button id="cancelMistakeBtn" class="study-button" type="button">Hủy</button></div>';
                form.querySelector('#mistakeSubject').value = record.subject || currentSession().subject;
                form.querySelector('#mistakeQuestion').value = record.question;
                form.querySelector('#mistakeAnswer').value = record.answer;
                form.querySelector('#mistakeNote').value = record.note || '';
                form.querySelector('#cancelMistakeBtn').onclick = renderMistakes;
                form.onsubmit = event => {
                    event.preventDefault(); const existing = study.mistakes.find(m => m.id === record.id);
                    if (!existing && study.mistakes.length >= MAX_MISTAKES) { alert('Sổ tối đa 100 bài. Hãy xuất và xóa bài không cần nữa.'); return; }
                    const updated = { ...record, id: record.id || makeDeviceId(), subject: form.querySelector('#mistakeSubject').value.trim().slice(0, 40),
                        question: form.querySelector('#mistakeQuestion').value.trim(), answer: form.querySelector('#mistakeAnswer').value.trim(),
                        note: form.querySelector('#mistakeNote').value.trim(), createdAt: record.createdAt || Date.now(), reviewed: record.reviewed === true };
                    if (!updated.question || !updated.subject) return;
                    if (existing) Object.assign(existing, updated); else study.mistakes.unshift(updated);
                    persistStudy(); renderSessionOptions(); renderMistakes();
                };
                target.appendChild(form); form.querySelector('#mistakeNote').focus();
            }
            function renderMistakes() {
                const target = $('libraryContent'); target.replaceChildren();
                target.appendChild(studyText('p', `${study.mistakes.filter(m => !m.reviewed).length} bài cần ôn · ${study.mistakes.length} bài đã lưu. Lưu tại trình duyệt trên website này.`, 'study-muted'));
                const search = document.createElement('input'); search.id = 'mistakeSearch'; search.className = 'study-search'; search.placeholder = 'Tìm đề, môn học hoặc ghi chú…'; search.setAttribute('aria-label', 'Tìm trong sổ bài sai');
                const filter = document.createElement('select'); filter.id = 'mistakeFilter'; filter.className = 'study-search';
                for (const [value, text] of [['todo', 'Cần ôn'], ['all', 'Tất cả'], ['reviewed', 'Đã ôn']]) { const option = document.createElement('option'); option.value = value; option.textContent = text; filter.appendChild(option); }
                target.append(search, filter, makeStudyButton('Xuất sổ (.json)', exportMistakes));
                const list = document.createElement('div'); list.id = 'mistakeList'; target.appendChild(list);
                const draw = () => {
                    list.replaceChildren(); const query = search.value.toLocaleLowerCase('vi').trim();
                    const rows = study.mistakes.filter(m => (filter.value === 'all' || Boolean(m.reviewed) === (filter.value === 'reviewed')) && `${m.subject} ${m.question} ${m.note || ''}`.toLocaleLowerCase('vi').includes(query));
                    if (!rows.length) list.appendChild(studyText('p', 'Chưa có bài khớp. Bạn có thể lưu bài từ nút “Lưu bài sai” dưới mỗi câu trả lời.', 'study-muted'));
                    rows.forEach(record => {
                        const card = document.createElement('article'); card.className = 'study-card'; card.dataset.mistakeId = record.id;
                        card.appendChild(studyText('h4', `${record.subject} · ${record.reviewed ? 'Đã ôn' : 'Cần ôn'}`));
                        const problem = document.createElement('div'); problem.className = 'study-exercise';
                        problem.innerHTML = renderMarkdown(normalizeMathOutput(record.question)); renderMath(problem); card.appendChild(problem);
                        if (record.image && /^data:image\/jpeg;base64,/i.test(record.image)) { const image = document.createElement('img'); image.className = 'mistake-image'; image.src = record.image; image.alt = 'Ảnh đề đã lưu'; card.appendChild(image); }
                        if (record.note) card.appendChild(studyText('p', 'Ghi nhớ: ' + record.note, 'study-muted'));
                        const answer = document.createElement('details'); const solution = document.createElement('div'); solution.className = 'study-exercise';
                        solution.innerHTML = renderMarkdown(normalizeMathOutput(record.answer)); renderMath(solution);
                        answer.append(studyText('summary', 'Xem lời giải tham khảo'), solution); card.appendChild(answer);
                        const actions = document.createElement('div'); actions.className = 'study-actions';
                        actions.append(makeStudyButton(record.reviewed ? 'Cần ôn lại' : 'Đánh dấu đã ôn', () => { record.reviewed = !record.reviewed; persistStudy(); renderSessionOptions(); renderMistakes(); }),
                            makeStudyButton('Sửa ghi chú', () => editMistake(record)), makeStudyButton('Ôn với AI', () => {
                                if (study.sessions.length >= MAX_SESSIONS) { alert('Đã đủ 20 hội thoại. Hãy xóa một hội thoại trước khi ôn.'); return; }
                                if (!newConversation()) return;
                                currentSession().title = 'Ôn: ' + record.question.slice(0, 40); currentSession().subject = record.subject;
                                question.value = '/gợi-ý Hãy gợi ý từng bước cho bài này, chưa đưa đáp án ngay:\n\n' + record.question;
                                currentSession().draft = question.value; persistStudy(); renderSessionOptions(); closeLibrary(); question.focus();
                            }), makeStudyButton('Xóa bài', () => {
                                if (!confirm('Xóa bài này khỏi sổ?')) return;
                                study.mistakes = study.mistakes.filter(m => m.id !== record.id); persistStudy(); renderSessionOptions(); renderMistakes();
                            }, 'danger'));
                        card.appendChild(actions); list.appendChild(card);
                    });
                };
                search.oninput = draw; filter.onchange = draw; draw();
            }
            $('sessionSel').onchange = () => switchSession($('sessionSel').value);
            $('newSessionBtn').onclick = newConversation;
            $('sessionsBtn').onclick = () => showLibrary('sessions');
            $('mistakesBtn').onclick = () => showLibrary('mistakes');
            $('closeLibraryBtn').onclick = closeLibrary;
            renderSessionOptions();
            let account = null;
            let followLatest = true;
            messages.addEventListener('scroll', () => {
                followLatest = messages.scrollHeight - messages.scrollTop - messages.clientHeight < 90;
            });
            function scrollLatest() { if (followLatest) messages.scrollTop = messages.scrollHeight; }
            async function refreshAccount() {
                if (authState !== 'unlocked') return;
                try {
                    const response = await fetch(BACKEND_URL + '/api/account', {
                        headers: { Authorization: 'Bearer ' + await getToken(), 'X-Device-ID': await getInstallationId() },
                        signal: AbortSignal.timeout(12000),
                    });
                    if (!response.ok) throw new Error('Unavailable');
                    account = await response.json();
                    $('accountUsage').textContent = `${account.requestsToday}/${account.dailyLimit || '∞'} lượt · ${account.multiAgentRemaining}/3 cộng tác`;
                    $('accountUsage').title = `Chat ${account.chatToday}/${account.chatLimit || '∞'} · Ảnh ${account.visionToday}/${account.visionLimit || '∞'}. Đặt lại lúc 07:00 giờ Việt Nam (00:00 UTC).`;
                    for (const option of modelSel.options) option.disabled = account.blockedModels.includes(option.value) || (Array.isArray(account.availableModels) && !account.availableModels.includes(option.value));
                    for (const option of visionSel.options) option.disabled = account.blockedModels.includes(option.value) || (Array.isArray(account.visionModels) && !account.visionModels.includes(option.value));
                } catch (_) { $('accountUsage').textContent = 'Hạn mức: chưa tải được'; }
            }
            function studyModeReady(mode) {
                if (mode === 'normal' || account?.studyModes?.includes(mode)) return true;
                setStatus(account ? 'Chế độ này chưa sẵn sàng trên dịch vụ. Hãy thử lại sau khi dịch vụ được cập nhật.' : 'Đang tải chế độ học. Bạn thử gửi lại sau ít giây nhé.');
                refreshAccount(); return false;
            }
            function showWelcome() {
                if (messages.querySelector('.msg')) return;
                const welcome = document.createElement('div');
                welcome.className = 'welcome';
                welcome.innerHTML = '<div class="eyebrow">學習室 / MỖI NGÀY MỘT CHÚT</div><h2>Học chậm.<br>Hiểu sâu.</h2><p>Một câu hỏi nhỏ cũng mở ra một góc nhìn mới. Nhập câu hỏi, dán ảnh hoặc chụp đề để bắt đầu.</p><div class="quick-prompts"></div><div class="welcome-rule"></div>';
                for (const text of ['Giải thích dễ hiểu', 'Gợi ý từng bước', 'Kiểm tra lời giải']) {
                    const button = document.createElement('button'); button.textContent = text;
                    button.onclick = () => { question.value = text + ': '; question.focus(); question.dispatchEvent(new Event('input')); };
                    welcome.querySelector('.quick-prompts').appendChild(button);
                }
                messages.appendChild(welcome);
            }
            panel.dataset.theme = localStorage.getItem('ioeai_theme') === 'dark' ? 'dark' : 'light';
            $('infoBox').dataset.theme = panel.dataset.theme;
            $('themeBtn').onclick = () => {
                panel.dataset.theme = panel.dataset.theme === 'dark' ? 'light' : 'dark';
                $('infoBox').dataset.theme = panel.dataset.theme;
                localStorage.setItem('ioeai_theme', panel.dataset.theme);
            };
            const storedFontSize = Number(localStorage.getItem('ioeai_font_size'));
            const fontSize = [12, 14, 16, 18, 20].includes(storedFontSize) ? storedFontSize : 14;
            panel.style.setProperty('--reader-size', fontSize + 'px'); $('fontSizeSel').value = String(fontSize);
            $('fontSizeSel').onchange = () => {
                const value = Number($('fontSizeSel').value);
                if (![12, 14, 16, 18, 20].includes(value)) return;
                panel.style.setProperty('--reader-size', value + 'px'); localStorage.setItem('ioeai_font_size', String(value));
            };
            const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
            let wantedMotion = localStorage.getItem('ioeai_motion_effects') !== 'off';
            function applyMotionPreference() {
                const enabled = wantedMotion && !reducedMotion.matches;
                root.dataset.motion = enabled ? 'on' : 'off';
                $('motionEffects').checked = enabled; $('motionEffects').disabled = reducedMotion.matches;
            }
            $('motionEffects').onchange = () => { wantedMotion = $('motionEffects').checked; localStorage.setItem('ioeai_motion_effects', wantedMotion ? 'on' : 'off'); applyMotionPreference(); };
            reducedMotion.addEventListener?.('change', applyMotionPreference); applyMotionPreference();
            let commandChoices = [], commandIndex = 0;
            function hideCommands() { $('commandMenu').hidden = true; $('commandHelpBtn').setAttribute('aria-expanded', 'false'); question.removeAttribute('aria-activedescendant'); }
            function chooseCommand(command) {
                const content = question.value.trimStart().replace(/^\/\S*\s*/, '');
                question.value = '/' + command.name + ' ' + content;
                question.dispatchEvent(new Event('input')); hideCommands(); question.focus(); question.selectionStart = question.selectionEnd = question.value.length;
            }
            function updateCommandMenu(force = false) {
                const raw = question.value.trimStart(); const token = raw.match(/^\/([^\s]*)$/);
                const selected = parseStudyCommand(raw).command;
                $('commandMode').hidden = !selected; $('commandMode').textContent = selected ? selected.label : '';
                if (!token && !force) { hideCommands(); return; }
                const query = token && !force ? commandKey(token[1]) : '';
                commandChoices = STUDY_COMMANDS.filter(command => commandKey(command.name).includes(query)); commandIndex = 0;
                const menu = $('commandMenu'); menu.replaceChildren();
                if (!commandChoices.length) { hideCommands(); return; }
                commandChoices.forEach((command, index) => {
                    const button = document.createElement('button'); button.type = 'button'; button.className = 'command-option'; button.id = 'study-command-' + command.mode;
                    button.setAttribute('role', 'option'); button.setAttribute('aria-selected', String(index === commandIndex));
                    button.append(studyText('strong', '/' + command.name + ' · ' + command.label), studyText('small', command.description));
                    button.onclick = () => chooseCommand(command); menu.appendChild(button);
                });
                menu.appendChild(studyText('div', '↑ ↓ chọn · Enter hoặc Tab để chèn · Esc đóng', 'command-menu-note'));
                menu.hidden = false; $('commandHelpBtn').setAttribute('aria-expanded', 'true');
                question.setAttribute('aria-activedescendant', 'study-command-' + commandChoices[0].mode);
            }
            $('commandHelpBtn').onclick = () => { if (!$('commandMenu').hidden) hideCommands(); else { updateCommandMenu(true); question.focus(); } };
            $('userStudioBtn').onclick = () => {
                const nonce = crypto.randomUUID();
                const origin = new URL(BACKEND_URL).origin;
                const popup = window.open(origin + '/user#connect=' + nonce, '_blank');
                if (!popup) { setStatus('Trình duyệt chặn cửa sổ mới. Cho phép mở cửa sổ để vào Góc của tôi.'); return; }
                let sent = false;
                const receive = async event => {
                    if (sent || event.origin !== origin || event.source !== popup || event.data?.type !== 'ioe-user-ready' || event.data.nonce !== nonce) return;
                    sent = true; window.removeEventListener('message', receive); clearTimeout(expiry);
                    const token = await getToken(); const deviceId = await getInstallationId();
                    if (isTokenValid(token)) popup.postMessage({ type: 'ioe-user-session', nonce, session: { token, deviceId } }, origin);
                };
                window.addEventListener('message', receive);
                const expiry = setTimeout(() => window.removeEventListener('message', receive), 25000);
            };
            question.setAttribute('aria-controls', 'commandMenu'); question.setAttribute('aria-autocomplete', 'list');
            question.addEventListener('keydown', event => {
                if ($('commandMenu').hidden || !commandChoices.length) return;
                if (['ArrowDown', 'ArrowUp', 'Enter', 'Tab', 'Escape'].includes(event.key)) {
                    event.preventDefault(); event.stopImmediatePropagation();
                    if (event.key === 'Escape') { hideCommands(); return; }
                    if (event.key === 'Enter' || event.key === 'Tab') { chooseCommand(commandChoices[commandIndex]); return; }
                    commandIndex = (commandIndex + (event.key === 'ArrowDown' ? 1 : -1) + commandChoices.length) % commandChoices.length;
                    $('commandMenu').querySelectorAll('[role="option"]').forEach((option, index) => option.setAttribute('aria-selected', String(index === commandIndex)));
                    const id = 'study-command-' + commandChoices[commandIndex].mode; question.setAttribute('aria-activedescendant', id);
                    $(id)?.scrollIntoView({ block: 'nearest' });
                }
            });
            $('settingsBtn').onclick = () => {
                const controls = $('advancedControls'); controls.hidden = !controls.hidden;
                $('settingsBtn').setAttribute('aria-expanded', String(!controls.hidden));
            };
            $('searchBtn').onclick = () => {
                const search = $('historySearch'); search.hidden = !search.hidden;
                $('searchBtn').setAttribute('aria-expanded', String(!search.hidden));
                if (!search.hidden) search.focus();
                else { search.value = ''; search.dispatchEvent(new Event('input')); }
            };
            $('historySearch').oninput = () => {
                const text = $('historySearch').value.trim().toLocaleLowerCase('vi');
                messages.querySelectorAll('.msg').forEach(message => message.classList.toggle('search-hidden', !message.textContent.toLocaleLowerCase('vi').includes(text)));
            };
            $('exportChatBtn').onclick = () => {
                if (!history.length) { setStatus('Chưa có cuộc trò chuyện để xuất.'); return; }
                const markdown = '# Góc học tập\n\n' + history.map(item => `## ${item.role === 'user' ? 'Bạn' : 'Trợ lý'}\n\n${item.content}`).join('\n\n---\n\n');
                const url = URL.createObjectURL(new Blob([markdown], { type: 'text/markdown;charset=utf-8' }));
                const link = document.createElement('a'); link.href = url; link.download = `goc-hoc-tap-${new Date().toISOString().slice(0, 10)}.md`; link.click();
                setTimeout(() => URL.revokeObjectURL(url), 1000);
                setStatus('Đã xuất cuộc trò chuyện.');
            };
            question.value = currentSession().draft || '';
            updateCommandMenu();
            persistStudy();
            question.addEventListener('input', () => {
                updateCommandMenu();
                currentSession().draft = question.value.slice(0, 16000);
                currentSession().draftImage = pendingChatImagePreview || '';
                try { localStorage.setItem('ioeai_draft', question.value); } catch (_) {}
                if (persistStudy()) $('draftState').textContent = 'Đã lưu bản nháp';
            });
            $('quickCaptureBtn').onclick = () => $('capBtn').click();
            $('quickScrapeBtn').onclick = () => $('scrapeBtn').click();
            $('uploadImageBtn').onclick = () => $('imageFileInput').click();
            $('imageFileInput').onchange = async event => {
                const file = event.target.files[0]; event.target.value = '';
                if (!file || busy || pendingReview || authState !== 'unlocked') return;
                if (file.size > 3 * 1024 * 1024) { setStatus('Ảnh tối đa 3 MB. Hãy chọn ảnh nhỏ hơn.'); return; }
                setBusy(true); await handleImageWithVision(file);
            };
            let pendingChatImagePreview = currentSession().draftImage || null;
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
            if (pendingChatImagePreview) { preview.src = pendingChatImagePreview; preview.style.display = 'block'; }

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
                // Keep display math in one text node: inserting <br> within a
                // formula splits its delimiters and prevents KaTeX auto-render.
                const mathBlocks = [];
                const protectedText = String(text).replace(/(```[\s\S]*?```|~~~[\s\S]*?~~~|`[^`\n]+`)|\\\[[\s\S]*?\\\]|\$\$[\s\S]*?\$\$/g, (match, code) => {
                    if (code) return code;
                    return `DISPLAYMATHTOKEN${mathBlocks.push(match) - 1}END`;
                });
                const lines = protectedText.replace(/\r\n?/g, '\n').split('\n');
                const out = [];
                const isHr = line => /^\s*(?:---+|___+|\*\*\*+)\s*$/.test(line);
                const isBlockStart = line => /^\s*(```|~~~|#{1,6}\s|>\s?|[-+*]\s+|\d+[.)]\s+)/.test(line) || isHr(line);
                const cells = line => line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(c => c.trim());
                const isTableStart = index => index + 1 < lines.length && lines[index].includes('|') && /^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(lines[index + 1]);
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
                    while (i < lines.length && lines[i].trim() && !isBlockStart(lines[i]) && !isTableStart(i)) para.push(lines[i++]);
                    out.push(`<p>${renderInlineMarkdown(para.join('\n')).replace(/\n/g, '<br>')}</p>`);
                }
                return out.join('').replace(/DISPLAYMATHTOKEN(\d+)END/g, (_, index) => escapeMarkdownHtml(mathBlocks[Number(index)] || ''));
            }

            function normalizeMathOutput(text) {
                const clean = formula => formula
                    // Correct double-escaped commands without touching matrix
                    // row separators (\\), including row-spacing syntax.
                    .replace(/(?<!\\)\\\\(?=(?:boxed|frac|dfrac|tfrac|sqrt|text|mathrm|mathbf|mathbb|left|right|begin|end|angle|overline|perp|parallel|times|cdot|leq|geq|neq|sum|prod|int|pi|alpha|beta|theta)\b|[,;!:])/g, '\\')
                    .replace(/(?<!\\)\\[ \t]*(?=\r?\n|$)/g, '')
                    .replace(/&#x0*20;|&#0*32;|&nbsp;/gi, ' ');
                return String(text).replace(/(```[\s\S]*?```|~~~[\s\S]*?~~~|`[^`\n]+`)|\\{1,2}\[([\s\S]*?)\\{1,2}\]|\\{1,2}\(([\s\S]*?)\\{1,2}\)|\$\$([\s\S]*?)\$\$|\$([^$\n]+)\$/g,
                    (match, code, display, inline, dollars, single) => {
                        if (code) return code;
                        if (display !== undefined) return '\\[' + clean(display) + '\\]';
                        if (inline !== undefined) return '\\(' + clean(inline) + '\\)';
                        if (dollars !== undefined) return '$$' + clean(dollars) + '$$';
                        return '$' + clean(single) + '$';
                    });
            }

            function renderAssistantMessage(element, text) {
                element._studyText = text;
                element.innerHTML = renderMarkdown(normalizeMathOutput(text));
                renderMath(element);
                if (element.classList.contains('bot') && text) {
                    const copy = document.createElement('button'); copy.className = 'copy-answer'; copy.textContent = 'Sao chép';
                    copy.onclick = async () => {
                        try { await navigator.clipboard.writeText(text); copy.textContent = 'Đã sao chép ✓'; }
                        catch (_) { setStatus('Không truy cập được clipboard. Bạn có thể chọn nội dung để sao chép.'); }
                    };
                    const actions = document.createElement('div'); actions.className = 'message-actions';
                    const save = document.createElement('button'); save.className = 'study-button save-mistake'; save.textContent = 'Lưu bài sai';
                    save.onclick = () => {
                        if (busy) { setStatus('Đợi câu trả lời hoàn tất trước khi lưu bài.'); return; }
                        let user = element.previousElementSibling;
                        while (user && !user.classList.contains('user')) user = user.previousElementSibling;
                        const source = user?._studyText || '';
                        const existing = study.mistakes.find(m => m.question === source && m.answer === text);
                        editMistake(existing || { question: source, answer: text, subject: currentSession().subject,
                            ...(user?._studyImage ? { image: user._studyImage } : {}) });
                    };
                    actions.append(copy, save); element.appendChild(actions);
                }
            }

            function addMessage(role, text) {
                messages.querySelector('.welcome')?.remove();
                followLatest = true;
                const d = document.createElement('div');
                d.className = 'msg ' + (role === 'user' ? 'user' : 'bot');
                // Scraped questions and user-entered prompts can contain LaTeX too.
                // Render both roles consistently so `$...$` is never shown raw.
                renderAssistantMessage(d, text);
                messages.appendChild(d);
                messages.scrollTop = messages.scrollHeight;
                return d;
            }

            function addImageMessage(imageSrc, caption = '') {
                messages.querySelector('.welcome')?.remove();
                const d = document.createElement('div');
                d.className = 'msg user';
                d._studyText = caption || 'Ảnh câu hỏi đã gửi.';
                d._studyImage = /^data:image\/jpeg;base64,/i.test(imageSrc) && imageSrc.length < 300000 ? imageSrc : '';
                const image = document.createElement('img');
                image.className = 'msg-image';
                image.src = imageSrc;
                image.alt = 'Ảnh câu hỏi đã gửi';
                image.loading = 'lazy';
                d.appendChild(image);
                if (caption) {
                    const text = document.createElement('div');
                    text.className = 'msg-caption';
                    text.textContent = caption;
                    d.appendChild(text);
                }
                messages.appendChild(d);
                messages.scrollTop = messages.scrollHeight;
                return d;
            }

            history.forEach(item => item.image
                ? addImageMessage(item.image, item.caption || '')
                : addMessage(item.role, item.content));
            showWelcome();

            function setBusy(v) {
                busy = v;
                ['capBtn','sendBtn','scrapeBtn','quickCaptureBtn','quickScrapeBtn','uploadImageBtn','clearBtn','exportChatBtn','newSessionBtn','sessionsBtn','mistakesBtn','sessionSel'].forEach(id => {
                    const el = $(id);
                    if (el) el.disabled = v;
                });
                if (modelSel) modelSel.disabled = v;
                if (visionSel) visionSel.disabled = v;
                if (imageModeSel) imageModeSel.disabled = v;
                if (multiAgentEl) multiAgentEl.disabled = v || modelSel.value === 'gemini-3.8-flash';
                if (multiAgentRoundsEl) multiAgentRoundsEl.disabled = v;
            }

            const openPanel = () => {
                panel.classList.remove('hidden');
                const l = $('launcher');
                if (l) { l.setAttribute('aria-expanded', 'true'); l.setAttribute('aria-label', 'Thu gọn trợ lý học tập'); }
                refreshAccount();
                question.focus();
            };
            const closePanel = () => {
                panel.classList.add('hidden');
                const l = $('launcher');
                if (l) { l.setAttribute('aria-expanded', 'false'); l.setAttribute('aria-label', 'Mở trợ lý học tập'); }
            };

            const launcherEl = $('launcher');
            const closeBtnEl = $('closeBtn');
            const logoutBtnEl = $('logoutBtn');
            const infoBtnEl = $('infoBtn'), infoModalEl = $('infoModal'), closeInfoBtnEl = $('closeInfoBtn');
            if (launcherEl) launcherEl.onclick = () => panel.classList.contains('hidden') ? openPanel() : closePanel();
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
                    const legacySmall = parseFloat(savedSize.width) <= 470 && innerWidth >= 760;
                    panel.style.width = legacySmall ? '680px' : savedSize.width;
                    panel.style.height = legacySmall ? '840px' : savedSize.height;
                }
            } catch (_) {}
            panel.classList.toggle('expanded', readFlag('ioeai_panel_expanded', false));
            $('expandBtn').setAttribute('aria-pressed', String(panel.classList.contains('expanded')));
            $('expandBtn').onclick = () => {
                const expanded = panel.classList.toggle('expanded'); writeFlag('ioeai_panel_expanded', expanded);
                $('expandBtn').setAttribute('aria-pressed', String(expanded));
                $('reviewExpandBtn').setAttribute('aria-pressed', String(expanded));
                $('expandBtn').setAttribute('aria-label', expanded ? 'Thu lại khung đọc' : 'Mở rộng khung đọc');
            };
            window.addEventListener('resize', () => {
                if (panel.classList.contains('hidden') || panel.classList.contains('expanded')) return;
                const rect = panel.getBoundingClientRect();
                if (rect.left < 8 || rect.right > innerWidth - 8) { panel.style.left = Math.max(8, Math.min(innerWidth - rect.width - 8, rect.left)) + 'px'; panel.style.right = 'auto'; }
                if (rect.top < 8 || rect.bottom > innerHeight - 78) { panel.style.top = Math.max(8, Math.min(innerHeight - rect.height - 82, rect.top)) + 'px'; panel.style.bottom = 'auto'; }
            });
            if (logoutBtnEl) logoutBtnEl.onclick = () => {
                if (busy) return;
                if (!confirm('Đăng xuất khỏi trợ lý AI?')) return;
                controller?.abort();
                clearToken().then(showLock);
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
                if (panel.classList.contains('expanded')) return null;
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
                    if (panel.classList.contains('expanded')) return;
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
            async function visionImageData(file) {
                if (visionSel.value !== 'gemini-3.8-flash' || !(file.type === 'image/gif' || /\.gif$/i.test(file.name || ''))) return fileToDataURL(file);
                // Gemini accepts PNG/JPEG/WebP. Read the first GIF frame locally.
                const image = await loadImageFromFile(file); const width = image.naturalWidth || image.width, height = image.naturalHeight || image.height;
                const scale = Math.min(1, 2200 / width, 2200 / height);
                const canvas = document.createElement('canvas'); canvas.width = Math.max(1, Math.round(width * scale)); canvas.height = Math.max(1, Math.round(height * scale));
                const ctx = canvas.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, canvas.width, canvas.height); ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
                return fileToDataURL(await canvasToFile(canvas));
            }

            const loadImageFromFile = f => new Promise((res, rej) => {
                const url = URL.createObjectURL(f);
                const img = new Image();
                img.onload = () => { URL.revokeObjectURL(url); res(img); };
                img.onerror = () => { URL.revokeObjectURL(url); rej(new Error('Không thể đọc được ảnh.')); };
                img.src = url;
            });

            async function makeChatImageThumbnail(file) {
                try {
                    const img = await loadImageFromFile(file);
                    const scale = Math.min(1, 360 / (img.naturalWidth || img.width), 280 / (img.naturalHeight || img.height));
                    const canvas = document.createElement('canvas');
                    canvas.width = Math.max(1, Math.round((img.naturalWidth || img.width) * scale));
                    canvas.height = Math.max(1, Math.round((img.naturalHeight || img.height) * scale));
                    const ctx = canvas.getContext('2d');
                    ctx.fillStyle = '#fff';
                    ctx.fillRect(0, 0, canvas.width, canvas.height);
                    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
                    return canvas.toDataURL('image/jpeg', 0.5);
                } catch (_) { return ''; }
            }

            async function apiFetch(path, body) {
                const headers = { 'Content-Type': 'application/json' };
                const token = await getToken();
                if (token) headers['Authorization'] = 'Bearer ' + token;
                headers['X-Device-ID'] = await getInstallationId();
                return fetch(BACKEND_URL + path, {
                    method: 'POST',
                    headers,
                    body: JSON.stringify(body),
                    signal: controller ? AbortSignal.any([controller.signal, AbortSignal.timeout(60000)]) : AbortSignal.timeout(60000),
                });
            }
            // GROQ VISION TRANSCRIPTION
            async function transcribeImageWithVision(file, sourceContext = '') {
                if (visionSel.value === 'gemini-3.8-flash' && !account?.visionModels?.includes('gemini-3.8-flash')) {
                    await refreshAccount();
                    if (!account?.visionModels?.includes('gemini-3.8-flash')) throw new Error('Gemini Vision chưa sẵn sàng trên dịch vụ. Hãy chọn Qwen hoặc cập nhật cấu hình Gemini.');
                }
                const dataUrl = await visionImageData(file);
                setStatus('Đang đọc ảnh bằng ' + visionSel.options[visionSel.selectedIndex].text + '…');
                const res = await apiFetch('/api/vision', { image: dataUrl, model: visionSel.value, context: sourceContext });
                if (res.status === 401) {
                    await handleAuthFailure('Session expired. Please enter the access code again.');
                    throw new Error('AUTH');
                }
                const data = await res.json().catch(() => ({}));
                if (!res.ok) {
                    const retry = data.retryAfter ? ` Thử lại sau ${data.retryAfter} giây.` : '';
                    throw new Error((data.error || `HTTP ${res.status}`) + retry);
                }
                if (data.text) return data.text;
                throw new Error('Vision API returned no text');
            }

            // CHAT
            async function callGroq(userContent, historyText, model, imageDataUrl = null, historyImage = '', historyCaption = '', forcedStudyMode = null) {
                const studyRequest = parseStudyCommand(typeof userContent === 'string' ? userContent : '');
                if (studyRequest.error) { setStatus(studyRequest.error); return; }
                if (forcedStudyMode && (!studyRequest.command || forcedStudyMode === 'analyze')) studyRequest.mode = forcedStudyMode;
                if (!studyModeReady(studyRequest.mode)) return;
                const useMultiAgent = multiAgentEl.checked && !imageDataUrl && model !== 'gemini-3.8-flash';
                if (useMultiAgent && account && account.multiAgentRemaining <= 0) {
                    setStatus('Daily multi-agent limit reached (3 runs). Use a single model or try again tomorrow.');
                    return;
                }
                setBusy(true);
                const stopBtn = $('stopBtn');
                if (stopBtn) stopBtn.style.display = 'block';
                const answer = addMessage('assistant', studyRequest.mode === 'hint' ? 'Đang tìm một gợi ý nhỏ để bạn tự làm…' : '⏳ Đang suy nghĩ...');
                let fullText = '';
                controller = new AbortController();

                const messagesForBackend = [
                    { role: 'system', content: SYSTEM_PROMPT },
                    ...history.slice(-CHAT_CONTEXT_MAX).map(({ role, content }) => ({ role, content })),
                    { role: 'user', content: studyRequest.content },
                ];

                const body = {
                    messages: messagesForBackend,
                    model,
                    studyMode: studyRequest.mode,
                    multiAgent: useMultiAgent,
                    ...(useMultiAgent ? { multiAgentMaxRevisions: Number(multiAgentRoundsEl.value) || 1 } : {}),
                    ...(imageDataUrl ? { image: imageDataUrl } : {}),
                };

                let lastRender = 0;
                const RENDER_MS = 350;

                try {
                    const headers = { 'Content-Type': 'application/json' };
                    const token = await getToken();
                    if (token) headers['Authorization'] = 'Bearer ' + token;
                    headers['X-Device-ID'] = await getInstallationId();

                    const response = await fetch(BACKEND_URL + '/api/chat', {
                        method: 'POST',
                        headers,
                        body: JSON.stringify(body),
                        signal: controller.signal,
                    });

                    if (response.status === 401) {
                        answer.textContent = '❌ Phiên đăng nhập đã hết hạn.';
                        await handleAuthFailure('Phiên đăng nhập đã hết hạn. Vui lòng nhập lại mã.');
                        return;
                    }

                    if (!response.ok) {
                        const errText = await response.text();
                        let detail = errText.slice(0, 300);
                        try {
                            const payload = JSON.parse(errText);
                            detail = (payload.error || detail) + (payload.retryAfter ? ` Thử lại sau ${payload.retryAfter} giây.` : '');
                        } catch (_) {}
                        throw new Error(detail || `Backend HTTP ${response.status}`);
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
                        if (obj.error) throw new Error(obj.error.message || obj.error || 'Luồng AI gặp lỗi.');
                        const c = obj.choices && obj.choices[0]?.delta?.content;
                        if (typeof c === 'string' && c) {
                            fullText += c;
                            const now = Date.now();
                            if (now - lastRender >= RENDER_MS) {
                                lastRender = now;
                                renderAssistantMessage(answer, fullText);
                            }
                            scrollLatest();
                        }
                        return false;
                    };

                    while (!ended) {
                        const r = await reader.read();
                        buffer += decoder.decode(r.value || new Uint8Array(), { stream: !r.done });
                        const lines = buffer.split('\n');
                        buffer = lines.pop() || '';
                        for (const line of lines) {
                            if (processLine(line.trimEnd())) { ended = true; break; }
                        }
                        if (r.done) {
                            if (buffer.trim() && processLine(buffer.trimEnd())) ended = true;
                            if (!ended) throw new Error('Kết nối bị ngắt trước khi AI trả lời xong. Hãy thử lại.');
                            break;
                        }
                    }

                    if (!fullText) throw new Error('Model không trả về nội dung.');

                    renderAssistantMessage(answer, fullText);

                    history.push(
                        { role: 'user', content: historyText, ...(historyImage ? { image: historyImage, caption: historyCaption } : {}) },
                        { role: 'assistant', content: fullText }
                    );
                    if (history.length > CHAT_HISTORY_MAX) history = history.slice(-CHAT_HISTORY_MAX);
                    saveChatHistory(history);
                    setStatus(studyRequest.mode === 'hint' ? 'Đã gợi ý. Bạn thử bước tiếp theo nhé.' : 'Đã trả lời · Lịch sử được lưu trên thiết bị này.');
                } catch (err) {
                    if (err.name === 'AbortError') {
                        renderAssistantMessage(answer, (fullText || '') + '\n\nStopped.');
                        if (fullText) {
                            history.push(
                                { role: 'user', content: historyText, ...(historyImage ? { image: historyImage, caption: historyCaption } : {}) },
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
                    refreshAccount();
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

            async function transcribeImageToInput(file, sourceContext = '') {
                const previousThumbnail = pendingChatImagePreview;
                controller = new AbortController();
                $('stopBtn').style.display = 'block';
                showPreview(file);
                try {
                    const text = await transcribeImageWithVision(file, sourceContext);
                    pendingChatImagePreview = await makeChatImageThumbnail(file);
                    clearPreview();
                    setBusy(false);
                    appendToQuestion(text);
                    setStatus('Đã chép đề vào bản nháp. Bạn có thể sửa trước khi gửi.');
                    question.dispatchEvent(new Event('input'));
                } catch (err) {
                    pendingChatImagePreview = previousThumbnail;
                    if (err.message === 'AUTH') return;
                    clearPreview();
                    setBusy(false);
                    setStatus(err.name === 'AbortError' ? 'Đã dừng đọc ảnh.' : 'Không đọc được ảnh: ' + (err.message || err));
                } finally {
                    controller = null; $('stopBtn').style.display = 'none'; setBusy(false); refreshAccount();
                    if (pendingChatImagePreview) { preview.src = pendingChatImagePreview; preview.style.display = 'block'; }
                }
            }

            function discardReview() {
                if (pendingReview?.url) URL.revokeObjectURL(pendingReview.url);
                pendingReview = null; $('imageReview').hidden = true; $('reviewImage').removeAttribute('src');
                $('reviewOriginalLink').removeAttribute('href');
                $('reviewFormatted').replaceChildren(); $('reviewFormatted').hidden = true; $('reviewText').hidden = false;
                $('reviewPreviewBtn').textContent = 'Xem định dạng'; $('reviewPreviewBtn').setAttribute('aria-pressed', 'false');
                $('reviewText').value = ''; $('reviewMessage').textContent = '';
            }
            async function acceptReview(solve) {
                if (!pendingReview || busy) return;
                const edited = $('reviewText').value.trim();
                if (!edited) { $('reviewMessage').textContent = 'Đề bài không được để trống.'; $('reviewText').focus(); return; }
                if (edited.length > 16000) { $('reviewMessage').textContent = 'Đề dài quá 16000 ký tự. Hãy rút gọn trước khi gửi.'; return; }
                const command = parseStudyCommand(edited);
                if (solve && command.error) { $('reviewMessage').textContent = command.error; return; }
                if (solve && !studyModeReady(command.mode)) { $('reviewMessage').textContent = 'Chế độ này chưa sẵn sàng trên dịch vụ. Bản chép đề được giữ nguyên.'; return; }
                const thumbnail = pendingReview.thumbnail;
                discardReview(); closeLibrary();
                if (!solve) {
                    question.value = edited; pendingChatImagePreview = thumbnail;
                    question.dispatchEvent(new Event('input')); question.focus();
                    setStatus('Đã đưa đề đã kiểm tra vào bản nháp.'); return;
                }
                addImageMessage(thumbnail, edited);
                question.value = ''; currentSession().draft = ''; currentSession().draftImage = ''; pendingChatImagePreview = null;
                persistStudy(); localStorage.removeItem('ioeai_draft');
                await callGroq(edited, edited, modelSel.value, null, thumbnail, edited);
            }
            $('discardReviewBtn').onclick = () => { discardReview(); setStatus('Đã bỏ bản chép đề. Bản nháp trước đó được giữ nguyên.'); };
            $('reviewDraftBtn').onclick = () => acceptReview(false);
            $('reviewSolveBtn').onclick = () => acceptReview(true);
            $('reviewExpandBtn').onclick = () => $('expandBtn').click();
            $('reviewPreviewBtn').onclick = () => {
                const show = $('reviewFormatted').hidden;
                if (show) { $('reviewFormatted').innerHTML = renderMarkdown(normalizeMathOutput($('reviewText').value)); renderMath($('reviewFormatted')); }
                $('reviewFormatted').hidden = !show; $('reviewText').hidden = show;
                $('reviewPreviewBtn').textContent = show ? 'Sửa văn bản' : 'Xem định dạng'; $('reviewPreviewBtn').setAttribute('aria-pressed', String(show));
            };
            $('imageReview').addEventListener('keydown', event => {
                if (event.key === 'Escape') { event.preventDefault(); discardReview(); question.focus(); }
                if (event.key === 'Tab') {
                    const nodes = [...$('imageReview').querySelectorAll('button,textarea')].filter(node => !node.disabled);
                    const active = container.activeElement || document.activeElement;
                    if (event.shiftKey && active === nodes[0]) { event.preventDefault(); nodes.at(-1).focus(); }
                    else if (!event.shiftKey && active === nodes.at(-1)) { event.preventDefault(); nodes[0].focus(); }
                }
            });
            async function handleImageWithVision(file, sourceContext = '') {
                hideCommands();
                if (imageModeSel.value === 'transcribe') { await transcribeImageToInput(file, sourceContext); return; }
                if (['analyze', 'direct-solve'].includes(imageModeSel.value)) {
                    const analyze = imageModeSel.value === 'analyze';
                    const forcedMode = analyze ? 'analyze' : 'solve';
                    if (!studyModeReady(forcedMode)) { setBusy(false); return; }
                    try {
                        const caption = question.value.trim();
                        let prompt = caption || (analyze ? 'Phân tích nội dung ảnh: giữ rõ bảng/cột, dữ kiện và hình vẽ; đánh dấu phần không rõ. Chưa giải bài hoặc đưa đáp án.' : 'Đọc kỹ ảnh, giữ đúng bảng/cột và dữ kiện hình vẽ, rồi giải bài. Nêu rõ phần không đọc được thay vì đoán.');
                        let parsed = parseStudyCommand(prompt);
                        if (parsed.error && parsed.command) { prompt += ' Hãy đọc bài trong ảnh.'; parsed = parseStudyCommand(prompt); }
                        if (parsed.error) { setBusy(false); setStatus(parsed.error); return; }
                        if (!studyModeReady(analyze ? 'analyze' : parsed.command ? parsed.mode : 'solve')) { setBusy(false); return; }
                        const dataUrl = await visionImageData(file); const thumbnail = await makeChatImageThumbnail(file);
                        addImageMessage(thumbnail, caption || (analyze ? 'Phân tích ảnh đã gửi.' : 'Giải bài trong ảnh.'));
                        question.value = ''; pendingChatImagePreview = null; currentSession().draft = ''; currentSession().draftImage = ''; persistStudy(); clearPreview();
                        await callGroq(prompt + (sourceContext ? '\n\nThông tin bố cục trên trang: ' + sourceContext : ''), caption || (analyze ? 'Phân tích ảnh đã gửi.' : 'Giải bài trong ảnh.'), visionSel.value, dataUrl, thumbnail, caption, forcedMode);
                    } catch (error) { setBusy(false); setStatus('Không xử lý được ảnh: ' + error.message); }
                    return;
                }
                controller = new AbortController(); $('stopBtn').style.display = 'block';
                showPreview(file);
                try {
                    const text = await transcribeImageWithVision(file, sourceContext);
                    const thumbnail = await makeChatImageThumbnail(file);
                    if (controller.signal.aborted) throw new DOMException('Aborted', 'AbortError');
                    const caption = question.value.trim();
                    pendingReview = { thumbnail, url: URL.createObjectURL(file) };
                    $('reviewImage').src = pendingReview.url;
                    $('reviewOriginalLink').href = pendingReview.url;
                    $('reviewExpandBtn').setAttribute('aria-pressed', String(panel.classList.contains('expanded')));
                    $('reviewText').value = (caption ? caption + '\n\n' : '') + text;
                    $('reviewMessage').textContent = '';
                    $('imageReview').hidden = false;
                    $('reviewText').focus();
                    setStatus('Đã đọc ảnh. Hãy kiểm tra đề trước khi gửi giải.');
                } catch (err) {
                    if (err.message !== 'AUTH') setStatus(err.name === 'AbortError' ? 'Đã dừng đọc ảnh.' : 'Không đọc được ảnh: ' + err.message);
                } finally {
                    clearPreview(); controller = null; $('stopBtn').style.display = 'none'; setBusy(false); refreshAccount();
                    if (pendingChatImagePreview) { preview.src = pendingChatImagePreview; preview.style.display = 'block'; }
                }
            }

            async function captureAndAsk() {
                if (busy || pendingReview || authState !== 'unlocked') return;
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

                await handleImageWithVision(file);
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
                    const question = el.querySelector('.questionRender');
                    const style = getComputedStyle(el);
                    return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && !el.closest('[aria-hidden="true"]') && question &&
                        (question.querySelector('img,math,mjx-container') || question.textContent.trim()) &&
                        (el.querySelector('form input, input[placeholder*="Đáp án"], input[type="radio"], input[type="checkbox"]') || el.querySelectorAll('button').length >= 2);
                }) || null;
            }

            function questionImageUrl(raw) {
                try {
                    const url = new URL(raw, location.href);
                    return url.protocol === 'https:' && url.hostname === 'images1.violympic.vn' && !url.port && !url.username && !url.password ? url.href : null;
                } catch (_) { return null; }
            }
            async function originalQuestionImage(raw) {
                const url = questionImageUrl(raw);
                if (!url) throw new Error('Ảnh không thuộc máy chủ đề bài được hỗ trợ.');
                let blob;
                if (typeof GM_xmlhttpRequest === 'function') {
                    blob = await new Promise((resolve, reject) => {
                        GM_xmlhttpRequest({ method: 'GET', url, responseType: 'blob', anonymous: true, timeout: 12000,
                            onload: response => response.status >= 200 && response.status < 300 ? resolve(response.response) : reject(new Error('Không tải được ảnh đề gốc.')),
                            onerror: () => reject(new Error('Không truy cập được máy chủ ảnh.')),
                            ontimeout: () => reject(new Error('Tải ảnh đề quá thời gian.')) });
                    });
                } else {
                    const response = await fetch(url, { credentials: 'omit', signal: AbortSignal.timeout(12000) });
                    if (!response.ok) throw new Error('Không tải được ảnh đề gốc.');
                    blob = await response.blob();
                }
                if (!blob || !blob.size || blob.size > 8 * 1024 * 1024) throw new Error('Ảnh đề không hợp lệ hoặc quá lớn.');
                const file = new File([blob], 'violympic-original.png', { type: blob.type || 'image/png' });
                const image = await loadImageFromFile(file);
                const width = image.naturalWidth || image.width, height = image.naturalHeight || image.height;
                if (blob.size <= 3 * 1024 * 1024 && width <= 2200 && height <= 2200 && ['image/png', 'image/jpeg', 'image/webp'].includes(blob.type)) return file;
                const scale = Math.min(1, 2200 / width, 2200 / height);
                const canvas = document.createElement('canvas'); canvas.width = Math.max(1, Math.round(width * scale)); canvas.height = Math.max(1, Math.round(height * scale));
                const ctx = canvas.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, canvas.width, canvas.height); ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
                return canvasToFile(canvas);
            }

            async function captureQuestionDialog(dialog) {
                const question = dialog.querySelector('.questionRender');
                const images = [...dialog.querySelectorAll('img')];
                if (question && images.length === 1 && question.contains(images[0]) && !question.textContent.trim() && questionImageUrl(images[0].currentSrc || images[0].src)) {
                    setStatus('Đang lấy ảnh đề gốc để giữ rõ chữ và bảng…');
                    return originalQuestionImage(images[0].currentSrc || images[0].src);
                }
                if (typeof html2canvas !== 'function') throw new Error('html2canvas is unavailable');
                const replacements = new Map();
                const trusted = [...new Set(images.map(image => questionImageUrl(image.currentSrc || image.src)).filter(Boolean))];
                if (trusted.length > 8) throw new Error('Đề có quá nhiều ảnh. Hãy chụp vùng cần đọc.');
                await Promise.all(trusted.map(async url => replacements.set(url, await fileToDataURL(await originalQuestionImage(url)))));
                root.style.visibility = 'hidden';
                try {
                    await wait(80);
                    const shot = await html2canvas(dialog, {
                        useCORS: true, allowTaint: false, logging: false,
                        backgroundColor: '#ffffff',
                        scale: Math.min(window.devicePixelRatio || 1, 2),
                        imageTimeout: 5000,
                        onclone: clone => {
                            clone.querySelectorAll('img').forEach(image => {
                                const inline = replacements.get(image.currentSrc || image.src);
                                if (inline) { image.removeAttribute('srcset'); image.src = inline; }
                            });
                            clone.querySelectorAll('.MuiDialogContent-root p').forEach(node => {
                                if (/^Còn lại:\s*\d+:\d+/.test(node.textContent.trim())) node.style.visibility = 'hidden';
                            });
                        },
                    });
                    return await canvasToFile(shot);
                } finally {
                    root.style.visibility = 'visible';
                }
            }

            async function doScrape(mode) {
                if (busy || pendingReview || authState !== 'unlocked') return;
                setBusy(true);
                try {
                    if (mode === 'all') {
                        const dialog = findVisibleQuestionDialog();
                        if (dialog) {
                            setStatus('Capturing the full question dialog...');
                            try {
                                const file = await captureQuestionDialog(dialog);
                                const fillAnswer = Boolean(dialog.querySelector('form input:not([type="radio"]):not([type="checkbox"]), input[placeholder*="Đáp án"]'));
                                await handleImageWithVision(file, fillAnswer ? 'Dạng trả lời trên trang: nhập đáp án vào một ô trống. Không tự điền hoặc gửi biểu mẫu.' : 'Giữ nguyên các lựa chọn đáp án và bố cục hiện trên trang.');
                            } catch (err) {
                                setBusy(false);
                                setStatus('Không lấy được ảnh đề: ' + err.message + ' Bạn có thể dán ảnh chụp đề bằng Ctrl+V hoặc chọn Chụp đề.');
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
                if (busy || pendingReview || authState !== 'unlocked') return;
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

                await handleImageWithVision(file);
            }

            document.addEventListener('paste', e => {
                if (authState !== 'unlocked') return;
                if (busy || pendingReview) return;
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
                if (busy || pendingReview || authState !== 'unlocked') return;
                hideScrapeActions();
                const raw = question.value.trim();
                if (!raw) return;
                if (raw.length > 16000) { setStatus('Câu hỏi tối đa 16000 ký tự. Hãy rút gọn trước khi gửi.'); return; }
                const command = parseStudyCommand(raw);
                if (command.error) { setStatus(command.error); return; }
                if (!studyModeReady(command.mode)) return;
                clearPreview();
                const attachedImage = pendingChatImagePreview;
                if (attachedImage) addImageMessage(attachedImage, raw);
                else addMessage('user', raw);
                pendingChatImagePreview = null;
                question.value = '';
                question.dispatchEvent(new Event('input'));
                localStorage.removeItem('ioeai_draft');
                callGroq(raw, raw, modelSel.value, null, attachedImage || '', attachedImage ? raw : '');
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
                pendingChatImagePreview = null;
                question.value = '';
                saveChatHistory(history);
                messages.replaceChildren();
                showWelcome();
                localStorage.removeItem('ioeai_draft');
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
    if (location.origin === new URL(BACKEND_URL).origin && ['/user', '/user.html'].includes(location.pathname)) {
        let confirming = false;
        window.addEventListener('message', async event => {
            if (event.source !== window || event.origin !== location.origin || !/^[a-f0-9-]{36}$/i.test(event.data?.nonce || '')) return;
            const { type, nonce, code } = event.data;
            if (type === 'ioe-device-probe') { window.postMessage({ type: 'ioe-device-ready', nonce }, location.origin); return; }
            if (type !== 'ioe-device-confirm' || confirming || typeof code !== 'string' || !code.trim() || code.length > 256) return;
            confirming = true;
            try {
                if (!window.confirm('Cho phép Góc học tập dùng lại phiên userscript trên trình duyệt này? Chỉ xác nhận khi chính bạn vừa bấm “Xác nhận cùng thiết bị”. Không thêm hoặc reset thiết bị.')) {
                    window.postMessage({ type: 'ioe-device-result', nonce, error: 'Bạn đã hủy xác nhận.' }, location.origin); return;
                }
                const token = await getToken();
                if (!isTokenValid(token)) throw new Error('Userscript chưa đăng nhập hoặc phiên đã hết hạn. Hãy đăng nhập trên trang học trước.');
                const deviceId = await getInstallationId();
                const response = await fetch(BACKEND_URL + '/api/auth', { method: 'POST', credentials: 'omit', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token, 'X-Device-ID': deviceId }, body: JSON.stringify({ code: code.trim(), deviceId, sameDevice: true }), signal: AbortSignal.timeout(20000) });
                const data = await response.json().catch(() => ({}));
                if (!response.ok || !data.reusedDevice || !data.token) throw new Error(data.error || 'Không xác nhận được thiết bị. Hãy thử lại.');
                window.postMessage({ type: 'ioe-device-result', nonce, session: { token: data.token, deviceId } }, location.origin);
            } catch (error) { window.postMessage({ type: 'ioe-device-result', nonce, error: error.message || 'Không xác nhận được thiết bị.' }, location.origin); }
            finally { confirming = false; }
        });
    } else boot();
})();
