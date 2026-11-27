// Счётчики сайта без имён: откуда человек пришёл (метка via) и на какую кнопку отклика нажал.
// О самом человеке ничего не хранится и не отправляется: ни идентификатора, ни cookie. Метка источника живёт
// во вкладке (sessionStorage), а сервер api.vacante.kz складывает нажатия в счётчики по дням и вакансиям.
(function () {
  'use strict';
  const config = (document.currentScript || {}).dataset || {};
  const API = config.api || ''; // сервер со счётчиками нажатий (vacante.launch.GO_URL)
  const METRIKA = Number(config.metrika) || 0; // номер счётчика Яндекс Метрики; 0 — Метрики на сайте нет

  // Метка источника — до восьми строчных латинских букв и цифр: так же её проверяет сервер
  const VIA = /^[a-z0-9]{1,8}$/;
  // utm_source, которые пишут по-разному: у одного источника одна метка
  const UTM = new Map([['chatgpt.com', 'chatgpt'], ['chatgpt', 'chatgpt'], ['openai', 'chatgpt'], ['telegram', 'tg'],
    ['tg', 'tg'], ['instagram', 'ig'], ['ig', 'ig'], ['perplexity', 'perplex'], ['perplexity.ai', 'perplex']]);
  // Сайт, с которого пришли, по его адресу. Порядок важен: gemini.google.com раньше остальных адресов Google.
  // Приложение на Android приходит с именем вместо адреса (android-app://org.telegram.messenger): поэтому
  // Telegram, Instagram, Google и Яндекс узнаём по слову в любом месте имени
  const SITES = [
    [/^gemini\.google\./, 'gemini'],
    [/(^|\.)google\./, 'google'],
    [/(^|\.)bing\.com$/, 'bing'],
    [/(^|\.)yandex\.|^ya\.ru$/, 'yandex'],
    [/(^|\.)duckduckgo\.com$/, 'ddg'],
    [/(^|\.)chatgpt\.com$|^chat\.openai\.com$/, 'chatgpt'],
    [/(^|\.)perplexity\.ai$/, 'perplex'],
    [/^copilot\.microsoft\.com$/, 'copilot'],
    [/(^|\.)claude\.ai$/, 'claude'],
    [/^t\.me$|(^|\.)telegram\./, 'tg'],
    [/(^|\.)instagram\./, 'ig'],
    [/(^|\.)2gis\./, '2gis'],
  ];

  // Источник захода: сначала метка utm_source в адресе страницы, потом сайт, с которого перешли
  function source() {
    const utm = (new URLSearchParams(location.search).get('utm_source') || '').toLowerCase();
    if (utm) return UTM.get(utm) || utm.replace(/[^a-z0-9]/g, '').slice(0, 8) || 'other';
    let host = '';
    try {
      host = new URL(document.referrer).hostname.toLowerCase();
    } catch (e) { /* перешли не по ссылке: адреса нет */ }
    const own = location.hostname.replace(/^www\./, '');
    // Свой сайт и его поддомены источником не считаем
    if (!host || host === own || host.endsWith('.' + own)) return 'direct';
    const site = SITES.find((s) => s[0].test(host));
    return site ? site[1] : 'other';
  }

  // Источник определяем на первой странице вкладки и больше не меняем: переходы внутри сайта его не затирают.
  // Если sessionStorage закрыт настройками браузера, считаем заново на каждой странице
  let via = '';
  try {
    via = sessionStorage.getItem('via') || '';
  } catch (e) { /* хранилище закрыто */ }
  if (!VIA.test(via)) {
    via = source();
    try {
      sessionStorage.setItem('via', via);
    } catch (e) { /* хранилище закрыто */ }
  }
  window.vacanteVia = via;

  // Метрики может не быть: не загрузилась или её закрыл блокировщик
  function metrika(...args) {
    try {
      if (METRIKA && typeof window.ym === 'function') window.ym(METRIKA, ...args);
    } catch (e) { /* счётчик не должен мешать переходу */ }
  }

  // Нажатие на кнопку отклика в Метрике: цель и параметр визита. Цель видна в отчётах, только если её завели
  // в интерфейсе Метрики, параметр виден всегда
  function goal(kind) {
    if (kind === 'app' || kind === 'pf') {
      metrika('reachGoal', 'to_app');
      metrika('params', { to_app: kind });
    } else {
      metrika('reachGoal', 'contact', { kind: kind, via: via });
      metrika('params', { contact: kind });
    }
  }

  // Нажатие для счётчика на сервере: вакансия, вид кнопки и метка источника
  function hit(id, kind) {
    try {
      const body = JSON.stringify({ id: id, kind: kind, via: via, s: 'web' });
      // sendBeacon не ждёт ответа и доходит, даже когда страница уже закрывается. Строка уходит как text/plain,
      // поэтому браузер не шлёт перед ней проверочный запрос (preflight)
      if (navigator.sendBeacon && navigator.sendBeacon(API + '/hit', body)) return;
      fetch(API + '/hit', { method: 'POST', body: body, keepalive: true, mode: 'no-cors' }).catch(function () {});
    } catch (e) { /* счётчик не должен мешать переходу */ }
  }

  // Адрес ссылки с меткой источника. Если метка в нём уже есть (на страницу вернулись кнопкой «Назад»),
  // второй раз не дописываем
  function withVia(href) {
    const url = new URL(href);
    if (!url.searchParams.has('via')) url.searchParams.set('via', via);
    return url.href;
  }

  function onClick(event) {
    try {
      // Считаем левую кнопку и колесо; правая кнопка открывает меню, это не переход
      if (event.button > 1) return;
      const el = event.target.closest('a[href], [data-kind]');
      if (!el) return;
      const href = el.href || '';
      if (API && href.startsWith(API + '/go/')) {
        // Прямая кнопка связи <сервер>/go/<вакансия>/<вид>: нажатие сервер считает сам на переходе,
        // от страницы ему нужна только метка источника
        el.href = withVia(href);
        goal(href.slice(API.length + 4).split(/[/?#]/)[1]);
      } else if (el.dataset.kind && el.dataset.id) {
        if (API) hit(el.dataset.id, el.dataset.kind);
        goal(el.dataset.kind);
      } else if (href.includes('tab=post')) {
        // Форма размещения вакансии: метку источника она передаст счётчику шагов формы
        el.href = withVia(href);
        metrika('reachGoal', 'post_form');
        metrika('params', { post_form: new URL(href).searchParams.get('from') || '' });
      }
    } catch (e) { /* счётчик не должен мешать переходу */ }
  }
  // Один обработчик на всю страницу, на перехвате (capture): срабатывает до перехода по ссылке,
  // даже если другой код остановит событие. auxclick — нажатие колесом, ссылка откроется в новой вкладке
  document.addEventListener('click', onClick, true);
  document.addEventListener('auxclick', onClick, true);
})();
