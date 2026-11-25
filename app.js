(function(){
// 经典脚本模式：数据由 knowledge.js 挂到 window（兼容 file:// 直接打开）
const { XIYOU_CHARACTERS: CHARACTERS, XIYOU_KNOWLEDGE: KNOWLEDGE, XIYOU_CATEGORIES: CATEGORIES, XIYOU_CURATED_QA: CURATED_QA } = window;

// 正式网站通过同源服务端代理调用云端模型，访客无需 API Key，密钥不会进入浏览器。
// file:// 与静态托管（无同源代理，/api/chat 404）时自动回退到公共服务直连。
const POLLINATIONS_OPENAI = 'https://text.pollinations.ai/openai';
const CLOUD_ENDPOINTS = location.protocol === 'file:'
  ? [POLLINATIONS_OPENAI]
  : ['/api/chat', POLLINATIONS_OPENAI];
const CLOUD_MODEL = 'openai'; // Pollinations Classic 当前公开的 GPT-OSS 20B 模型名
const CUSTOM_CFG_KEY = 'xiyou-cloud-config';
// WebLLM: 在线加载 Hugging Face 上的开源模型（Qwen 等），浏览器 WebGPU 推理，无需 API key。
// https://github.com/mlc-ai/web-llm
const WEBLLM_CDN = 'https://esm.run/@mlc-ai/web-llm';
// LiteRT-LM Web API: https://developers.google.com/edge/litert-lm/js
const LITERT_CDN = 'https://cdn.jsdelivr.net/npm/@litert-lm/core/+esm';
const EMBEDDING_MODEL = 'https://huggingface.co/litert-community/embeddinggemma-2-740m-litert-lm/resolve/main/embeddinggemma-2-740m.litertlm';
const MODEL_FILES = {
  'hf://litert-community/gemma-4-E2B-it-litert-lm':
    'https://huggingface.co/litert-community/gemma-4-E2B-it-litert-lm/resolve/web/gemma-4-E2B-it-gpu.litertlm',
  'hf://litert-community/gemma-4-E4B-it-litert-lm':
    'https://huggingface.co/litert-community/gemma-4-E4B-it-litert-lm/resolve/web/gemma-4-E4B-it-gpu.litertlm'
};
const MODEL_OPTIONS = {
  local: [
    ['local', '内置精选知识 + 角色化生成（无需网络/GPU）']
  ],
  cloud: [
    ['openai', 'GPT-OSS 20B（开源权重 · 云端 · 免 key）']
  ],
  webllm: [
    ['Qwen2.5-0.5B-Instruct-q4f16_1-MLC', 'Qwen2.5 0.5B · 约 0.3 GB（推荐，低配可跑）'],
    ['Qwen3-0.6B-q4f16_1-MLC', 'Qwen3 0.6B · 约 0.4 GB'],
    ['Qwen2.5-1.5B-Instruct-q4f16_1-MLC', 'Qwen2.5 1.5B · 约 1.0 GB'],
    ['Qwen2.5-3B-Instruct-q4f16_1-MLC', 'Qwen2.5 3B · 约 1.9 GB']
  ],
  litert: [
    ['hf://litert-community/gemma-4-E2B-it-litert-lm', 'Gemma 4 E2B · 约 2.3 GB'],
    ['hf://litert-community/gemma-4-E4B-it-litert-lm', 'Gemma 4 E4B · 约 3.3 GB']
  ]
};
const ENGINE_HINTS = {
  local: '智能本地：内置精选问答 + 本地知识检索，按角色生成回答。无需网络、无需 GPU、无延迟、不限流，任何环境都能用。想要真实大模型可切到「线上开源」或「WebLLM」。',
  cloud: '云端模型流式生成回答：优先本站代理，静态托管时直连公共服务。访客无需 API Key、无需下载，手机和电脑浏览器均可使用。问题和检索片段会发送到模型服务，请勿输入敏感内容；高峰时段可能需要短暂等待。',
  webllm: '模型来自 Hugging Face 的开源权重（mlc-ai / Qwen），首次加载在线下载到浏览器缓存，之后可复用；无需 API key，推理全程在你的设备上。需要新版 Chrome / Edge + WebGPU。',
  litert: 'Google LiteRT-LM 端侧引擎，通过 ReadableStream 将权重直接送入 WebGPU 编译，不在内存中重复保存整份模型。模型体积较大（2.3 GB 起）；若 Hugging Face 要求授权，请先接受模型许可并填写下载 Token。',
  demo: '不下载模型、不运行大模型。只把本地检索到的知识片段按角色语气组织成回答，用于先看交互效果。'
};
const TOP_K = 3;
const CLOUD_TIMEOUT_MS = 120000;

const $ = (id) => document.getElementById(id);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const state = {
  charId: 'wukong',
  engineKind: 'local',        // 当前选择的引擎：local | cloud | webllm | litert
  mode: 'local',              // 实际使用的引擎：local | cloud | webllm | litert
  cloudHistory: [],           // 云端会话上下文 [{role, content}]
  cloudAbort: null,           // 云端请求的 AbortController
  custom: null,               // 自定义接口配置 { endpoint, model, key }
  busy: false,
  stopRequested: false,
  webllm: null,
  webllmModule: null,
  chatHistory: [],            // WebLLM 会话上下文 [{role, content}]
  litertModule: null,
  engine: null,               // LiteRT Engine
  conversation: null,
  embeddingEngine: null,
  embeddingLoading: null,
  docVectors: null,
  semantic: false,
  cloudNextAllowedAt: 0
};

const el = {
  characterList: $('character-list'),
  hero: $('hero'),
  messages: $('messages'),
  input: $('input'),
  send: $('send-btn'),
  stop: $('stop-btn'),
  suggestions: $('suggestions'),
  enginePill: $('engine-pill'),
  enginePillText: $('engine-pill-text'),
  engineTabs: $('engine-tabs'),
  engineState: $('engine-state'),
  enginePlace: $('engine-place'),
  engineHint: $('engine-hint'),
  webgpu: $('webgpu-state'),
  modelSelect: $('model-select'),
  localModelLabel: $('local-model-label'),
  loadEngine: $('load-engine-btn'),
  unloadEngine: $('unload-engine-btn'),
  progressWrap: $('engine-progress'),
  progressBar: $('progress-bar'),
  progressText: $('progress-text'),
  semanticToggle: $('semantic-toggle'),
  kbCount: $('kb-count'),
  kbTags: $('kb-tags'),
  toast: $('toast')
};

const currentChar = () => CHARACTERS.find((c) => c.id === state.charId);

let uid = 0;
function avatarSVG(char) {
  const gid = `ag${++uid}`;
  return `<svg viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
    <defs><linearGradient id="${gid}" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="${char.color}"/><stop offset="100%" stop-color="${char.color2}"/>
    </linearGradient></defs>
    <rect width="100" height="100" fill="url(#${gid})"/>
    <path d="M0 79 Q17 65 33 79 T67 79 T100 79 V100 H0Z" fill="rgba(0,0,0,.18)"/>
    <circle cx="50" cy="47" r="32" fill="none" stroke="rgba(255,246,222,.42)" stroke-width="1"/>
    <circle cx="50" cy="47" r="28" fill="none" stroke="rgba(255,246,222,.16)" stroke-width="1"/>
    <text x="50" y="64" text-anchor="middle" font-family="serif" font-size="46" fill="#fff7e3">${char.glyph}</text>
  </svg>`;
}

function toast(msg) {
  el.toast.textContent = msg;
  el.toast.classList.add('show');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.toast.classList.remove('show'), 3200);
}

const ENGINE_LABEL = { local: '智能本地', cloud: '线上开源模型', webllm: 'WebLLM 开源模型', litert: 'LiteRT-LM 端侧', demo: '演示模式' };
function setPill(mode, text) {
  el.enginePill.className = `engine-pill mode-${mode}`;
  el.enginePillText.textContent = text;
}

/* ---------------- 本地知识检索 ---------------- */

function tokenize(text) {
  const out = [];
  for (const run of text.match(/[\u3400-\u9fff]+/g) || []) {
    for (let i = 0; i < run.length; i++) {
      out.push(run[i]);
      if (i < run.length - 1) out.push(run.slice(i, i + 2));
    }
  }
  for (const w of (text.toLowerCase().match(/[a-z0-9]+/g) || [])) out.push(w);
  return out;
}

const LEX_INDEX = KNOWLEDGE.map((k) => ({
  k,
  set: new Set(tokenize(`${k.title} ${k.text} ${k.keywords.join(' ')}`))
}));

function lexicalSearch(query, topK = TOP_K) {
  const qTokens = tokenize(query);
  const scored = LEX_INDEX.map(({ k, set }) => {
    let score = 0;
    for (const t of qTokens) if (set.has(t)) score += t.length >= 2 ? 2 : 1;
    if (k.keywords.some((kw) => query.includes(kw))) score += 4;
    if (query.includes(k.title)) score += 3;
    return { k, score };
  }).filter((x) => x.score > 0);
  scored.sort((a, b) => b.score - a.score);
  // 过滤掉弱相关命中，避免「大圣」这类共用词带出无关片段
  const threshold = scored.length ? Math.max(2, scored[0].score * 0.6) : 0;
  return scored.filter((x) => x.score >= threshold).slice(0, topK).map((x) => x.k);
}

function cosine(a, b) {
  let s = 0;
  for (let i = 0; i < a.length && i < b.length; i++) s += a[i] * b[i];
  return s;
}

async function ensureEmbeddings() {
  if (state.embeddingEngine && state.docVectors) return;
  if (state.embeddingLoading) return state.embeddingLoading;
  refreshModePill();
  state.embeddingLoading = (async () => {
    try {
      el.semanticToggle.disabled = true;
      setPill('loading', '正在加载嵌入模型…');
      el.kbCount.textContent = '嵌入模型加载中…';
      const mod = state.litertModule || await import(LITERT_CDN);
      state.litertModule = mod;
      state.embeddingEngine = await mod.EmbeddingEngine.create({
        model: EMBEDDING_MODEL,
        backend: mod.Backend.GPU
      });
      const docs = KNOWLEDGE.map((k) => `task: search result | text: ${(k.title + '。' + k.text).trim()}`);
      const vectors = [];
      for (let i = 0; i < docs.length; i++) {
        const { embedding } = await state.embeddingEngine.computeEmbedding(docs[i], { normalize: true });
        vectors.push(embedding);
        if (i % 5 === 0 || i === docs.length - 1) {
          el.kbCount.textContent = `索引中 ${i + 1}/${docs.length}`;
          await sleep(0);
        }
      }
      state.docVectors = vectors;
      el.kbCount.textContent = `${KNOWLEDGE.length} 条 · 语义检索就绪`;
    } catch (err) {
      state.embeddingEngine = null;
      state.docVectors = null;
      state.semantic = false;
      el.semanticToggle.checked = false;
      el.kbCount.textContent = `${KNOWLEDGE.length} 条 · 词法检索`;
      throw err;
    } finally {
      state.embeddingLoading = null;
      el.semanticToggle.disabled = false;
      refreshModePill();
    }
  })();
  return state.embeddingLoading;
}

async function retrieve(query) {
  if (state.semantic) {
    try {
      await ensureEmbeddings();
      const { embedding } = await state.embeddingEngine.computeEmbedding(
        `task: search query | text: ${query.trim()}`, { normalize: true });
      const scored = KNOWLEDGE.map((k, i) => ({ k, score: cosine(embedding, state.docVectors[i]) }));
      scored.sort((a, b) => b.score - a.score);
      return scored.slice(0, TOP_K).map((x) => x.k);
    } catch (err) {
      state.semantic = false;
      el.semanticToggle.checked = false;
      toast(`语义检索不可用，已回退词法检索：${err.message}`);
      refreshModePill();
    }
  }
  return lexicalSearch(query);
}

function buildSystemContent(hits, query) {
  const char = currentChar();
  const context = hits.map((k, i) => `[${i + 1}] ${k.title}：${k.text}`).join('\n');
  const curated = query ? findCuratedAnswer(query) : null;
  const parts = [char.systemPrompt];
  if (curated) {
    parts.push(`以下是本题的标准参考答案，你的回答必须以其事实为准，不得编造回目、卷数或其他细节：\n${curated}`);
  }
  if (context) {
    parts.push(`以下是本地知识库检索到的资料，请优先依据它们作答，不要编造资料外的内容：\n${context}`);
  }
  parts.push('严格要求：只使用上面提供的事实，不要虚构原著回目、卷数或情节；如果资料没有提到，就如实说不知道。');
  return parts.join('\n\n');
}

/* ---------------- 引擎加载 / 卸载 ---------------- */

function applyEngineKind(kind) {
  state.engineKind = kind;
  el.engineTabs.querySelectorAll('.engine-tab').forEach((b) => {
    b.classList.toggle('active', b.dataset.engine === kind);
  });
  if (MODEL_OPTIONS[kind]) {
    el.localModelLabel.hidden = false;
    el.modelSelect.hidden = false;
    el.modelSelect.innerHTML = MODEL_OPTIONS[kind]
      .map(([v, label]) => `<option value="${v}">${label}</option>`).join('');
  } else {
    el.localModelLabel.hidden = true;
    el.modelSelect.hidden = true;
  }
  el.engineHint.textContent = ENGINE_HINTS[kind];
  $('hf-token-wrap').hidden = kind !== 'litert';
  el.loadEngine.hidden = kind === 'local' || kind === 'cloud';
  el.loadEngine.textContent = kind === 'litert' ? '加载端侧模型' : '加载开源模型';
}

async function unloadEngine(silent = false) {
  if (state.conversation) {
    try { await state.conversation.delete(); } catch (e) { console.warn(e); }
  }
  if (state.webllm) {
    try { await state.webllm.unload(); } catch (e) { console.warn(e); }
    state.webllm = null;
  }
  if (state.engine) {
    try { await state.engine.delete(); } catch (e) { console.warn(e); }
    state.engine = null;
  }
  state.conversation = null;
  state.mode = 'local';
  state.chatHistory = [];
  state.cloudHistory = [];
  state.cloudDegraded = false;
  state.cloudNextAllowedAt = 0;
  el.engineState.textContent = '智能本地就绪（免加载）';
  el.engineState.className = 'ok';
  el.enginePlace.textContent = '用户设备 / 本地';
  el.unloadEngine.hidden = true;
  el.loadEngine.textContent = state.engineKind === 'litert' ? '加载端侧模型' : '加载开源模型';
  refreshModePill();
  if (!silent) toast('已卸载模型，回到智能本地模式。');
}

async function hasWebGPUAdapter() {
  if (!navigator.gpu) return false;
  try {
    const adapter = await navigator.gpu.requestAdapter();
    return !!adapter;
  } catch (e) {
    return false;
  }
}

async function loadEngine() {
  if (state.busy) return;
  const kind = state.engineKind;
  if (kind === 'local') { toast('智能本地模式无需加载模型，直接提问即可。'); return; }
  if (kind === 'cloud') { toast('线上开源模型开箱即用，直接提问即可。'); return; }
  if (!await hasWebGPUAdapter()) {
    toast('当前浏览器没有可用的 WebGPU 适配器，无法运行开源模型。请使用新版 Chrome / Edge，开启硬件加速，并通过 localhost 或 HTTPS 打开；智能本地回答不受影响。');
    return;
  }
  state.busy = true;
  el.loadEngine.disabled = true;
  el.loadEngine.textContent = '加载中…';
  el.progressWrap.hidden = false;
  el.progressBar.style.width = '2%';
  el.progressText.textContent = '正在准备运行环境…';
  setPill('loading', '模型加载中…');

  try {
    if (kind === 'webllm') await loadWebLLM();
    else await loadLiteRT();
    state.mode = kind;
    el.enginePlace.textContent = '用户设备（WebGPU）';
    el.unloadEngine.hidden = false;
    refreshModePill();
    toast(`${ENGINE_LABEL[kind]}已就绪，现在的问题将在你的设备上推理。`);
  } catch (err) {
    console.error(err);
    el.engineState.textContent = '加载失败';
    el.engineState.className = 'warn';
    setPill('error', '模型加载失败');
    toast(`模型加载失败：${err.message || err}`);
    addMessage('system', `模型加载失败：${err.message || err}。你可以切回演示模式继续查看交互，或检查 WebGPU / 网络后重试。`);
  } finally {
    state.busy = false;
    el.loadEngine.disabled = false;
    el.loadEngine.textContent = kind === 'litert' ? '重新加载端侧模型' : '重新加载开源模型';
    el.progressWrap.hidden = true;
  }
}

async function loadWebLLM() {
  const modelId = el.modelSelect.value;
  el.progressText.textContent = `正在在线获取开源模型 ${modelId} 的权重…`;
  const mod = state.webllmModule || await import(WEBLLM_CDN);
  state.webllmModule = mod;
  state.webllm = await mod.CreateMLCEngine(modelId, {
    initProgressCallback: (report) => {
      const pct = Math.min(99, Math.max(1, Math.round((report.progress || 0) * 100)));
      el.progressBar.style.width = `${pct}%`;
      el.progressText.textContent = `加载中 ${pct}% · ${report.text || '下载开源模型权重'}`;
    }
  });
  state.chatHistory = [];
  el.engineState.textContent = `${modelId.split('-q')[0]} 已就绪`;
  el.engineState.className = 'ok';
}

async function modelStreamWithProgress(url, accessToken = '') {
  el.progressText.textContent = '正在连接模型服务器…';
  const headers = accessToken ? { Authorization: `Bearer ${accessToken}` } : {};
  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error(`模型下载失败：HTTP ${res.status}`);
  if (!res.body) throw new Error('浏览器不支持读取模型下载流。');
  const total = Number(res.headers.get('content-length')) || 0;
  const reader = res.body.getReader();
  let received = 0;
  let lastPct = -1;
  return new ReadableStream({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          el.progressBar.style.width = '100%';
          el.progressText.textContent = '权重已接收，正在编译到 GPU…';
          controller.close();
          return;
        }
        received += value.length;
        const pct = total ? Math.min(99, Math.round((received / total) * 100)) : Math.min(99, Math.round(received / 25e6));
        if (pct !== lastPct) {
          el.progressBar.style.width = `${pct}%`;
          el.progressText.textContent = total
            ? `已流式加载 ${(received / 1e9).toFixed(2)} / ${(total / 1e9).toFixed(2)} GB（${pct}%）`
            : `已流式加载 ${(received / 1e6).toFixed(0)} MB…`;
          lastPct = pct;
        }
        controller.enqueue(value);
      } catch (err) {
        controller.error(err);
        await reader.cancel().catch(() => {});
      }
    },
    async cancel(reason) {
      await reader.cancel(reason).catch(() => {});
    }
  });
}

