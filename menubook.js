/* Меню-журнал. openMenuBook(foods, {fmt, canOrder, onOrder, note}) / closeMenuBook()
   Страницы строятся из блюд базы: фото берётся из food.image_url (Supabase Storage). */
(function () {
  'use strict';
  var W = 390, H = 700, pf = null, cur = 0, total = 0, onKey = null;
  var esc = function (s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]; }); };

  function fit() {
    var w = document.querySelector('#mbook .mb-wrap'), o = document.querySelector('#mbook .mb-outer');
    if (!w || !o) return;
    o.style.transform = 'scale(' + Math.min(w.clientWidth / W, w.clientHeight / H, 1) + ')';
  }

  function pageHtml(f, i, n, fmt) {
    var img = f.image_url
      ? '<img src="' + esc(f.image_url) + '" alt="' + esc(f.name) + '" decoding="async">'
      : '<div class="mb-nophoto">🍽</div>';
    return '<div class="mb-page"><div class="mb-ph"><span class="mb-pb">Обед</span><span class="mb-pn">' + (i + 1) + ' / ' + n + '</span></div>' +
      '<div class="mb-pp">' + img + '</div>' +
      '<div class="mb-pi"><div class="mb-cat">' + (f.kind === 'salad' ? 'Салат' : 'Горячее') + '</div>' +
      '<div class="mb-name">' + esc(f.name) + '</div><div class="mb-price">' + esc(fmt(f.price)) + '</div></div></div>';
  }

  window.closeMenuBook = function () {
    if (pf) { try { pf.destroy(); } catch (e) {} pf = null; }
    if (onKey) { document.removeEventListener('keydown', onKey); onKey = null; }
    window.removeEventListener('resize', fit);
    var el = document.getElementById('mbook'); if (el) el.remove();
  };

  window.openMenuBook = function (foods, opt) {
    opt = opt || {};
    var fmt = opt.fmt || function (x) { return x; };
    if (typeof St === 'undefined') { alert('Не удалось загрузить журнал меню. Обновите страницу.'); return; }
    window.closeMenuBook();
    var list = foods.filter(function (f) { return f.kind !== 'salad'; }).concat(foods.filter(function (f) { return f.kind === 'salad'; }));
    var pages =
      '<div class="mb-page mb-cover"><div class="mb-frame"></div><div class="mb-in"><div class="mb-orn"></div><div class="mb-brand">Обед</div><div class="mb-ln"></div>' +
      '<div class="mb-title">Меню</div><div class="mb-sub">' + list.length + ' блюд</div></div><span class="mb-yr">ЛИСТАЙТЕ</span></div>' +
      list.map(function (f, i) { return pageHtml(f, i, list.length, fmt); }).join('') +
      '<div class="mb-page mb-end"><div class="mb-frame"></div><div class="mb-in"><div class="mb-orn"></div><div class="mb-endt">Приятного<br>аппетита</div><div class="mb-ln"></div>' +
      '<div class="mb-note">' + esc(opt.note || '') + '</div></div></div>';
    total = list.length + 2; cur = 0;

    var root = document.createElement('div');
    root.id = 'mbook';
    root.innerHTML =
      '<button class="mb-x" aria-label="Закрыть">✕</button>' +
      '<div class="mb-wrap"><div class="mb-outer"><div class="mb-book">' + pages + '</div></div></div>' +
      '<div class="mb-bar"><div class="mb-l"><button class="mb-back" id="mb-back">← Назад</button></div>' +
      '<div class="mb-mid"><button class="mb-nav off" id="mb-prev" aria-label="Назад">‹</button><span class="mb-count" id="mb-count"></span>' +
      '<button class="mb-nav" id="mb-next" aria-label="Вперёд">›</button></div>' +
      '<div class="mb-r">' + (opt.canOrder ? '<button class="mb-order" id="mb-order">Заказать</button>' : '') + '</div></div>';
    document.body.appendChild(root);
    fit(); window.addEventListener('resize', fit);

    pf = new St.PageFlip(root.querySelector('.mb-book'), {
      width: W, height: H, size: 'fixed', minWidth: W, maxWidth: W, minHeight: H, maxHeight: H,
      usePortrait: true, autoSize: false, showCover: false, flippingTime: 700, useMouseEvents: true,
      swipeDistance: 30, mobileScrollSupport: false, maxShadowOpacity: 0.65, drawShadow: true
    });
    pf.loadFromHTML(root.querySelectorAll('.mb-page'));

    function ui() {
      root.querySelector('#mb-count').textContent = (cur + 1) + ' / ' + total;
      root.querySelector('#mb-prev').classList.toggle('off', cur === 0);
      root.querySelector('#mb-next').classList.toggle('off', cur === total - 1);
    }
    ui();
    pf.on('flip', function (e) { cur = e.data; ui(); });
    root.querySelector('#mb-prev').onclick = function () { pf.flipPrev(); };
    root.querySelector('#mb-next').onclick = function () { pf.flipNext(); };
    root.querySelector('.mb-x').onclick = window.closeMenuBook;
    root.querySelector('#mb-back').onclick = window.closeMenuBook;
    var ob = root.querySelector('#mb-order');
    if (ob) ob.onclick = function () { window.closeMenuBook(); if (opt.onOrder) opt.onOrder(); };
    onKey = function (e) {
      if (e.key === 'ArrowRight' || e.key === 'ArrowDown') pf.flipNext();
      else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') pf.flipPrev();
      else if (e.key === 'Escape') window.closeMenuBook();
    };
    document.addEventListener('keydown', onKey);
  };
})();
