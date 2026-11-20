(function () {
  'use strict';
  var reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var PS4 = window.PS4 = { reduceMotion: reduceMotion };

  var THEMES = ['oled', 'classic', 'midnight', 'light'];
  PS4.themes = THEMES;
  PS4.getTheme = function () {
    var t = document.documentElement.getAttribute('data-theme');
    return THEMES.indexOf(t) !== -1 ? t : 'oled';
  };
  PS4.setTheme = function (name) {
    if (THEMES.indexOf(name) === -1) name = 'oled';
    document.documentElement.setAttribute('data-theme', name);
    try { localStorage.setItem('ps4store-theme', name); } catch (e) {  }
    var meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', getComputedStyle(document.documentElement).getPropertyValue('--bg').trim() || '#000000');
    document.querySelectorAll('[data-theme-choice]').forEach(function (b) {
      b.setAttribute('aria-checked', String(b.getAttribute('data-theme-choice') === name));
    });
    var swatch = document.querySelector('[data-theme-current]');
    if (swatch) swatch.setAttribute('data-t', name);
    var label = document.querySelector('[data-theme-label]');
    var active = document.querySelector('[data-theme-choice="' + name + '"] .menu-text');
    if (label && active) label.textContent = active.textContent;
  };
  PS4.setTheme(PS4.getTheme());
  document.querySelectorAll('[data-theme-choice]').forEach(function (b) {
    b.addEventListener('click', function () {
      PS4.setTheme(b.getAttribute('data-theme-choice'));
      var menu = b.closest('details'); if (menu) menu.removeAttribute('open');
    });
  });

  var menus = Array.prototype.slice.call(document.querySelectorAll('details.menu'));
  menus.forEach(function (m) {
    m.addEventListener('toggle', function () {
      if (m.open) menus.forEach(function (o) { if (o !== m) o.removeAttribute('open'); });
    });
  });
  document.addEventListener('click', function (e) {
    menus.forEach(function (m) { if (m.open && !m.contains(e.target)) m.removeAttribute('open'); });
  });
  document.addEventListener('keydown', function (e) {
    if (e.key !== 'Escape') return;
    menus.forEach(function (m) { if (m.open) { m.removeAttribute('open'); var s = m.querySelector('summary'); if (s) s.focus(); } });
  });

  var nav = document.querySelector('.nav');
  if (nav) {
    var onScroll = function () { nav.classList.toggle('is-scrolled', window.scrollY > 4); };
    window.addEventListener('scroll', onScroll, { passive: true });
    onScroll();
  }

  document.querySelectorAll('.cover img').forEach(function (img) {
    var broken = function () { img.parentNode.classList.add('is-broken'); };
    img.addEventListener('error', broken);
    if (img.complete && img.naturalWidth === 0 && img.currentSrc) broken();
  });

  PS4.watchAvatars = function (root) {
    (root || document).querySelectorAll('.avatar img').forEach(function (img) {
      var broken = function () { img.parentNode.classList.add('is-broken'); };
      img.addEventListener('error', broken);
      if (img.complete && img.naturalWidth === 0 && img.currentSrc) broken();
    });
  };
  PS4.watchAvatars();

  var observer = null;
  if ('IntersectionObserver' in window && !reduceMotion) {
    observer = new IntersectionObserver(function (entries) {
      var order = 0;
      entries.forEach(function (entry) {
        if (!entry.isIntersecting) return;
        entry.target.style.setProperty('--i', order++);
        entry.target.classList.add('is-in');
        observer.unobserve(entry.target);
      });
    }, { rootMargin: '0px 0px -8% 0px', threshold: 0.08 });
  }
  PS4.reveal = function (list) {
    Array.prototype.forEach.call(list, function (el) {
      if (observer) { el.classList.remove('is-in'); observer.observe(el); }
      else el.classList.add('is-in');
    });
  };

  PS4.seg = function (id, onChange) {
    var seg = document.getElementById(id);
    if (!seg) return;
    var pill = seg.querySelector('.seg-pill');
    var buttons = Array.prototype.slice.call(seg.querySelectorAll('button'));
    function movePill() {
      var active = seg.querySelector('button[aria-pressed="true"]');
      if (!active) return;
      pill.style.width = active.offsetWidth + 'px';
      pill.style.transform = 'translateX(' + active.offsetLeft + 'px)';
    }
    buttons.forEach(function (btn) {
      btn.addEventListener('click', function () {
        if (btn.getAttribute('aria-pressed') === 'true') return;
        buttons.forEach(function (b) { b.setAttribute('aria-pressed', String(b === btn)); });
        movePill();
        onChange(btn.dataset.value);
      });
    });
    movePill();
    requestAnimationFrame(function () { requestAnimationFrame(function () { seg.classList.remove('no-anim'); }); });
    window.addEventListener('resize', movePill);
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(movePill);
  };

  PS4.fold = function (s) {
    return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  };
})();


