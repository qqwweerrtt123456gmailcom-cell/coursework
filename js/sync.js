/**
 * Синхронізація без сервера:
 * 1) між вкладками одного браузера — BroadcastChannel;
 * 2) між пристроями — експорт і імпорт JSON-файлу зі злиттям.
 */
import { mergeTasks, isTaskRecord } from './model.js';

// Канал створюється лише при першому використанні (у тестах Node.js він не потрібен)
let channel;
const getChannel = () => {
  if (channel === undefined) channel = 'BroadcastChannel' in globalThis ? new BroadcastChannel('localdo') : null;
  return channel;
};

export function notifyTabs() {
  getChannel()?.postMessage({ type: 'changed', at: Date.now() });
}

export function onTabsChange(callback) {
  const ch = getChannel();
  if (ch) ch.onmessage = (e) => e.data?.type === 'changed' && callback();
}

export const EXPORT_FORMAT = 'localdo/v1';

export function buildExport(tasks, deviceId) {
  return JSON.stringify({ format: EXPORT_FORMAT, exportedAt: new Date().toISOString(), deviceId, tasks }, null, 2);
}

/** Розбір файлу імпорту. Кидає помилку з українським повідомленням */
export function parseImport(text) {
  let data;
  try { data = JSON.parse(text); } catch { throw new Error('Файл не є коректним JSON'); }
  if (data?.format !== EXPORT_FORMAT || !Array.isArray(data.tasks)) throw new Error('Це не файл експорту LocalDo');
  const valid = data.tasks.filter(isTaskRecord);
  return { tasks: valid, skipped: data.tasks.length - valid.length };
}

export function mergeImport(localTasks, text) {
  const { tasks, skipped } = parseImport(text);
  const result = mergeTasks(localTasks, tasks);
  return { ...result, skipped };
}