async function loadLiteRT() {
  const modelPath = el.modelSelect.value;
  if (!MODEL_FILES[modelPath]) throw new Error('请选择有效的 LiteRT 模型。');
  const mod = state.litertModule || await import(LITERT_CDN);
  state.litertModule = mod;
  el.progressText.textContent = '正在初始化 LiteRT-LM WebGPU 运行时…';
  await mod.loadLiteRtLm();
  el.progressText.textContent = '正在流式加载模型权重…';
  const modelStream = await modelStreamWithProgress(MODEL_FILES[modelPath], $('hf-token').value.trim());
  state.engine = await mod.Engine.create({
    model: modelStream,
    backend: mod.Backend.GPU,
    benchmarkEnabled: true,
    mainExecutorSettings: { maxNumTokens: 8192 }
  });
  await createConversation();
  el.engineState.textContent = '端侧模型已就绪';
  el.engineState.className = 'ok';
}

async function createConversation() {
  if (!state.engine) return;
  if (state.conversation) {
    try { await state.conversation.delete(); } catch (e) { console.warn(e); }
    state.conversation = null;
  }
  const char = currentChar();
  state.conversation = await state.engine.createConversation({
    preface: { messages: [{ role: 'system', content: char.systemPrompt }] },
    sessionConfig: {
      maxOutputTokens: 1024,
      samplerParams: { temperature: 0.7, p: 0.9, k: 40 }
    }
  });
}

