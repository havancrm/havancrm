// Server-side record store with last-write-wins merge and a monotonic change sequence.
import fs from 'node:fs';
import path from 'node:path';

export const COLLECTIONS = ['customers', 'orders'];

export function emptyState() {
  return { seq: 0, customers: {}, orders: {} };
}

// Merge incoming client changes into state. A record wins if it is new or its
// updatedAt is newer than (or equal to) the stored one. Returns accepted count.
export function applyChanges(state, changes = {}) {
  let accepted = 0;
  for (const col of COLLECTIONS) {
    for (const rec of changes[col] || []) {
      if (!rec || typeof rec.id !== 'string' || typeof rec.updatedAt !== 'number') continue;
      const cur = state[col][rec.id];
      if (cur && cur.updatedAt > rec.updatedAt) continue;
      state.seq += 1;
      state[col][rec.id] = { ...rec, _seq: state.seq };
      accepted += 1;
    }
  }
  return accepted;
}

// All records changed after the given sequence number.
export function changesSince(state, since = 0) {
  const out = {};
  for (const col of COLLECTIONS) {
    out[col] = Object.values(state[col])
      .filter((r) => r._seq > since)
      .map(({ _seq, ...r }) => r);
  }
  return out;
}

export class FileStore {
  constructor(dir) {
    this.dir = dir;
    this.file = path.join(dir, 'db.json');
    this.backupDir = path.join(dir, 'backups');
    fs.mkdirSync(this.backupDir, { recursive: true });
    this.state = fs.existsSync(this.file)
      ? JSON.parse(fs.readFileSync(this.file, 'utf8'))
      : emptyState();
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
