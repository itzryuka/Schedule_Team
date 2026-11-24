// Logic dùng chung cho cả server (Node) và trình duyệt.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Shared = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  const SLOTS = [
    { id: 's', label: 'Sáng' },
    { id: 'c', label: 'Chiều' },
    { id: 't', label: 'Tối' },
  ];

  function defaultState() {
    return {
      version: 1,
      members: ['Quang', 'Chi', 'Hoài Anh', 'Sơn', 'Khánh'].map((name, i) => ({ id: 'm' + (i + 1), name })),
      statuses: [
        { id: 'free', label: 'Rảnh', color: '#2e9e4f', free: true },
        { id: 'busy', label: 'Không rảnh', color: '#d64545', free: false },
        { id: 'home', label: 'Về quê', color: '#3b74d6', free: false },
        { id: 'homefree', label: 'Quê (Rảnh)', color: '#0f9b9b', free: true },
        { id: 'homebusy', label: 'Quê (Không rảnh)', color: '#c47a12', free: false },
      ],
      cells: {}, // "YYYY-MM-DD|slot|memberId" -> statusId
      memories: {}, // "YYYY-MM-DD" -> [{ id, author, text, images: [imageId], createdAt }]
      log: [], // [{ id, at, by, text }] – mới nhất ở cuối
    };
  }

  const LOG_MAX = 300;

  function cellKey(date, slot, memberId) {
    return date + '|' + slot + '|' + memberId;
  }

  const DAY_NAMES = ['Chủ Nhật', 'Thứ 2', 'Thứ 3', 'Thứ 4', 'Thứ 5', 'Thứ 6', 'Thứ 7'];
  function dayText(date, withYear) {
    const [y, m, d] = date.split('-').map(Number);
    const dn = DAY_NAMES[new Date(y, m - 1, d).getDay()];
    const p = (n) => String(n).padStart(2, '0');
    return `${dn} (${p(d)}/${p(m)}${withYear ? '/' + y : ''})`;
  }

  // Mô tả thao tác bằng tiếng Việt để ghi vào lịch sử. Gọi TRƯỚC khi apply (để còn tên cũ).
  function describe(state, op) {
    const mName = (id) => (state.members.find((m) => m.id === id) || {}).name || '?';
    const sName = (id) => (id ? (state.statuses.find((s) => s.id === id) || {}).label || '?' : 'trống');
    switch (op.type) {
      case 'setCells': {
        const it = op.items[0];
        const sameDay = op.items.every((x) => x.date === it.date && x.memberId === it.memberId && x.statusId === it.statusId);
        const when =
          op.items.length > 1 && sameDay
            ? `cả ngày ${dayText(it.date)}`
            : `${(SLOTS.find((s) => s.id === it.slot) || {}).label} ${dayText(it.date)}`;
        return `đặt ${when} của ${mName(it.memberId)} → ${sName(it.statusId)}`;
      }
      case 'addMember':
        return `thêm thành viên ${op.name}`;
      case 'renameMember':
        return `đổi tên ${mName(op.id)} → ${op.name}`;
      case 'removeMember':
        return `xoá thành viên ${mName(op.id)}`;
      case 'moveMember':
        return `chuyển cột ${mName(op.id)} sang ${op.dir < 0 ? 'trái' : 'phải'}`;
      case 'addStatus':
        return `thêm trạng thái “${op.label}”`;
      case 'updateStatus': {
        const parts = [];
        if (op.label !== undefined) parts.push(`đổi tên thành “${op.label}”`);
        if (op.color !== undefined) parts.push('đổi màu');
        if (op.free !== undefined) parts.push(op.free ? 'tính là rảnh' : 'không tính là rảnh');
        return `sửa trạng thái “${sName(op.id)}”: ${parts.join(', ')}`;
      }
      case 'removeStatus':
        return `xoá trạng thái “${sName(op.id)}”`;
      case 'addMemory': {
        const n = (op.images || []).length;
        return `thêm kỉ niệm ngày ${dayText(op.date, true)}${n ? ` (${n} ảnh)` : ''}`;
      }
      case 'deleteMemory':
        return `xoá kỉ niệm ngày ${dayText(op.date, true)}`;
    }
    return op.type;
  }

  // Áp dụng 1 thao tác vào state. Mọi thao tác đều idempotent (áp dụng 2 lần vẫn ra cùng kết quả).
  function apply(state, op) {
    if (op.log) {
      state.log = state.log || [];
      if (!state.log.some((l) => l.id === op.log.id)) {
        state.log.push(op.log);
        if (state.log.length > LOG_MAX) state.log.splice(0, state.log.length - LOG_MAX);
      }
    }
    switch (op.type) {
      case 'setCells':
        for (const it of op.items) {
          const k = cellKey(it.date, it.slot, it.memberId);
          if (it.statusId) state.cells[k] = it.statusId;
          else delete state.cells[k];
        }
        break;

      case 'addMember':
        if (!state.members.some((m) => m.id === op.id)) state.members.push({ id: op.id, name: op.name });
        break;

      case 'renameMember': {
        const m = state.members.find((x) => x.id === op.id);
        if (m) m.name = op.name;
        break;
      }

      case 'removeMember':
        state.members = state.members.filter((m) => m.id !== op.id);
        for (const k of Object.keys(state.cells)) {
          if (k.endsWith('|' + op.id)) delete state.cells[k];
        }
        break;

      case 'moveMember': {
        const i = state.members.findIndex((m) => m.id === op.id);
        const j = i + op.dir;
        if (i >= 0 && j >= 0 && j < state.members.length) {
          const [m] = state.members.splice(i, 1);
          state.members.splice(j, 0, m);
        }
        break;
      }

      case 'addStatus':
        if (!state.statuses.some((s) => s.id === op.id)) {
          state.statuses.push({ id: op.id, label: op.label, color: op.color, free: !!op.free });
        }
        break;

      case 'updateStatus': {
        const s = state.statuses.find((x) => x.id === op.id);
        if (s) {
          if (op.label !== undefined) s.label = op.label;
          if (op.color !== undefined) s.color = op.color;
          if (op.free !== undefined) s.free = !!op.free;
        }
        break;
      }

      case 'removeStatus':
        state.statuses = state.statuses.filter((s) => s.id !== op.id);
        for (const [k, v] of Object.entries(state.cells)) {
          if (v === op.id) delete state.cells[k];
        }
        break;

      case 'addMemory': {
        const list = (state.memories[op.date] = state.memories[op.date] || []);
        if (!list.some((m) => m.id === op.id)) {
          list.push({ id: op.id, author: op.author, text: op.text, images: op.images || [], createdAt: op.createdAt });
        }
        break;
      }

      case 'deleteMemory': {
        const list = state.memories[op.date];
        if (list) {
          state.memories[op.date] = list.filter((m) => m.id !== op.id);
          if (!state.memories[op.date].length) delete state.memories[op.date];
        }
        break;
      }
    }
    return state;
  }

  return { SLOTS, DAY_NAMES, defaultState, cellKey, apply, describe, dayText };
});