function refreshModePill() {
  const suffix = state.semantic ? ' + 语义检索' : '';
  if (state.mode === 'cloud' && state.cloudDegraded) setPill('demo', '云端不可用 · 已本地降级');
  else if (state.mode === 'cloud') setPill('live', `线上开源模型 · GPT-OSS 20B${suffix}`);
  else if (state.mode === 'webllm') setPill('live', `WebLLM 开源模型运行中${suffix}`);
  else if (state.mode === 'litert') setPill('live', `LiteRT-LM 端侧运行中${suffix}`);
  else if (state.engineKind === 'webllm') setPill('loading', '开源模型待加载');
  else if (state.engineKind === 'litert') setPill('loading', '端侧模型待加载');
  else if (state.embeddingLoading) setPill('loading', '正在构建语义索引…');
  else setPill('live', state.semantic ? '智能本地 · 精选知识 + 语义检索' : '智能本地 · 精选知识回答');
}

/* ---------------- 对话界面 ---------------- */

function addMessage(role, text, opts = {}) {
  const char = currentChar();
  const wrap = document.createElement('div');
  wrap.className = `msg ${role}`;
  const avatar = document.createElement('div');
  avatar.className = 'msg-avatar';
  avatar.innerHTML = avatarSVG(role === 'user'
    ? { id: 'me', glyph: '我', color: '#5a6069', color2: '#2a2e35' }
    : char);
  const body = document.createElement('div');
  body.className = 'msg-body';
  const name = document.createElement('div');
  name.className = 'msg-name';
  name.textContent = role === 'user' ? '你' : (role === 'system' ? '系统提示' : `${char.name} · ${char.title}`);
  const bubble = document.createElement('div');
  bubble.className = 'bubble';
  bubble.textContent = text;
  body.append(name, bubble);
  wrap.append(avatar, body);
  el.messages.querySelector('.messages-inner').append(wrap);

  if (opts.citations && opts.citations.length) {
    const row = document.createElement('div');
    row.className = 'citations';
    opts.citations.forEach((k, i) => {
      const chip = document.createElement('button');
      chip.className = 'cite-chip';
      chip.textContent = `[${i + 1}] ${k.title}`;
      chip.title = k.text;
      chip.onclick = () => {
        const old = row.parentNode.querySelector(`.cite-detail[data-id="${k.id}"]`);
        if (old) { old.remove(); return; }
        const detail = document.createElement('div');
        detail.className = 'cite-detail';
        detail.dataset.id = k.id;
        detail.textContent = `${k.category} · ${k.title}：${k.text}`;
        row.parentNode.insertBefore(detail, row.nextSibling);
      };
      row.append(chip);
    });
    body.append(row);
  }
  if (opts.note) {
    const note = document.createElement('div');
    note.className = 'hint';
    note.textContent = opts.note;
    body.append(note);
  }
  el.messages.scrollTop = el.messages.scrollHeight;
  return bubble;
}

