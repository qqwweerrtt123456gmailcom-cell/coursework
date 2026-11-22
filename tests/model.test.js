// Модульні тести моделі даних і злиття: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  validateTask, createTask, updateTask, deleteTask, mergeTasks, newer, nextClock,
  visibleTasks, stats, isTaskRecord,
} from '../js/model.js';
import { buildExport, parseImport, mergeImport } from '../js/sync.js';

const A = 'device-a';
const B = 'device-b';

// Порядок записів не важливий — порівнюємо як множини
const norm = (tasks) => JSON.stringify([...tasks].sort((x, y) => x.id.localeCompare(y.id)));

test('валідація: коректне завдання', () => {
  const r = validateTask({ title: '  Підготувати презентацію ', due: '2026-11-24', priority: 'high' });
  assert.equal(r.ok, true);
  assert.equal(r.data.title, 'Підготувати презентацію');
});

test('валідація: помилки', () => {
  assert.ok(validateTask({ title: '' }).errors.title);
  assert.ok(validateTask({ title: 'a'.repeat(121) }).errors.title);
  assert.ok(validateTask({ title: 'Ок', notes: 'b'.repeat(501) }).errors.notes);
  assert.ok(validateTask({ title: 'Ок', due: '24.11.2026' }).errors.due);
  assert.ok(validateTask({ title: 'Ок', priority: 'urgent' }).errors.priority);
});

test('створення і зміна запису', () => {
  const t = createTask({ title: 'Купити хліб' }, A, 1000);
  assert.equal(t.updatedAt, 1000);
  assert.equal(t.deleted, false);
  const u = updateTask(t, { done: true }, B, 2000);
  assert.equal(u.done, true);
  assert.equal(u.deviceId, B);
  assert.equal(u.updatedAt, 2000);
});

test('годинник не йде назад, навіть якщо системний час відстає', () => {
  assert.equal(nextClock(5000, 3000), 5001);
  const t = createTask({ title: 'X' }, A, 5000);
  assert.ok(updateTask(t, { done: true }, A, 1000).updatedAt > t.updatedAt);
});

test('видалення — це «надгробок», запис не зникає', () => {
  const t = createTask({ title: 'X' }, A, 1000);
  const d = deleteTask(t, A, 2000);
  assert.equal(d.deleted, true);
  assert.equal(visibleTasks([d]).length, 0);
});

test('LWW: перемагає новіша версія, при рівності — більший deviceId', () => {
  const t = createTask({ title: 'X' }, A, 1000);
  const a = updateTask(t, { title: 'A' }, A, 2000);
  const b = updateTask(t, { title: 'B' }, B, 3000);
  assert.equal(newer(a, b).title, 'B');
  const a2 = { ...a, updatedAt: 3000 };
  assert.equal(newer(a2, b).deviceId, B);
  assert.equal(newer(b, a2).deviceId, B);
});

test('злиття: нові записи додаються, новіші — оновлюють', () => {
  const t1 = createTask({ title: 'Спільне' }, A, 1000);
  const t2 = createTask({ title: 'Тільки на B' }, B, 1500);
  const local = [t1];
  const remote = [updateTask(t1, { done: true }, B, 2000), t2];
  const { tasks, stats: s } = mergeTasks(local, remote);
  assert.deepEqual(s, { added: 1, updated: 1, unchanged: 0 });
  assert.equal(tasks.find((t) => t.id === t1.id).done, true);
});

test('злиття: видалення на одному пристрої перемагає старішу зміну на іншому', () => {
  const t = createTask({ title: 'X' }, A, 1000);
  const editedOnA = updateTask(t, { title: 'Y' }, A, 2000);
  const deletedOnB = deleteTask(t, B, 3000);
  const { tasks } = mergeTasks([editedOnA], [deletedOnB]);
  assert.equal(tasks[0].deleted, true);
});

test('властивості злиття: комутативність, асоціативність, ідемпотентність', () => {
  const base = createTask({ title: 'Базове' }, A, 1000);
  const x = [updateTask(base, { title: 'X' }, A, 2000), createTask({ title: 'x' }, A, 2100)];
  const y = [updateTask(base, { title: 'Y' }, B, 2500), createTask({ title: 'y' }, B, 2200)];
  const z = [deleteTask(base, 'device-c', 2400)];
  const m = (p, q) => mergeTasks(p, q).tasks;

  assert.equal(norm(m(x, y)), norm(m(y, x)), 'комутативність');
  assert.equal(norm(m(m(x, y), z)), norm(m(x, m(y, z))), 'асоціативність');
  assert.equal(norm(m(m(x, y), y)), norm(m(x, y)), 'ідемпотентність');
});

test('фільтри, пошук і сортування', () => {
  const t1 = createTask({ title: 'Звіт', due: '2026-11-25', priority: 'low' }, A, 1);
  const t2 = { ...createTask({ title: 'Презентація', due: '2026-11-23', priority: 'high' }, A, 2), done: true };
  const t3 = createTask({ title: 'Без терміну', notes: 'звіт додати', priority: 'normal' }, A, 3);
  const all = [t1, t2, t3];
  assert.deepEqual(visibleTasks(all).map((t) => t.title), ['Презентація', 'Звіт', 'Без терміну']);
  assert.deepEqual(visibleTasks(all, { filter: 'active' }).length, 2);
  assert.deepEqual(visibleTasks(all, { query: 'звіт' }).length, 2);
  assert.deepEqual(visibleTasks(all, { sort: 'priority' })[0].title, 'Презентація');
  assert.deepEqual(stats(all), { total: 3, done: 1, active: 2 });
});

test('експорт → імпорт: дані повертаються без втрат', () => {
  const tasks = [createTask({ title: 'Один' }, A, 1), createTask({ title: 'Два', notes: 'нотатка' }, A, 2)];
  const { tasks: back, skipped } = parseImport(buildExport(tasks, A));
  assert.equal(skipped, 0);
  assert.equal(norm(back), norm(tasks));
});

test('імпорт: чужий або пошкоджений файл не ламає дані', () => {
  assert.throws(() => parseImport('не json'), /коректним JSON/);
  assert.throws(() => parseImport('{"tasks":[]}'), /не файл експорту/);
  const good = createTask({ title: 'Ок' }, A, 1);
  const text = JSON.stringify({ format: 'localdo/v1', tasks: [good, { id: 5 }, null] });
  const r = mergeImport([], text);
  assert.equal(r.skipped, 2);
  assert.equal(r.tasks.length, 1);
  assert.equal(isTaskRecord({ id: 'x' }), false);
});
