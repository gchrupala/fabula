'use strict';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const APP = 'fabula';
// Earlier name of the app; its synced file is read once if the new one does not exist yet.
const LEGACY_APP = 'biblioteka';
const MISTRAL_URL = 'https://api.mistral.ai/v1';
const DEFAULTS = {
  user: '',
  mistralKey: '',
  model: 'mistral-large-latest',
  githubToken: '',
  repo: 'gchrupala/app-data',
};

// Tried in this order when the chosen model is not included in the Mistral plan.
// All are open-weight models.
const FALLBACK_MODELS = ['mistral-small-latest', 'open-mistral-nemo', 'ministral-8b-latest'];

// Long conversations: only the most recent messages are sent to the model,
// at most this many and at most this many characters (the latest message is always sent).
const HISTORY_MAX_MESSAGES = 40;
const HISTORY_MAX_CHARS = 40000;
// Earlier replies longer than this are sent shortened, so the model does not
// copy the length of its own earlier long replies.
const HISTORY_MAX_REPLY_CHARS = 1500;
// Upper limit for one writing-helper reply (about 900 words), so a reply cannot run on.
// Translations have no such limit: they must be as long as her text.
const MAX_REPLY_TOKENS = 1200;
// Translations keep more of the conversation, unshortened, so follow-up requests
// about a long chapter still see it.
const TRANSLATE_HISTORY_MAX_CHARS = 150000;
// A translation that still stops because of length is continued automatically, at most this many times.
const MAX_CONTINUATIONS = 5;
// Texts to translate that are longer than this are translated in parts of about PART_WORDS words.
const SPLIT_ABOVE_WORDS = 900;
const PART_WORDS = 700;
const CONTINUE_REQUEST = 'Continue the translation exactly where you stopped. Do not repeat anything you already wrote and do not add any introduction or notes before it.';

const LANGS = {
  pl: 'polski',
  en: 'angielski',
  nl: 'niderlandzki',
  fa: 'perski (farsi)',
  es: 'hiszpański',
};

const MODES = {
  brainstorm: { label: 'Pomysły', placeholder: 'O czym jest twoje opowiadanie? Z czym potrzebujesz pomocy?' },
  translate: { label: 'Tłumaczenie', placeholder: 'Wklej tekst do przetłumaczenia albo napisz, co zmienić.' },
};

// ---------------------------------------------------------------------------
// Local storage
// ---------------------------------------------------------------------------

function load(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

function store(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* storage full or blocked */ }
}

const settings = { ...DEFAULTS, ...load(`${APP}-settings`, {}) };
// Devices set up before the default changed have the old default saved;
// move them to the new one once. A later 403 fallback is kept.
if (!settings.largeDefault) {
  if (settings.model === 'mistral-small-latest') settings.model = DEFAULTS.model;
  settings.largeDefault = true;
  store(`${APP}-settings`, settings);
}
const state = load(`${APP}-state`, { conversations: {}, activeId: null });
// Her story notes, given to the writing helper in every conversation.
if (!state.notes) state.notes = { text: '', updatedAt: 0 };
let device = load(`${APP}-device`, null);
if (!device) {
  device = Math.random().toString(36).slice(2, 18);
  store(`${APP}-device`, device);
}

function saveState() { store(`${APP}-state`, state); }
function saveSettings() { store(`${APP}-settings`, settings); }

// ---------------------------------------------------------------------------
// Conversations
// ---------------------------------------------------------------------------

function newId() {
  return (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));
}

