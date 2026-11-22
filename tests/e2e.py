"""
Наскрізні (end-to-end) тести LocalDo у справжньому браузері Chromium.
Запуск:  npm run dev  (в іншому терміналі)  →  python tests/e2e.py
Потрібно: pip install playwright && playwright install chromium
"""
import asyncio, json, os, sys, time
from playwright.async_api import async_playwright

BASE = os.environ.get("BASE", "http://localhost:3000/")
CHROME = os.environ.get("CHROME")  # шлях до Chrome, якщо не встановлено через playwright
results = []


def check(name, ok, detail=""):
    results.append({"test": name, "ok": bool(ok), "detail": detail})
    print(("PASS " if ok else "FAIL ") + name + (f" — {detail}" if detail else ""))


async def add(page, title, **kw):
    await page.fill("#add-title", title)
    if kw.get("due"):
        await page.fill("#add-due", kw["due"])
    if kw.get("priority"):
        await page.select_option("#add-priority", kw["priority"])
    await page.click("#add-form button[type=submit]")
    await page.wait_for_function("t => [...document.querySelectorAll('.task__title')].some(e => e.textContent === t)", arg=title)


async def titles(page):
    return await page.eval_on_selector_all(".task__title", "els => els.map(e => e.textContent)")


async def main():
    async with async_playwright() as p:
        browser = await p.chromium.launch(executable_path=CHROME, args=["--no-sandbox"]) if CHROME else await p.chromium.launch()

        # ---------- Пристрій A ----------
        ctx_a = await browser.new_context(locale="uk-UA")
        a = await ctx_a.new_page()
        await a.goto(BASE)
        await a.wait_for_selector("#device-id:not(:empty)")

        # 1. Валідація: порожня назва
        await a.click("#add-form button[type=submit]")
        err = await a.text_content("#add-title-error")
        check("Порожня назва не зберігається", "Вкажіть назву" in err, err)

        # 2. Додавання і час локального запису
        t0 = time.perf_counter()
        await add(a, "Підготувати презентацію", due="2026-11-24", priority="high")
        check("Завдання додано", "Підготувати презентацію" in await titles(a),
              f"{(time.perf_counter() - t0) * 1000:.0f} мс разом з відображенням")
        await add(a, "Роздрукувати записку", due="2026-11-23")

        # 3. Дані переживають перезавантаження (IndexedDB)
        await a.reload()
        await a.wait_for_selector(".task__title")
        check("Дані зберігаються після перезавантаження", len(await titles(a)) == 2)

        # 4. Синхронізація між вкладками (BroadcastChannel)
        a2 = await ctx_a.new_page()
        await a2.goto(BASE)
        await a2.wait_for_selector(".task__title")
        await add(a, "Додано в першій вкладці")
        try:
            await a2.wait_for_function("() => [...document.querySelectorAll('.task__title')].some(e => e.textContent === 'Додано в першій вкладці')", timeout=3000)
            check("Друга вкладка оновилась автоматично", True)
        except Exception:
            check("Друга вкладка оновилась автоматично", False)
        await a2.close()

        # 5. Робота офлайн (Service Worker)
        await a.evaluate("navigator.serviceWorker.ready.then(() => true)")
        await a.reload()  # після цього сторінкою керує Service Worker
        await a.wait_for_function("() => navigator.serviceWorker.controller !== null", timeout=10000)
        await ctx_a.set_offline(True)
        await a.reload()
        await a.wait_for_selector(".task__title", timeout=5000)
        badge = await a.text_content("#net-status")
        check("Застосунок відкривається без мережі", len(await titles(a)) == 3, badge)
        await add(a, "Додано офлайн")
        check("Додавання офлайн працює", "Додано офлайн" in await titles(a))
        await a.screenshot(path="report/screenshots/offline.png", full_page=True)
        await ctx_a.set_offline(False)

        # 6. Експорт
        async with a.expect_download() as dl:
            await a.click("#export-btn")
        path_a = await (await dl.value).path()
        exported = json.loads(open(path_a, encoding="utf-8").read())
        check("Експорт створює файл localdo/v1", exported["format"] == "localdo/v1" and len(exported["tasks"]) == 4)

        # ---------- Пристрій B: власні зміни + імпорт з A ----------
        ctx_b = await browser.new_context(locale="uk-UA")
        b = await ctx_b.new_page()
        await b.goto(BASE)
        await b.wait_for_selector("#device-id:not(:empty)")
        await add(b, "Завдання з телефона")
        await b.set_input_files("#import-input", path_a)
        await b.wait_for_selector("#sync-status:not(:empty)")
        status = await b.text_content("#sync-status")
        check("Імпорт на пристрої B: додано 4", "додано 4" in status, status)
        check("На B тепер 5 завдань", len(await titles(b)) == 5)

        # Конфлікт: та сама задача змінена на обох пристроях; новіша зміна має перемогти
        await a.bring_to_front()
        await a.click("text=Роздрукувати записку >> xpath=ancestor::li >> text=Змінити")
        await a.fill("#edit-title", "Роздрукувати записку (A)")
        await a.click("#edit-form button[type=submit]")
        await b.wait_for_timeout(50)
        await b.click("text=Роздрукувати записку >> xpath=ancestor::li >> text=Змінити")
        await b.fill("#edit-title", "Роздрукувати записку (B, пізніше)")
        await b.click("#edit-form button[type=submit]")
        await b.screenshot(path="report/screenshots/import-merge.png", full_page=True)

        async with b.expect_download() as dl:
            await b.click("#export-btn")
        path_b = await (await dl.value).path()
        await a.set_input_files("#import-input", path_b)
        await a.wait_for_function("() => document.querySelector('#sync-status').textContent.includes('Злиття')")
        ta, tb = sorted(await titles(a)), None
        async with a.expect_download() as dl:
            await a.click("#export-btn")
        await b.set_input_files("#import-input", await (await dl.value).path())
        await b.wait_for_timeout(300)
        tb = sorted(await titles(b))
        check("Після обміну файлами A і B мають однакові дані", ta == tb, f"{len(ta)} завдань")
        check("Конфлікт розв'язано на користь новішої зміни", "Роздрукувати записку (B, пізніше)" in ta)

        # 7. Видалення і скасування
        await a.click("text=Додано офлайн >> xpath=ancestor::li >> text=Видалити")
        await a.wait_for_function("() => ![...document.querySelectorAll('.task__title')].some(e => e.textContent === 'Додано офлайн')")
        gone = "Додано офлайн" not in await titles(a)
        await a.screenshot(path="report/screenshots/undo-toast.png")
        await a.click("#toast button")
        await a.wait_for_timeout(300)
        check("Видалення зі скасуванням", gone and "Додано офлайн" in await titles(a))

        # 8. XSS: HTML у назві показується як текст
        await add(a, "<img src=x onerror=alert(1)>")
        injected = await a.eval_on_selector_all(".task__title img", "els => els.length")
        check("HTML у назві не виконується", injected == 0)

        # 9. Пошкоджений файл імпорту
        bad = "report/bad.json"
        open(bad, "w").write("{\"hello\": 1}")
        await a.set_input_files("#import-input", bad)
        await a.wait_for_timeout(200)
        msg = await a.text_content("#sync-status")
        check("Чужий файл відхилено з поясненням", "не файл експорту" in msg, msg)
        os.remove(bad)

        # 10. Продуктивність: 1000 завдань
        n = await a.evaluate("""async () => {
            const m = await import('./js/model.js'); const db = await import('./js/db.js');
            const tasks = Array.from({length: 1000}, (_, i) => m.createTask({title: 'Тест ' + i}, 'bench'));
            const t0 = performance.now(); await db.putTasks(tasks); const w = performance.now() - t0;
            const t1 = performance.now(); const all = await db.getAllTasks(); const r = performance.now() - t1;
            return {write: w, read: r, count: all.length};
        }""")
        check("1000 записів: запис і читання IndexedDB", n["count"] >= 1000,
              f"запис {n['write']:.0f} мс, читання {n['read']:.0f} мс")

        await browser.close()

    json.dump(results, open("report/e2e-results.json", "w", encoding="utf-8"), ensure_ascii=False, indent=2)
    failed = [r for r in results if not r["ok"]]
    print(f"\nПройдено {len(results) - len(failed)} з {len(results)}")
    sys.exit(1 if failed else 0)


asyncio.run(main())
