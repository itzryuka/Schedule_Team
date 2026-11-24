const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { Server } = require('socket.io');
const Shared = require('./public/shared.js');

const PORT = process.env.PORT || 3000;
const DATABASE_URL = process.env.DATABASE_URL;
const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, 'data', 'db.json');

// ---------------- Lưu trữ ----------------
// Có DATABASE_URL (Postgres: Render / Neon / Supabase) -> lưu vào DB, không mất khi Render khởi động lại.
// Không có -> lưu file JSON (dùng khi chạy local; trên Render free sẽ mất khi redeploy/ngủ).
let pool = null;

async function loadState() {
  if (DATABASE_URL) {
    const { Pool } = require('pg');
    const host = new URL(DATABASE_URL).hostname;
    // Host nội bộ của Render (vd: dpg-xxxx-a) không có dấu chấm -> không cần SSL.
    let ssl = host.includes('.') ? { rejectUnauthorized: false } : false;
    if (process.env.PGSSL === 'false') ssl = false;
    if (process.env.PGSSL === 'true') ssl = { rejectUnauthorized: false };
    pool = new Pool({ connectionString: DATABASE_URL, ssl });
    await pool.query(
      'CREATE TABLE IF NOT EXISTS app_state (id INT PRIMARY KEY, data JSONB NOT NULL, updated_at TIMESTAMPTZ NOT NULL DEFAULT now())'
    );
    await pool.query(
      'CREATE TABLE IF NOT EXISTS images (id TEXT PRIMARY KEY, mime TEXT NOT NULL, data BYTEA NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now())'
    );
    const r = await pool.query('SELECT data FROM app_state WHERE id = 1');
    console.log('Lưu trữ: Postgres');
    return r.rows[0] ? r.rows[0].data : null;
  }
  console.log('Lưu trữ: file', DATA_FILE);
  try {
    return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  } catch {
    return null;
  }
}

async function writeState(json) {
  if (pool) {
    await pool.query(
      'INSERT INTO app_state (id, data, updated_at) VALUES (1, $1, now()) ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data, updated_at = now()',
      [json]
    );
  } else {
    fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
    const tmp = DATA_FILE + '.tmp';
    fs.writeFileSync(tmp, json);
    fs.renameSync(tmp, DATA_FILE);
  }
}

// ---------------- Ảnh kỉ niệm (lưu riêng, không nằm trong state) ----------------
const IMG_DIR = path.join(path.dirname(DATA_FILE), 'images');
const IMG_ID_RE = /^[a-f0-9]{24}$/;
const IMG_TYPES = { 'image/jpeg': 1, 'image/png': 1, 'image/webp': 1, 'image/gif': 1 };

async function putImage(id, mime, buf) {
  if (pool) {
    await pool.query('INSERT INTO images (id, mime, data) VALUES ($1, $2, $3)', [id, mime, buf]);
  } else {
    fs.mkdirSync(IMG_DIR, { recursive: true });
    fs.writeFileSync(path.join(IMG_DIR, id), buf);
    fs.writeFileSync(path.join(IMG_DIR, id + '.type'), mime);
  }
}

async function getImage(id) {
  if (pool) {
    const r = await pool.query('SELECT mime, data FROM images WHERE id = $1', [id]);
    return r.rows[0] || null;
  }
  try {
    return {
      data: fs.readFileSync(path.join(IMG_DIR, id)),
      mime: fs.readFileSync(path.join(IMG_DIR, id + '.type'), 'utf8'),
    };
  } catch {
    return null;
  }
}

async function deleteImages(ids) {
  if (!ids.length) return;
  try {
    if (pool) await pool.query('DELETE FROM images WHERE id = ANY($1)', [ids]);
    else for (const id of ids) for (const f of [id, id + '.type']) fs.rmSync(path.join(IMG_DIR, f), { force: true });
  } catch (e) {
    console.error('Lỗi xoá ảnh:', e.message);
  }
}