function renderCharacter() {
  const char = currentChar();
  el.characterList.innerHTML = CHARACTERS.map((c) => `
    <button class="char-card ${c.id === char.id ? 'active' : ''}" data-id="${c.id}">
      <span class="char-avatar">${avatarSVG(c)}</span>
      <span class="char-meta"><strong>${c.name}</strong><span>${c.title}</span></span>
    </button>`).join('');
  el.characterList.querySelectorAll('.char-card').forEach((btn) => {
    btn.onclick = () => selectCharacter(btn.dataset.id);
  });

  el.hero.innerHTML = `
    <div class="hero-avatar">${avatarSVG(char)}</div>
    <div class="hero-main">
      <div class="hero-kicker">数字分身 · DIGITAL AVATAR</div>
      <h2>${char.name}<small>${char.title}</small></h2>
      <p class="hero-desc">${char.desc}</p>
    </div>`;

  el.suggestions.innerHTML = char.suggestions
    .map((s) => `<button class="suggestion">${s}</button>`).join('');
  el.suggestions.querySelectorAll('.suggestion').forEach((btn) => {
    btn.onclick = () => { el.input.value = btn.textContent; send(); };
  });
}

async function selectCharacter(id) {
  if (state.charId === id || state.busy) return;
  state.charId = id;
  renderCharacter();
  el.messages.querySelector('.messages-inner').innerHTML = '';
  if (state.mode === 'cloud') {
    state.cloudHistory = [];
  } else if (state.mode === 'webllm') {
    state.chatHistory = [];
    try { await state.webllm.resetChat(); } catch (e) { console.warn(e); }
  } else if (state.mode === 'litert') {
    try { await createConversation(); } catch (err) { toast(`会话重建失败：${err.message}`); }
  }
  const char = currentChar();
  addMessage('assistant', char.greeting);
}