(function () {
  'use strict';
  var meta = document.querySelector('meta[name="csrf-token"]');
  var token = meta ? meta.getAttribute('content') : '';
  function post(url) {
    return fetch(url, { method: 'POST', credentials: 'same-origin', headers: { 'X-CSRF-Token': token, 'Content-Type': 'application/json' }, body: '{}' })
      .then(function (r) { return r.json().catch(function () { return {}; }).then(function (d) { return { ok: r.ok, status: r.status, data: d }; }); });
  }
  function login() { location.href = '/login?next=' + encodeURIComponent(location.pathname + location.search); }
  document.addEventListener('click', function (e) {
    var b = e.target.closest ? e.target.closest('[data-act]') : null;
    if (!b) return;
    e.preventDefault(); e.stopPropagation();
    if (!token) { login(); return; }
    var id = b.getAttribute('data-game'), act = b.getAttribute('data-act');
    var url = act === 'like' ? '/api/games/' + id + '/like' : act === 'library' ? '/api/games/' + id + '/library' : '/api/remote-download/' + id;
    b.disabled = true;
    post(url).then(function (res) {
      if (res.status === 401) { login(); return; }
      var all = document.querySelectorAll('[data-act="' + act + '"][data-game="' + id + '"]');
      if (act === 'like' && res.ok) {
        all.forEach(function (x) { x.classList.toggle('is-on', !!res.data.liked); x.setAttribute('aria-pressed', String(!!res.data.liked)); var c = x.querySelector('.count'); if (c) c.textContent = res.data.count; });
      } else if (act === 'library' && res.ok) {
        all.forEach(function (x) { x.classList.toggle('is-on', !!res.data.in_library); x.setAttribute('aria-pressed', String(!!res.data.in_library)); var l = x.querySelector('.lbl'); if (l) l.textContent = x.getAttribute(res.data.in_library ? 'data-lbl-on' : 'data-lbl-off'); });
      } else if (act === 'remote' && res.ok) {
        all.forEach(function (x) { x.classList.add('is-on'); var l = x.querySelector('.lbl'); if (l) { var old = l.textContent; l.textContent = x.getAttribute('data-done'); setTimeout(function () { l.textContent = old; x.classList.remove('is-on'); }, 3500); } else { x.setAttribute('title', x.getAttribute('data-done')); setTimeout(function () { x.classList.remove('is-on'); }, 3500); } });
      }
    }).catch(function () {}).then(function () { b.disabled = false; });
  }, true);
})();

