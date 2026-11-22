/**
 * Інтерфейс LocalDo. Кожна дія спочатку записується в IndexedDB,
 * потім оновлюється екран — мережа для роботи не потрібна.
 */
import { createTask, updateTask, deleteTask, validateTask, visibleTasks, stats, uid } from './model.js';
import { getAllTasks, putTask, putTasks, getMeta, setMeta } from './db.js';
import { notifyTabs, onTabsChange, buildExport, mergeImport } from './sync.js';

const $ = (sel) => document.querySelector(sel);
const state = { tasks: [], filter: 'all', query: '', sort: 'due', deviceId: null, undo: null };
const PRIORITY_LABEL = { high: 'Високий', normal: 'Звичайний', low: 'Низький' };

// ---------- Ініціалізація ----------
async function init() {
  state.deviceId = (await getMeta('deviceId')) || uid();
  await setMeta('deviceId', state.deviceId);
  $('#device-id').textContent = state.deviceId.slice(0, 8);
  await reload();
  bindEvents();
  updateNetwork();
  updateStorage();
  onTabsChange(reload); // інша вкладка змінила дані — перечитуємо базу
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('./sw.js').catch(() => {});
}

async function reload() {
  state.tasks = await getAllTasks();
  render();
}

function markSaved() {
  const t = new Date().toLocaleTimeString('uk-UA', { hour: '2-digit', minute: '2-digit' });
  $('#saved-status').textContent = `Усі зміни збережено на цьому пристрої о ${t}`;
}

async function save(task) {
  await putTask(task);
  markSaved();
  const i = state.tasks.findIndex((t) => t.id === task.id);
  if (i >= 0) state.tasks[i] = task; else state.tasks.push(task);
  render();
  notifyTabs();
}

// ---------- Відображення ----------
function render() {
  const list = $('#task-list');
  const items = visibleTasks(state.tasks, state);
  list.replaceChildren(...items.map(renderTask));
  $('#empty').hidden = items.length > 0;
  const s = stats(state.tasks);
  $('#stat-total').textContent = s.total;
  $('#stat-active').textContent = s.active;
  $('#stat-done').textContent = s.done;
}

function renderTask(task) {
  const li = document.createElement('li');
  li.className = `task task--${task.priority}${task.done ? ' task--done' : ''}`;
  const today = new Date().toISOString().slice(0, 10);
  const overdue = task.due && !task.done && task.due < today;

  const check = document.createElement('input');
  check.type = 'checkbox';
  check.checked = task.done;
  check.id = `t-${task.id}`;
  check.className = 'task__check';
  check.addEventListener('change', () => save(updateTask(task, { done: check.checked }, state.deviceId)));

  const body = document.createElement('div');
  body.className = 'task__body';
  const label = document.createElement('label');
  label.htmlFor = check.id;
  label.className = 'task__title';
  label.textContent = task.title; // textContent — дані користувача ніколи не стають HTML
  body.append(label);
  if (task.notes) {
    const p = document.createElement('p');
    p.className = 'task__notes';
    p.textContent = task.notes;
    body.append(p);
  }
  const meta = document.createElement('p');
  meta.className = 'task__meta';
  meta.textContent = `Пріоритет: ${PRIORITY_LABEL[task.priority]}` +
    (task.due ? ` · До ${task.due.split('-').reverse().join('.')}${overdue ? ' (прострочено)' : ''}` : '');
  if (overdue) meta.classList.add('task__meta--overdue');
  body.append(meta);

  const actions = document.createElement('div');
  actions.className = 'task__actions';
  actions.append(
    button('Змінити', 'btn btn--ghost', () => openEdit(task), `Змінити завдання «${task.title}»`),
    button('Видалити', 'btn btn--ghost btn--danger', () => remove(task), `Видалити завдання «${task.title}»`),
  );
  li.append(check, body, actions);
  return li;
}

function button(text, cls, onClick, ariaLabel) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = cls;
  b.textContent = text;
  if (ariaLabel) b.setAttribute('aria-label', ariaLabel);
  b.addEventListener('click', onClick);
  return b;
}

// ---------- Форма додавання і редагування ----------
function showErrors(form, errors) {
  for (const field of ['title', 'notes', 'due', 'priority']) {
    const input = form.elements[field];
    const err = form.querySelector(`[data-error="${field}"]`);
    if (!input || !err) continue;
    err.textContent = errors[field] || '';
    input.setAttribute('aria-invalid', errors[field] ? 'true' : 'false');
  }
}

function readForm(form) {
  return {
    title: form.elements.title.value,
    notes: form.elements.notes.value,
    due: form.elements.due.value || null,
    priority: form.elements.priority.value,
  };
}