function findCuratedAnswer(query) {
  // 命中任一关键词即返回该条精选回答（按匹配数量排序取最优）
  let best = null;
  let bestScore = 0;
  for (const qa of CURATED_QA) {
    const score = qa.match.reduce((n, kw) => n + (query.includes(kw) ? 1 : 0), 0);
    if (score > bestScore) { bestScore = score; best = qa; }
  }
  if (!best) return null;
  const char = currentChar();
  return best.answers[char.id] || best.answers.wukong;
}

function demoAnswer(query, hits) {
  const char = currentChar();
  // 优先使用精选的手工回答（质量最高，且不依赖网络/GPU）
  const curated = findCuratedAnswer(query);
  if (curated) return curated;
  if (!hits.length) {
    const tails = {
      wukong: '这问题俺老孙可记不真切，换个问法再试试？',
      tangseng: '阿弥陀佛，此节贫僧未曾听闻，施主可换个话题。',
      bajie: '嘿嘿，老猪实在想不起来，咱换个问法吧。',
      shaseng: '弟子记不真切，师父若再提点一二便是。',
      puti: '此非我门中事。换个问题，我再听你道来。'
    };
    return tails[char.id];
  }
  const lead = {
    wukong: `嘿嘿，你问「${query}」？俺老孙先说结论：`,
    tangseng: `施主问「${query}」，贫僧且从头说起：`,
    bajie: `嘿，你问「${query}」？老猪先想想……说正经的：`,
    shaseng: `施主问「${query}」，弟子依记忆答来：`,
    puti: `来者问「${query}」。既问了，便听我一言：`
  }[char.id];
  const body = hits.map((k, i) => `[${i + 1}] ${k.title}：${k.text}`).join('\n\n');
  const tail = {
    wukong: '若还想听细节，俺老孙再给你掰扯掰扯。',
    tangseng: '阿弥陀佛，愿施主得见本来面目。',
    bajie: '嘿嘿，老猪就知道这么多，可别告诉师父我偷懒。',
    shaseng: '弟子所言如有差池，还请施主指正。',
    puti: '可曾悟得？'
  }[char.id];
  return `${lead}\n\n${body}\n\n${tail}`;
}

/* ---------------- 云端接口配置与多端点调用 ---------------- */

function loadCustomConfig() {
  try {
    const raw = localStorage.getItem(CUSTOM_CFG_KEY);
    state.custom = raw ? JSON.parse(raw) : null;
  } catch (e) { state.custom = null; }
}

