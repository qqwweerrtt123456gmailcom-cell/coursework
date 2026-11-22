/**
 * Модель даних LocalDo — чисті функції без доступу до браузера.
 * Підключається і в застосунку, і в тестах Node.js.
 */

export const LIMITS = { title: 120, notes: 500 };
export const PRIORITIES = ['low', 'normal', 'high'];
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Унікальний ідентифікатор (працює в браузері й у Node.js 20+) */
export const uid = () => globalThis.crypto.randomUUID();

/**
 * Годинник, що не йде назад: якщо системний час відстає
 * від попередньої версії запису, беремо попередню + 1 мс.
 */
export const nextClock = (prev = 0, now = Date.now()) => Math.max(now, prev + 1);

/** Перевірка полів завдання. Повертає { ok, errors, data } */
export function validateTask(input) {
  const errors = {};
  const title = typeof input?.title === 'string' ? input.title.normalize('NFC').trim() : '';
  const notes = typeof input?.notes === 'string' ? input.notes.normalize('NFC').trim() : '';
  const due = input?.due || null;
  const priority = input?.priority || 'normal';

  if (!title) errors.title = 'Вкажіть назву завдання';
  else if (title.length > LIMITS.title) errors.title = `Назва — не більше ${LIMITS.title} символів`;
  if (notes.length > LIMITS.notes) errors.notes = `Нотатка — не більше ${LIMITS.notes} символів`;
  if (due !== null && (!DATE_RE.test(due) || Number.isNaN(Date.parse(due)))) errors.due = 'Некоректна дата';
  if (!PRIORITIES.includes(priority)) errors.priority = 'Невідомий пріоритет';

  return { ok: Object.keys(errors).length === 0, errors, data: { title, notes, due, priority } };
}

/** Новий запис завдання */
export function createTask(fields, deviceId, now = Date.now()) {
  const { ok, errors, data } = validateTask(fields);
  if (!ok) throw Object.assign(new Error('invalid'), { errors });
  return { id: uid(), ...data, done: false, deleted: false, createdAt: now, updatedAt: now, deviceId };
}

/** Зміна завдання: нова версія з новою позначкою часу */
export function updateTask(task, changes, deviceId, now = Date.now()) {
  return { ...task, ...changes, updatedAt: nextClock(task.updatedAt, now), deviceId };
}

/** Видалення = «надгробок» (tombstone), щоб видалення теж синхронізувалось */
export const deleteTask = (task, deviceId, now) => updateTask(task, { deleted: true }, deviceId, now);

/**
 * Яка з двох версій одного запису новіша (Last-Writer-Wins).
 * При однаковому часі вирішує deviceId — так результат однаковий на всіх пристроях.
 */
export function newer(a, b) {
  if (a.updatedAt !== b.updatedAt) return a.updatedAt > b.updatedAt ? a : b;
  return a.deviceId >= b.deviceId ? a : b;
}

/**
 * Злиття двох наборів завдань (локального і віддаленого).
 * Властивості: комутативність, асоціативність, ідемпотентність —
 * тому пристрої сходяться до однакового стану в будь-якому порядку обміну.
 */
export function mergeTasks(local, remote) {
  const map = new Map(local.map((t) => [t.id, t]));
  const stats = { added: 0, updated: 0, unchanged: 0 };
  for (const r of remote) {
    const l = map.get(r.id);
    if (!l) { map.set(r.id, r); stats.added++; continue; }
    const winner = newer(l, r);
    if (winner === l || (winner.updatedAt === l.updatedAt && winner.deviceId === l.deviceId)) stats.unchanged++;
    else { map.set(r.id, winner); stats.updated++; }
  }
  return { tasks: [...map.values()], stats };
}

/** Перевірка структури імпортованого запису */
export function isTaskRecord(t) {
  return t && typeof t.id === 'string' && typeof t.title === 'string' &&
    Number.isFinite(t.updatedAt) && typeof t.deviceId === 'string' && typeof t.deleted === 'boolean';
}

/** Відбір і сортування для інтерфейсу */
const PR = { high: 0, normal: 1, low: 2 };
export function visibleTasks(tasks, { filter = 'all', query = '', sort = 'due' } = {}) {
  const q = query.trim().toLowerCase();
  return tasks
    .filter((t) => !t.deleted)
    .filter((t) => (filter === 'active' ? !t.done : filter === 'done' ? t.done : true))
    .filter((t) => !q || t.title.toLowerCase().includes(q) || t.notes.toLowerCase().includes(q))
    .sort((a, b) => {
      if (sort === 'priority') return PR[a.priority] - PR[b.priority] || a.createdAt - b.createdAt;
      if (sort === 'created') return b.createdAt - a.createdAt;
      return (a.due || '9999') .localeCompare(b.due || '9999') || PR[a.priority] - PR[b.priority];
    });
}

export function stats(tasks) {
  const live = tasks.filter((t) => !t.deleted);
  return { total: live.length, done: live.filter((t) => t.done).length, active: live.filter((t) => !t.done).length };
}
