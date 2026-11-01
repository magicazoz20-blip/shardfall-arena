(() => {
  'use strict';
  const q = s => document.querySelector(s);
  const state = { socket: null, session: null, base: '', code: '', started: false, scriptPromise: null };
  const emotes = [['hello', '👋 أهلًا'], ['attack', '⚔️ هجوم'], ['defend', '🛡️ دافعوا'], ['thanks', '💙 شكرًا'], ['gg', '✨ لعب جميل']];
  const style = document.createElement('style');
  style.textContent = `
  #sfNetButton{--c:#28c5d2;--d:#116d88;background:linear-gradient(145deg,#174554,#112a3b)!important;border-color:#5fe8e4!important}
  #sfNetLayer{position:fixed;inset:0;z-index:12000;display:none;place-items:center;padding:20px;background:radial-gradient(ellipse at 50% 20%,#1b465dca,#060914ed 70%);backdrop-filter:blur(12px);font-family:inherit;color:#eef8ff}
  #sfNetLayer.open{display:grid} #sfNetCard{width:min(480px,100%);border:1px solid #81e9ef5c;border-radius:22px;padding:24px;background:linear-gradient(155deg,#142638f5,#0b1020f8);box-shadow:0 24px 90px #000a,inset 0 1px #ffffff1a}
  #sfNetCard h2{margin:0 0 5px;font-size:25px} #sfNetCard p{margin:0 0 18px;color:#a8bfd0;line-height:1.6;font-size:13px}
  .sfNetField{display:block;margin:11px 0;color:#9bb5c7;font-size:12px;font-weight:700}.sfNetField input{display:block;box-sizing:border-box;width:100%;margin-top:6px;padding:12px 13px;border:1px solid #416477;border-radius:11px;background:#080e19;color:#f2fbff;font:inherit;outline:none}.sfNetField input:focus{border-color:#64ede5;box-shadow:0 0 0 3px #3de2da20}
  .sfNetRow{display:flex;gap:9px;margin-top:14px}.sfNetRow button,.sfNetAction{border:1px solid #5be1df;border-radius:12px;padding:12px 14px;background:linear-gradient(145deg,#1e7d84,#15506b);color:white;font:inherit;font-weight:900;cursor:pointer}.sfNetRow button.secondary{border-color:#526879;background:#1b2636}.sfNetRow button:disabled{opacity:.55;cursor:wait}
  #sfNetStatus{min-height:22px;margin-top:12px;color:#80e2dc;font-size:13px}#sfNetLobby{display:none;margin-top:15px;padding:14px;border-radius:13px;background:#070d18;border:1px solid #344857}#sfNetLobby strong{color:#6ef2ea;font-size:21px;letter-spacing:4px}#sfNetPlayers{margin-top:8px;color:#c4d8e7;font-size:13px;line-height:1.8}
  #sfNetClose{float:left;border:0;background:transparent;color:#b9cbd6;font-size:22px;cursor:pointer}#sfNetPill{position:fixed;z-index:8000;top:12px;left:50%;transform:translateX(-50%);display:none;gap:8px;align-items:center;border:1px solid #5edbdc8a;border-radius:999px;padding:7px 11px;background:#071420dc;color:#e8ffff;box-shadow:0 6px 20px #0007;font:700 12px system-ui,sans-serif;backdrop-filter:blur(8px)}#sfNetPill.visible{display:flex}#sfNetPill button{border:0;border-radius:999px;padding:5px 8px;background:#205760;color:white;font:inherit;cursor:pointer}
  #sfNetQuick{position:fixed;z-index:8001;top:58px;left:50%;transform:translateX(-50%);display:none;gap:5px;border:1px solid #466377;border-radius:13px;padding:7px;background:#08121de8;box-shadow:0 8px 24px #0008}#sfNetQuick.visible{display:flex}#sfNetQuick button{border:0;border-radius:9px;padding:8px;background:#142b3d;color:white;font:12px system-ui,sans-serif;cursor:pointer}#sfNetQuick button:hover{background:#216577}
  @media(max-width:540px){#sfNetCard{padding:19px;border-radius:18px}.sfNetRow{flex-direction:column}#sfNetPill{top:5px;font-size:10px}#sfNetQuick{top:48px}}
  `;
  document.head.appendChild(style);
  const button = document.createElement('button');
  button.id = 'sfNetButton'; button.className = 'hm-nb'; button.title = 'اللعب عبر الإنترنت';
  button.innerHTML = '<i>🌐</i><span>لعب شبكي</span>';
  const rail = q('.hm-rail.hm-r');
  if (rail) rail.insertBefore(button, rail.firstChild);

  const layer = document.createElement('div'); layer.id = 'sfNetLayer';
  layer.innerHTML = `<section id="sfNetCard" dir="rtl" role="dialog" aria-modal="true" aria-labelledby="sfNetTitle">
    <button id="sfNetClose" aria-label="إغلاق">×</button><div style="color:#66e6df;font-size:11px;font-weight:900;letter-spacing:2px">SHARDFALL • ONLINE ARENA</div>
    <h2 id="sfNetTitle">ادخل ساحة المنافسة</h2><p>مواجهة مباشرة، غرف خاصة برمز قصير، ودردشة سريعة برسائل جاهزة.</p>
    <label class="sfNetField">عنوان الخادم<input id="sfNetUrl" inputmode="url" placeholder="http://localhost:3000" autocomplete="url"></label>
    <label class="sfNetField">اسم المقاتل<input id="sfNetName" maxlength="20" placeholder="مقاتل" autocomplete="nickname"></label>
    <label class="sfNetField">رمز الغرفة الخاصة (اختياري)<input id="sfNetCode" maxlength="5" placeholder="مثال: F7K2Q" autocapitalize="characters"></label>
    <div class="sfNetRow"><button id="sfNetPlay">⚡ ابحث عن مباراة</button><button id="sfNetJoin" class="secondary">🔑 دخول الغرفة</button></div>
    <div id="sfNetStatus" role="status" aria-live="polite">العب كضيف؛ تقدم الملف الشبكي يحفظه الخادم.</div>
    <div id="sfNetLobby"><div>رمز دعوتك: <strong id="sfNetRoomCode"></strong></div><div id="sfNetPlayers"></div><div style="color:#7d98aa;font-size:11px;margin-top:7px">تبدأ الجولة فور انضمام لاعب آخر، أو تنطلق ضد حراس الساحة بعد قليل.</div></div>
  </section>`;
  document.body.appendChild(layer);
  const pill = document.createElement('div'); pill.id = 'sfNetPill';
  pill.innerHTML = '<span>🌐 متصل</span><b id="sfNetPillCode"></b><button id="sfNetChatToggle">رسائل</button><button id="sfNetLeave">خروج</button>';
  document.body.appendChild(pill);
  const quick = document.createElement('div'); quick.id = 'sfNetQuick';
  quick.innerHTML = emotes.map(([key, label]) => `<button type="button" data-emote="${key}">${label}</button>`).join('');
  document.body.appendChild(quick);

  const status = message => { const el = q('#sfNetStatus'); if (el) el.textContent = message; };
  const open = () => { layer.classList.add('open'); if (window.sfGameBridge) q('#sfNetName').value = window.sfGameBridge.getName() || ''; };
  const close = () => layer.classList.remove('open');
  button.addEventListener('click', open); q('#sfNetClose').addEventListener('click', close);
  layer.addEventListener('click', e => { if (e.target === layer && !state.started) close(); });
  q('#sfNetChatToggle').addEventListener('click', () => quick.classList.toggle('visible'));
  q('#sfNetLeave').addEventListener('click', () => leave());
  quick.addEventListener('click', e => { const key = e.target.closest('[data-emote]')?.dataset.emote; if (key && state.socket) { state.socket.emit('chat:emote', key); quick.classList.remove('visible'); } });

  function getBase() {
    let value = q('#sfNetUrl').value.trim();
    if (!value) value = /^https?:$/.test(location.protocol) ? location.origin : 'http://localhost:3000';
    if (!/^https?:\/\//i.test(value)) value = 'http://' + value;
    return value.replace(/\/$/, '');
  }
  function loadSocketLibrary(base) {
    if (window.io) return Promise.resolve();
    if (state.scriptPromise) return state.scriptPromise;
    state.scriptPromise = new Promise((resolve, reject) => {
      const script = document.createElement('script'); script.src = base + '/socket.io/socket.io.js'; script.async = true;
      script.onload = resolve; script.onerror = () => { state.scriptPromise = null; reject(new Error('لم أستطع تحميل مكتبة الاتصال. تحقق من تشغيل الخادم.')); };
      document.head.appendChild(script);
    });
    return state.scriptPromise;
  }
  async function connect(roomCode = '') {
    const play = q('#sfNetPlay'), join = q('#sfNetJoin'); play.disabled = join.disabled = true;
    try {
      state.base = getBase();
      if (location.protocol === 'https:' && state.base.startsWith('http:')) throw new Error('يجب أن يكون الخادم آمنًا HTTPS عند فتح اللعبة عبر HTTPS.');
      const name = q('#sfNetName').value.trim().slice(0, 20) || 'مقاتل';
      const tokenKey = 'sf_net_token_' + btoa(state.base).replace(/[^a-z0-9]/gi, '').slice(0, 32);
      let token = localStorage.getItem(tokenKey) || '';
      status('جارٍ تجهيز جلسة ضيف آمنة…');
      const response = await fetch(state.base + '/api/session', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, token }) });
      if (!response.ok) throw new Error('الخادم رفض إنشاء جلسة ضيف (' + response.status + ').');
      state.session = await response.json(); localStorage.setItem(tokenKey, state.session.token);
      await loadSocketLibrary(state.base);
      if (state.socket) { state.socket.disconnect(); state.socket = null; }
      status('جارٍ الاتصال بالساحة…');
      const socket = state.socket = window.io(state.base, { auth: { token: state.session.token }, transports: ['websocket', 'polling'], reconnection: true, reconnectionAttempts: Infinity, timeout: 10000 });
      socket.on('connect', () => {
        if (state.started) { status('عاد الاتصال؛ استعادة موقعك…'); return; }
        socket.emit('match:join', { name: state.session.name, heroId: window.sfGameBridge?.getHeroId() || 'balanced', roomCode }, result => {
          if (result?.error) { status(result.error); play.disabled = join.disabled = false; return; }
          state.code = result.code; q('#sfNetRoomCode').textContent = result.code; q('#sfNetPillCode').textContent = '• ' + result.code;
          q('#sfNetLobby').style.display = 'block'; status('الغرفة جاهزة. شارك الرمز وانتظر بدء الجولة…'); renderLobby(result.state);
        });
      });
      socket.on('connect_error', err => { status(err.message || 'تعذر الاتصال بالخادم.'); play.disabled = join.disabled = false; });
      socket.on('lobby:update', renderLobby);
      socket.on('match:resumed', data => { state.code = data.code; q('#sfNetRoomCode').textContent = data.code; q('#sfNetPillCode').textContent = '• ' + data.code; renderLobby(data); });
      socket.on('match:started', data => {
        state.started = true; state.code = data.code; q('#sfNetPillCode').textContent = '• ' + data.code;
        close(); pill.classList.add('visible');
        if (window.sfGameBridge) { window.sfGameBridge.startOnline({ playerId: state.session.playerId, heroId: window.sfGameBridge.getHeroId(), mapIndex: data.mapIndex, name: state.session.name }); window.sfGameBridge.applySnapshot({ remaining: data.duration, players: data.players }); }
      });
      socket.on('match:snapshot', data => window.sfGameBridge?.applySnapshot(data));
      socket.on('combat:event', data => window.sfGameBridge?.combatEvent(data));
      socket.on('match:ended', data => { state.started = false; quick.classList.remove('visible'); pill.classList.remove('visible'); window.sfGameBridge?.endOnline(data); });
      socket.on('chat:emote', data => window.sfGameBridge?.emote(data.name, data.text));
    } catch (err) { status(err.message || 'حدث خطأ أثناء الاتصال.'); play.disabled = join.disabled = false; }
  }
  function renderLobby(data) {
    if (!data) return;
    if (data.code) { state.code = data.code; q('#sfNetRoomCode').textContent = data.code; q('#sfNetPillCode').textContent = '• ' + data.code; }
    q('#sfNetLobby').style.display = 'block';
    q('#sfNetPlayers').textContent = (data.players || []).map(p => `${p.bot ? '🤖 ' : '🟢 '}${p.name}`).join('　•　') || 'بانتظار المقاتلين…';
  }
  function leave() {
    if (state.socket) { state.socket.emit('match:leave'); state.socket.disconnect(); state.socket = null; }
    state.started = false; state.code = ''; pill.classList.remove('visible'); quick.classList.remove('visible');
    window.sfGameBridge?.leaveOnline(); close();
  }
  q('#sfNetPlay').addEventListener('click', () => connect(''));
  q('#sfNetJoin').addEventListener('click', () => {
    const code = q('#sfNetCode').value.trim().toUpperCase();
    if (!code) { status('أدخل رمز الغرفة أولًا.'); return; }
    connect(code);
  });
  window.sfNetSendInput = data => { if (state.socket?.connected && state.started) state.socket.emit('player:input', { ...data, ability: !!(data.ability || data.skill || data.a7 || data.hyper) }); };
  window.addEventListener('beforeunload', () => { if (state.socket) state.socket.disconnect(); });
})();