function liveConversations() {
  return Object.values(state.conversations)
    .filter(c => !c.deleted)
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

function activeConv() {
  const c = state.conversations[state.activeId];
  return c && !c.deleted ? c : null;
}

function createConversation(mode) {
  const now = Date.now();
  const conv = {
    id: newId(),
    mode,
    targetLang: mode === 'translate' ? (settings.lastTargetLang || 'en') : null,
    title: '',
    messages: [],
    createdAt: now,
    updatedAt: now,
  };
  state.conversations[conv.id] = conv;
  state.activeId = conv.id;
  saveState();
  render();
  closeSidebar();
  $('#input').focus();
}

function touch(conv) {
  conv.updatedAt = Date.now();
  saveState();
}

function deleteConversation(conv) {
  if (!confirm('Usunąć tę rozmowę?')) return;
  // Keep a tombstone so the deletion also reaches other devices on sync.
  state.conversations[conv.id] = { id: conv.id, deleted: true, updatedAt: Date.now() };
  state.activeId = liveConversations()[0]?.id || null;
  saveState();
  render();
  scheduleSync();
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

const $ = sel => document.querySelector(sel);

function renderMarkdown(text) {
  if (window.marked && window.DOMPurify) {
    return DOMPurify.sanitize(marked.parse(text, { breaks: true }));
  }
  const div = document.createElement('div');
  div.textContent = text;
  div.style.whiteSpace = 'pre-wrap';
  return div.outerHTML;
}

// Sets rendered Markdown and lets each block pick its own text direction,
// so Persian (right-to-left) and Latin-script paragraphs both display correctly.
function setMarkdown(el, text) {
  el.innerHTML = renderMarkdown(text);
  el.querySelectorAll('p, li, h1, h2, h3, h4, h5, h6, blockquote, td, th, div')
    .forEach(block => { block.dir = 'auto'; });
}

// ---------------------------------------------------------------------------
// Bold and italics in her own text
// ---------------------------------------------------------------------------

// Her messages keep bold and italics as Markdown marks (**bold**, *italics*).
// Only those two are shown as formatting; everything else stays plain text, so a
// line of dialogue starting with "- " does not turn into a list.
function formatUserText(text) {
  const escaped = text.replace(/[&<>"]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));
  return escaped
    .replace(/\*\*\*(?=\S)([\s\S]*?\S)\*\*\*/g, '<strong><em>$1</em></strong>')
    .replace(/\*\*(?=\S)([\s\S]*?\S)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*\\])\*(?=\S)([^*\n]*?\S)\*(?!\*)/g, '$1<em>$2</em>')
    .replace(/\\\*/g, '*');
}

// When she pastes text copied from a document (Google Docs, Word, a web page),
// bold and italics are kept as Markdown marks. Plain text pastes as usual.
function pasteWithFormatting(event) {
  const html = event.clipboardData?.getData('text/html');
  if (!html) return;
  const markdown = htmlToMarkdown(html);
  if (!markdown.trim()) return;
  event.preventDefault();
  const field = event.target;
  field.setRangeText(markdown, field.selectionStart, field.selectionEnd, 'end');
  field.dispatchEvent(new Event('input', { bubbles: true }));
}

function htmlToMarkdown(html) {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const BLOCKS = new Set(['P', 'DIV', 'LI', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'BLOCKQUOTE', 'TR']);

  function isBold(el) {
    const weight = el.style?.fontWeight;
    if (weight) return weight === 'bold' || weight === 'bolder' || Number(weight) >= 600;
    return ['B', 'STRONG'].includes(el.tagName);
  }
  function isItalic(el) {
    const style = el.style?.fontStyle;
    if (style) return style === 'italic' || style === 'oblique';
    return ['I', 'EM'].includes(el.tagName);
  }
  // Puts marks around the text, keeping spaces outside them ("**word** ", not "**word **").
  function wrap(text, mark) {
    const match = text.match(/^(\s*)([\s\S]*?)(\s*)$/);
    return match[2] ? match[1] + mark + match[2] + mark + match[3] : text;
  }
  function walk(node) {
    if (node.nodeType === Node.TEXT_NODE) return node.textContent.replace(/\*/g, '\\*');
    if (node.nodeType !== Node.ELEMENT_NODE) return '';
    if (['SCRIPT', 'STYLE', 'TITLE', 'META'].includes(node.tagName)) return '';
    if (node.tagName === 'BR') return '\n';
    let text = Array.from(node.childNodes).map(walk).join('');
    // Marks are not repeated inside text that is already marked, and do not cross line breaks.
    const hasMark = (line, m) => m === '**' ? line.includes('**') : /(^|[^*])\*(?!\*)/.test(line.replace(/\\\*/g, ''));
    const mark = (t, m) => t.split('\n').map(line => hasMark(line, m) ? line : wrap(line, m)).join('\n');
    if (isBold(node)) text = mark(text, '**');
    if (isItalic(node)) text = mark(text, '*');
    if (BLOCKS.has(node.tagName)) text = '\n' + text + '\n';
    return text;
  }
  return walk(doc.body)
    .replace(/\u00a0/g, ' ')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function formatDate(ms) {
  return new Date(ms).toLocaleDateString('pl-PL', { day: 'numeric', month: 'short' });
}

function renderList() {
  const list = $('#conv-list');
  list.innerHTML = '';
  for (const conv of liveConversations()) {
    const li = document.createElement('li');
    if (conv.id === state.activeId) li.classList.add('active');
    const title = document.createElement('span');
    title.className = 'conv-title';
    title.textContent = conv.title || 'Nowa rozmowa';
    title.dir = 'auto';
    const meta = document.createElement('span');
    meta.className = 'conv-meta';
    meta.textContent = `${MODES[conv.mode].label} · ${formatDate(conv.updatedAt)}`;
    li.append(title, meta);
    li.onclick = () => {
      state.activeId = conv.id;
      saveState();
      render();
      closeSidebar();
    };
    list.append(li);
  }
}

function messageElement(msg) {
  const div = document.createElement('div');
  div.className = `msg ${msg.role}`;
  div.dir = 'auto';
  if (msg.role === 'user') {
    div.innerHTML = formatUserText(msg.content);
  } else {
    const body = document.createElement('div');
    body.className = 'msg-body';
    setMarkdown(body, msg.content);
    const actions = document.createElement('div');
    actions.className = 'msg-actions';
    const copy = document.createElement('button');
    copy.textContent = 'Kopiuj';
    copy.onclick = async () => {
      try {
        await navigator.clipboard.writeText(msg.content);
        copy.textContent = 'Skopiowano';
        setTimeout(() => { copy.textContent = 'Kopiuj'; }, 1500);
      } catch { /* clipboard not available */ }
    };
    actions.append(copy);
    div.append(body, actions);
  }
  return div;
}

function renderWelcome(container) {
  const div = document.createElement('div');
  div.className = 'welcome';
  div.innerHTML = `
    <h2>Cześć!</h2>
    <p>Wybierz <strong>Pomysły</strong>, żeby razem wymyślać opowiadanie,
    albo <strong>Tłumaczenie</strong>, żeby przetłumaczyć tekst.</p>
    <div class="new-buttons">
      <button class="primary" data-mode="brainstorm">+ Pomysły</button>
      <button class="primary" data-mode="translate">+ Tłumaczenie</button>
    </div>`;
  div.querySelectorAll('button').forEach(b => { b.onclick = () => createConversation(b.dataset.mode); });
  container.append(div);
}

function renderChat() {
  const conv = activeConv();
  const messages = $('#messages');
  messages.innerHTML = '';
  $('#composer').hidden = !conv;
  $('#delete-conv').hidden = !conv;
  $('#lang-wrap').hidden = !conv || conv.mode !== 'translate';

  if (!conv) {
    $('#chat-title').textContent = '';
    renderWelcome(messages);
    return;
  }

  $('#chat-title').textContent = conv.title || MODES[conv.mode].label;
  $('#input').placeholder = MODES[conv.mode].placeholder;
  if (conv.mode === 'translate') $('#target-lang').value = conv.targetLang;
  for (const msg of conv.messages) messages.append(messageElement(msg));
  addRetryButton();
  messages.scrollTop = messages.scrollHeight;
}

function render() {
  renderList();
  renderChat();
}

function openSidebar() { $('#sidebar').classList.add('open'); }
function closeSidebar() { $('#sidebar').classList.remove('open'); }

// ---------------------------------------------------------------------------
// Mistral chat
// ---------------------------------------------------------------------------

let controller = null;

async function send(text) {
  let conv = activeConv();
  if (!conv || controller) return;
  if (!settings.mistralKey) {
    openSettings();
    return;
  }

  conv.messages.push({ role: 'user', content: text, at: Date.now() });
  if (!conv.title) conv.title = text.replace(/\s+/g, ' ').slice(0, 50);
  touch(conv);
  render();
  await respond(conv);
}

// Asks the model to answer the last message in the conversation.
async function respond(conv) {
  if (controller) return;
  $('#messages .retry')?.remove();

  const reply = { role: 'assistant', content: '', at: Date.now() };
  const el = messageElement(reply);
  const body = el.querySelector('.msg-body');
  const messages = $('#messages');
  messages.append(el);
  messages.scrollTop = messages.scrollHeight;

  controller = new AbortController();
  setBusy(true);
  let aborted = false;
  let error = null;

  try {
    const last = conv.messages.at(-1);
    let finish;
    if (conv.mode === 'translate' && last?.role === 'user' && wordCount(last.content) > SPLIT_ABOVE_WORDS) {
      finish = await translateInParts(conv, last.content, reply, body, messages);
    } else {
      finish = await readStream(await requestChat(conv, controller.signal, messages), reply, body, messages);
      // A translation that stopped because of length is continued where it stopped.
      for (let n = 0; conv.mode === 'translate' && finish === 'length' && n < MAX_CONTINUATIONS; n++) {
        if (!/\s$/.test(reply.content)) reply.content += ' ';
        finish = await readStream(await requestChat(conv, controller.signal, messages, reply.content), reply, body, messages);
      }
    }
    // Still too long: say so instead of ending mid-sentence silently.
    if (finish === 'length') {
      reply.content += '\n\n(Odpowiedź była za długa i została ucięta. Poproś o dalszy ciąg albo o krótszą wersję.)';
      setMarkdown(body, reply.content);
    }
  } catch (err) {
    if (err.name === 'AbortError') aborted = true;
    else error = err.message;
  } finally {
    controller = null;
    setBusy(false);
  }

  // Shown only after `controller` is cleared, so the retry button can appear.
  if (error) showError(error);
  else if (!reply.content && !aborted) showError('model nie zwrócił odpowiedzi. Spróbuj jeszcze raz.');

  conv = state.conversations[conv.id];
  if (reply.content && conv?.messages) {
    conv.messages.push(reply);
    touch(conv);
    renderList();
    scheduleSync();
  } else {
    el.remove();
  }
}

// Streamed content is usually a string, but some models send a list of parts
// (for example "thinking" and "text"); only the text parts are shown.
function deltaText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map(part => (part?.type === 'text' && typeof part.text === 'string' ? part.text : '')).join('');
  }
  return '';
}

function showError(message) {
  const e = document.createElement('div');
  e.className = 'msg error';
  e.textContent = `Błąd: ${message}`;
  $('#messages').append(e);
  addRetryButton();
}

// Offers to ask again when the last message in the conversation has no answer.
function addRetryButton() {
  const conv = activeConv();
  const messages = $('#messages');
  if (!conv || controller || conv.messages.at(-1)?.role !== 'user' || messages.querySelector('.retry')) return;
  const button = document.createElement('button');
  button.className = 'retry';
  button.textContent = 'Spróbuj ponownie';
  button.onclick = () => respond(conv);
  messages.append(button);
  messages.scrollTop = messages.scrollHeight;
}

// The most recent part of a conversation that fits the limits above.
// It starts with one of her messages, as the model expects.
function recentMessages(messages, maxMessages = HISTORY_MAX_MESSAGES, maxChars = HISTORY_MAX_CHARS) {
  const kept = [];
  let chars = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    const length = messages[i].content.length;
    if (kept.length && (kept.length >= maxMessages || chars + length > maxChars)) break;
    kept.unshift(messages[i]);
    chars += length;
  }
  while (kept.length > 1 && kept[0].role !== 'user') kept.shift();
  return { messages: kept, trimmed: kept.length < messages.length };
}

