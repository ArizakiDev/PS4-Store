(function () {
  'use strict';
  var root = document.documentElement;
  root.classList.add('wb-edit');
  var ORIGIN = location.origin, L = { move: '⋮⋮ Déplacer', edit: '⚙️ Personnaliser', dup: '📋 Dupliquer', del: '🗑️ Supprimer', drop: 'Déposer ici' };
  function send(m) { m.wb = 1; window.parent.postMessage(m, ORIGIN); }
  function blocks() { return Array.prototype.slice.call(document.querySelectorAll('.vt-block')); }
  function el(tag, cls, txt) { var e = document.createElement(tag); if (cls) e.className = cls; if (txt) e.textContent = txt; return e; }

  var line = el('div', 'wb-line'); document.body.appendChild(line);
  var selected = '';
  function select(id, notify) {
    selected = id;
    blocks().forEach(function (b) { b.classList.toggle('wb-selected', b.dataset.bid === id); });
    if (notify) send({ t: 'select', id: id });
  }

  function addBars() {
    blocks().forEach(function (b) {
      if (b.querySelector(':scope > .wb-bar')) return;
      var bar = el('div', 'wb-bar'), grip = el('button', 'wb-grip', L.move);
      grip.type = 'button'; grip.draggable = true;
      grip.addEventListener('dragstart', function (e) { e.dataTransfer.setData('text/plain', 'move:' + b.dataset.bid); e.dataTransfer.effectAllowed = 'move'; b.style.opacity = '.4'; });
      grip.addEventListener('dragend', function () { b.style.opacity = ''; hideLine(); });
      bar.appendChild(grip);
      [['edit', L.edit], ['dup', L.dup], ['del', L.del]].forEach(function (a) {
        var btn = el('button', '', a[1]); btn.type = 'button';
        btn.addEventListener('click', function (e) { e.stopPropagation(); e.preventDefault(); if (a[0] === 'edit') { select(b.dataset.bid, true); } else send({ t: a[0], id: b.dataset.bid }); });
        bar.appendChild(btn);
      });
      b.insertBefore(bar, b.firstChild);
    });
  }
  addBars();

  var BIG = /^(hero_client_card|home_collections|home_install_steps|home_cta|hero_stats_bar|requests_form|status_|catalogue_collections)/;
  var hideBtn = el('button', 'wb-hide'); hideBtn.type = 'button'; document.body.appendChild(hideBtn);
  var hideTarget = null, hideTimer = null;
  function showHide(t) {
    clearTimeout(hideTimer); hideTarget = t;
    var id = t.dataset.toggleable, r = t.getBoundingClientRect();
    hideBtn.textContent = BIG.test(id) ? (L.remove || '🗑️ Retirer') : (L.hide || '👁️ Masquer');
    hideBtn.style.top = Math.max(4, r.top - 12) + 'px'; hideBtn.style.left = Math.max(4, Math.min(window.innerWidth - 100, r.right - 90)) + 'px'; hideBtn.classList.add('on');
  }
  function leaveHide() { clearTimeout(hideTimer); hideTimer = setTimeout(function () { hideBtn.classList.remove('on'); hideTarget = null; }, 250); }
  document.addEventListener('mouseover', function (e) {
    if (e.target.closest('.wb-hide')) { clearTimeout(hideTimer); return; }
    var t = e.target.closest('[data-toggleable]');
    if (t) { if (t !== hideTarget) showHide(t); else clearTimeout(hideTimer); } else if (hideTarget) leaveHide();
  });
  hideBtn.addEventListener('mouseleave', leaveHide);
  hideBtn.addEventListener('click', function (e) { e.preventDefault(); e.stopPropagation(); if (!hideTarget) return; var id = hideTarget.dataset.toggleable; hideBtn.classList.remove('on'); hideTarget.style.display = 'none'; hideTarget = null; send({ t: 'hide', id: id }); });
  window.addEventListener('scroll', function () { if (hideTarget) showHide(hideTarget); }, { passive: true });

  document.addEventListener('click', function (e) {
    var b = e.target.closest('.vt-block');
    var keep = e.target.closest('.cr-nav, .cr-dots button, .cr-thumb, .latest-tabs button, .wb-bar, .wb-hide');
    if (e.target.closest('a, button') && !keep) e.preventDefault();
    if (b && !e.target.closest('.wb-bar')) select(b.dataset.bid, true);
    else if (!b && !e.target.closest('.wb-hide')) { select('', false); send({ t: 'select', id: '' }); }
  }, true);

  function hideLine() { line.style.display = 'none'; }
  function insertionAt(y) {
    var list = blocks();
    for (var i = 0; i < list.length; i++) { var r = list[i].getBoundingClientRect(); if (y < r.top + r.height / 2) return { index: i, y: r.top }; }
    var last = list[list.length - 1];
    return { index: list.length, y: last ? last.getBoundingClientRect().bottom : 90 };
  }
  var dropAt = 0;
  document.addEventListener('dragover', function (e) {
    var types = e.dataTransfer && e.dataTransfer.types ? Array.prototype.slice.call(e.dataTransfer.types) : [];
    if (types.indexOf('text/plain') === -1) return;
    e.preventDefault(); e.dataTransfer.dropEffect = 'move';
    var p = insertionAt(e.clientY); dropAt = p.index;
    line.dataset.label = L.drop; line.style.top = Math.max(0, p.y - 2) + 'px'; line.style.display = 'block';
    if (e.clientY < 80) window.scrollBy(0, -22); else if (e.clientY > window.innerHeight - 80) window.scrollBy(0, 22);
  });
  document.addEventListener('dragleave', function (e) { if (!e.relatedTarget) hideLine(); });
  document.addEventListener('drop', function (e) {
    var data = e.dataTransfer.getData('text/plain') || '';
    if (data.indexOf('new:') !== 0 && data.indexOf('move:') !== 0) return;
    e.preventDefault(); hideLine();
    if (data.indexOf('new:') === 0) send({ t: 'add', type: data.slice(4), index: dropAt });
    else send({ t: 'move', id: data.slice(5), index: dropAt });
  });
  document.addEventListener('dragend', hideLine);

  document.addEventListener('dblclick', function (e) {
    var t = e.target.closest('[data-edit]'); if (!t) return;
    var b = t.closest('.vt-block'); if (!b) return;
    e.preventDefault();
    t.contentEditable = 'true'; t.focus();
    var r = document.createRange(); r.selectNodeContents(t); var s = window.getSelection(); s.removeAllRanges(); s.addRange(r);
    var done = function () {
      t.removeEventListener('blur', done); t.removeEventListener('keydown', key); t.contentEditable = 'false';
      send({ t: 'text', id: b.dataset.bid, key: t.dataset.edit, slide: t.dataset.slide || '', value: t.textContent.replace(/\s+/g, ' ').trim() });
    };
    var key = function (ev) { if (ev.key === 'Enter' && !ev.shiftKey) { ev.preventDefault(); t.blur(); } else if (ev.key === 'Escape') { t.blur(); } };
    t.addEventListener('blur', done); t.addEventListener('keydown', key);
  });

  var tb = el('div', 'wb-rt'); tb.setAttribute('role', 'toolbar'); document.body.appendChild(tb);
  var editing = null, kind = '', savedRange = null, beforeHtml = '', textMode = false;
  function saveSel() { var sl = window.getSelection(); if (sl.rangeCount) savedRange = sl.getRangeAt(0).cloneRange(); }
  function restoreSel() { if (savedRange) { var sl = window.getSelection(); sl.removeAllRanges(); sl.addRange(savedRange); } }
  function exec(cmd, val) { if (!editing) return; editing.focus(); restoreSel(); document.execCommand('styleWithCSS', false, true); document.execCommand(cmd, false, val); saveSel(); }
  function btn(label, title, fn, cls) { var b = el('button', cls || '', label); b.type = 'button'; b.title = title; b.addEventListener('mousedown', function (e) { e.preventDefault(); }); b.addEventListener('click', fn); return b; }
  function colorBtn(label, title, cmd, init) {
    var l = el('label', 'col', label); l.title = title; var i = document.createElement('input'); i.type = 'color'; i.value = init;
    i.addEventListener('mousedown', saveSel); i.addEventListener('input', function () { exec(cmd, i.value); }); l.appendChild(i); return l;
  }
  function sep() { return el('span', 'sep'); }
  function link() { saveSel(); var u = window.prompt(L.linkPrompt || 'URL du lien (https://… ou /page)', 'https://'); if (u) exec('createLink', u); }
  function actionButton() {
    saveSel(); var lab = window.prompt(L.btnLabel || 'Texte du bouton', 'En savoir plus'); if (!lab) return;
    var u = window.prompt(L.btnUrl || 'Lien du bouton (https://… ou /page)', '/catalogue'); if (!u) return;
    exec('insertHTML', '<a class="btn" href="' + u.replace(/"/g, '&quot;') + '">' + lab.replace(/[<>&]/g, '') + '</a>');
  }
  function buildTb(k) {
    tb.innerHTML = '';
    if (k === 'rich') {
      var sel = document.createElement('select'); sel.title = 'Style';
      [['P', L.p || 'Paragraphe'], ['H1', L.h1 || 'Titre H1'], ['H2', L.h2 || 'Titre H2'], ['H3', L.h3 || 'Sous-titre H3'], ['BLOCKQUOTE', L.quote || 'Citation']].forEach(function (o) { var op = document.createElement('option'); op.value = o[0]; op.textContent = o[1]; sel.appendChild(op); });
      sel.addEventListener('mousedown', saveSel); sel.addEventListener('change', function () { exec('formatBlock', '<' + sel.value.toLowerCase() + '>'); });
      tb.appendChild(sel); tb.appendChild(sep());
      tb.appendChild(btn('B', 'Gras', function () { exec('bold'); })); tb.appendChild(btn('I', 'Italique', function () { exec('italic'); })); tb.appendChild(btn('U', 'Souligné', function () { exec('underline'); }));
      tb.appendChild(btn('S', 'Barré', function () { exec('strikeThrough'); }));
      tb.appendChild(btn('</>', 'Code', function () { saveSel(); var t = String(window.getSelection()).replace(/[<>&]/g, ''); if (t) exec('insertHTML', '<code>' + t + '</code>'); }));
      tb.appendChild(sep()); tb.appendChild(colorBtn('A', 'Couleur du texte', 'foreColor', '#ff453a')); tb.appendChild(colorBtn('🖍', 'Surlignage', 'hiliteColor', '#ffd60a')); tb.appendChild(sep());
      [['⬅', 'Gauche', 'justifyLeft'], ['⬌', 'Centre', 'justifyCenter'], ['➡', 'Droite', 'justifyRight'], ['☰', 'Justifié', 'justifyFull']].forEach(function (a) { tb.appendChild(btn(a[0], a[1], function () { exec(a[2]); })); });
      tb.appendChild(sep()); tb.appendChild(btn('•', 'Liste à puces', function () { exec('insertUnorderedList'); })); tb.appendChild(btn('1.', 'Liste numérotée', function () { exec('insertOrderedList'); }));
      tb.appendChild(sep()); tb.appendChild(btn('🔗', 'Lien', link)); tb.appendChild(btn('⏺', 'Bouton d\'action', actionButton));
    } else {
      tb.appendChild(btn('B', 'Gras', function () { exec('bold'); })); tb.appendChild(btn('I', 'Italique', function () { exec('italic'); }));
      tb.appendChild(colorBtn('A', 'Couleur', 'foreColor', '#ff453a')); tb.appendChild(btn('🔗', 'Lien', link)); tb.appendChild(sep());
      tb.appendChild(btn(L.reset || '↺ Réinitialiser', 'Valeur par défaut', function () { var key = editing && editing.dataset.editKey; stopEdit(false); if (key) send({ t: 'override_reset', key: key }); }, 'reset'));
    }
  }
  function placeTb() {
    if (!editing) return;
    var r = editing.getBoundingClientRect(), h = tb.offsetHeight || 40, w = tb.offsetWidth || 300;
    var top = r.top - h - 8; if (top < 8) top = Math.min(window.innerHeight - h - 8, r.bottom + 8);
    tb.style.top = Math.max(8, top) + 'px'; tb.style.left = Math.max(8, Math.min(window.innerWidth - w - 8, r.left)) + 'px';
  }
  function startEdit(node, k) {
    if (editing === node) return;
    if (editing) stopEdit(true);
    editing = node; kind = k; beforeHtml = node.innerHTML; node.contentEditable = 'true'; node.focus(); buildTb(k); tb.classList.add('on'); placeTb();
    node.addEventListener('keydown', editKey); node.addEventListener('paste', editPaste); node.addEventListener('keyup', saveSel); node.addEventListener('mouseup', saveSel);
  }
  function editKey(e) {
    if (e.key === 'Escape') { e.preventDefault(); editing.innerHTML = beforeHtml; stopEdit(false); }
    else if (e.key === 'Enter' && kind === 'mini' && !e.shiftKey) { e.preventDefault(); stopEdit(true); }
  }
  function editPaste(e) { e.preventDefault(); var t = (e.clipboardData || window.clipboardData).getData('text/plain'); document.execCommand('insertText', false, t); }
  function stopEdit(commit) {
    if (!editing) return;
    var node = editing, k = kind; editing = null; kind = '';
    node.removeEventListener('keydown', editKey); node.removeEventListener('paste', editPaste); node.removeEventListener('keyup', saveSel); node.removeEventListener('mouseup', saveSel);
    node.contentEditable = 'false'; tb.classList.remove('on'); savedRange = null;
    if (!commit || node.innerHTML === beforeHtml) return;
    if (k === 'rich') { var b = node.closest('.vt-block'); send({ t: 'rich', id: b ? b.dataset.bid : '', html: node.innerHTML }); }
    else send({ t: 'override', key: node.dataset.editKey, html: node.innerHTML });
  }
  document.addEventListener('focusout', function () {
    if (!editing) return;
    setTimeout(function () { var a = document.activeElement; if (editing && !(a === editing || editing.contains(a) || tb.contains(a))) stopEdit(true); }, 60);
  });
  window.addEventListener('scroll', placeTb, { passive: true });
  document.addEventListener('mousedown', function (e) { if (editing && !editing.contains(e.target) && !tb.contains(e.target)) stopEdit(true); }, true);
  document.addEventListener('click', function (e) {
    if (tb.contains(e.target)) return;
    var rich = e.target.closest('[data-rich]');
    if (rich) { startEdit(rich, 'rich'); return; }
    if (textMode) { var t = e.target.closest('[data-edit-key]'); if (t) { e.preventDefault(); startEdit(t, 'mini'); } }
  });
  if (location.hash === '#footer') window.addEventListener('load', function () { window.scrollTo(0, document.documentElement.scrollHeight); });

  window.addEventListener('message', function (e) {
    if (e.origin !== ORIGIN || !e.data || !e.data.wb) return;
    var m = e.data;
    if (m.t === 'labels') L = Object.assign(L, m.L);
    else if (m.t === 'textmode') { textMode = !!m.on; root.classList.toggle('wb-textmode', textMode); if (!textMode) stopEdit(true); }
    else if (m.t === 'select') { select(m.id || '', false); var b = m.id && document.querySelector('.vt-block[data-bid="' + m.id + '"]'); if (b && m.scroll) b.scrollIntoView({ block: 'center', behavior: 'smooth' }); }
    else if (m.t === 'restore') { window.scrollTo(0, m.y || 0); if (m.id) select(m.id, false); }
  });
  document.addEventListener('keydown', function (e) { if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z' && !document.activeElement.isContentEditable) { e.preventDefault(); send({ t: 'undo' }); } });
  var st = null;
  window.addEventListener('scroll', function () { clearTimeout(st); st = setTimeout(function () { send({ t: 'scroll', y: window.scrollY }); }, 120); }, { passive: true });
  send({ t: 'ready' });
})();
