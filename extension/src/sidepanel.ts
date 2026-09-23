/// <reference types="chrome" />
interface Candidate { ref: string; p: number; desc: string }
interface Question { question_id: string; kind: string; summary: string; decision?: { candidates: Candidate[] }; answer_with: string[] }
interface TaskView {
  task_id: string; state: string; reason?: string; goal: string; step: number; subintent: string | null; url: string | null;
  pending_question: Question | null; tab_target?: string; act?: number; highlight?: boolean;
}

const $ = <T extends HTMLElement>(sel: string) => document.querySelector(sel) as T;

function ui<T = any>(method: string, params?: unknown): Promise<T> {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({ type: 'ui', method, params }, (r: { result?: T; error?: string } | undefined) => {
      if (!r) return reject(new Error(chrome.runtime.lastError?.message ?? 'no response'));
      if (r.error) reject(new Error(r.error)); else resolve(r.result as T);
    });
  });
}

function setStatus(status: string, error: string): void {
  const pill = $('#status');
  pill.textContent = status;
  pill.className = `pill ${status === 'connected' ? 'ok' : status === 'unpaired' ? 'warn' : 'bad'}`;
  $('#pair').hidden = status !== 'unpaired';
  $('#offline').hidden = status !== 'offline';
  $('#main').hidden = status !== 'connected';
  $('#pair-error').textContent = error;
  if (status === 'connected') void refresh();
}

const highlightOn = new Set<string>();

async function refresh(): Promise<void> {
  let tasks: TaskView[] = [];
  try { tasks = (await ui<{ tasks: TaskView[] }>('ext.state')).tasks; } catch { return; }
  const box = $('#tasks');
  box.innerHTML = '';
  $('#empty').hidden = tasks.length > 0;
  const tpl = $('#task-tpl') as unknown as HTMLTemplateElement;
  for (const t of tasks) {
    const node = tpl.content.firstElementChild!.cloneNode(true) as HTMLElement;
    node.querySelector('.state')!.textContent = t.state.replace('_', ' ') + (t.reason ? ` (${t.reason})` : '');
    node.querySelector('.goal')!.textContent = t.goal;
    node.querySelector('.step')!.textContent = `step ${t.step}${t.subintent ? ` · ${t.subintent}` : ''}${t.url ? ` · ${new URL(t.url).host}` : ''}`;
    const q = t.pending_question;
    if (q) {
      const qEl = node.querySelector('.question') as HTMLElement;
      qEl.hidden = false;
      qEl.querySelector('.q-summary')!.textContent = `[${q.kind}] ${q.summary}`;
      const cands = qEl.querySelector('.cands')!;
      for (const c of q.decision?.candidates ?? []) {
        const b = document.createElement('button');
        b.textContent = `${c.ref} · ${(c.p * 100).toFixed(0)}% · ${c.desc}`;
        b.onclick = () => answer(q.question_id, { type: 'pick', ref: c.ref });
        cands.appendChild(b);
      }
      (qEl.querySelector('.hint-form') as HTMLFormElement).onsubmit = (e) => {
        e.preventDefault();
        const text = (qEl.querySelector('.hint') as HTMLInputElement).value.trim();
        if (text) void answer(q.question_id, { type: 'hint', text });
      };
      for (const b of qEl.querySelectorAll<HTMLButtonElement>('.q-actions button')) {
        if (!q.answer_with.includes(b.dataset.a!)) b.hidden = true;
        b.onclick = () => answer(q.question_id, { type: b.dataset.a });
      }
    }
    const slider = node.querySelector('.act') as HTMLInputElement;
    slider.value = String(t.act ?? 0.85);
    node.querySelector('.act-val')!.textContent = Number(slider.value).toFixed(2);
    slider.oninput = () => { node.querySelector('.act-val')!.textContent = Number(slider.value).toFixed(2); };
    slider.onchange = () => { void ui('ext.control', { task_id: t.task_id, action: 'update', patch: { confidence: { act: Number(slider.value) } } }); };
    for (const b of node.querySelectorAll<HTMLButtonElement>('.controls button')) {
      const c = b.dataset.c!;
      if (c === 'resume' && t.state !== 'paused') b.hidden = true;
      if ((c === 'pause' || c === 'takeover') && t.state === 'paused') b.hidden = true;
      if (['done', 'failed', 'cancelled'].includes(t.state)) b.hidden = true;
      b.onclick = () => { void ui('ext.control', { task_id: t.task_id, action: c }).then(refresh); };
    }
    const hl = node.querySelector('.hl') as HTMLInputElement;
    hl.checked = highlightOn.has(t.task_id);
    hl.onchange = () => {
      if (hl.checked) highlightOn.add(t.task_id); else highlightOn.delete(t.task_id);
      void ui('ext.highlight', { task_id: t.task_id, on: hl.checked });
    };
    box.appendChild(node);
  }
}

async function answer(questionId: string, a: unknown): Promise<void> {
  try { await ui('ext.answer', { question_id: questionId, answer: a }); } catch (e) { alertLine((e as Error).message); }
  await refresh();
}

function alertLine(msg: string): void { $('#pair-error').textContent = msg; }

$('#pair-form').addEventListener('submit', (e) => {
  e.preventDefault();
  chrome.runtime.sendMessage({ type: 'pair', code: ($('#code') as HTMLInputElement).value });
});
$('#port-form').addEventListener('submit', (e) => {
  e.preventDefault();
  chrome.runtime.sendMessage({ type: 'setPort', port: ($('#port') as HTMLInputElement).value });
});
$('#forget').addEventListener('click', (e) => { e.preventDefault(); chrome.runtime.sendMessage({ type: 'forget' }); });
$('#ui-link').addEventListener('click', async (e) => {
  e.preventDefault();
  try { const r = await ui<{ url: string }>('ui.url'); if (r.url) void chrome.tabs.create({ url: r.url }); } catch { /* offline */ }
});

chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type === 'status') setStatus(msg.status, msg.error ?? '');
  if (msg?.type === 'push') void refresh();
});
chrome.runtime.sendMessage({ type: 'getStatus' }, (r) => { if (r) setStatus(r.status, r.error); });
chrome.storage.local.get('port').then((s) => { ($('#port') as HTMLInputElement).value = String(s.port ?? 47913); });
setInterval(() => { if (!$('#main').hidden) void refresh(); }, 3000);