async function onAdd(e) {
  e.preventDefault();
  const form = e.target;
  const fields = readForm(form);
  const { ok, errors } = validateTask(fields);
  showErrors(form, errors);
  if (!ok) { form.querySelector('[aria-invalid="true"]')?.focus(); return; }
  await save(createTask(fields, state.deviceId));
  form.reset();
  form.elements.title.focus();
  toast('Завдання збережено на цьому пристрої');
}

let editing = null;
function openEdit(task) {
  editing = task;
  const form = $('#edit-form');
  form.elements.title.value = task.title;
  form.elements.notes.value = task.notes;
  form.elements.due.value = task.due || '';
  form.elements.priority.value = task.priority;
  showErrors(form, {});
  $('#edit-dialog').showModal();
}

async function onEditSubmit(e) {
  e.preventDefault();
  const form = e.target;
  const { ok, errors, data } = validateTask(readForm(form));
  showErrors(form, errors);
  if (!ok) return;
  await save(updateTask(editing, data, state.deviceId));
  $('#edit-dialog').close();
  toast('Зміни збережено');
}

async function remove(task) {
  const deleted = deleteTask(task, state.deviceId);
  await save(deleted);
  state.undo = deleted; // скасування — нова, ще новіша версія запису
  toast('Завдання видалено', 'Скасувати', async () => {
    await save(updateTask(state.undo, { deleted: false }, state.deviceId));
    state.undo = null;
  });
}

// ---------- Експорт / імпорт ----------
function exportData() {
  const blob = new Blob([buildExport(state.tasks, state.deviceId)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `localdo-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  toast(`Експортовано записів: ${state.tasks.length}`);
}

async function importData(e) {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  if (file.size > 5 * 1024 * 1024) { setSyncStatus('Файл завеликий (понад 5 МБ)', true); return; }
  try {
    const { tasks, stats: s, skipped } = mergeImport(state.tasks, await file.text());
    await putTasks(tasks);
    markSaved();
    state.tasks = tasks;
    render();
    notifyTabs();
    setSyncStatus(`Злиття завершено: додано ${s.added}, оновлено ${s.updated}, без змін ${s.unchanged}` +
      (skipped ? `, пропущено пошкоджених ${skipped}` : ''));
  } catch (err) {
    setSyncStatus(err.message, true);
  }
}

function setSyncStatus(text, isError = false) {
  const el = $('#sync-status');
  el.textContent = text;
  el.className = `notice ${isError ? 'notice--error' : 'notice--ok'}`;
}

// ---------- Мережа і сховище ----------
function updateNetwork() {
  const online = navigator.onLine;
  const el = $('#net-status');
  el.textContent = online ? 'Онлайн' : 'Офлайн — усе працює';
  el.className = `badge ${online ? 'badge--online' : 'badge--offline'}`;
}

async function updateStorage() {
  if (!navigator.storage?.estimate) { $('#storage-info').textContent = 'Браузер не надає даних про сховище'; return; }
  const { usage = 0, quota = 0 } = await navigator.storage.estimate();
  const persisted = navigator.storage.persisted ? await navigator.storage.persisted() : false;
  $('#storage-info').textContent =
    `Використано ${(usage / 1024).toFixed(1)} КБ з ${(quota / 1024 / 1024 / 1024).toFixed(1)} ГБ. ` +
    (persisted ? 'Дані захищені від автоматичного очищення.' : 'Браузер може очистити дані при нестачі місця.');
  $('#persist-btn').hidden = persisted || !navigator.storage.persist;
}

async function requestPersist() {
  const granted = await navigator.storage.persist();
  toast(granted ? 'Сховище стало постійним' : 'Браузер відхилив запит. Спробуйте встановити застосунок');
  updateStorage();
}

// ---------- Сповіщення ----------
let toastTimer;
function toast(text, actionText, action) {
  const el = $('#toast');
  el.replaceChildren(document.createTextNode(text));
  if (actionText) el.append(' ', button(actionText, 'btn btn--link', () => { el.hidden = true; action(); }));
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 5000);
}

// ---------- Події ----------
function bindEvents() {
  $('#add-form').addEventListener('submit', onAdd);
  $('#edit-form').addEventListener('submit', onEditSubmit);
  $('#edit-cancel').addEventListener('click', () => $('#edit-dialog').close());
  $('#search').addEventListener('input', (e) => { state.query = e.target.value; render(); });
  $('#sort').addEventListener('change', (e) => { state.sort = e.target.value; render(); });
  document.querySelectorAll('[name="filter"]').forEach((r) =>
    r.addEventListener('change', (e) => { state.filter = e.target.value; render(); }));
  $('#export-btn').addEventListener('click', exportData);
  $('#import-input').addEventListener('change', importData);
  $('#persist-btn').addEventListener('click', requestPersist);
  window.addEventListener('online', updateNetwork);
  window.addEventListener('offline', updateNetwork);
}

init();
