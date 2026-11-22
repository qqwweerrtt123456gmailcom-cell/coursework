/**
 * Тонка обгортка над IndexedDB на промісах.
 * Сховища: tasks (ключ id) і meta (ключ — назва параметра).
 */
const DB_NAME = 'localdo';
const DB_VERSION = 1;
let dbPromise;

function promisify(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export function openDb() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      // Викликається при першому запуску або зміні версії схеми
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains('tasks')) {
          const store = db.createObjectStore('tasks', { keyPath: 'id' });
          store.createIndex('updatedAt', 'updatedAt');
        }
        if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta');
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return dbPromise;
}

async function tx(store, mode, fn) {
  const db = await openDb();
  const t = db.transaction(store, mode);
  const result = fn(t.objectStore(store));
  await new Promise((resolve, reject) => {
    t.oncomplete = resolve;
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
  return result instanceof IDBRequest ? result.result : result;
}

export const getAllTasks = () => openDb().then((db) =>
  promisify(db.transaction('tasks').objectStore('tasks').getAll()));

export const putTask = (task) => tx('tasks', 'readwrite', (s) => s.put(task));

/** Запис багатьох завдань однією транзакцією (усе або нічого) */
export const putTasks = (tasks) => tx('tasks', 'readwrite', (s) => tasks.forEach((t) => s.put(t)));

export const getMeta = (key) => openDb().then((db) =>
  promisify(db.transaction('meta').objectStore('meta').get(key)));

export const setMeta = (key, value) => tx('meta', 'readwrite', (s) => s.put(value, key));