function wordCount(text) {
  return text.split(/\s+/).filter(Boolean).length;
}

// Splits a long text into parts of about `maxWords` words, at line breaks
// (or, inside a very long paragraph, at the end of a sentence).
function splitIntoParts(text, maxWords = PART_WORDS) {
  const pieces = [];
  for (const line of text.split('\n')) {
    if (wordCount(line) <= maxWords) { pieces.push(line); continue; }
    let current = '';
    for (const sentence of line.split(/(?<=[.!?…])\s+/)) {
      if (current && wordCount(current + ' ' + sentence) > maxWords) { pieces.push(current); current = sentence; }
      else current = current ? current + ' ' + sentence : sentence;
    }
    if (current) pieces.push(current);
  }
  const parts = [];
  let current = [];
  for (const piece of pieces) {
    if (current.length && wordCount(current.join('\n') + '\n' + piece) > maxWords) {
      parts.push(current.join('\n'));
      current = [];
    }
    current.push(piece);
  }
  if (current.join('').trim()) parts.push(current.join('\n'));
  return parts;
}

// Translates a long text part by part into `reply`. Each part is sent with the
// previous part and its translation, so names and wording stay consistent.
async function translateInParts(conv, text, reply, body, container) {
  const parts = splitIntoParts(text);
  const system = { role: 'system', content: systemPrompt(conv) };
  const done = [];
  let finish = 'stop';
  for (let i = 0; i < parts.length; i++) {
    const messages = [system];
    if (i > 0) {
      messages.push(
        { role: 'user', content: translatePartContent(conv, parts[i - 1], i - 1, parts.length) },
        { role: 'assistant', content: done[i - 1] },
      );
    }
    messages.push({ role: 'user', content: translatePartContent(conv, parts[i], i, parts.length) });
    if (i > 0) reply.content += '\n\n';
    const start = reply.content.length;
    finish = await readStream(await requestChat(conv, controller.signal, container, '', messages), reply, body, container);
    for (let n = 0; finish === 'length' && n < MAX_CONTINUATIONS; n++) {
      if (!/\s$/.test(reply.content)) reply.content += ' ';
      const partial = reply.content.slice(start);
      finish = await readStream(await requestChat(conv, controller.signal, container, partial, messages), reply, body, container);
    }
    done.push(reply.content.slice(start).trim());
  }
  return finish;
}