function saveCustomConfig() {
  const endpoint = $('custom-endpoint').value.trim();
  const model = $('custom-model').value.trim();
  const key = $('custom-key').value.trim();
  if (!endpoint) {
    state.custom = null;
    localStorage.removeItem(CUSTOM_CFG_KEY);
    toast('已清除自定义接口，恢复 Pollinations 公共接口。');
  } else {
    state.custom = { endpoint, model, key };
    localStorage.setItem(CUSTOM_CFG_KEY, JSON.stringify(state.custom));
    toast('自定义接口已保存到本机浏览器。');
  }
  el.engineHint.textContent = state.custom
    ? `当前优先使用你的自定义接口：${state.custom.endpoint}（${state.custom.model || '默认模型'}）。失败时会自动回退 Pollinations 与本地知识回答。`
    : ENGINE_HINTS.cloud;
}

function cloudErrorMessage(err) {
  if (err.name === 'AbortError' && state.stopRequested) return '已停止生成。';
  if (err.status === 402 || err.status === 429) {
    const retry = err.retryAfter ? `请在 ${Math.ceil(err.retryAfter)} 秒后重试。` : '请稍后重试。';
    return `云端免费额度暂时不可用，${retry}也可以填写自己的接口。`;
  }
  if (err.name === 'TimeoutError') return '云端请求超时，请稍后重试。';
  return err.message || String(err);
}

async function tryCloudOnce(endpoint, model, key, messages, signal, onPiece) {
  const headers = { 'Content-Type': 'application/json' };
  if (key) headers.Authorization = `Bearer ${key}`;
  const res = await fetch(endpoint, {
    method: 'POST',
    headers,
    body: JSON.stringify({ model, messages, stream: true, temperature: 0.7 }),
    signal
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    const err = new Error(`HTTP ${res.status} ${detail.slice(0, 160)}`);
    err.status = res.status;
    const retryAfter = Number(res.headers.get('retry-after'));
    if (Number.isFinite(retryAfter) && retryAfter > 0) err.retryAfter = retryAfter;
    throw err;
  }
  if (!res.body) throw new Error('浏览器不支持读取云端响应流。');

  const contentType = (res.headers.get('content-type') || '').toLowerCase();
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let reply = '';

  const consume = (line) => {
    const trimmed = line.trim();
    if (!trimmed.startsWith('data:')) return;
    const payload = trimmed.slice(5).trim();
    if (!payload || payload === '[DONE]') return;
    let chunk;
    try { chunk = JSON.parse(payload); } catch (e) { return; }
    if (chunk.error) throw new Error(chunk.error.message || '云端模型返回错误。');
    const piece = chunk.choices?.[0]?.delta?.content
      || chunk.choices?.[0]?.message?.content
      || chunk.response
      || '';
    if (typeof piece !== 'string') return;
    reply += piece;
    onPiece(piece);
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const hasContentType = !!contentType;
    const isStreamingSSE = contentType.includes('text/event-stream') || (!hasContentType && buffer.trimStart().startsWith('data:'));
    if (!isStreamingSSE) continue;
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() || '';
    for (const line of lines) consume(line);
  }
  buffer += decoder.decode();
  const responseText = buffer.trim();
  const isSSE = contentType.includes('text/event-stream')
    || (!contentType && (responseText.startsWith('data:') || !responseText.startsWith('{')));
  if (isSSE) {
    if (buffer.trim()) consume(buffer);
  } else {
    let chunk;
    try { chunk = JSON.parse(buffer); } catch (e) {
      const text = buffer.trim();
      const noticeStatus = text.match(/^(402|429)\b/);
      if (noticeStatus) {
        const err = new Error(text.slice(0, 160));
        err.status = Number(noticeStatus[1]);
        const retryAfter = Number(res.headers.get('retry-after'));
        if (Number.isFinite(retryAfter) && retryAfter > 0) err.retryAfter = retryAfter;
        throw err;
      }
      if (text) {
        reply += text;
        onPiece(text);
      }
    }
    if (chunk) {
      if (chunk.error) throw new Error(chunk.error.message || '云端模型返回错误。');
      const piece = chunk.choices?.[0]?.message?.content
        || chunk.choices?.[0]?.delta?.content
        || chunk.response
        || '';
      if (typeof piece === 'string' && piece) {
        reply += piece;
        onPiece(piece);
      }
    }
  }
  if (!reply.trim()) throw new Error('云端接口返回了空内容。');
  return reply;
}

async function cloudChat(messages, signal, onPiece, onStatus) {
  const candidates = [];
  if (state.custom) {
    candidates.push({
      endpoint: state.custom.endpoint,
      model: state.custom.model || CLOUD_MODEL,
      key: state.custom.key
    });
  }
  for (const endpoint of CLOUD_ENDPOINTS) {
    candidates.push({ endpoint, model: CLOUD_MODEL, key: '' });
  }
  const errors = [];
  for (const cfg of candidates) {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const reply = await tryCloudOnce(cfg.endpoint, cfg.model, cfg.key, messages, signal, onPiece);
        if (!state.custom && location.protocol === 'file:') state.cloudNextAllowedAt = Date.now() + 45000;
        return reply;
      } catch (err) {
        if (signal?.aborted) throw err;
        const rateLimited = !state.custom && (err.status === 402 || err.status === 429);
        if (rateLimited && attempt < 2) {
          // 免费服务遇到并发请求会返回 429；保留本次回答，等待后重试而非立即降级。
          const waitMs = Math.min(60000, Math.max(15000, (err.retryAfter || 15) * 1000));
          onStatus?.(`云端当前繁忙，约 ${Math.ceil(waitMs / 1000)} 秒后自动重试…`);
          await new Promise((resolve, reject) => {
            const timer = setTimeout(resolve, waitMs);
            signal?.addEventListener('abort', () => {
              clearTimeout(timer);
              reject(signal.reason || new DOMException('Aborted', 'AbortError'));
            }, { once: true });
          });
          continue;
        }
        errors.push(`${cfg.endpoint.replace('https://', '')}: ${cloudErrorMessage(err)}`);
        console.warn('云端端点失败：', cfg.endpoint, err.message);
        break;
      }
    }
  }
  const err = new Error(errors.join(' | '));
  err.allFailed = true;
  throw err;
}

