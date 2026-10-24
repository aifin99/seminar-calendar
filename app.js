(function () {
  // 今日（日本時間）。月を読んだあとはサーバーの日付で上書きする
  var TODAY = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  var API_URL = String((window.SEMINAR_CONFIG && window.SEMINAR_CONFIG.apiUrl) || '');
  var WEEK = ['日', '月', '火', '水', '木', '金', '土'];
  var MAX_SIDE = 1600;
  var MAX_BYTES = 1500000;

  var state = {
    ym: TODAY.slice(0, 7),
    today: TODAY,
    seminars: [],
    needsPassphrase: false,
    requestNo: 0,
    openId: null,
    flyer: null, // { base64, mimeType }
    teams: [],   // [{ name, representative }]（所属チームシート）
    edit: null   // 編集中：{ seminar }。新規登録のときは null
  };

  // ---- 小さな道具 ----
  function $(id) { return document.getElementById(id); }
  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }
  /**
   * GAS の API（/exec）を呼ぶ。本文は { api, args } の JSON。
   * Content-Type を text/plain にして preflight を出さない（GAS は OPTIONS に応えられない）
   */
  function call(fn, args, onOk, onErr) {
    fetch(API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ api: fn, args: args }),
      redirect: 'follow'
    }).then(function (res) {
      if (!res.ok) throw new Error('通信に失敗しました（' + res.status + '）');
      return res.json();
    }).then(onOk, function (err) {
      onErr((err && err.message) || String(err));
    });
  }
  function addMonth(ym, n) {
    var y = Number(ym.slice(0, 4)), m = Number(ym.slice(5, 7)) - 1 + n;
    y += Math.floor(m / 12); m = ((m % 12) + 12) % 12;
    return y + '-' + ('0' + (m + 1)).slice(-2);
  }
  function weekdayOf(date) {
    return new Date(Number(date.slice(0, 4)), Number(date.slice(5, 7)) - 1, Number(date.slice(8, 10))).getDay();
  }
  function dateLabel(date) {
    return Number(date.slice(5, 7)) + '月' + Number(date.slice(8, 10)) + '日';
  }
  function setMsg(node, text, kind) {
    node.textContent = text || '';
    node.className = 'msg' + (kind ? ' ' + kind : '');
  }

  // ---- メニュー（カレンダー／セミナー登録の切替） ----
  function showTab(name) {
    ['calendar', 'register'].forEach(function (t) {
      $('tab-' + t).classList.toggle('active', t === name);
      $('panel-' + t).classList.toggle('active', t === name);
    });
    setMenuOpen(false);
    window.scrollTo(0, 0);
  }
  function setMenuOpen(open) {
    $('menu').hidden = !open;
    $('menu-btn').setAttribute('aria-expanded', String(open));
  }
  $('menu-btn').addEventListener('click', function (ev) {
    ev.stopPropagation();
    setMenuOpen($('menu').hidden);
  });
  document.addEventListener('click', function (ev) {
    if (!$('menu').hidden && !$('menu').contains(ev.target)) setMenuOpen(false);
  });
  $('tab-calendar').addEventListener('click', function () { showTab('calendar'); });
  $('tab-register').addEventListener('click', function () {
    startForm(null);
    showTab('register');
  });

  // ---- カレンダー ----
  $('prev').addEventListener('click', function () { setMsg($('cal-msg'), ''); loadMonth(addMonth(state.ym, -1)); });
  $('next').addEventListener('click', function () { setMsg($('cal-msg'), ''); loadMonth(addMonth(state.ym, 1)); });

  function loadMonth(ym, openId) {
    state.ym = ym;
    state.seminars = [];
    state.openId = null;
    var no = ++state.requestNo;
    $('month-label').textContent = Number(ym.slice(0, 4)) + '年' + Number(ym.slice(5, 7)) + '月';
    renderGrid();
    $('list-title').textContent = '';
    $('list').innerHTML = '';
    $('list').appendChild(el('div', 'status', '読み込み中…'));
    call('getMonth', [ym], function (res) {
      if (no !== state.requestNo) return;
      if (!res || !res.ok) { showListError((res && res.reason) || '読み込めませんでした'); return; }
      state.seminars = res.seminars;
      state.today = res.today;
      setNeedsPassphrase(res.needsPassphrase);
      renderGrid();
      renderList();
      if (openId) openCard(openId, true);
    }, function (err) {
      if (no !== state.requestNo) return;
      showListError('読み込めませんでした：' + err);
    });
  }

  function showListError(text) {
    $('list').innerHTML = '';
    $('list').appendChild(el('div', 'msg error', text));
  }

  function renderGrid() {
    var ym = state.ym;
    var y = Number(ym.slice(0, 4)), m = Number(ym.slice(5, 7));
    var first = new Date(y, m - 1, 1).getDay();
    var days = new Date(y, m, 0).getDate();
    var byDate = {};
    state.seminars.forEach(function (s) { (byDate[s.date] = byDate[s.date] || []).push(s); });

    var body = $('grid-body');
    body.innerHTML = '';
    var tr = null;
    for (var i = 0; i < Math.ceil((first + days) / 7) * 7; i++) {
      if (i % 7 === 0) { tr = el('tr'); body.appendChild(tr); }
      var d = i - first + 1;
      var td = el('td');
      if (d < 1 || d > days) { td.className = 'empty'; tr.appendChild(td); continue; }
      var date = ym + '-' + ('0' + d).slice(-2);
      if (date === state.today) td.className = 'today';
      td.appendChild(el('div', 'day' + (i % 7 === 0 ? ' sun' : i % 7 === 6 ? ' sat' : ''), String(d)));
      (byDate[date] || []).forEach(function (s) {
        var chip = el('button', 'chip');
        chip.type = 'button';
        chip.appendChild(el('span', 'ct', s.time));
        chip.appendChild(el('span', 'cn', s.lecturer));
        if (s.theme) chip.appendChild(el('span', 'cm', s.theme));
        chip.title = s.time + ' ' + s.lecturer + (s.theme ? ' ' + s.theme : '');
        chip.addEventListener('click', function () { openCard(s.id, true); });
        td.appendChild(chip);

        var box = el('button', 'cell-detail');
        box.type = 'button';
        [['t', s.time], ['', s.place], ['', s.affiliation], ['n', s.lecturer], ['', s.theme]].forEach(function (p) {
          box.appendChild(el('span', p[0], p[1] || ' '));
        });
        box.addEventListener('click', function () { openCard(s.id, true); });
        td.appendChild(box);
      });
      tr.appendChild(td);
    }
  }

  function renderList() {
    var list = $('list');
    list.innerHTML = '';
    var m = Number(state.ym.slice(5, 7));
    $('list-title').textContent = m + '月のセミナー（' + state.seminars.length + '件）';
    if (!state.seminars.length) {
      list.appendChild(el('div', 'status', 'この月のセミナーはありません'));
      return;
    }
    state.seminars.forEach(function (s) {
      var card = el('div', 'card');
      card.id = 'card-' + s.id;
      var head = el('button', 'card-head');
      head.type = 'button';
      var when = el('div', 'when');
      var wd = weekdayOf(s.date);
      when.appendChild(document.createTextNode(dateLabel(s.date) + '（'));
      when.appendChild(el('span', wd === 0 ? 'sun' : wd === 6 ? 'sat' : '', WEEK[wd]));
      when.appendChild(document.createTextNode('） ' + s.time));
      head.appendChild(when);
      head.appendChild(el('div', 'lecturer', s.lecturer));
      if (s.theme) head.appendChild(el('div', 'theme', '「' + s.theme + '」'));
      var team = s.affiliation && ('所属：' + s.affiliation + (s.representative ? '（代表 ' + s.representative + '）' : ''));
      var meta = [s.place && ('場所：' + s.place), team].filter(Boolean).join('　');
      if (meta) head.appendChild(el('div', 'meta', meta));
      head.appendChild(el('div', 'count', '参加予定 ' + s.count + '名'));
      head.addEventListener('click', function () {
        if (state.openId === s.id) closeCard(s.id); else openCard(s.id, false);
      });
      card.appendChild(head);
      var edit = el('button', 'edit-btn', '編集');
      edit.type = 'button';
      edit.addEventListener('click', function () { openEdit(s); });
      card.appendChild(edit);
      card.appendChild(el('div', 'card-body'));
      list.appendChild(card);
    });
  }

  function closeCard(id) {
    var card = $('card-' + id);
    if (card) { card.classList.remove('open'); card.querySelector('.card-body').innerHTML = ''; }
    if (state.openId === id) state.openId = null;
  }

  function openCard(id, scroll) {
    if (state.openId && state.openId !== id) closeCard(state.openId);
    var card = $('card-' + id);
    if (!card) return;
    var s = state.seminars.filter(function (x) { return x.id === id; })[0];
    state.openId = id;
    card.classList.add('open');
    var body = card.querySelector('.card-body');
    body.innerHTML = '';
    body.appendChild(el('div', 'status', '読み込み中…'));
    if (scroll) card.scrollIntoView({ behavior: 'smooth', block: 'start' });
    call('getDetail', [id], function (res) {
      if (state.openId !== id) return;
      body.innerHTML = '';
      if (!res || !res.ok) { body.appendChild(el('div', 'msg error', (res && res.reason) || '読み込めませんでした')); return; }
      renderDetail(body, s, res);
    }, function (err) {
      if (state.openId !== id) return;
      body.innerHTML = '';
      body.appendChild(el('div', 'msg error', '読み込めませんでした：' + err));
    });
  }

  function renderDetail(body, s, detail) {
    if (s.address) body.appendChild(whereBox(s.address));
    if (detail.flyer) {
      var img = el('img', 'flyer');
      img.alt = 'チラシ';
      img.src = detail.flyer;
      body.appendChild(img);
    } else {
      body.appendChild(el('div', 'no-flyer', 'チラシ準備中'));
    }

    var participants = el('div', 'participants');
    if (s.date < state.today) {
      body.appendChild(el('div', 'ended', '終了'));
    } else {
      body.appendChild(applyForm(s, participants, detail.teams || []));
    }
    renderParticipants(participants, detail);
    body.appendChild(participants);
  }

  /** 住所なら地図、URL（ZOOM など）なら参加ボタン */
  function whereBox(address) {
    var box = el('div', 'where');
    var a = el('a', 'link-btn');
    a.target = '_blank';
    a.rel = 'noopener';
    if (/^https?:\/\//i.test(address)) {
      box.appendChild(el('div', '', 'オンライン開催'));
      a.href = address;
      a.textContent = /zoom/i.test(address) ? 'ZOOM に参加する' : '参加用のページを開く';
    } else {
      box.appendChild(el('div', '', '住所：' + address));
      a.href = 'https://www.google.com/maps/search/?api=1&query=' + encodeURIComponent(address);
      a.textContent = '地図を開く';
    }
    box.appendChild(a);
    return box;
  }

  // ---- 編集（カード右上の「編集」→ 登録フォームに今の内容を入れて開く。合言葉は「更新する」「削除」のときにサーバーで照合） ----
  function openEdit(s) {
    call('getFormOptions', [], function (opt) {
      setTeams(opt.teams);
      state.needsPassphrase = !!opt.needsPassphrase;
      startForm(s);
      showTab('register');
    }, function (err) {
      setMsg($('cal-msg'), '編集画面を開けませんでした：' + err, 'error');
    });
  }

  var GUEST_TEAM = 'ゲスト';

  /** 申込フォーム：所属チーム（必須）・参加者名（必須）・紹介者名（ゲストのときに書いてもらう）の順 */
  function applyForm(s, participants, teams) {
    var form = el('form', 'form');
    form.noValidate = true;

    var f = el('div', 'field');
    var l = el('label', '', '所属チーム');
    l.htmlFor = 'f-' + s.id + '-team';
    l.appendChild(el('span', 'req', '必須'));
    var teamSelect = el('select');
    teamSelect.id = 'f-' + s.id + '-team';
    var add = function (value, label) {
      var o = el('option', '', label);
      o.value = value;
      teamSelect.appendChild(o);
    };
    add('', '（選んでください）');
    teams.forEach(function (t) { add(t.name, t.name); });
    add(GUEST_TEAM, 'ゲスト（会員以外の方）');
    f.appendChild(l);
    f.appendChild(teamSelect);
    form.appendChild(f);

    var nameInput = textField(form, '参加者名', s.id + '-name', true);
    var introInput = textField(form, '紹介者名', s.id + '-intro', false, 'ゲストの方は紹介者名を入れてください');
    var btn = el('button', 'btn', '申し込む');
    btn.type = 'submit';
    btn.style.marginTop = '8px';
    form.appendChild(btn);
    var msg = el('div', 'msg');
    form.appendChild(msg);

    form.addEventListener('submit', function (ev) {
      ev.preventDefault();
      var name = nameInput.value.trim(), team = teamSelect.value, intro = introInput.value.trim();
      if (!name) { setMsg(msg, '参加者名を入れてください', 'error'); return; }
      if (!team) { setMsg(msg, '所属チームを選んでください（会員でない方は「ゲスト」）', 'error'); return; }
      btn.disabled = true;
      setMsg(msg, '送信中…');
      call('addParticipant', [s.id, name, team, intro], function (res) {
        btn.disabled = false;
        if (res && res.groups) renderParticipants(participants, res);
        if (!res || !res.ok) { setMsg(msg, (res && res.reason) || '申し込めませんでした', 'error'); return; }
        nameInput.value = '';
        teamSelect.value = '';
        introInput.value = '';
        setMsg(msg, '申し込みました', 'ok');
        s.count = res.participants.length;
        var count = $('card-' + s.id).querySelector('.count');
        if (count) count.textContent = '参加予定 ' + s.count + '名';
      }, function (err) {
        btn.disabled = false;
        setMsg(msg, '申し込めませんでした：' + err, 'error');
      });
    });
    return form;
  }

  /** note があれば見出しの右に小さく出す */
  function textField(form, label, id, required, note) {
    var f = el('div', 'field');
    var l = el('label', '', label);
    l.htmlFor = 'f-' + id;
    if (required) l.appendChild(el('span', 'req', '必須'));
    if (note) l.appendChild(el('span', 'note', note));
    var input = el('input');
    input.type = 'text';
    input.id = 'f-' + id;
    f.appendChild(l);
    f.appendChild(input);
    form.appendChild(f);
    return input;
  }

  /** 参加者を所属チームごとに（サーバーが No. 順に並べた groups のまま）。各チームの中は申込順 */
  function renderParticipants(box, res) {
    var groups = res.groups || [];
    var total = (res.participants || []).length;
    box.innerHTML = '';
    box.appendChild(el('h3', '', '参加予定 ' + total + '名'));
    if (!total) { box.appendChild(el('div', 'none', 'まだ申込はありません')); return; }
    groups.forEach(function (g) {
      box.appendChild(el('h4', '', g.team + '（' + g.participants.length + '名）'));
      var table = el('table');
      var head = el('tr');
      head.appendChild(el('th', 'no', 'No.'));
      head.appendChild(el('th', '', '参加者名'));
      head.appendChild(el('th', '', '紹介者名'));
      table.appendChild(head);
      g.participants.forEach(function (p, i) {
        var tr = el('tr');
        tr.appendChild(el('td', 'no', String(i + 1)));
        tr.appendChild(el('td', '', p.name));
        tr.appendChild(el('td', '', p.introducer));
        table.appendChild(tr);
      });
      box.appendChild(table);
    });
  }

  // ---- セミナー登録・編集フォーム ----
  function setNeedsPassphrase(v) {
    state.needsPassphrase = !!v;
    // 登録・編集・削除のどれも、ここに入れた合言葉をサーバーで照合する
    $('r-pass-field').hidden = !state.needsPassphrase;
  }

  var TEAM_NONE = '', TEAM_OTHER = 'other';

  /** 所属の選択肢：（選ばない）／チーム名（代表者名）…／その他（入力する） */
  function setTeams(teams) {
    state.teams = teams || [];
    var select = $('r-team');
    var keep = select.value;
    select.innerHTML = '';
    var add = function (value, label) {
      var o = el('option', '', label);
      o.value = value;
      select.appendChild(o);
    };
    add(TEAM_NONE, '（選ばない）');
    state.teams.forEach(function (t, i) {
      add('t' + i, t.name + (t.representative ? '（' + t.representative + '）' : ''));
    });
    add(TEAM_OTHER, 'その他（入力する）');
    if (Array.prototype.some.call(select.options, function (o) { return o.value === keep; })) select.value = keep;
    syncTeamInput();
  }

  function syncTeamInput() {
    $('r-affiliation').hidden = $('r-team').value !== TEAM_OTHER;
  }
  $('r-team').addEventListener('change', syncTeamInput);

  /** 所属の欄に今の値を入れる。チーム名がマスターにあればそれを選び、無ければ「その他」に文字を入れる */
  function selectTeam(affiliation) {
    var i = -1;
    state.teams.forEach(function (t, k) { if (i < 0 && t.name === affiliation) i = k; });
    $('r-team').value = !affiliation ? TEAM_NONE : i >= 0 ? 't' + i : TEAM_OTHER;
    $('r-affiliation').value = i >= 0 ? '' : (affiliation || '');
    syncTeamInput();
  }

  /** 所属と代表者は、選んだ時点のチーム名・代表者の「値」を保存する（ID ではない） */
  function teamValues() {
    var v = $('r-team').value;
    if (v === TEAM_OTHER) return { affiliation: $('r-affiliation').value.trim(), representative: '' };
    var t = state.teams[Number(v.slice(1))];
    if (!t) return { affiliation: '', representative: '' };
    var orig = state.edit && state.edit.seminar;
    // 編集で所属を変えていなければ、登録したときの代表者をそのまま残す（当期の代表者）
    if (orig && orig.affiliation === t.name && orig.representative) {
      return { affiliation: t.name, representative: orig.representative };
    }
    return { affiliation: t.name, representative: t.representative };
  }

  function clearFlyer() {
    $('r-flyer').value = '';
    state.flyer = null;
    $('r-preview').hidden = true;
    setMsg($('r-flyer-msg'), '');
  }

  /** s が null なら新規登録、あれば編集 */
  function startForm(s) {
    state.edit = s ? { seminar: s } : null;
    $('register-form').reset();
    clearFlyer();
    setMsg($('r-msg'), '');
    $('r-title').textContent = s ? 'セミナー編集' : 'セミナー登録';
    $('r-submit').textContent = s ? '更新する' : '保存';
    $('r-cancel').hidden = !s;
    $('r-delete-area').hidden = !s;
    $('r-delete-confirm').hidden = true;
    $('r-delete').hidden = false;
    setMsg($('r-delete-msg'), '');
    $('r-flyer-current').hidden = !(s && s.hasFlyer);
    if (s) {
      $('r-date').value = s.date;
      $('r-time').value = s.time;
      $('r-place').value = s.place || '';
      $('r-address').value = s.address || '';
      $('r-lecturer').value = s.lecturer || '';
      $('r-theme').value = s.theme || '';
    }
    selectTeam(s ? s.affiliation : '');
    setNeedsPassphrase(state.needsPassphrase);
    if (!s) {
      call('getFormOptions', [], function (opt) {
        if (state.edit) return;
        setTeams(opt.teams);
        setNeedsPassphrase(opt.needsPassphrase);
      }, function () {});
    }
  }

  $('r-cancel').addEventListener('click', function () {
    startForm(null);
    showTab('calendar');
  });

  // ---- 削除（編集画面の赤いボタン → 確認 → 合言葉をサーバーで照合して行を消す） ----
  $('r-delete').addEventListener('click', function () {
    setMsg($('r-delete-msg'), '');
    if (state.needsPassphrase && !$('r-pass').value.trim()) {
      setMsg($('r-delete-msg'), '削除するには上の合言葉の欄に合言葉を入れてください', 'error');
      return;
    }
    $('r-delete').hidden = true;
    $('r-delete-confirm').hidden = false;
  });
  $('r-delete-no').addEventListener('click', function () {
    $('r-delete-confirm').hidden = true;
    $('r-delete').hidden = false;
  });
  $('r-delete-yes').addEventListener('click', function () {
    var editing = state.edit;
    if (!editing) return;
    var btn = this;
    btn.disabled = true;
    setMsg($('r-delete-msg'), '削除しています…');
    call('deleteSeminar', [editing.seminar.id, $('r-pass').value.trim()], function (res) {
      btn.disabled = false;
      if (!res || !res.ok) {
        $('r-delete-confirm').hidden = true;
        $('r-delete').hidden = false;
        setMsg($('r-delete-msg'), (res && res.reason) || '削除できませんでした', 'error');
        return;
      }
      startForm(null);
      setMsg($('cal-msg'), '削除しました', 'ok');
      showTab('calendar');
      loadMonth(res.yearMonth);
    }, function (err) {
      btn.disabled = false;
      setMsg($('r-delete-msg'), '削除できませんでした：' + err, 'error');
    });
  });

  $('r-flyer').addEventListener('change', function () {
    var file = this.files && this.files[0];
    state.flyer = null;
    $('r-preview').hidden = true;
    setMsg($('r-flyer-msg'), '');
    if (!file) return;
    setMsg($('r-flyer-msg'), '画像を縮小しています…');
    shrinkImage(file, function (err, flyer) {
      if (err) {
        $('r-flyer').value = '';
        setMsg($('r-flyer-msg'), err, 'error');
        return;
      }
      state.flyer = flyer;
      $('r-preview').src = 'data:' + flyer.mimeType + ';base64,' + flyer.base64;
      $('r-preview').hidden = false;
      setMsg($('r-flyer-msg'), '縮小後 ' + flyer.width + '×' + flyer.height + 'px・約' + Math.round(flyer.bytes / 1024) + 'KB');
    });
  });

  /** 長辺 1600px に縮小し JPEG にする。1.5MB を超えるときは品質を下げる */
  function shrinkImage(file, done) {
    var url = URL.createObjectURL(file);
    var img = new Image();
    img.onload = function () {
      URL.revokeObjectURL(url);
      var scale = Math.min(1, MAX_SIDE / Math.max(img.naturalWidth, img.naturalHeight));
      var w = Math.round(img.naturalWidth * scale), h = Math.round(img.naturalHeight * scale);
      var canvas = document.createElement('canvas');
      canvas.width = w; canvas.height = h;
      var ctx = canvas.getContext('2d');
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, w, h);
      ctx.drawImage(img, 0, 0, w, h);
      var qualities = [0.85, 0.75, 0.65, 0.55, 0.45];
      for (var i = 0; i < qualities.length; i++) {
        var base64 = canvas.toDataURL('image/jpeg', qualities[i]).split(',')[1];
        var bytes = Math.floor(base64.length * 3 / 4) - (base64.slice(-2) === '==' ? 2 : base64.slice(-1) === '=' ? 1 : 0);
        if (bytes <= MAX_BYTES || i === qualities.length - 1) {
          if (bytes > MAX_BYTES) { done('画像が大きすぎて縮小できませんでした'); return; }
          done(null, { base64: base64, mimeType: 'image/jpeg', width: w, height: h, bytes: bytes });
          return;
        }
      }
    };
    img.onerror = function () {
      URL.revokeObjectURL(url);
      done('この画像は読み込めません。JPEG か PNG の画像を選んでください');
    };
    img.src = url;
  }

  $('register-form').addEventListener('submit', function (ev) {
    ev.preventDefault();
    var msg = $('r-msg');
    var team = teamValues();
    var payload = {
      date: $('r-date').value,
      time: $('r-time').value,
      place: $('r-place').value.trim(),
      address: $('r-address').value.trim(),
      affiliation: team.affiliation,
      representative: team.representative,
      lecturer: $('r-lecturer').value.trim(),
      theme: $('r-theme').value.trim(),
      flyer: state.flyer ? { base64: state.flyer.base64, mimeType: state.flyer.mimeType } : null
    };
    var editing = state.edit;
    var pass = $('r-pass').value.trim();
    if (!payload.date) { setMsg(msg, '日付を入れてください', 'error'); return; }
    if (!payload.time) { setMsg(msg, '開始時刻を入れてください', 'error'); return; }
    if (!payload.lecturer) { setMsg(msg, '講師名を入れてください', 'error'); return; }
    if (state.needsPassphrase && !pass) { setMsg(msg, '合言葉を入れてください', 'error'); return; }
    if ($('r-flyer').files.length && !state.flyer) { setMsg(msg, 'チラシの縮小が終わるまでお待ちください', 'error'); return; }

    $('r-submit').disabled = true;
    setMsg(msg, '保存中…');
    var fn = editing ? 'updateSeminar' : 'addSeminar';
    var args = editing ? [editing.seminar.id, payload, pass] : [payload, pass];
    call(fn, args, function (res) {
      $('r-submit').disabled = false;
      if (!res || !res.ok) {
        setMsg(msg, (res && res.reason) || '保存できませんでした', 'error');
        if (res && res.reason === '合言葉が違います') setNeedsPassphrase(true);
        return;
      }
      startForm(null);
      setMsg($('cal-msg'), editing ? '更新しました' : '登録しました', 'ok');
      showTab('calendar');
      loadMonth(res.yearMonth, res.id);
    }, function (err) {
      $('r-submit').disabled = false;
      setMsg(msg, '保存できませんでした：' + err, 'error');
    });
  });

  setTeams([]);
  loadMonth(state.ym);
})();