// ---------------- Lịch sử thay đổi (lưu riêng, giữ lâu dài) ----------------
const LOG_FILE = path.join(path.dirname(DATA_FILE), 'log.json');
const LOG_FILE_MAX = 50000; // giới hạn khi lưu bằng file
let logMem = [];
let logTimer = null;

async function initLog() {
  if (pool) {
    await pool.query(
      'CREATE TABLE IF NOT EXISTS logs (id TEXT PRIMARY KEY, at BIGINT NOT NULL, by_name TEXT NOT NULL, text TEXT NOT NULL)'
    );
    await pool.query('CREATE INDEX IF NOT EXISTS logs_at_idx ON logs (at)');
  } else {
    try {
      logMem = JSON.parse(fs.readFileSync(LOG_FILE, 'utf8'));
    } catch {
      logMem = [];
    }
  }
}

function saveLogFile() {
  clearTimeout(logTimer);
  logTimer = null;
  try {
    fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
    fs.writeFileSync(LOG_FILE + '.tmp', JSON.stringify(logMem));
    fs.renameSync(LOG_FILE + '.tmp', LOG_FILE);
  } catch (e) {
    console.error('Lỗi lưu lịch sử:', e.message);
  }
}

async function addLogs(entries) {
  if (!entries.length) return;
  if (pool) {
    for (const l of entries) {
      await pool.query('INSERT INTO logs (id, at, by_name, text) VALUES ($1, $2, $3, $4) ON CONFLICT (id) DO NOTHING', [
        l.id,
        l.at,
        l.by,
        l.text,
      ]);
    }
  } else {
    logMem.push(...entries);
    if (logMem.length > LOG_FILE_MAX) logMem.splice(0, logMem.length - LOG_FILE_MAX);
    clearTimeout(logTimer);
    logTimer = setTimeout(saveLogFile, 500);
  }
}

// Lấy lịch sử trong khoảng [from, to), mới nhất trước, kèm mốc ngày có thay đổi gần nhất trước/sau
async function queryLog(from, to) {
  if (pool) {
    const [items, prev, next] = await Promise.all([
      pool.query('SELECT id, at, by_name AS by, text FROM logs WHERE at >= $1 AND at < $2 ORDER BY at DESC LIMIT 2000', [from, to]),
      pool.query('SELECT max(at) AS at FROM logs WHERE at < $1', [from]),
      pool.query('SELECT min(at) AS at FROM logs WHERE at >= $1', [to]),
    ]);
    return {
      items: items.rows.map((r) => ({ ...r, at: Number(r.at) })),
      prevAt: prev.rows[0].at ? Number(prev.rows[0].at) : null,
      nextAt: next.rows[0].at ? Number(next.rows[0].at) : null,
    };
  }
  const items = logMem.filter((l) => l.at >= from && l.at < to).reverse();
  let prevAt = null;
  let nextAt = null;
  for (const l of logMem) {
    if (l.at < from && (prevAt === null || l.at > prevAt)) prevAt = l.at;
    if (l.at >= to && (nextAt === null || l.at < nextAt)) nextAt = l.at;
  }
  return { items, prevAt, nextAt };
}

async function countLogSince(since) {
  if (pool) {
    const r = await pool.query('SELECT count(*)::int AS n FROM logs WHERE at > $1', [since]);
    return r.rows[0].n;
  }
  return logMem.filter((l) => l.at > since).length;
}

let state;
let saveTimer = null;
let saving = Promise.resolve();

function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(flushSave, 400);
}

function flushSave() {
  clearTimeout(saveTimer);
  saveTimer = null;
  const json = JSON.stringify(state);
  saving = saving.then(() => writeState(json)).catch((e) => console.error('Lỗi lưu dữ liệu:', e.message));
  return saving;
}

// ---------------- Kiểm tra dữ liệu gửi lên ----------------
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const ID_RE = /^[A-Za-z0-9_-]{1,40}$/;
const COLOR_RE = /^#[0-9a-fA-F]{6}$/;
const SLOT_IDS = Shared.SLOTS.map((s) => s.id);