(function () {
  'use strict';
      var GROUPS = { games: ['pkg', 'update', 'dlc'], mods: ['plugin'], payloads: ['payload'] };
      document.querySelectorAll('.vt-latest').forEach(function (sec) {
        var cards = Array.prototype.slice.call(sec.querySelectorAll('.card')), max = parseInt(sec.dataset.count, 10) || 8;
        var tabs = sec.querySelector('.latest-tabs'), none = sec.querySelector('.latest-empty');
        function apply(f) {
          var shown = [], n = 0;
          cards.forEach(function (c) {
            var ok = f === 'all' || GROUPS[f].indexOf(c.dataset.type) !== -1, show = ok && n < max;
            if (show) n++;
            c.hidden = !show; if (show) shown.push(c);
          });
          if (none) none.hidden = shown.length > 0;
          PS4.reveal(shown.filter(function (c) { return !c.classList.contains('is-in'); }));
        }
        if (tabs) tabs.addEventListener('click', function (e) {
          var b = e.target.closest('[data-f]'); if (!b) return;
          Array.prototype.forEach.call(tabs.querySelectorAll('button'), function (x) { x.setAttribute('aria-pressed', String(x === b)); });
          apply(b.dataset.f);
        });
        apply('all');
      });

      document.querySelectorAll('.vt-carousel').forEach(function (cr) {
        var slides = Array.prototype.slice.call(cr.querySelectorAll('.cr-slide')), dots = cr.querySelectorAll('.cr-dots button'), thumbs = cr.querySelectorAll('.cr-thumb');
        var bg = cr.querySelector('.cr-bg'), stage = cr.querySelector('.cr-stage'), cur = 0, timer = null;
        var auto = (parseInt(cr.dataset.auto, 10) || 0) * 1000;
        function go(i) {
          cur = (i + slides.length) % slides.length;
          slides.forEach(function (s, k) { s.classList.toggle('is-active', k === cur); s.setAttribute('aria-hidden', String(k !== cur)); });
          Array.prototype.forEach.call(dots, function (d, k) { d.setAttribute('aria-selected', String(k === cur)); });
          Array.prototype.forEach.call(thumbs, function (t, k) { t.classList.toggle('is-on', k === cur); });
          var img = slides[cur].dataset.img; bg.style.backgroundImage = img ? 'url("' + img.replace(/"/g, '%22') + '")' : 'none';
          bg.style.setProperty('--accent', getComputedStyle(slides[cur]).getPropertyValue('--accent'));
        }
        function play() { stop(); if (document.documentElement.classList.contains('wb-edit')) return; if (auto >= 2000 && slides.length > 1 && !PS4.reduceMotion) timer = setInterval(function () { go(cur + 1); }, auto); }
        function stop() { clearInterval(timer); }
        var prev = cr.querySelector('.cr-prev'), next = cr.querySelector('.cr-next');
        if (prev) prev.addEventListener('click', function () { go(cur - 1); play(); });
        if (next) next.addEventListener('click', function () { go(cur + 1); play(); });
        Array.prototype.forEach.call(dots, function (d, k) { d.addEventListener('click', function () { go(k); play(); }); });
        Array.prototype.forEach.call(thumbs, function (t) { t.addEventListener('click', function () { go(parseInt(t.dataset.i, 10)); play(); }); });
        cr.addEventListener('mouseenter', stop); cr.addEventListener('mouseleave', play); cr.addEventListener('focusin', stop); cr.addEventListener('focusout', play);
        document.addEventListener('visibilitychange', function () { if (document.hidden) stop(); else play(); });
        var x0 = null;
        stage.addEventListener('pointerdown', function (e) { x0 = e.clientX; });
        stage.addEventListener('pointerup', function (e) { if (x0 === null) return; var dx = e.clientX - x0; x0 = null; if (Math.abs(dx) > 40) { go(cur + (dx < 0 ? 1 : -1)); play(); } });
        stage.addEventListener('pointercancel', function () { x0 = null; });
        cr.addEventListener('keydown', function (e) { if (e.key === 'ArrowLeft') { go(cur - 1); play(); } else if (e.key === 'ArrowRight') { go(cur + 1); play(); } });
        go(0); play();
      });
})();

(function () {
  'use strict';
  document.addEventListener('click', function (e) {
    var b = e.target.closest && e.target.closest('.vt-gal-item[data-lb]');
    if (!b || document.documentElement.classList.contains('wb-edit')) return;
    var o = document.createElement('div'); o.className = 'wb-lightbox'; o.setAttribute('role', 'dialog'); o.setAttribute('aria-modal', 'true');
    var f = document.createElement('figure'), img = document.createElement('img'); img.src = b.dataset.lb; img.alt = b.dataset.cap || ''; f.appendChild(img);
    if (b.dataset.cap) { var c = document.createElement('figcaption'); c.textContent = b.dataset.cap; f.appendChild(c); }
    o.appendChild(f);
    function close() { o.remove(); document.removeEventListener('keydown', key); }
    function key(ev) { if (ev.key === 'Escape') close(); }
    o.addEventListener('click', close); document.addEventListener('keydown', key); document.body.appendChild(o);
  });
})();