// Reads a streamed reply into `reply`, showing it as it arrives. Returns why the
// model stopped ('stop', 'length', ...).
async function readStream(res, reply, body, messages) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let finish = null;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop();
    for (const line of lines) {
      const data = line.replace(/^data: ?/, '').trim();
      if (!line.startsWith('data:') || !data || data === '[DONE]') continue;
      const event = JSON.parse(data);
      if (event.error || event.object === 'error') {
        throw new Error(event.error?.message || event.message || 'błąd serwera Mistral');
      }
      reply.content += deltaText(event.choices?.[0]?.delta?.content);
      finish = event.choices?.[0]?.finish_reason || finish;
    }
    setMarkdown(body, reply.content);
    messages.scrollTop = messages.scrollHeight;
  }
  return finish;
}

function shortenReply(msg) {
  if (msg.role !== 'assistant' || msg.content.length <= HISTORY_MAX_REPLY_CHARS) return msg;
  return { ...msg, content: msg.content.slice(0, HISTORY_MAX_REPLY_CHARS) + ' […]' };
}

// `partial` is the part of a translation already received; the model is asked to continue it.
// `override` replaces the conversation as the messages sent (used for translating in parts).
function chatRequest(conv, model, signal, partial = '', override = null) {
  const translate = conv.mode === 'translate';
  const history = translate
    ? recentMessages(conv.messages, HISTORY_MAX_MESSAGES, TRANSLATE_HISTORY_MAX_CHARS)
    : recentMessages(conv.messages);
  const messages = override ? [...override] : [
    { role: 'system', content: systemPrompt(conv, { notes: state.notes.text, trimmed: history.trimmed }) },
    ...history.messages.map((m, i, all) => ({
      role: m.role,
      content: apiContent(conv, translate ? m : shortenReply(m), i === all.length - 1),
    })),
  ];
  if (partial) {
    messages.push({ role: 'assistant', content: partial }, { role: 'user', content: CONTINUE_REQUEST });
  }
  return fetch(`${MISTRAL_URL}/chat/completions`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${settings.mistralKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model,
      stream: true,
      temperature: TEMPERATURE[conv.mode],
      ...(translate ? {} : { max_tokens: MAX_REPLY_TOKENS }),
      messages,
    }),
    signal,
  });
}

