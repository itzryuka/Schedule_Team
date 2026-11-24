(() => {
  const { SLOTS, DAY_NAMES, cellKey, apply } = window.Shared;
  const socket = io();

  // ---------- Tiện ích ----------
  const $ = (s) => document.querySelector(s);
  const esc = (s) =>
    String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const pad = (n) => String(n).padStart(2, '0');
  const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const parseYmd = (s) => {
    const [y, m, d] = s.split('-').map(Number);
    return new Date(y, m - 1, d);
  };
  const addDays = (d, n) => {
    const x = new Date(d);
    x.setDate(x.getDate() + n);
    return x;
  };
  const startOfWeek = (d) => {
    const x = new Date(d.getFullYear(), d.getMonth(), d.getDate());
    return addDays(x, -((x.getDay() + 6) % 7)); // Thứ 2 là đầu tuần
  };
  const dm = (d) => `${pad(d.getDate())}/${pad(d.getMonth() + 1)}`;
  const dayName = (d) => DAY_NAMES[d.getDay()];
  const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  const store = {
    get: (k) => { try { return localStorage.getItem(k); } catch { return null; } },
    set: (k, v) => { try { localStorage.setItem(k, v); } catch {} },
  };

  // ---------- Trạng thái ứng dụng ----------
  let state = null;
  let weekStart = startOfWeek(new Date());
  let view = 'week';
  let meId = store.get('meId');
  let popCtx = null; // ô đang chọn
  let memDate = null; // ngày đang mở kỉ niệm
  let pending = []; // ảnh chờ đăng: { blob, url }
  let lastSeenLog = Number(store.get('lastSeenLog') || 0);

  const statusById = (id) => state.statuses.find((s) => s.id === id);
  const memberById = (id) => state.members.find((m) => m.id === id);
  const me = () => (state && memberById(meId)) || null;

  function send(op, optimistic = true) {
    op.by = op.by || (me() ? me().name : 'Ai đó');
    if (optimistic && state) apply(state, op);
    socket.emit('op', op);
    if (optimistic) render();
  }

  function toast(msg) {
    const t = $('#toast');
    t.textContent = msg;
    t.hidden = false;
    clearTimeout(toast._t);
    toast._t = setTimeout(() => (t.hidden = true), 2400);
  }

  // ---------- Hộp hỏi lại / nhập chữ (thay cho confirm/prompt) ----------
  function ask({ title, message = '', icon = '🤔', okText = 'OK', cancelText = 'Huỷ', danger = false, input = null }) {
    const dlg = $('#askDialog');
    $('#askIcon').textContent = icon;
    $('#askTitle').textContent = title;
    $('#askMsg').textContent = message;
    const inp = $('#askInput');
    inp.hidden = input === null;
    inp.value = input && input.value ? input.value : '';
    inp.placeholder = (input && input.placeholder) || '';
    const ok = $('#askOk');
    ok.textContent = okText;
    ok.className = 'btn ' + (danger ? 'danger-fill' : 'primary');
    $('#askCancel').textContent = cancelText;
    dlg.showModal();
    if (input !== null) {
      inp.focus();
      inp.select();
    } else ok.focus();

    return new Promise((resolve) => {
      const done = (val) => {
        cleanup();
        dlg.close();
        resolve(val);
      };
      const onOk = () => {
        if (input !== null) {
          const v = inp.value.trim();
          if (!v) return inp.focus();
          done(v);
        } else done(true);
      };
      const onCancel = () => done(input !== null ? null : false);
      const onKey = (e) => {
        if (e.key === 'Enter' && input !== null) {
          e.preventDefault();
          onOk();
        }
      };
      const onClose = (e) => {
        e.preventDefault();
        onCancel();
      };
      function cleanup() {
        ok.removeEventListener('click', onOk);
        $('#askCancel').removeEventListener('click', onCancel);
        inp.removeEventListener('keydown', onKey);
        dlg.removeEventListener('cancel', onClose);
      }
      ok.addEventListener('click', onOk);
      $('#askCancel').addEventListener('click', onCancel);
      inp.addEventListener('keydown', onKey);
      dlg.addEventListener('cancel', onClose);
    });
  }
  const confirmDelete = (title, message) => ask({ title, message, icon: '🗑️', okText: 'Xoá', danger: true });

  // ---------- Bắt buộc chọn tên trước khi sửa ----------
  function requireMe() {
    if (me()) return true;
    const m = $('#mascot');
    $('#mascotBubble').textContent = 'Ê! Chọn tên trước đã rồi mới được sửa nha!';
    m.hidden = false;
    m.classList.remove('nag');
    void m.offsetWidth; // chạy lại animation
    m.classList.add('nag');
    closePopover();
    window.scrollTo({ top: 0, behavior: 'smooth' });
    toast('Bấm “Bạn là” để chọn tên trước đã nhé 👆');
    return false;
  }

  // ---------- Socket ----------
  socket.on('connect', () => setBadge(true));
  socket.on('disconnect', () => setBadge(false));
  socket.on('state', (s) => {
    state = s;
    render();
    refreshUnread();
  });
  socket.on('op', (op) => {
    if (!state) return;
    apply(state, op);
    if (op.log) onNewLog(op.log);
    render();
  });
  socket.on('presence', (n) => {
    $('#presence').textContent = n > 1 ? `👥 ${n} người đang mở` : '';
  });

  function setBadge(on) {
    const b = $('#syncBadge');
    b.className = 'badge ' + (on ? 'on' : 'off');
    b.textContent = on ? 'Đã đồng bộ trực tuyến' : 'Mất kết nối – đang thử lại…';
  }

  // ---------- Tính toán ----------
  function weekDays() {
    return Array.from({ length: 7 }, (_, i) => addDays(weekStart, i));
  }

  function freeCount(date, slot) {
    let n = 0;
    const names = [];
    for (const m of state.members) {
      const s = statusById(state.cells[cellKey(date, slot, m.id)]);
      if (s && s.free) {
        n++;
        names.push(m.name);
      }
    }
    return { n, names };
  }

  // Khung giờ đẹp: phải có ít nhất 4 người rảnh (hoặc cả nhóm nếu nhóm ít hơn 4 người)
  // và không tính những ngày đã qua.
  const MIN_FREE = 4;
  const minFree = () => Math.max(1, Math.min(MIN_FREE, state.members.length));

  function bestSlots(limit = 3) {
    const list = [];
    const today = ymd(new Date());
    const need = minFree();
    weekDays().forEach((d, di) => {
      if (ymd(d) < today) return; // ngày đã qua
      SLOTS.forEach((sl, si) => {
        const { n, names } = freeCount(ymd(d), sl.id);
        if (n >= need) list.push({ d, sl, n, names, order: di * 3 + si });
      });
    });
    list.sort((a, b) => b.n - a.n || a.order - b.order);
    return list.slice(0, limit);
  }

  function renderBest(best) {
    const total = state.members.length;
    const need = minFree();
    const weekOver = ymd(weekDays()[6]) < ymd(new Date());
    const head = `<div class="best-head"><span>⭐ Khung giờ đẹp nhất tuần</span><span class="best-sub">từ ${need} người rảnh trở lên</span></div>`;
    if (!best.length) {
      const msg = weekOver
        ? 'Tuần này qua rồi nên không gợi ý nữa nha.'
        : `Chưa có buổi nào đủ ${need} người rảnh. Mọi người điền thêm lịch nhé!`;
      return `<div class="best empty">${head}<div class="best-empty">${msg}</div></div>`;
    }
    const medals = ['🥇', '🥈', '🥉'];
    return `<div class="best">${head}<div class="best-list">${best
      .map(
        (x, i) => `<div class="best-card ${i === 0 ? 'top' : ''}">
          <div class="best-row">
            <span class="best-medal">${medals[i] || '•'}</span>
            <span class="best-when"><span class="best-slot">${x.sl.label}</span> ${dayName(x.d)} <span class="best-date">${dm(x.d)}</span></span>
            <span class="best-count"><b>${x.n}</b>/${total}</span>
          </div>
          <div class="best-names">${x.names.map((n) => `<span>${esc(n)}</span>`).join('')}</div>
        </div>`
      )
      .join('')}</div></div>`;
  }

  const slotText = (x) => `${x.sl.label} ${dayName(x.d)} (${dm(x.d)})`;

  // ---------- Vẽ giao diện ----------
  function render() {
    if (!state) return;
    $('#memberCount').textContent = `· ${state.members.length} người`;
    renderMe();
    renderLogDot();
    renderOnThisDay();
    if (view === 'week') renderWeek();
    else renderMemoriesAll();
    if (popCtx) renderPopover();
    if (memDate && $('#memDialog').open) renderMemList();
    if ($('#setDialog').open) renderSettings();
    if ($('#whoDialog').open) renderWho();
  }

  function renderMe() {
    const m = me();
    $('#meName').textContent = m ? m.name : 'chưa chọn';
    $('#meBtn').classList.toggle('unset', !m);
    const mascot = $('#mascot');
    if (m) {
      mascot.hidden = true;
      mascot.classList.remove('nag');
    } else if (mascot.hidden) {
      $('#mascotBubble').textContent = 'Chọn tên trước đã nha!';
      mascot.hidden = false;
    }
  }

  function renderWeek() {
    const days = weekDays();
    const end = days[6];
    $('#weekLabel').textContent = `Tuần ${dm(weekStart)} - ${dm(end)}/${end.getFullYear()}`;
    const todayStr = ymd(new Date());
    const isThisWeek = ymd(startOfWeek(new Date())) === ymd(weekStart);
    $('#todayBtn').textContent = isThisWeek ? '(Hôm nay)' : 'Về tuần này';

    const best = bestSlots();
    $('#bestSlots').innerHTML = renderBest(best);
    const bestKeys = new Set(best.map((x) => ymd(x.d) + '|' + x.sl.id));

    $('#legend').innerHTML = state.statuses
      .map((s) => `<span class="pill" style="--c:${s.color}">${esc(s.label)}${s.free ? ' ✓' : ''}</span>`)
      .join('');

    const total = state.members.length;
    let html = '<table class="grid"><thead><tr><th>Ngày</th><th>Buổi</th>';
    for (const m of state.members) html += `<th class="member" data-mid="${m.id}" title="Bấm để đổi tên">${esc(m.name)}</th>`;
    html += '<th>Rảnh</th></tr></thead><tbody>';

    for (const d of days) {
      const ds = ymd(d);
      const isToday = ds === todayStr;
      const memCount = (state.memories[ds] || []).length;
      SLOTS.forEach((sl, si) => {
        html += `<tr class="${si === 0 ? 'day-start' : ''} ${isToday ? 'today' : ''}">`;
        if (si === 0) {
          html += `<td class="day ${isToday ? 'today' : ''}" rowspan="3">
            ${dayName(d)} <span class="date">(${dm(d)})</span>${isToday ? '<span class="today-tag">Hôm nay</span>' : ''}<br>
            <button class="mem-btn ${memCount ? 'has' : ''}" data-mem="${ds}">${memCount ? `💖 ${memCount} kỉ niệm` : '＋ Kỉ niệm'}</button>
          </td>`;
        }
        html += `<td class="slot">${sl.label}</td>`;
        for (const m of state.members) {
          const s = statusById(state.cells[cellKey(ds, sl.id, m.id)]);
          html += `<td class="cell" data-date="${ds}" data-slot="${sl.id}" data-mid="${m.id}">`;
          html += s
            ? `<span class="pill" style="--c:${s.color}">${esc(s.label)}</span>`
            : '<span class="pill empty">—</span>';
          html += '</td>';
        }
        const { n } = freeCount(ds, sl.id);
        const ratio = total ? n / total : 0;
        const color = n === 0 ? '#a0a7b4' : ratio >= 0.99 ? '#1e7a3a' : ratio >= 0.5 ? '#2e9e4f' : '#c47a12';
        const isBest = bestKeys.has(ds + '|' + sl.id);
        html += `<td class="count ${isBest ? 'is-best' : ''}" style="color:${color}" ${isBest ? 'title="Khung giờ đẹp"' : ''}>${
          isBest ? '<span class="star">⭐</span>' : ''
        }${n}/${total}</td></tr>`;
      });
    }
    html += '</tbody></table>';
    if (!state.members.length) html = '<div class="empty-state">Chưa có thành viên nào. Bấm “＋ Thêm người” nhé.</div>';
    $('#grid').innerHTML = html;
  }

  function renderOnThisDay() {
    const now = new Date();
    const md = `-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
    const hits = Object.keys(state.memories)
      .filter((k) => k.endsWith(md) && Number(k.slice(0, 4)) < now.getFullYear() && state.memories[k].length)
      .sort()
      .reverse();
    $('#onThisDay').innerHTML = hits
      .map((k) => {
        const first = state.memories[k][0];
        const years = now.getFullYear() - Number(k.slice(0, 4));
        const t = first.text || `${(first.images || []).length} ảnh`;
        return `<div class="otd" data-mem="${k}">🎉 <b>Ngày này ${years} năm trước</b> (${dm(parseYmd(k))}/${k.slice(0, 4)}): “${esc(
          t.slice(0, 120)
        )}${t.length > 120 ? '…' : ''}” — ${esc(first.author)}</div>`;
      })
      .join('');
  }

  function renderMemoriesAll() {
    const keys = Object.keys(state.memories)
      .filter((k) => state.memories[k].length)
      .sort()
      .reverse();
    if (!keys.length) {
      $('#memoriesAll').innerHTML =
        '<div class="empty-state">Chưa có kỉ niệm nào 🥲<br>Vào “Lịch theo tuần”, bấm <b>＋ Kỉ niệm</b> ở ngày bất kỳ để thêm.</div>';
      return;
    }
    $('#memoriesAll').innerHTML =
      '<div class="memories-all">' +
      keys
        .map((k) => {
          const d = parseYmd(k);
          return `<div class="mem-day">
            <div class="mem-day-head"><span>${dayName(d)}, ${dm(d)}/${d.getFullYear()}</span>
              <span><button class="btn" data-mem="${k}">＋ Thêm</button> <button class="btn" data-goto="${k}">Xem tuần đó →</button></span></div>
            <div class="mem-list">${memItems(k)}</div>
          </div>`;
        })
        .join('') +
      '</div>';
  }

  function memItems(date) {
    const list = (state.memories[date] || []).slice().sort((a, b) => a.createdAt - b.createdAt);
    return list
      .map((m) => {
        const imgs = m.images || [];
        return `<div class="mem">
          <div class="mem-head">
            <div class="mem-text">${esc(m.text)}</div>
            <button class="del" data-delmem="${m.id}" data-date="${date}" title="Xoá kỉ niệm">🗑 Xoá</button>
          </div>
          ${
            imgs.length
              ? `<div class="thumbs">${imgs
                  .map((id, i) => `<div class="thumb"><img src="/img/${id}" loading="lazy" alt="" data-lb="${imgs.join(',')}" data-i="${i}"></div>`)
                  .join('')}</div>`
              : ''
          }
          <div class="mem-meta">— ${esc(m.author)} · ${new Date(m.createdAt).toLocaleString('vi-VN', {
          hour: '2-digit',
          minute: '2-digit',
          day: '2-digit',
          month: '2-digit',
        })}</div>
        </div>`;
      })
      .join('');
  }

  // ---------- Popup chọn trạng thái ----------
  function openPopover(td) {
    popCtx = { date: td.dataset.date, slot: td.dataset.slot, mid: td.dataset.mid, td, allDay: popCtx ? popCtx.allDay : false };
    renderPopover();
  }

  function closePopover() {
    popCtx = null;
    $('#popover').hidden = true;
  }

  function renderPopover() {
    const pop = $('#popover');
    const m = memberById(popCtx.mid);
    if (!m) return closePopover();
    const d = parseYmd(popCtx.date);
    const slotLabel = SLOTS.find((s) => s.id === popCtx.slot).label;
    const cur = state.cells[cellKey(popCtx.date, popCtx.slot, popCtx.mid)];
    pop.innerHTML = `
      <div class="pop-title">${esc(m.name)} · ${popCtx.allDay ? 'Cả ngày' : slotLabel} ${dayName(d)} (${dm(d)})</div>
      <div class="pop-list">
        ${state.statuses
          .map(
            (s) =>
              `<button class="pill ${s.id === cur && !popCtx.allDay ? 'sel' : ''}" style="--c:${s.color}" data-set="${s.id}">${esc(s.label)}</button>`
          )
          .join('')}
      </div>
      <label class="pop-opts"><input type="checkbox" id="popAllDay" ${popCtx.allDay ? 'checked' : ''}> Áp dụng cả ngày (sáng, chiều, tối)</label>
      <div class="pop-actions">
        <button class="btn" data-newstatus>＋ Trạng thái khác</button>
        <button class="btn danger" data-clear>Xoá</button>
      </div>`;
    pop.hidden = false;

    const td =
      document.querySelector(`td.cell[data-date="${popCtx.date}"][data-slot="${popCtx.slot}"][data-mid="${popCtx.mid}"]`) || popCtx.td;
    const r = td.getBoundingClientRect();
    const pw = pop.offsetWidth;
    const ph = pop.offsetHeight;
    let left = r.left + window.scrollX + r.width / 2 - pw / 2;
    left = Math.max(8 + window.scrollX, Math.min(left, window.scrollX + document.documentElement.clientWidth - pw - 8));
    let top = r.bottom + window.scrollY + 6;
    if (r.bottom + ph + 12 > window.innerHeight && r.top - ph - 6 > 0) top = r.top + window.scrollY - ph - 6;
    pop.style.left = left + 'px';
    pop.style.top = top + 'px';
  }

  function setStatus(ctx, statusId) {
    const slots = ctx.allDay ? SLOTS.map((s) => s.id) : [ctx.slot];
    send({
      type: 'setCells',
      items: slots.map((slot) => ({ date: ctx.date, slot, memberId: ctx.mid, statusId: statusId || null })),
    });
  }

  $('#popover').addEventListener('click', async (e) => {
    const b = e.target.closest('[data-set]');
    if (b) {
      setStatus(popCtx, b.dataset.set);
      return closePopover();
    }
    if (e.target.closest('[data-clear]')) {
      const ctx = { ...popCtx };
      const m = memberById(ctx.mid);
      const d = parseYmd(ctx.date);
      const when = ctx.allDay ? 'cả ngày' : SLOTS.find((s) => s.id === ctx.slot).label.toLowerCase();
      closePopover();
      if (await confirmDelete('Xoá trạng thái?', `Xoá trạng thái ${when} ${dayName(d)} (${dm(d)}) của ${m.name}?`)) {
        setStatus(ctx, null);
      }
      return;
    }
    if (e.target.closest('[data-newstatus]')) {
      const ctx = { ...popCtx };
      closePopover();
      openQuickStatus(ctx);
    }
  });
  $('#popover').addEventListener('change', (e) => {
    if (e.target.id === 'popAllDay') {
      popCtx.allDay = e.target.checked;
      renderPopover();
    }
  });

  // Thêm trạng thái mới ngay từ popup
  let qsCtx = null;
  function openQuickStatus(ctx) {
    qsCtx = ctx;
    $('#qsLabel').value = '';
    $('#qsFree').checked = false;
    $('#qsColor').value = '#' + Math.floor(Math.random() * 0xffffff).toString(16).padStart(6, '0');
    $('#statusDialog').showModal();
    $('#qsLabel').focus();
  }
  $('#qsCancel').onclick = () => $('#statusDialog').close();
  $('#qsOk').onclick = () => {
    const label = $('#qsLabel').value.trim();
    if (!label) return $('#qsLabel').focus();
    const id = 'st' + uid();
    send({ type: 'addStatus', id, label, color: $('#qsColor').value, free: $('#qsFree').checked });
    if (qsCtx) setStatus(qsCtx, id);
    $('#statusDialog').close();
  };
  $('#qsLabel').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); $('#qsOk').click(); } });

  document.addEventListener('mousedown', (e) => {
    if (popCtx && !e.target.closest('#popover') && !e.target.closest('td.cell')) closePopover();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closePopover();
  });
  window.addEventListener('resize', closePopover);

  // ---------- Bảng ----------
  $('#grid').addEventListener('click', async (e) => {
    const td = e.target.closest('td.cell');
    if (td) {
      if (!requireMe()) return;
      if (popCtx && popCtx.date === td.dataset.date && popCtx.slot === td.dataset.slot && popCtx.mid === td.dataset.mid) {
        return closePopover();
      }
      return openPopover(td);
    }
    const th = e.target.closest('th.member');
    if (th) {
      if (!requireMe()) return;
      const m = memberById(th.dataset.mid);
      const name = await ask({ title: 'Đổi tên', icon: '✏️', okText: 'Lưu', input: { value: m.name } });
      if (name && name !== m.name) send({ type: 'renameMember', id: m.id, name });
    }
  });

  document.addEventListener('click', async (e) => {
    const mb = e.target.closest('[data-mem]');
    if (mb) return openMemories(mb.dataset.mem);
    const go = e.target.closest('[data-goto]');
    if (go) {
      weekStart = startOfWeek(parseYmd(go.dataset.goto));
      switchView('week');
      return;
    }
    const del = e.target.closest('[data-delmem]');
    if (del) {
      if (!requireMe()) return;
      const mem = (state.memories[del.dataset.date] || []).find((m) => m.id === del.dataset.delmem);
      if (!mem) return;
      const preview = mem.text ? `“${mem.text.slice(0, 80)}${mem.text.length > 80 ? '…' : ''}”` : '';
      const imgs = (mem.images || []).length;
      const ok = await confirmDelete(
        'Xoá kỉ niệm này?',
        [preview, imgs ? `Kèm ${imgs} ảnh cũng sẽ bị xoá vĩnh viễn.` : '', 'Không thể khôi phục lại.'].filter(Boolean).join('\n')
      );
      if (ok) {
        send({ type: 'deleteMemory', date: del.dataset.date, id: mem.id });
        toast('Đã xoá kỉ niệm');
      }
      return;
    }
    const lb = e.target.closest('[data-lb]');
    if (lb) openLightbox(lb.dataset.lb.split(','), Number(lb.dataset.i));
  });

  // ---------- Điều hướng tuần / tab ----------
  $('#prevWeek').onclick = () => {
    weekStart = addDays(weekStart, -7);
    closePopover();
    render();
  };
  $('#nextWeek').onclick = () => {
    weekStart = addDays(weekStart, 7);
    closePopover();
    render();
  };
  $('#todayBtn').onclick = () => {
    weekStart = startOfWeek(new Date());
    render();
  };

  function switchView(v) {
    view = v;
    document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.dataset.view === v));
    $('#weekView').hidden = v !== 'week';
    $('#memoriesView').hidden = v !== 'memories';
    closePopover();
    render();
  }
  document.querySelectorAll('.tab').forEach((t) => (t.onclick = () => switchView(t.dataset.view)));

  // ---------- Bạn là ai ----------
  function setMe(id) {
    meId = id;
    store.set('meId', id);
    render();
    if ($('#memDialog').open) $('#memAuthor').textContent = me() ? me().name : 'Ẩn danh';
  }
  function renderWho() {
    $('#whoList').innerHTML = state.members
      .map((m) => `<button data-who="${m.id}" class="${m.id === meId ? 'sel' : ''}">${esc(m.name)}</button>`)
      .join('');
  }
  $('#meBtn').onclick = () => {
    if (!state) return;
    renderWho();
    $('#whoNewName').value = '';
    $('#whoDialog').showModal();
  };
  $('#whoList').addEventListener('click', (e) => {
    const b = e.target.closest('[data-who]');
    if (!b) return;
    setMe(b.dataset.who);
    $('#whoDialog').close();
    toast(`Chào ${me().name} 👋`);
  });
  $('#whoNewBtn').onclick = () => {
    const name = $('#whoNewName').value.trim();
    if (!name) return $('#whoNewName').focus();
    const exist = state.members.find((m) => m.name.toLowerCase() === name.toLowerCase());
    if (exist) {
      setMe(exist.id);
    } else {
      const id = 'm' + uid();
      send({ type: 'addMember', id, name, by: name });
      setMe(id);
    }
    $('#whoDialog').close();
    toast(`Chào ${name} 👋`);
  };
  $('#whoNewName').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); $('#whoNewBtn').click(); } });

  // ---------- Thêm người ----------
  function addMember(name) {
    name = (name || '').trim();
    if (!name) return;
    send({ type: 'addMember', id: 'm' + uid(), name });
    toast(`Đã thêm ${name}`);
  }
  $('#addMemberBtn').onclick = async () => {
    if (!requireMe()) return;
    const name = await ask({ title: 'Thêm người mới', icon: '🙋', okText: 'Thêm', input: { placeholder: 'Tên người mới' } });
    if (name) addMember(name);
  };

  // ---------- Kỉ niệm ----------
  function openMemories(date) {
    memDate = date;
    const d = parseYmd(date);
    $('#memTitle').textContent = `💖 Kỉ niệm ${dayName(d)}, ${dm(d)}/${d.getFullYear()}`;
    $('#memAuthor').textContent = me() ? me().name : 'chưa chọn tên';
    $('#memText').value = store.get('draft:' + date) || '';
    clearPending();
    renderMemList();
    closePopover();
    $('#memDialog').showModal();
  }
  function renderMemList() {
    const html = memItems(memDate);
    $('#memList').innerHTML = html || '<div class="mem-empty">Chưa có kỉ niệm nào cho ngày này. Viết cái đầu tiên đi! ✍️</div>';
  }
  function clearPending() {
    pending.forEach((p) => URL.revokeObjectURL(p.url));
    pending = [];
    renderPending();
  }
  function renderPending() {
    $('#memPreview').innerHTML = pending
      .map((p, i) => `<div class="thumb"><img src="${p.url}" alt=""><button class="rm" data-rmpending="${i}" title="Bỏ ảnh">✕</button></div>`)
      .join('');
  }
  $('#memPreview').addEventListener('click', (e) => {
    const b = e.target.closest('[data-rmpending]');
    if (!b) return;
    const [p] = pending.splice(Number(b.dataset.rmpending), 1);
    URL.revokeObjectURL(p.url);
    renderPending();
  });

  // Thu nhỏ ảnh trước khi tải lên (tối đa 1600px, JPEG)
  async function shrinkImage(file) {
    if (file.type === 'image/gif' && file.size < 4e6) return file;
    const url = URL.createObjectURL(file);
    try {
      const img = await new Promise((res, rej) => {
        const i = new Image();
        i.onload = () => res(i);
        i.onerror = rej;
        i.src = url;
      });
      const MAX = 1600;
      const k = Math.min(1, MAX / Math.max(img.naturalWidth, img.naturalHeight));
      const c = document.createElement('canvas');
      c.width = Math.round(img.naturalWidth * k);
      c.height = Math.round(img.naturalHeight * k);
      const ctx = c.getContext('2d');
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, c.width, c.height);
      ctx.drawImage(img, 0, 0, c.width, c.height);
      return await new Promise((res) => c.toBlob(res, 'image/jpeg', 0.82));
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  $('#memFiles').addEventListener('change', async (e) => {
    const files = [...e.target.files].filter((f) => f.type.startsWith('image/'));
    e.target.value = '';
    for (const f of files) {
      if (pending.length >= 10) {
        toast('Tối đa 10 ảnh cho mỗi kỉ niệm');
        break;
      }
      try {
        const blob = await shrinkImage(f);
        pending.push({ blob, url: URL.createObjectURL(blob) });
        renderPending();
      } catch {
        toast(`Không đọc được ảnh ${f.name}`);
      }
    }
  });

  $('#memText').addEventListener('input', (e) => memDate && store.set('draft:' + memDate, e.target.value));
  $('#memSave').onclick = async () => {
    if (!requireMe()) {
      $('#memDialog').close();
      return;
    }
    const text = $('#memText').value.trim();
    if (!text && !pending.length) return $('#memText').focus();
    const btn = $('#memSave');
    btn.disabled = true;
    const date = memDate;
    try {
      const images = [];
      for (let i = 0; i < pending.length; i++) {
        btn.textContent = `Đang tải ảnh ${i + 1}/${pending.length}…`;
        const r = await fetch('/api/upload', {
          method: 'POST',
          headers: { 'Content-Type': pending[i].blob.type || 'image/jpeg' },
          body: pending[i].blob,
        });
        if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || 'Tải ảnh thất bại');
        images.push((await r.json()).id);
      }
      send({ type: 'addMemory', date, id: 'k' + uid(), author: me().name, text, images, createdAt: Date.now() });
      $('#memText').value = '';
      store.set('draft:' + date, '');
      clearPending();
      toast('Đã lưu kỉ niệm 💖');
    } catch (err) {
      toast('Lỗi: ' + err.message);
    } finally {
      btn.disabled = false;
      btn.textContent = 'Lưu kỉ niệm';
    }
  };
  $('#memText').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); $('#memSave').click(); }
  });
  $('#memDialog').addEventListener('close', () => {
    memDate = null;
    clearPending();
  });

  // ---------- Xem ảnh lớn ----------
  let lb = { ids: [], i: 0 };
  function openLightbox(ids, i) {
    lb = { ids, i };
    showLb();
    $('#lightbox').showModal();
  }
  function showLb() {
    $('#lbImg').src = '/img/' + lb.ids[lb.i];
    $('#lbPrev').hidden = $('#lbNext').hidden = lb.ids.length < 2;
  }
  const lbStep = (d) => {
    lb.i = (lb.i + d + lb.ids.length) % lb.ids.length;
    showLb();
  };
  $('#lbPrev').onclick = () => lbStep(-1);
  $('#lbNext').onclick = () => lbStep(1);
  $('#lightbox').addEventListener('keydown', (e) => {
    if (e.key === 'ArrowLeft') lbStep(-1);
    if (e.key === 'ArrowRight') lbStep(1);
  });
  $('#lightbox').addEventListener('click', (e) => {
    if (e.target.id === 'lightbox') $('#lightbox').close(); // bấm ra ngoài để đóng
  });

  // ---------- Lịch sử thay đổi ----------
  // Lịch sử được lưu đầy đủ trên server; ở đây chỉ tải từng ngày một khi xem.
  let unread = 0;
  let logDay = startOfDay(new Date());
  let logData = null; // { items, prevAt, nextAt } của ngày đang xem
  let lbSeenAtOpen = 0;
  let logReq = 0;

  function startOfDay(d) {
    return new Date(d.getFullYear(), d.getMonth(), d.getDate());
  }
  const isTodayDay = (d) => ymd(d) === ymd(new Date());

  async function refreshUnread() {
    try {
      const r = await fetch(`/api/log/count?since=${lastSeenLog}`);
      unread = (await r.json()).count || 0;
    } catch {
      unread = 0;
    }
    renderLogDot();
  }

  function renderLogDot() {
    const dot = $('#logDot');
    dot.hidden = unread === 0 || $('#logDialog').open;
    dot.textContent = unread > 99 ? '99+' : unread;
  }

  function onNewLog(l) {
    if ($('#logDialog').open) {
      const from = logDay.getTime();
      const to = addDays(logDay, 1).getTime();
      if (logData && l.at >= from && l.at < to && !logData.items.some((x) => x.id === l.id)) {
        logData.items.unshift(l);
        renderLog();
      } else if (logData && l.at >= to) {
        logData.nextAt = logData.nextAt || l.at;
        renderLog();
      }
      markLogSeen(l.at);
    } else if (!me() || l.by !== me().name) {
      unread++;
      renderLogDot();
    }
  }

  async function loadLog() {
    const req = ++logReq;
    const from = logDay.getTime();
    const to = addDays(logDay, 1).getTime();
    renderLogNav();
    $('#logList').innerHTML = '<div class="mem-empty">Đang tải…</div>';
    try {
      const r = await fetch(`/api/log?from=${from}&to=${to}`);
      if (!r.ok) throw new Error();
      const data = await r.json();
      if (req !== logReq) return; // đã chuyển sang ngày khác
      logData = data;
    } catch {
      if (req !== logReq) return;
      logData = null;
      $('#logList').innerHTML = '<div class="mem-empty">Không tải được lịch sử 😢</div>';
      return;
    }
    renderLog();
  }

  function renderLogNav() {
    const d = logDay;
    const today = startOfDay(new Date());
    const yest = addDays(today, -1);
    const label = isTodayDay(d) ? 'Hôm nay' : ymd(d) === ymd(yest) ? 'Hôm qua' : dayName(d);
    $('#logDayLabel').textContent = `${label}, ${dm(d)}/${d.getFullYear()}`;
    $('#logDate').value = ymd(d);
    $('#logDate').max = ymd(today);
    $('#logNext').disabled = isTodayDay(d);
    $('#logToday').hidden = isTodayDay(d);
  }

  function renderLog() {
    renderLogNav();
    if (!logData) return;
    const { items, prevAt, nextAt } = logData;
    let html = `<div class="log-count">${items.length ? `${items.length} thay đổi` : ''}</div>`;
    if (!items.length) {
      html += '<div class="mem-empty">Không có thay đổi nào trong ngày này.</div>';
    }
    for (const l of items) {
      const t = new Date(l.at);
      html += `<div class="log-item ${l.at > lbSeenAtOpen ? 'new' : ''}">
        <span class="log-time">${pad(t.getHours())}:${pad(t.getMinutes())}</span>
        <span><b>${esc(l.by)}</b> ${esc(l.text)}</span>
      </div>`;
    }
    const jumps = [];
    if (prevAt) jumps.push(`<button class="btn" data-logjump="${prevAt}">‹ Ngày có thay đổi trước (${dm(new Date(prevAt))})</button>`);
    if (nextAt) jumps.push(`<button class="btn" data-logjump="${nextAt}">Ngày có thay đổi sau (${dm(new Date(nextAt))}) ›</button>`);
    if (jumps.length) html += `<div class="log-jumps">${jumps.join('')}</div>`;
    $('#logList').innerHTML = html;
  }

  function gotoLogDay(d) {
    const today = startOfDay(new Date());
    logDay = startOfDay(d) > today ? today : startOfDay(d);
    loadLog();
  }

  $('#logBtn').onclick = () => {
    if (!state) return;
    lbSeenAtOpen = lastSeenLog;
    logDay = startOfDay(new Date());
    $('#logDialog').showModal();
    loadLog();
    markLogSeen(Date.now());
  };
  $('#logPrev').onclick = () => gotoLogDay(addDays(logDay, -1));
  $('#logNext').onclick = () => gotoLogDay(addDays(logDay, 1));
  $('#logToday').onclick = () => gotoLogDay(new Date());
  $('#logDate').addEventListener('change', (e) => e.target.value && gotoLogDay(parseYmd(e.target.value)));
  $('#logList').addEventListener('click', (e) => {
    const b = e.target.closest('[data-logjump]');
    if (b) gotoLogDay(new Date(Number(b.dataset.logjump)));
  });
  $('#logDialog').addEventListener('keydown', (e) => {
    if (e.target.tagName === 'INPUT') return;
    if (e.key === 'ArrowLeft') $('#logPrev').click();
    if (e.key === 'ArrowRight' && !$('#logNext').disabled) $('#logNext').click();
  });

  function markLogSeen(at) {
    lastSeenLog = Math.max(lastSeenLog, at);
    store.set('lastSeenLog', String(lastSeenLog));
    unread = 0;
    renderLogDot();
  }
  $('#logDialog').addEventListener('close', () => {
    markLogSeen(Date.now());
  });
  $('#logDialog').addEventListener('click', (e) => {
    if (e.target.id === 'logDialog') $('#logDialog').close();
  });

  // ---------- Cài đặt ----------
  $('#settingsBtn').onclick = () => {
    if (!requireMe()) return;
    renderSettings(true);
    closePopover();
    $('#setDialog').showModal();
  };

  function renderSettings(force) {
    const ae = document.activeElement;
    if (!force && ae && ae.closest('#setDialog') && (ae.type === 'text' || ae.type === 'color')) return;

    $('#setMembers').innerHTML = state.members
      .map(
        (m, i) => `<div class="set-row" data-mid="${m.id}">
          <input type="text" value="${esc(m.name)}" maxlength="40" data-rename>
          <button class="btn" data-move="-1" ${i === 0 ? 'disabled' : ''} title="Lên">↑</button>
          <button class="btn" data-move="1" ${i === state.members.length - 1 ? 'disabled' : ''} title="Xuống">↓</button>
          <button class="btn danger" data-delmember title="Xoá">Xoá</button>
        </div>`
      )
      .join('');

    $('#setStatuses').innerHTML = state.statuses
      .map(
        (s) => `<div class="set-row" data-sid="${s.id}">
          <input type="color" value="${s.color}" data-scolor>
          <input type="text" value="${esc(s.label)}" maxlength="30" data-slabel>
          <label class="chk"><input type="checkbox" data-sfree ${s.free ? 'checked' : ''}> Tính là rảnh</label>
          <button class="btn danger" data-delstatus title="Xoá">Xoá</button>
        </div>`
      )
      .join('');
  }

  $('#setDialog').addEventListener('change', (e) => {
    const t = e.target;
    const mrow = t.closest('[data-mid]');
    const srow = t.closest('[data-sid]');
    if (t.matches('[data-rename]') && mrow) {
      const name = t.value.trim();
      if (name) send({ type: 'renameMember', id: mrow.dataset.mid, name });
    } else if (srow && t.matches('[data-slabel]')) {
      const label = t.value.trim();
      if (label) send({ type: 'updateStatus', id: srow.dataset.sid, label });
    } else if (srow && t.matches('[data-scolor]')) {
      send({ type: 'updateStatus', id: srow.dataset.sid, color: t.value });
    } else if (srow && t.matches('[data-sfree]')) {
      send({ type: 'updateStatus', id: srow.dataset.sid, free: t.checked });
    }
  });

  $('#setDialog').addEventListener('click', async (e) => {
    const t = e.target;
    const mrow = t.closest('[data-mid]');
    const srow = t.closest('[data-sid]');
    if (t.matches('[data-delmember]') && mrow) {
      const m = memberById(mrow.dataset.mid);
      if (await confirmDelete(`Xoá ${m.name}?`, `Toàn bộ lịch đã điền của ${m.name} cũng sẽ bị xoá.`)) {
        send({ type: 'removeMember', id: m.id });
        renderSettings(true);
      }
    } else if (t.matches('[data-move]') && mrow) {
      send({ type: 'moveMember', id: mrow.dataset.mid, dir: Number(t.dataset.move) });
      renderSettings(true);
    } else if (t.matches('[data-delstatus]') && srow) {
      const s = statusById(srow.dataset.sid);
      if (await confirmDelete(`Xoá trạng thái “${s.label}”?`, 'Các ô đang chọn trạng thái này sẽ bị để trống.')) {
        send({ type: 'removeStatus', id: s.id });
        renderSettings(true);
      }
    }
  });

  $('#newMemberBtn').onclick = () => {
    addMember($('#newMemberName').value);
    $('#newMemberName').value = '';
    renderSettings(true);
  };
  $('#newMemberName').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); $('#newMemberBtn').click(); } });

  $('#newStatusBtn').onclick = () => {
    const label = $('#newStatusLabel').value.trim();
    if (!label) return $('#newStatusLabel').focus();
    send({ type: 'addStatus', id: 'st' + uid(), label, color: $('#newStatusColor').value, free: $('#newStatusFree').checked });
    $('#newStatusLabel').value = '';
    $('#newStatusFree').checked = false;
    renderSettings(true);
  };
  $('#newStatusLabel').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); $('#newStatusBtn').click(); } });

  // ---------- Chốt kèo & Copy ----------
  $('#copyBtn').onclick = async () => {
    if (!state) return;
    const days = weekDays();
    const total = state.members.length;
    const best = bestSlots(3);
    let text = `📅 Lịch nhóm tuần ${dm(days[0])} - ${dm(days[6])}/${days[6].getFullYear()}\n`;
    if (!best.length) text += `Chưa có buổi nào đủ ${minFree()} người rảnh 😢\n`;
    best.forEach((x, i) => {
      text += `${i === 0 ? '⭐' : '•'} ${slotText(x)}: ${x.n}/${total} rảnh (${x.names.join(', ')})\n`;
    });
    const notFilled = state.members.filter((m) =>
      days.every((d) => SLOTS.every((sl) => !state.cells[cellKey(ymd(d), sl.id, m.id)]))
    );
    if (notFilled.length) text += `⚠️ Chưa điền lịch: ${notFilled.map((m) => m.name).join(', ')}\n`;
    text += location.origin;
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const ta = document.createElement('textarea');
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      ta.remove();
    }
    toast('Đã copy tóm tắt – dán vào nhóm chat nhé!');
  };
})();