const str = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const newId = () => crypto.randomBytes(6).toString('hex');
const okId = (v) => (typeof v === 'string' && ID_RE.test(v) ? v : newId());
const hasMember = (id) => state.members.some((m) => m.id === id);
const hasStatus = (id) => state.statuses.some((s) => s.id === id);

// Trả về op đã làm sạch, hoặc null nếu không hợp lệ.
function normalize(op) {
  if (!op || typeof op !== 'object') return null;
  switch (op.type) {
    case 'setCells': {
      if (!Array.isArray(op.items) || op.items.length === 0 || op.items.length > 200) return null;
      const items = [];
      for (const it of op.items) {
        if (!it || !DATE_RE.test(it.date) || !SLOT_IDS.includes(it.slot) || !hasMember(it.memberId)) return null;
        const statusId = it.statusId ? String(it.statusId) : null;
        if (statusId && !hasStatus(statusId)) return null;
        items.push({ date: it.date, slot: it.slot, memberId: it.memberId, statusId });
      }
      return { type: 'setCells', items };
    }
    case 'addMember': {
      const name = str(op.name, 40);
      if (!name || state.members.length >= 30) return null;
      let id = okId(op.id);
      if (hasMember(id)) id = newId();
      return { type: 'addMember', id, name };
    }
    case 'renameMember': {
      const name = str(op.name, 40);
      if (!name || !hasMember(op.id)) return null;
      return { type: 'renameMember', id: op.id, name };
    }
    case 'removeMember':
      return hasMember(op.id) ? { type: 'removeMember', id: op.id } : null;
    case 'moveMember':
      return hasMember(op.id) && (op.dir === 1 || op.dir === -1) ? { type: 'moveMember', id: op.id, dir: op.dir } : null;
    case 'addStatus': {
      const label = str(op.label, 30);
      if (!label || state.statuses.length >= 20) return null;
      let id = okId(op.id);
      if (hasStatus(id)) id = newId();
      return { type: 'addStatus', id, label, color: COLOR_RE.test(op.color) ? op.color : '#7a7a7a', free: !!op.free };
    }
    case 'updateStatus': {
      if (!hasStatus(op.id)) return null;
      const out = { type: 'updateStatus', id: op.id };
      if (op.label !== undefined) {
        out.label = str(op.label, 30);
        if (!out.label) return null;
      }
      if (op.color !== undefined) {
        if (!COLOR_RE.test(op.color)) return null;
        out.color = op.color;
      }
      if (op.free !== undefined) out.free = !!op.free;
      return out;
    }
    case 'removeStatus':
      return hasStatus(op.id) ? { type: 'removeStatus', id: op.id } : null;
    case 'addMemory': {
      const text = str(op.text, 2000);
      const images = Array.isArray(op.images) ? op.images.filter((x) => IMG_ID_RE.test(x)).slice(0, 10) : [];
      if ((!text && !images.length) || !DATE_RE.test(op.date)) return null;
      return {
        type: 'addMemory',
        date: op.date,
        id: okId(op.id),
        author: str(op.author, 40) || 'Ẩn danh',
        text,
        images,
        createdAt: Date.now(),
      };
    }
    case 'deleteMemory':
      return DATE_RE.test(op.date) && typeof op.id === 'string' ? { type: 'deleteMemory', date: op.date, id: op.id } : null;
  }
  return null;
}