function modeNote() {
  if (state.mode === 'local') return '智能本地：由内置精选问答与本地知识库按角色生成，数据不离开设备。';
  if (state.mode === 'cloud') return '线上开源模式：资料先在本机检索，再由云端开源模型（GPT-OSS 20B）生成，内容会发送到公共服务。';
  return `${ENGINE_LABEL[state.mode]}：资料先在本机检索，再由设备上的模型生成。`;
}

async function send() {
  const text = el.input.value.trim();
  if (!text || state.busy) return;
  el.input.value = '';
  el.input.style.height = '';
  state.busy = true;
  state.stopRequested = false;
  el.send.disabled = true;
  el.engineTabs.querySelectorAll('button').forEach((b) => { b.disabled = true; });
  el.characterList.querySelectorAll('button').forEach((b) => { b.disabled = true; });
  el.modelSelect.disabled = true;
  el.loadEngine.disabled = true;
  el.stop.hidden = false;

  addMessage('user', text);
  let bubble;
  try {
    const hits = await retrieve(text);
    bubble = addMessage('assistant', '', { citations: hits, note: modeNote() });
    bubble.classList.add('cursor');

    if (state.mode === 'cloud') {
      const messages = [
        { role: 'system', content: buildSystemContent(hits, text) },
        ...state.cloudHistory.slice(-8),
        { role: 'user', content: text }
      ];
      state.cloudAbort = new AbortController();
      const timeout = setTimeout(() => {
        const err = new Error('云端请求超时');
        err.name = 'TimeoutError';
        state.cloudAbort?.abort(err);
      }, CLOUD_TIMEOUT_MS);
      let reply = '';
      try {
        const waitMs = state.custom || location.protocol !== 'file:' ? 0 : Math.max(0, state.cloudNextAllowedAt - Date.now());
        if (waitMs > 0) {
          bubble.classList.remove('cursor');
          bubble.textContent = `免费云端接口正在等待下一个调用名额（约 ${Math.ceil(waitMs / 1000)} 秒）…`;
        }
        reply = await cloudChat(messages, state.cloudAbort.signal, (piece) => {
          bubble.classList.remove('cursor');
          bubble.textContent += piece;
          el.messages.scrollTop = el.messages.scrollHeight;
        }, (status) => {
          bubble.classList.remove('cursor');
          bubble.textContent = status;
        });
      } catch (err) {
        if (state.stopRequested) {
          if (!bubble.textContent.trim()) bubble.textContent = '已停止生成。';
          return;
        }
        bubble.textContent = '';
        bubble.textContent = demoAnswer(text, hits);
        const note = bubble.parentNode.querySelector('.hint');
        if (note) note.textContent = `云端接口暂时不可用，已自动用本地知识回答。${cloudErrorMessage(err)}`;
        state.cloudDegraded = true;
        setPill('demo', '云端不可用 · 已本地降级');
        toast('云端接口不可用，已自动用本地知识回答。');
        console.warn('云端全部失败：', err.message);
        return;
      } finally {
        clearTimeout(timeout);
      }
      if (reply) {
        state.cloudDegraded = false;
        state.cloudHistory.push({ role: 'user', content: text }, { role: 'assistant', content: reply });
        state.cloudHistory = state.cloudHistory.slice(-8);
      }
      if (!bubble.textContent) bubble.textContent = '（云端模型没有返回内容，请稍后重试。）';
    } else if (state.mode === 'webllm' && state.webllm) {
      const sys = buildSystemContent(hits, text);
      const messages = [
        { role: 'system', content: sys },
        ...state.chatHistory.slice(-8),
        { role: 'user', content: text }
      ];
      // 每轮重置内部会话，保证 system prompt 中的 RAG 资料是最新的
      try { await state.webllm.resetChat(); } catch (e) { console.warn(e); }
      const chunks = await state.webllm.chat.completions.create({
        messages, temperature: 0.7, max_tokens: 1024, stream: true
      });
      let reply = '';
      for await (const chunk of chunks) {
        if (state.stopRequested) { state.webllm.interruptGenerate(); break; }
        const piece = chunk.choices?.[0]?.delta?.content || '';
        if (piece) {
          reply += piece;
          bubble.textContent += piece;
          el.messages.scrollTop = el.messages.scrollHeight;
        }
      }
      if (reply) {
        state.chatHistory.push({ role: 'user', content: text }, { role: 'assistant', content: reply });
        state.chatHistory = state.chatHistory.slice(-8);
      }
      if (!bubble.textContent) bubble.textContent = '（模型没有返回内容，请重试或检查模型兼容性。）';
    } else if (state.mode === 'litert' && state.conversation) {
      const prompt = `${buildSystemContent(hits, text)}\n\n用户问题：${text}`;
      const stream = state.conversation.sendMessageStreaming(prompt);
      let reply = '';
      for await (const chunk of stream) {
        if (state.stopRequested) { state.conversation.cancel(); break; }
        let piece = '';
        if (typeof chunk === 'string') piece = chunk;
        else if (chunk && typeof chunk.content === 'string') piece = chunk.content;
        else if (chunk && Array.isArray(chunk.content)) {
          for (const item of chunk.content) if (item && item.type === 'text') piece += item.text;
        }
        if (piece) {
          reply += piece;
          bubble.textContent += piece;
          el.messages.scrollTop = el.messages.scrollHeight;
        }
      }
      if (reply) {
        const benchmark = await state.conversation.getBenchmarkInfo().catch(() => null);
        const rate = benchmark?.lastDecodeTokensPerSecond;
        if (Number.isFinite(rate) && rate > 0) {
          const note = bubble.parentNode.querySelector('.hint');
          if (note) note.textContent += ` · ${rate.toFixed(1)} tokens/s`;
        }
      }
      if (!bubble.textContent) bubble.textContent = '（模型没有返回内容，请重试或检查模型兼容性。）';
    } else {
      const answer = demoAnswer(text, hits);
      for (let i = 0; i < answer.length; i += 6) {
        if (state.stopRequested) break;
        bubble.textContent += answer.slice(i, i + 6);
        el.messages.scrollTop = el.messages.scrollHeight;
        await sleep(14);
      }
    }
  } catch (err) {
    if (state.stopRequested) {
      if (bubble && !bubble.textContent.trim()) bubble.textContent = '已停止生成。';
      return;
    }
    console.error(err);
    if (bubble) bubble.textContent = '生成失败，请检查网络或接口设置后重试。';
    toast(`生成失败：${err.message || err}`);
  } finally {
    if (bubble) bubble.classList.remove('cursor');
    state.cloudAbort = null;
    state.busy = false;
    el.send.disabled = false;
    el.engineTabs.querySelectorAll('button').forEach((b) => { b.disabled = false; });
    el.characterList.querySelectorAll('button').forEach((b) => { b.disabled = false; });
    el.modelSelect.disabled = false;
    el.loadEngine.disabled = false;
    el.stop.hidden = true;
    el.input.focus();
    refreshModePill();
  }
}

