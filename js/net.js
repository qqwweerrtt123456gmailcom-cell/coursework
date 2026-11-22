// Індикатор мережі та реєстрація Service Worker на допоміжних сторінках
const badge = document.querySelector('#net-status');
function update() {
  badge.textContent = navigator.onLine ? 'Онлайн' : 'Офлайн — усе працює';
  badge.className = `badge ${navigator.onLine ? 'badge--online' : 'badge--offline'}`;
}
window.addEventListener('online', update);
window.addEventListener('offline', update);
update();
if ('serviceWorker' in navigator) navigator.serviceWorker.register('./sw.js').catch(() => {});