// ---------------- Server ----------------
async function main() {
  state = (await loadState()) || Shared.defaultState();
  const def = Shared.defaultState();
  for (const k of Object.keys(def)) if (state[k] === undefined) state[k] = def[k];
  // Đổi tên cũ "Không rảnh" -> "Bận rùi" cho dữ liệu đã lưu từ trước
  const RENAME = { 'Không rảnh': 'Bận rùi', 'Bận': 'Bận rùi', 'Quê (Không rảnh)': 'Quê (Bận rùi)', 'Quê (Bận)': 'Quê (Bận rùi)' };
  for (const s of state.statuses) if (RENAME[s.label]) s.label = RENAME[s.label];

  // Lịch sử trước đây nằm trong state (tối đa 300 mục) -> chuyển sang nơi lưu riêng
  await initLog();
  if (Array.isArray(state.log)) {
    await addLogs(state.log);
    delete state.log;
    scheduleSave();
  }

  const app = express();
  const server = http.createServer(app);
  const io = new Server(server, { maxHttpBufferSize: 1e6 });

  app.use(express.static(path.join(__dirname, 'public')));
  app.get('/healthz', (_req, res) => res.send('ok'));

  // Tải ảnh lên: body là file ảnh (đã được trình duyệt thu nhỏ), trả về { id }
  app.post('/api/upload', express.raw({ type: Object.keys(IMG_TYPES), limit: '8mb' }), async (req, res) => {
    const mime = (req.headers['content-type'] || '').split(';')[0];
    if (!IMG_TYPES[mime] || !Buffer.isBuffer(req.body) || !req.body.length) {
      return res.status(400).json({ error: 'Ảnh không hợp lệ' });
    }
    try {
      const id = crypto.randomBytes(12).toString('hex');
      await putImage(id, mime, req.body);
      res.json({ id });
    } catch (e) {
      console.error('Lỗi lưu ảnh:', e.message);
      res.status(500).json({ error: 'Không lưu được ảnh' });
    }
  });
  app.use('/api/upload', (err, _req, res, _next) => res.status(413).json({ error: err.message || 'Ảnh quá lớn' }));

  app.get('/img/:id', async (req, res) => {
    if (!IMG_ID_RE.test(req.params.id)) return res.sendStatus(404);
    const img = await getImage(req.params.id).catch(() => null);
    if (!img) return res.sendStatus(404);
    res.setHeader('Content-Type', img.mime);
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    res.send(img.data);
  });
  // Lịch sử theo khoảng thời gian (trình duyệt tự tính đầu/cuối ngày theo giờ máy)
  app.get('/api/log', async (req, res) => {
    const from = Number(req.query.from);
    const to = Number(req.query.to);
    if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from || to - from > 8 * 86400000) {
      return res.status(400).json({ error: 'Khoảng thời gian không hợp lệ' });
    }
    try {
      res.json(await queryLog(from, to));
    } catch (e) {
      console.error('Lỗi đọc lịch sử:', e.message);
      res.status(500).json({ error: 'Không đọc được lịch sử' });
    }
  });
  app.get('/api/log/count', async (req, res) => {
    const since = Number(req.query.since) || 0;
    try {
      res.json({ count: await countLogSince(since) });
    } catch {
      res.json({ count: 0 });
    }
  });

  app.get('/api/export', (_req, res) => {
    res.setHeader('Content-Disposition', 'attachment; filename="lich-nhom-backup.json"');
    res.json(state);
  });

  const broadcastPresence = () => io.emit('presence', io.engine.clientsCount);

  io.on('connection', (socket) => {
    socket.emit('state', state);
    broadcastPresence();

    socket.on('op', (raw) => {
      const op = normalize(raw);
      if (!op) {
        socket.emit('state', state); // đồng bộ lại cho máy gửi sai
        return;
      }
      op.log = { id: newId(), at: Date.now(), by: str(raw.by, 40) || 'Ai đó', text: Shared.describe(state, op) };
      let orphanImages = [];
      if (op.type === 'deleteMemory') {
        const mem = (state.memories[op.date] || []).find((m) => m.id === op.id);
        if (!mem) return;
        orphanImages = mem.images || [];
      }
      Shared.apply(state, op);
      deleteImages(orphanImages);
      addLogs([op.log]).catch((e) => console.error('Lỗi ghi lịch sử:', e.message));
      io.emit('op', op);
      scheduleSave();
    });

    socket.on('disconnect', broadcastPresence);
  });

  const shutdown = async () => {
    await flushSave();
    if (!pool && logTimer) saveLogFile();
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);

  server.listen(PORT, () => console.log(`Lịch nhóm đang chạy: http://localhost:${PORT}`));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
