// Server-side record store with per-operation acknowledgement, revision conflict checks
// and a monotonic change sequence.
import fs from 'node:fs';
import path from 'node:path';

export const COLLECTIONS = ['customers', 'orders', 'leads', 'tasks', 'activities', 'products'];

export function emptyState() {
  const state = { seq: 0 };
  for (const col of COLLECTIONS) state[col] = {};
  return state;
}

// Apply client operations. Each record carries:
//  - opId: identifies the operation; seeing the same opId again means it was already applied (safe retry)
//  - revision / baseRevision: the client saw baseRevision; if the stored revision is newer, the
//    change is a conflict and the current cloud record is returned instead of being written.
// Records without baseRevision (older clients) fall back to last-write-wins on updatedAt.
// Fills `result.acceptedIds` (opIds per collection) and `result.conflicts`. Returns the accepted count.
export function applyChanges(state, changes = {}, result = {}) {
  let accepted = 0;
  result.acceptedIds ??= {};
  result.conflicts ??= {};
  for (const col of COLLECTIONS) {
    for (const rec of changes[col] || []) {
      if (!rec || typeof rec.id !== 'string' || typeof rec.updatedAt !== 'number') continue;
      const cur = state[col][rec.id];
      const ack = () => { if (rec.opId) (result.acceptedIds[col] ??= []).push(rec.opId); };
      if (cur && rec.opId && cur.opId === rec.opId) { ack(); continue; }
      if (cur && rec.baseRevision !== undefined && (cur.revision || 0) > rec.baseRevision) {
        (result.conflicts[col] ??= []).push({ opId: rec.opId, id: rec.id, current: withoutSeq(cur) });
        continue;
      }
      if (cur && rec.baseRevision === undefined && cur.updatedAt > rec.updatedAt) continue;
      state.seq += 1;
      const { baseRevision, ...stored } = rec;
      state[col][rec.id] = { ...stored, _seq: state.seq };
      accepted += 1;
      ack();
    }
  }
  return accepted;
}

const withoutSeq = ({ _seq, ...r }) => r;

// All records changed after the given sequence number.
export function changesSince(state, since = 0) {
  const out = {};
  for (const col of COLLECTIONS) {
    out[col] = Object.values(state[col] || {})
      .filter((r) => r._seq > since)
      .map(withoutSeq);
  }
  return out;
}

export class FileStore {
  constructor(dir) {
    this.dir = dir;
    this.file = path.join(dir, 'db.json');
    this.backupDir = path.join(dir, 'backups');
    fs.mkdirSync(this.backupDir, { recursive: true });
    const saved = fs.existsSync(this.file) ? JSON.parse(fs.readFileSync(this.file, 'utf8')) : {};
    this.state = { ...emptyState(), ...saved };
    this.writing = Promise.resolve();
  }

  save() {
    const data = JSON.stringify(this.state);
    // Serialize writes; write to a temp file then rename so the file is never half-written.
    this.writing = this.writing.then(async () => {
      const tmp = this.file + '.tmp';
      await fs.promises.writeFile(tmp, data);
      await fs.promises.rename(tmp, this.file);
    });
    return this.writing;
  }

  // Keep one snapshot per day, pruning anything beyond `keep` days.
  async backup(keep = 30) {
    const day = new Date().toISOString().slice(0, 10);
    const target = path.join(this.backupDir, `db-${day}.json`);
    await fs.promises.writeFile(target, JSON.stringify(this.state));
    const files = (await fs.promises.readdir(this.backupDir)).filter((f) => f.endsWith('.json')).sort();
    for (const f of files.slice(0, Math.max(0, files.length - keep))) {
      await fs.promises.unlink(path.join(this.backupDir, f));
    }
    return target;
  }
}