// Sends the request with the chosen model. If the Mistral plan does not include
// that model, tries the fallback models and remembers the first one that works.
async function requestChat(conv, signal, container, partial = '', override = null) {
  const chosen = settings.model || DEFAULTS.model;
  const candidates = [chosen, ...FALLBACK_MODELS.filter(m => m !== chosen)];
  for (const model of candidates) {
    const res = await chatRequest(conv, model, signal, partial, override);
    if (res.ok) {
      if (model !== chosen) {
        settings.model = model;
        saveSettings();
        const note = document.createElement('div');
        note.className = 'msg info';
        note.textContent = `Model „${chosen}” nie jest dostępny w tym planie Mistral, więc od teraz używam „${model}”. Można to zmienić w ustawieniach.`;
        container.insertBefore(note, container.lastElementChild);
      }
      return res;
    }
    const detail = await res.text();
    if (res.status === 403 && /tier|subscription/i.test(detail)) continue;
    throw new Error(errorMessage(res.status, detail));
  }
  throw new Error(`żaden z modeli (${candidates.join(', ')}) nie jest dostępny w tym planie Mistral. Sprawdź plan na console.mistral.ai.`);
}

function errorMessage(status, text) {
  let detail = text;
  try {
    const j = JSON.parse(text);
    detail = j.message || j.detail || text;
    if (typeof detail !== 'string') detail = JSON.stringify(detail);
  } catch { /* not JSON */ }
  if (status === 401) return 'nieprawidłowy klucz API (sprawdź ustawienia)';
  if (status === 429) return 'za dużo zapytań, spróbuj za chwilę';
  return `${status} ${detail}`.trim();
}