/* ---------------- 初始化 ---------------- */

function init() {
  el.kbCount.textContent = `${KNOWLEDGE.length} 条`;
  el.kbTags.innerHTML = CATEGORIES.map((c) => `<span class="kb-tag">${c}</span>`).join('');

  hasWebGPUAdapter().then((ok) => {
    el.webgpu.textContent = ok ? '可用' : '不可用';
    el.webgpu.className = ok ? 'ok' : 'warn';
  });

  el.messages.innerHTML = '<div class="messages-inner"></div>';
  loadCustomConfig();
  if (state.custom) {
    $('custom-endpoint').value = state.custom.endpoint;
    $('custom-model').value = state.custom.model || '';
    $('custom-key').value = state.custom.key || '';
    el.engineHint.textContent = `当前优先使用你的自定义接口：${state.custom.endpoint}（${state.custom.model || '默认模型'}）。失败时会自动回退 Pollinations 与本地知识回答。`;
  }
  $('save-custom-btn').onclick = saveCustomConfig;
  $('clear-custom-btn').onclick = () => {
    $('custom-endpoint').value = '';
    $('custom-model').value = '';
    $('custom-key').value = '';
    saveCustomConfig();
  };
  applyEngineKind('local');
  el.engineState.textContent = '智能本地就绪（免加载）';
  el.engineState.className = 'ok';
  el.enginePlace.textContent = '用户设备 / 本地';
  renderCharacter();
  addMessage('assistant', currentChar().greeting);
  refreshModePill();

  el.send.onclick = send;
  el.stop.onclick = () => {
    state.stopRequested = true;
    if (state.mode === 'cloud') state.cloudAbort?.abort();
    else if (state.mode === 'webllm') state.webllm?.interruptGenerate();
    else if (state.mode === 'litert') state.conversation?.cancel?.();
  };
  el.input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
  });
  el.input.addEventListener('input', () => {
    el.input.style.height = 'auto';
    el.input.style.height = `${Math.min(150, el.input.scrollHeight)}px`;
  });
  el.engineTabs.querySelectorAll('.engine-tab').forEach((btn) => {
    btn.onclick = async () => {
      if (state.busy || btn.dataset.engine === state.engineKind) return;
      await unloadEngine(true);
      applyEngineKind(btn.dataset.engine);
      if (btn.dataset.engine === 'cloud') {
        state.mode = 'cloud';
        state.cloudDegraded = false;
        el.engineState.textContent = '云端开源模型就绪（免加载）';
        el.engineState.className = 'ok';
        el.enginePlace.textContent = 'Pollinations / 自定义接口';
      } else if (btn.dataset.engine === 'local') {
        state.mode = 'local';
        el.engineState.textContent = '智能本地就绪（免加载）';
        el.engineState.className = 'ok';
        el.enginePlace.textContent = '用户设备 / 本地';
      } else {
        el.engineState.textContent = '未加载';
        el.engineState.className = '';
        el.enginePlace.textContent = '等待加载模型';
      }
      refreshModePill();
      toast(`已切换到${ENGINE_LABEL[btn.dataset.engine]}`);
    };
  });
  el.loadEngine.onclick = loadEngine;
  el.unloadEngine.onclick = () => unloadEngine(false);
  el.semanticToggle.onchange = async () => {
    if (el.semanticToggle.checked) {
      try { await ensureEmbeddings(); state.semantic = true; }
      catch (err) {
        el.semanticToggle.checked = false;
        toast(`嵌入模型加载失败：${err.message || err}`);
      }
    } else {
      state.semantic = false;
      el.kbCount.textContent = `${KNOWLEDGE.length} 条`;
      if (state.embeddingEngine) {
        try { await state.embeddingEngine.delete(); } catch (e) { console.warn(e); }
        state.embeddingEngine = null;
        state.docVectors = null;
        el.kbCount.textContent = `${KNOWLEDGE.length} 条 · 已释放嵌入模型`;
      }
    }
    refreshModePill();
  };
}

init();

})();
