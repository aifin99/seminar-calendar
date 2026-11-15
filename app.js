(function () {
  // 表示中の月を描いたあと、前後の月を裏で読んでおく（1か月 約5KB）。false にすると先読みしない（v5、J17）。
  // ブラウザのデータセーバーが入っているときも先読みしない
  var PREFETCH_NEIGHBOR_MONTHS = true;

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
    loadedYm: null,     // カレンダーに読み込んである月（まだなら null）
    monthDirty: false,  // 登録・更新・削除のあと、カレンダーを読み直す
    calScroll: 0,       // 詳細ページに移る前のカレンダーのスクロール位置
    view: null,         // 'calendar' / 'detail:<ID>' / 'register' / 'manual'
    manualFrom: null,   // 使い方ページ（#manual）の直前の画面（直接開いたときは null）
    detailNo: 0,
    passKnown: false,   // 合言葉が設定されているかをサーバーから聞いたか（v6：参加者の「削除」を出すため）
    passAsking: false,
    applyNo: 0,         // 申込の返事（参加者一覧）を受け取った回数（裏の取り直しで古い一覧に戻さないため）
    inAppHistory: false, // 直前の履歴がこの画面の中のもの（「‹ カレンダーに戻る」でブラウザの戻ると同じ動きにする）
    flash: '',          // 詳細ページの上に出すメッセージ（登録しました／更新しました）
    exportNo: 0,
    flyer: null, // { base64, mimeType }
    teams: [],   // [{ name, representative }]（所属チームシート）
    edit: null   // 編集中：{ seminar }。新規登録のときは null
  };

  // ---- ページを開いている間だけ覚えておく（v5）。JS の変数だけで、端末の保存領域（localStorage など）は使わない ----
  // 再読み込み・ページを閉じると消える
  var MONTH_TTL = 60 * 1000;      // これより古い月は、描いたあと裏で取り直す
  var FLYER_TTL = 10 * 60 * 1000; // これより古いチラシは取り直す
  var FLYER_MAX = 10;             // チラシは直近10枚まで（古いものから捨てる）
  var memo = {
    months: {},   // 'yyyy-MM' → { res, at }（getMonth の結果）
    loading: {},  // 'yyyy-MM' → 取得中の月の待ち手 [[onOk, onErr], …]（同じ月を2回取りに行かない）
    gen: 0,       // 月を全部捨てたら増やす（捨てる前に始めた取得の結果は覚えない）
    details: {},  // セミナーID → { res, at }（getDetail の結果。チラシは含めない）
    flyers: {}    // セミナーID → { flyer, at }（data URL か null）
  };
  var flyerOrder = []; // チラシを覚えた順（古い順）

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
    handle(fetch(API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ api: fn, args: args }),
      redirect: 'follow'
    }).then(function (res) {
      if (!res.ok) throw new Error('通信に失敗しました（' + res.status + '）');
      return res.json();
    }), onOk, onErr);
  }
  function handle(promise, onOk, onErr) {
    promise.then(onOk, function (err) {
      onErr((err && err.message) || String(err));
    });
  }
  /**
   * index.html の <head> で app.js より先に始めた最初の要求（v5-3.5）。名前と引数が合えば1回だけ使う。
   * 合わなければ null（普通に call する）
   */
  function takeEarly(fn, key) {
    var e = window.SEMINAR_EARLY;
    if (!e || !e[fn] || e.key !== key) return null;
    var p = e[fn];
    e[fn] = null;
    return p;
  }
  function callOrEarly(fn, args, key, onOk, onErr) {
    var early = takeEarly(fn, key);
    if (early) handle(early, onOk, onErr); else call(fn, args, onOk, onErr);
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

  /** ZOOM か会場か。住所・URL が http(s):// で始まる、または場所に zoom を含むなら ZOOM */
  function kindOf(s) {
    return /^https?:\/\//i.test(s.address || '') || /zoom/i.test(s.place || '') ? 'zoom' : 'venue';
  }

  // ---- メニュー（カレンダー／セミナー登録／使い方の切替）。詳細ページはカレンダーの一部として扱う ----
  function showTab(name) {
    ['calendar', 'register', 'manual'].forEach(function (t) {
      $('tab-' + t).classList.toggle('active', t === (name === 'detail' ? 'calendar' : name));
    });
    ['calendar', 'detail', 'register', 'manual'].forEach(function (t) {
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
  $('tab-calendar').addEventListener('click', function () {
    clearHash(false);
    showCalendar();
  });
  $('tab-register').addEventListener('click', function () {
    clearHash(false);
    state.view = 'register';
    startForm(null);
    showTab('register');
  });
  // 使い方：#manual を履歴に積む（ブラウザの「戻る」で元の画面に戻れる）
  $('tab-manual').addEventListener('click', function () {
    if (state.view === 'calendar') state.calScroll = window.pageYOffset;
    if (location.hash === '#manual') showTab('manual'); else location.hash = '#manual';
  });

  // ---- 画面の切替（URL のハッシュ：#s=<セミナーID> なら詳細ページ、#manual なら使い方、無ければカレンダー） ----
  function route() {
    var m = /^#s=(.+)$/.exec(location.hash);
    var id = m ? decodeURIComponent(m[1]) : null;
    var view = location.hash === '#manual' ? 'manual' : id ? 'detail:' + id : 'calendar';
    if (state.view === view) return; // hashchange と popstate の両方が来ても1回だけ
    if (view === 'manual') showManual(); else if (id) showDetail(id); else showCalendar();
  }
  function onHistory() {
    state.inAppHistory = true;
    route();
  }
  window.addEventListener('hashchange', onHistory);
  window.addEventListener('popstate', onHistory);

  /** 詳細ページへ（ハッシュを履歴に積むので、ブラウザの「戻る」でカレンダーに戻れる） */
  function goDetail(id) {
    var hash = '#s=' + encodeURIComponent(id);
    if (location.hash === hash) { state.view = null; route(); } else location.hash = hash;
  }

  /** ハッシュを外す（replace なら今の履歴を置き換え、そうでなければ積む）。画面の切替は呼んだ側で行う */
  function clearHash(replace) {
    if (!location.hash) return;
    var url = location.pathname + location.search;
    if (replace) history.replaceState(null, '', url); else history.pushState(null, '', url);
  }

  function showCalendar() {
    var back = state.view !== 'calendar';
    state.view = 'calendar';
    showTab('calendar');
    if (state.loadedYm !== state.ym || state.monthDirty) loadMonth(state.ym);
    else if (back) window.scrollTo(0, state.calScroll);
  }

  // ---- カレンダー ----
  $('prev').addEventListener('click', function () { setMsg($('cal-msg'), ''); loadMonth(addMonth(state.ym, -1)); });
  $('next').addEventListener('click', function () { setMsg($('cal-msg'), ''); loadMonth(addMonth(state.ym, 1)); });

  /** カードやチップをタップ → 詳細ページ */
  function openSeminar(id) {
    state.calScroll = window.pageYOffset;
    goDetail(id);
  }

  /**
   * 月を表示する。覚えている月ならすぐ描き、60秒より古ければ裏で取り直して、変わっていたら描き直す（v5）。
   * 描いたあとに前後の月を先読みする
   */
  function loadMonth(ym) {
    state.ym = ym;
    state.loadedYm = ym;
    state.monthDirty = false;
    resetExport();
    var no = ++state.requestNo;
    $('month-label').textContent = Number(ym.slice(0, 4)) + '年' + Number(ym.slice(5, 7)) + '月';
    var hit = memo.months[ym];
    if (hit) {
      showMonth(hit.res);
      if (Date.now() - hit.at > MONTH_TTL) {
        var before = JSON.stringify(hit.res);
        fetchMonth(ym, function (res) {
          if (no !== state.requestNo || !res || !res.ok) return;
          if (JSON.stringify(res) !== before) showMonth(res);
        }, function () {});
      }
      prefetchNeighbors(ym);
      return;
    }
    state.seminars = [];
    renderGrid();
    $('list-title').textContent = '';
    $('list').innerHTML = '';
    $('list').appendChild(el('div', 'status', '読み込み中…'));
    fetchMonth(ym, function (res) {
      if (no !== state.requestNo) return;
      if (!res || !res.ok) { showListError((res && res.reason) || '読み込めませんでした'); return; }
      showMonth(res);
      prefetchNeighbors(ym);
    }, function (err) {
      if (no !== state.requestNo) return;
      showListError('読み込めませんでした：' + err);
    });
  }

  function showMonth(res) {
    state.seminars = res.seminars;
    state.today = res.today;
    state.passKnown = true;
    setNeedsPassphrase(res.needsPassphrase);
    renderGrid();
    renderList();
  }

  /** getMonth を呼び、成功したら覚える。同じ月を取得中なら、その結果を待つ（2回呼ばない） */
  function fetchMonth(ym, onOk, onErr) {
    var waiting = memo.loading[ym];
    if (waiting) { waiting.push([onOk, onErr]); return; }
    waiting = memo.loading[ym] = [[onOk, onErr]];
    var gen = memo.gen;
    var done = function () { if (memo.loading[ym] === waiting) delete memo.loading[ym]; };
    callOrEarly('getMonth', [ym], ym, function (res) {
      done();
      if (res && res.ok && gen === memo.gen) memo.months[ym] = { res: res, at: Date.now() };
      waiting.forEach(function (w) { w[0](res); });
    }, function (err) {
      done();
      waiting.forEach(function (w) { w[1](err); });
    });
  }

  /** 登録・更新・削除のあと：覚えている月を全部捨てる（取得中のものも結果を覚えない） */
  function forgetMonths() {
    memo.gen++;
    memo.months = {};
    memo.loading = {};
  }

  /** 更新・削除のあと：覚えている月を全部と、そのセミナーの詳細・チラシを捨てる */
  function forgetSeminar(id) {
    forgetMonths();
    delete memo.details[id];
    forgetFlyer(id);
  }

  /** 前後の月を裏で読んでおく（覚えていない月だけ。次の月 → 前の月の順に1つずつ）。チラシと詳細は先読みしない */
  function prefetchNeighbors(ym) {
    if (!PREFETCH_NEIGHBOR_MONTHS) return;
    if (navigator.connection && navigator.connection.saveData === true) return;
    var queue = [addMonth(ym, 1), addMonth(ym, -1)];
    (function next() {
      var m = queue.shift();
      if (!m) return;
      if (memo.months[m] || memo.loading[m]) { next(); return; }
      fetchMonth(m, next, next);
    })();
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
        var kind = kindOf(s);
        var chip = el('button', 'chip ' + kind);
        chip.type = 'button';
        chip.appendChild(el('span', 'ct', s.time));
        chip.appendChild(el('span', 'cn', s.lecturer));
        if (s.theme) chip.appendChild(el('span', 'cm', s.theme));
        chip.title = s.time + ' ' + s.lecturer + (s.theme ? ' ' + s.theme : '');
        chip.addEventListener('click', function () { openSeminar(s.id); });
        td.appendChild(chip);

        var box = el('button', 'cell-detail ' + kind);
        box.type = 'button';
        [['t', s.time], ['', s.place], ['', s.affiliation], ['n', s.lecturer], ['', s.theme]].forEach(function (p) {
          box.appendChild(el('span', p[0], p[1] || ' '));
        });
        box.addEventListener('click', function () { openSeminar(s.id); });
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
    sortForList(state.seminars, state.today).forEach(function (s) {
      var ended = s.date < state.today;
      // 終了したカードは薄い灰色（v6。.ended は詳細ページの「終了」の枠と同じ名前なので card-ended にした）
      var card = el('button', 'card ' + kindOf(s) + (ended ? ' card-ended' : ''));
      card.type = 'button';
      card.id = 'card-' + s.id;
      fillHead(card, s);
      if (ended) card.appendChild(el('span', 'ended-badge', '終了'));
      card.addEventListener('click', function () { openSeminar(s.id); });
      list.appendChild(card);
    });
  }

  /**
   * 一覧の並び（v5）：今日以降のもの（日付・開始時刻の早い順）→ 終了したもの（同じく早い順）。
   * 今日のセミナーは上の組（詳細ページの「終了」と同じ date < today の判定）。グリッドの並びは変えない
   */
  function sortForList(seminars, today) {
    var key = function (s) { return s.date + ' ' + s.time; };
    var byTime = function (a, b) { return key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0; };
    var upcoming = seminars.filter(function (s) { return s.date >= today; }).sort(byTime);
    var ended = seminars.filter(function (s) { return s.date < today; }).sort(byTime);
    return upcoming.concat(ended);
  }

  /** カードと詳細ページの見出し：日付（曜日）・開始時刻／講師名／テーマ／場所・所属／参加予定人数 */
  function fillHead(node, s) {
    var when = el('div', 'when');
    var wd = weekdayOf(s.date);
    when.appendChild(document.createTextNode(dateLabel(s.date) + '（'));
    when.appendChild(el('span', wd === 0 ? 'sun' : wd === 6 ? 'sat' : '', WEEK[wd]));
    when.appendChild(document.createTextNode('） ' + s.time));
    node.appendChild(when);
    node.appendChild(el('div', 'lecturer', s.lecturer));
    if (s.theme) node.appendChild(el('div', 'theme', '「' + s.theme + '」'));
    var team = s.affiliation && ('所属：' + s.affiliation + (s.representative ? '（代表 ' + s.representative + '）' : ''));
    var meta = [s.place && ('場所：' + s.place), team].filter(Boolean).join('　');
    if (meta) node.appendChild(el('div', 'meta', meta));
    node.appendChild(el('div', 'count', '参加予定 ' + s.count + '名'));
  }

  /** 申込のあと、詳細ページとカレンダーの一覧の人数をそろえる */
  function setCount(id, n) {
    state.seminars.forEach(function (x) { if (x.id === id) x.count = n; });
    // 覚えている月の人数もそろえる（月に戻ったときに古い人数を出さない）
    Object.keys(memo.months).forEach(function (ym) {
      memo.months[ym].res.seminars.forEach(function (x) { if (x.id === id) x.count = n; });
    });
    [$('detail').querySelector('.detail-head .count'), $('card-' + id) && $('card-' + id).querySelector('.count')]
      .forEach(function (node) { if (node) node.textContent = '参加予定 ' + n + '名'; });
  }

  // ---- 詳細ページ（#s=<ID>）。見出しは手元の情報で先に出し、参加者とチラシは開いたときに取りに行く ----
  // v5：参加者（getDetail、チラシ抜き）とチラシ（getFlyer）を同時に取り、チラシを待たずに申込フォームと参加者を出す。
  // 一度開いたセミナーは覚えていてすぐ描き、参加者だけ裏で取り直す（チラシは10分まで取り直さない）
  function showDetail(id) {
    state.view = 'detail:' + id;
    var no = ++state.detailNo;
    showTab('detail');
    setMsg($('d-msg'), state.flash, state.flash ? 'ok' : '');
    state.flash = '';
    var box = $('detail');
    box.innerHTML = '';
    // flyer：undefined＝取得中、null＝チラシなし（読めない）、false＝取得に失敗、文字列＝data URL
    var page = { id: id, box: box, flyer: undefined, s: null, head: null, where: null, slot: null, participants: null };
    var kept = keptFlyer(id);
    if (kept) page.flyer = kept.flyer;
    var cached = memo.details[id];
    var known = cached ? cached.res.seminar : findKnown(id);
    if (cached) {
      renderDetailPage(page, cached.res);
    } else {
      if (known) {
        renderDetailHead(box, known);
        if (known.address) box.appendChild(whereBox(known.address));
      }
      box.appendChild(el('div', 'no-flyer', '読み込み中…'));
    }

    var flyerAsked = false;
    var askFlyer = function () {
      if (flyerAsked || page.flyer !== undefined) return;
      flyerAsked = true;
      callOrEarly('getFlyer', [id], id, function (res) {
        if (!res || !res.ok) { if (no === state.detailNo) { page.flyer = false; fillFlyer(page); } return; }
        keepFlyer(id, res.flyer);
        if (no !== state.detailNo) return;
        page.flyer = res.flyer;
        fillFlyer(page);
      }, function () {
        if (no !== state.detailNo) return;
        page.flyer = false;
        fillFlyer(page);
      });
    };
    // チラシの有無が手元で分かれば、参加者と同時に取りに行く（#s=… を直接開いたときは getDetail の返事を見てから）
    if (known && known.hasFlyer) askFlyer();

    var applyNo = state.applyNo;
    callOrEarly('getDetail', [id, { flyer: false }], id, function (res) {
      if (no !== state.detailNo) return;
      if (state.applyNo !== applyNo) return; // 取り直しの途中で申し込んだ：申込の返事の方が新しい
      if (!res || !res.ok) {
        box.innerHTML = '';
        var notFound = res && /見つかりません/.test(res.reason || '');
        box.appendChild(el('div', notFound ? 'status' : 'msg error', notFound ? 'このセミナーは見つかりません' : (res && res.reason) || '読み込めませんでした'));
        return;
      }
      if (res.flyer) { keepFlyer(id, res.flyer); page.flyer = res.flyer; } // チラシ付きで返ってきたとき（v5 より前のサーバー）
      var stored = {};
      for (var k in res) stored[k] = res[k];
      stored.flyer = null;
      var prev = memo.details[id];
      memo.details[id] = { res: stored, at: Date.now() };
      var hasFlyer = res.hasFlyer != null ? res.hasFlyer : res.seminar.hasFlyer;
      if (!hasFlyer && page.flyer === undefined) page.flyer = null;
      if (hasFlyer) askFlyer();
      if (cached && page.head) refreshDetailPage(page, prev ? prev.res : cached.res, stored);
      else renderDetailPage(page, stored);
    }, function (err) {
      if (no !== state.detailNo) return;
      if (cached) return; // 覚えている内容を出したまま
      box.innerHTML = '';
      box.appendChild(el('div', 'msg error', '読み込めませんでした：' + err));
    });
  }

  /** 表示中の月か、覚えている月にあるセミナー（見出しを先に出す・チラシの有無を知るため） */
  function findKnown(id) {
    var hit = state.seminars.filter(function (x) { return x.id === id; })[0];
    Object.keys(memo.months).forEach(function (ym) {
      if (!hit) hit = memo.months[ym].res.seminars.filter(function (x) { return x.id === id; })[0];
    });
    return hit || null;
  }

  function seminarOf(res) {
    var s = {};
    for (var k in res.seminar) s[k] = res.seminar[k];
    s.count = (res.participants || []).length;
    return s;
  }

  /** 詳細ページを描く：見出し → 住所・URL → チラシ → 申込フォーム（終了なら「終了」） → 参加者 */
  function renderDetailPage(page, res) {
    var box = page.box;
    box.innerHTML = '';
    var s = seminarOf(res);
    page.s = s;
    // #s=… を直接開いたとき：戻るとこのセミナーの月のカレンダー
    if (state.loadedYm === null) state.ym = s.date.slice(0, 7);
    page.head = renderDetailHead(box, s);
    page.where = s.address ? box.appendChild(whereBox(s.address)) : null;
    page.slot = box.appendChild(el('div'));
    fillFlyer(page);
    var participants = el('div', 'participants');
    if (s.date < state.today) {
      box.appendChild(el('div', 'ended', '終了'));
    } else {
      box.appendChild(applyForm(s, participants, res.teams || []));
    }
    renderParticipants(participants, res, s);
    box.appendChild(participants);
    page.participants = participants;
    setCount(s.id, s.count);
    if (!state.passKnown) askPassphraseSetting(page);
  }

  /**
   * #s=… を直接開いたときなど、合言葉が設定されているか（参加者の「削除」を出すか）をまだ知らないとき：
   * getFormOptions で確かめ、設定されていれば参加者の表を描き直す（v6。1回だけ）
   */
  function askPassphraseSetting(page) {
    if (state.passAsking) return;
    state.passAsking = true;
    call('getFormOptions', [], function (opt) {
      state.passAsking = false;
      if (!opt || !opt.ok) return;
      state.passKnown = true;
      setNeedsPassphrase(opt.needsPassphrase);
      var d = memo.details[page.id];
      if (state.needsPassphrase && d && state.view === 'detail:' + page.id && page.participants && page.participants.isConnected && !page.participants.deleting) {
        renderParticipants(page.participants, d.res, page.s);
      }
    }, function () { state.passAsking = false; });
  }

  /** 覚えている内容で描いたあと、取り直した結果で見出しと参加者だけ差し替える（申込フォームの入力は消さない） */
  function refreshDetailPage(page, old, res) {
    var s = seminarOf(res);
    if (JSON.stringify(old.seminar) !== JSON.stringify(res.seminar) || s.count !== page.s.count) {
      page.s = s;
      var head = renderDetailHead(document.createDocumentFragment(), s);
      page.head.replaceWith(head);
      page.head = head;
      var where = s.address ? whereBox(s.address) : null;
      if (page.where) page.where.remove();
      if (where) head.after(where);
      page.where = where;
    }
    if (JSON.stringify(old.groups) !== JSON.stringify(res.groups) || JSON.stringify(old.participants) !== JSON.stringify(res.participants)) {
      if (!page.participants.deleting) renderParticipants(page.participants, res, page.s); // 削除の確認を開いている間は描き直さない
    }
    setCount(s.id, s.count);
  }

  /** チラシの場所：取得中は「チラシを読み込み中…」の枠、届いたら画像に差し替える */
  function fillFlyer(page) {
    if (!page.slot) return;
    var node;
    if (typeof page.flyer === 'string') {
      node = el('img', 'flyer');
      node.alt = 'チラシ';
      node.src = page.flyer;
    } else if (page.flyer === undefined) {
      node = el('div', 'no-flyer loading', 'チラシを読み込み中…');
    } else {
      node = el('div', 'no-flyer', page.flyer === false ? 'チラシを読み込めませんでした' : 'チラシ準備中');
    }
    page.slot.replaceWith(node);
    page.slot = node;
  }

  /** 覚えているチラシ（10分より古いものは捨てて null） */
  function keptFlyer(id) {
    var f = memo.flyers[id];
    if (f && Date.now() - f.at > FLYER_TTL) { forgetFlyer(id); f = null; }
    return f || null;
  }
  function keepFlyer(id, flyer) {
    forgetFlyer(id);
    memo.flyers[id] = { flyer: flyer, at: Date.now() };
    flyerOrder.push(id);
    while (flyerOrder.length > FLYER_MAX) delete memo.flyers[flyerOrder.shift()];
  }
  function forgetFlyer(id) {
    delete memo.flyers[id];
    flyerOrder = flyerOrder.filter(function (x) { return x !== id; });
  }

  function renderDetailHead(box, s) {
    var head = el('div', 'detail-head ' + kindOf(s));
    fillHead(head, s);
    var edit = el('button', 'edit-btn', '編集');
    edit.type = 'button';
    edit.addEventListener('click', function () { openEdit(s); });
    head.appendChild(edit);
    box.appendChild(head);
    return head;
  }

  $('d-back').addEventListener('click', function () {
    // 画面の中から来たならブラウザの「戻る」と同じ。#s=… を直接開いたときは、そのセミナーの月のカレンダーへ
    if (state.inAppHistory) { history.back(); return; }
    clearHash(true);
    showCalendar();
  });

  // ---- 使い方（#manual）。中身は index.html に書いてある。画像は loading="lazy" で開いたときに読む ----
  function showManual() {
    state.manualFrom = state.view;
    state.view = 'manual';
    openManualSection(null);
    showTab('manual');
  }

  /** 上下の「‹ カレンダーに戻る」：カレンダーから来たならブラウザの「戻る」と同じ。それ以外はカレンダーへ（直接開いたときは履歴を置き換える） */
  function manualBack() {
    if (state.manualFrom === 'calendar') { history.back(); return; }
    clearHash(state.manualFrom === null);
    showCalendar();
  }
  $('m-back-top').addEventListener('click', manualBack);
  $('m-back-bottom').addEventListener('click', manualBack);

  // アコーディオン（申し込む／登録する／直す・削除する）：押した見出しの直下に中身を開く。開くのは1つだけ、もう一度押すと閉じる。
  // name が null なら全部閉じる。ハッシュは #manual のまま
  var manualHeads = document.querySelectorAll('[data-acc]');
  function openManualSection(name) {
    Array.prototype.forEach.call(manualHeads, function (b) {
      var on = b.getAttribute('data-acc') === name;
      b.setAttribute('aria-expanded', String(on));
      $('manual-' + b.getAttribute('data-acc')).hidden = !on;
    });
  }
  Array.prototype.forEach.call(manualHeads, function (b) {
    b.addEventListener('click', function () {
      var open = b.getAttribute('aria-expanded') === 'true';
      openManualSection(open ? null : b.getAttribute('data-acc'));
      if (!open) b.scrollIntoView(); // 開いた見出しを画面の上に
    });
  });

  // ---- 月のカレンダーの書き出し（カレンダーの右下。サーバーでスプレッドシートと PDF を作り、開くボタンを出す） ----
  $('export-btn').addEventListener('click', function () {
    var ym = state.ym, no = ++state.exportNo;
    var btn = $('export-btn'), box = $('export-box');
    btn.disabled = true;
    $('export-label').textContent = '作成中…';
    box.hidden = true;
    box.innerHTML = '';
    call('exportMonth', [ym], function (res) {
      if (no !== state.exportNo) return;
      resetExportButton();
      renderExport(res);
    }, function (err) {
      if (no !== state.exportNo) return;
      resetExportButton();
      renderExport({ ok: false, reason: '書き出せませんでした：' + err });
    });
  });

  function resetExportButton() {
    $('export-btn').disabled = false;
    $('export-label').textContent = 'この月を書き出す';
  }

  /** 月を切り替えたら枠を消す（作成中の結果も捨てる） */
  function resetExport() {
    state.exportNo++;
    resetExportButton();
    $('export-box').hidden = true;
    $('export-box').innerHTML = '';
  }

  function renderExport(res) {
    var box = $('export-box');
    box.innerHTML = '';
    box.hidden = false;
    var safe = function (u) { return /^https:\/\//.test(u || ''); };
    if (!res || !res.ok || !safe(res.pdfUrl) || !safe(res.sheetUrl)) {
      box.appendChild(el('div', 'msg error', (res && res.reason) || '書き出せませんでした'));
      return;
    }
    var links = el('div', 'export-links');
    [[res.pdfUrl, 'PDF を開く'], [res.sheetUrl, 'スプレッドシートを開く']].forEach(function (p) {
      var a = el('a', 'link-btn', p[1]);
      a.href = p[0];
      a.target = '_blank';
      a.rel = 'noopener';
      links.appendChild(a);
    });
    box.appendChild(links);
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

  // ---- 編集（詳細ページ右上の「編集」→ 登録フォームに今の内容を入れて開く。合言葉は「更新する」「削除」のときにサーバーで照合） ----
  function openEdit(s) {
    call('getFormOptions', [], function (opt) {
      setTeams(opt.teams);
      state.needsPassphrase = !!opt.needsPassphrase;
      state.passKnown = true;
      state.view = 'register';
      startForm(s);
      showTab('register');
    }, function (err) {
      setMsg($('d-msg'), '編集画面を開けませんでした：' + err, 'error');
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
        if (res && res.groups) {
          renderParticipants(participants, res, s);
          // 覚えている詳細の参加者もそろえる（開き直したときに古い一覧を出さない）
          state.applyNo++;
          var d = memo.details[s.id];
          if (d) { d.res.participants = res.participants; d.res.groups = res.groups; }
        }
        if (!res || !res.ok) { setMsg(msg, (res && res.reason) || '申し込めませんでした', 'error'); return; }
        nameInput.value = '';
        teamSelect.value = '';
        introInput.value = '';
        setMsg(msg, '申し込みました', 'ok');
        s.count = res.participants.length;
        setCount(s.id, s.count);
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

  /**
   * 参加者を所属チームごとに（サーバーが No. 順に並べた groups のまま）。各チームの中は申込順。
   * v6：合言葉が設定されていれば、申込の id がある行の右端に「削除」（リーダーが合言葉で消す）。
   * note があれば表の上に出す（{ text, kind }）
   */
  function renderParticipants(box, res, s, note) {
    var groups = res.groups || [];
    var total = (res.participants || []).length;
    var canDelete = !!state.needsPassphrase && !!s;
    box.innerHTML = '';
    box.deleting = null;
    box.appendChild(el('h3', '', '参加予定 ' + total + '名'));
    if (note) box.appendChild(el('div', 'msg ' + note.kind, note.text));
    if (!total) { box.appendChild(el('div', 'none', 'まだ申込はありません')); return; }
    groups.forEach(function (g) {
      box.appendChild(el('h4', '', g.team + '（' + g.participants.length + '名）'));
      var table = el('table');
      var head = el('tr');
      head.appendChild(el('th', 'no', 'No.'));
      head.appendChild(el('th', '', '参加者名'));
      head.appendChild(el('th', '', '紹介者名'));
      if (canDelete) head.appendChild(el('th', 'del', ''));
      table.appendChild(head);
      g.participants.forEach(function (p, i) {
        var tr = el('tr');
        tr.appendChild(el('td', 'no', String(i + 1)));
        tr.appendChild(el('td', '', p.name));
        tr.appendChild(el('td', '', p.introducer));
        if (canDelete) {
          var td = el('td', 'del');
          if (p.id) {
            var b = el('button', 'p-del-btn', '削除');
            b.type = 'button';
            b.addEventListener('click', function () { openParticipantDelete(box, s, p, tr); });
            td.appendChild(b);
          }
          tr.appendChild(td);
        }
        table.appendChild(tr);
      });
      box.appendChild(table);
    });
  }

  /**
   * 参加者の削除の確認（v6）：その行のすぐ下に、名前・合言葉の欄・「削除する」「やめる」。開くのは1つだけ。
   * 合言葉はこの入力欄にだけあり、閉じる・描き直すと欄ごと消える（覚えない・URL に入れない）
   */
  function openParticipantDelete(box, s, p, tr) {
    var cols = tr.children.length;
    if (box.deleting) {
      var same = box.deleting.applyId === p.id;
      box.deleting.row.remove();
      box.deleting = null;
      if (same) return; // もう一度押したら閉じる
    }
    var row = el('tr', 'p-del-row');
    var cell = el('td');
    cell.colSpan = cols;
    var wrap = el('div', 'delete-confirm p-del-confirm');
    wrap.appendChild(el('div', '', '「' + p.name + '」さんの申込を削除します'));
    var f = el('div', 'field');
    var passId = 'p-del-pass-' + p.id;
    var label = el('label', '', '合言葉');
    label.htmlFor = passId;
    label.appendChild(el('span', 'req', '必須'));
    var input = el('input');
    input.type = 'text';
    input.id = passId;
    input.autocomplete = 'off';
    f.appendChild(label);
    f.appendChild(input);
    wrap.appendChild(f);
    var yes = el('button', 'btn danger', '削除する');
    yes.type = 'button';
    var no = el('button', 'btn sub', 'やめる');
    no.type = 'button';
    var msg = el('div', 'msg');
    wrap.appendChild(yes);
    wrap.appendChild(no);
    wrap.appendChild(msg);
    cell.appendChild(wrap);
    row.appendChild(cell);
    tr.after(row);
    box.deleting = { applyId: p.id, row: row };
    input.focus();

    no.addEventListener('click', function () {
      row.remove();
      if (box.deleting && box.deleting.row === row) box.deleting = null;
    });
    yes.addEventListener('click', function () {
      var pass = input.value.trim();
      if (!pass) { setMsg(msg, '合言葉を入れてください', 'error'); return; }
      yes.disabled = true;
      no.disabled = true;
      setMsg(msg, '削除しています…');
      call('deleteParticipant', [s.id, p.id, pass], function (res) {
        if (!row.isConnected) return; // 描き直されて確認の枠が無くなった
        yes.disabled = false;
        no.disabled = false;
        if (res && res.ok) {
          applyParticipants(box, s, res, { text: '削除しました', kind: 'ok' });
          return;
        }
        var reason = (res && res.reason) || '削除できませんでした';
        if (res && res.groups && /見つかりません/.test(reason)) {
          applyParticipants(box, s, res, { text: reason, kind: 'error' });
          return;
        }
        setMsg(msg, reason, 'error');
      }, function (err) {
        if (!row.isConnected) return;
        yes.disabled = false;
        no.disabled = false;
        setMsg(msg, '削除できませんでした：' + err, 'error');
      });
    });
  }

  /** 申込・削除の返事の参加者一覧を、表・人数（見出し・カード）・覚えている詳細と月にそろえる */
  function applyParticipants(box, s, res, note) {
    renderParticipants(box, res, s, note);
    state.applyNo++; // 裏の取り直しで古い一覧に戻さない
    var d = memo.details[s.id];
    if (d) { d.res.participants = res.participants; d.res.groups = res.groups; }
    s.count = (res.participants || []).length;
    setCount(s.id, s.count);
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

  // ---- ZOOM（Web）で開催（2026-10-27 竹腰さん指示）----
  // チェックすると場所に「ZOOM」を入れ、住所欄を URL 用の案内にする。外すと場所の「ZOOM…」を消す。
  // 保存するのは場所と住所・URL だけ（列は増やさない）。色分けは今までどおり kindOf（場所に zoom、または URL）
  function syncZoom() {
    var on = $('r-zoom').checked;
    $('r-address-label').textContent = on ? 'ZOOM の URL' : '住所／ZOOM の URL';
    $('r-address').placeholder = on ? 'https://zoom.us/j/…' : '静岡県磐田市… ／ https://zoom.us/j/…';
  }
  $('r-zoom').addEventListener('change', function () {
    var place = $('r-place');
    if (this.checked && !/zoom/i.test(place.value)) place.value = 'ZOOM';
    if (!this.checked && /zoom/i.test(place.value)) place.value = '';
    syncZoom();
  });

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
    $('r-zoom').checked = !!s && kindOf(s) === 'zoom';
    syncZoom();
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

  // 編集をやめる → 今の URL の画面（編集を始めた詳細ページ）に戻る
  $('r-cancel').addEventListener('click', function () {
    startForm(null);
    state.view = null;
    route();
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
      // 削除したセミナーの詳細（#s=…）の履歴は置き換えて、その月のカレンダーへ
      forgetSeminar(editing.seminar.id);
      startForm(null);
      setMsg($('cal-msg'), '削除しました', 'ok');
      clearHash(true);
      state.ym = res.yearMonth;
      state.monthDirty = true;
      showCalendar();
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
      // 登録・更新したセミナーの詳細ページへ。カレンダーは戻ったときに読み直す
      if (editing) forgetSeminar(editing.seminar.id); else forgetMonths();
      startForm(null);
      state.monthDirty = true;
      state.flash = editing ? '更新しました' : '登録しました';
      goDetail(res.id);
    }, function (err) {
      $('r-submit').disabled = false;
      setMsg(msg, '保存できませんでした：' + err, 'error');
    });
  });

  setTeams([]);
  route();
})();