function setBusy(busy) {
  $('#send').disabled = busy;
  $('#stop').hidden = !busy;
}

async function loadModels() {
  if (!settings.mistralKey) return;
  try {
    const res = await fetch(`${MISTRAL_URL}/models`, {
      headers: { 'Authorization': `Bearer ${settings.mistralKey}` },
    });
    if (!res.ok) return;
    const { data } = await res.json();
    const list = $('#model-list');
    list.innerHTML = '';
    for (const m of data.filter(m => m.capabilities?.completion_chat !== false)) {
      const opt = document.createElement('option');
      opt.value = m.id;
      list.append(opt);
    }
  } catch { /* offline */ }
}

// ---------------------------------------------------------------------------
// GitHub sync: one JSON file per user at <user>/fabula.json
// ---------------------------------------------------------------------------

function b64encode(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  }
  return btoa(bin);
}

function b64decode(b64) {
  const bin = atob(b64.replace(/\s/g, ''));
  const bytes = Uint8Array.from(bin, ch => ch.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

function syncConfigured() {
  return settings.githubToken && settings.repo && settings.user;
}

function dataPath(app = APP) {
  return [settings.user.trim(), `${app}.json`].map(encodeURIComponent).join('/');
}

async function gh(path, options = {}) {
  const res = await fetch(`https://api.github.com/repos/${settings.repo}${path}`, {
    ...options,
    headers: {
      'Authorization': `Bearer ${settings.githubToken}`,
      'Accept': 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      ...(options.headers || {}),
    },
    cache: 'no-store',
  });
  return res;
}

async function fetchRemote(app = APP) {
  const res = await gh(`/contents/${dataPath(app)}`);
  if (res.status === 404) {
    // No file under the new name yet: start from the file saved under the old name, if any.
    // The next save then creates the file under the new name.
    if (app === APP) {
      const legacy = await fetchRemote(LEGACY_APP);
      return { sha: null, conversations: legacy.conversations, notes: legacy.notes };
    }
    return { sha: null, conversations: {}, notes: null };
  }
  if (!res.ok) throw new Error(`GitHub ${res.status}`);
  const meta = await res.json();
  let content = meta.content;
  // The contents API leaves `content` empty for files over 1 MB; the blob API has no such limit.
  if (!content && meta.size > 0) {
    const blob = await gh(`/git/blobs/${meta.sha}`);
    if (!blob.ok) throw new Error(`GitHub ${blob.status}`);
    content = (await blob.json()).content;
  }
  const json = content ? JSON.parse(b64decode(content)) : {};
  return { sha: meta.sha, conversations: json.data?.conversations || {}, notes: json.data?.notes || null };
}

function merge(local, remote) {
  const out = { ...remote };
  for (const [id, conv] of Object.entries(local)) {
    // Ties keep the local object, so references held elsewhere stay valid.
    if (!out[id] || conv.updatedAt >= out[id].updatedAt) out[id] = conv;
  }
  return out;
}

let syncing = false;
let syncTimer = null;

function scheduleSync() {
  if (!syncConfigured()) return;
  clearTimeout(syncTimer);
  syncTimer = setTimeout(sync, 3000);
}

function setSyncStatus(text, isError = false) {
  const el = $('#sync-status');
  el.textContent = text;
  el.classList.toggle('error', isError);
}

async function sync() {
  if (!syncConfigured()) {
    setSyncStatus('wyłączona');
    return;
  }
  // Don't sync while a reply is streaming in; try again afterwards.
  if (syncing || controller) { scheduleSync(); return; }
  syncing = true;
  setSyncStatus('synchronizuję…');
  try {
    for (let attempt = 0; attempt < 3; attempt++) {
      const remote = await fetchRemote();
      const merged = merge(state.conversations, remote.conversations);
      state.conversations = merged;
      // Notes: the most recently changed version wins.
      if (remote.notes && remote.notes.updatedAt > state.notes.updatedAt) state.notes = remote.notes;
      if (state.activeId && !activeConv()) state.activeId = liveConversations()[0]?.id || null;
      saveState();
      render();

      // Nothing to save, unless the data came from the old file name and still has to be written under the new one.
      const notesUnchanged = JSON.stringify(state.notes) === JSON.stringify(remote.notes || { text: '', updatedAt: 0 });
      const unchanged = notesUnchanged && JSON.stringify(merged) === JSON.stringify(remote.conversations);
      if (unchanged && (remote.sha || Object.keys(merged).length === 0)) break;

      const body = {
        message: `Fabula: zapis ${new Date().toISOString()}`,
        content: b64encode(JSON.stringify({
          [APP]: 1,
          saved: Date.now(),
          device,
          data: { conversations: merged, notes: state.notes },
        }, null, 1)),
      };
      if (remote.sha) body.sha = remote.sha;
      const res = await gh(`/contents/${dataPath()}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (res.ok) break;
      // 409/422: the file changed on another device since we read it; fetch and merge again.
      if (res.status !== 409 && res.status !== 422) throw new Error(`GitHub ${res.status}`);
      if (attempt === 2) throw new Error('konflikt zapisu');
    }
    setSyncStatus(`zsynchronizowano ${new Date().toLocaleTimeString('pl-PL', { hour: '2-digit', minute: '2-digit' })}`);
  } catch (err) {
    setSyncStatus(`błąd: ${err.message}`, true);
  } finally {
    syncing = false;
  }
}

// ---------------------------------------------------------------------------
// Settings dialog
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Story notes dialog
// ---------------------------------------------------------------------------

function openNotes() {
  $('#notes-text').value = state.notes.text;
  const conv = activeConv();
  $('#notes-fill').disabled = !conv || !conv.messages.length || !settings.mistralKey;
  $('#notes-status').textContent = '';
  closeSidebar();
  $('#notes').showModal();
}

$('#notes').addEventListener('close', () => {
  if ($('#notes').returnValue !== 'save') return;
  const text = $('#notes-text').value.trim();
  if (text === state.notes.text) return;
  state.notes = { text, updatedAt: Date.now() };
  saveState();
  scheduleSync();
});

// Asks the model for a draft of new notes from the open conversation and adds
// it to the text field, where she can check and edit it before saving.
async function draftNotes() {
  const conv = activeConv();
  if (!conv) return;
  const button = $('#notes-fill');
  const status = $('#notes-status');
  button.disabled = true;
  status.textContent = 'Przygotowuję notatki z tej rozmowy…';
  // Her messages in full, the companion's shortened: the notes should come from her.
  const shortened = conv.messages.map(m => ({
    role: m.role,
    content: m.role === 'user' || m.content.length <= 400 ? m.content : m.content.slice(0, 400) + ' […]',
  }));
  const transcript = recentMessages(shortened, 400, 60000).messages
    .map(m => `${m.role === 'user' ? 'Her' : 'Companion'}: ${m.content}`)
    .join('\n\n');
  try {
    const res = await fetch(`${MISTRAL_URL}/chat/completions`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${settings.mistralKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: settings.model || DEFAULTS.model,
        temperature: 0.2,
        messages: [
          { role: 'system', content: notesPrompt($('#notes-text').value) },
          { role: 'user', content: transcript },
        ],
      }),
    });
    if (!res.ok) throw new Error(errorMessage(res.status, await res.text()));
    // Plain text for the notes field: no bold or italics markers, no doubled list dashes.
    const draft = deltaText((await res.json()).choices?.[0]?.message?.content)
      .replace(/\*+/g, '')
      .replace(/^(\s*)- - /gm, '$1- ')
      .trim();
    if (!draft || draft.includes('NOTHING_NEW')) {
      status.textContent = 'W tej rozmowie nie ma nic nowego do zapisania.';
    } else {
      const field = $('#notes-text');
      field.value = (field.value.trim() ? field.value.trim() + '\n\n' : '') + draft;
      field.scrollTop = field.scrollHeight;
      status.textContent = 'Dodano propozycję na końcu. Sprawdź ją, popraw i kliknij Zapisz.';
    }
  } catch (err) {
    status.textContent = `Błąd: ${err.message}`;
  } finally {
    button.disabled = false;
  }
}

function openSettings() {
  const form = $('#settings-form');
  for (const key of Object.keys(DEFAULTS)) form.elements[key].value = settings[key] || '';
  loadModels();
  $('#settings').showModal();
}

$('#settings').addEventListener('close', () => {
  if ($('#settings').returnValue !== 'save') return;
  const form = $('#settings-form');
  for (const key of Object.keys(DEFAULTS)) settings[key] = form.elements[key].value.trim();
  saveSettings();
  sync();
});

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

for (const [code, name] of Object.entries(LANGS)) {
  const opt = document.createElement('option');
  opt.value = code;
  opt.textContent = name;
  $('#target-lang').append(opt);
}

$('#target-lang').onchange = e => {
  const conv = activeConv();
  if (!conv) return;
  conv.targetLang = e.target.value;
  settings.lastTargetLang = e.target.value;
  saveSettings();
  touch(conv);
  scheduleSync();
};

$('#new-brainstorm').onclick = () => createConversation('brainstorm');
$('#new-translate').onclick = () => createConversation('translate');
$('#delete-conv').onclick = () => { const c = activeConv(); if (c) deleteConversation(c); };
$('#settings-btn').onclick = openSettings;
$('#notes-btn').onclick = openNotes;
$('#notes-fill').onclick = draftNotes;
$('#sync-btn').onclick = sync;
$('#open-sidebar').onclick = openSidebar;
$('#close-sidebar').onclick = closeSidebar;
$('#stop').onclick = () => controller?.abort();

$('#composer').onsubmit = e => {
  e.preventDefault();
  const text = $('#input').value.trim();
  if (!text) return;
  $('#input').value = '';
  send(text);
};

$('#input').addEventListener('paste', pasteWithFormatting);

$('#input').addEventListener('keydown', e => {
  // Ctrl+Enter (Cmd+Enter on Mac) sends; plain Enter adds a new line.
  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && !e.isComposing) {
    e.preventDefault();
    $('#composer').requestSubmit();
  }
});

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') sync();
});

if ('serviceWorker' in navigator && window.isSecureContext && location.protocol !== 'file:') {
  navigator.serviceWorker.register('sw.js').catch(() => { /* not installable, still works */ });
}

render();
if (!settings.mistralKey) openSettings();
sync();
