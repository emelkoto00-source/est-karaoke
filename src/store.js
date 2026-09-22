import fs from 'node:fs/promises';
import path from 'node:path';

export class JsonStore {
  constructor(file) {
    this.file = file;
    this.state = { jobs: [], library: [], nextSongNumber: 100001 };
    this.writeChain = Promise.resolve();
  }

  async load() {
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    try {
      const raw = await fs.readFile(this.file, 'utf8');
      const parsed = JSON.parse(raw);
      this.state.jobs = Array.isArray(parsed.jobs) ? parsed.jobs : [];
      this.state.library = Array.isArray(parsed.library) ? parsed.library : [];
      const next = Number(parsed.nextSongNumber);
      this.state.nextSongNumber = Number.isInteger(next) && next > 0 ? next : this.computeNextSongNumber();
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
      await this.save();
    }
    return this.state;
  }

  computeNextSongNumber() {
    let highest = 100000;
    for (const song of this.state.library) {
      const n = Number(song.number ?? song.Number);
      if (Number.isInteger(n) && n > highest) highest = n;
    }
    return highest + 1;
  }

  allocateSongNumber() {
    const value = String(this.state.nextSongNumber || this.computeNextSongNumber());
    this.state.nextSongNumber = Number(value) + 1;
    return value;
  }

  save() {
    this.writeChain = this.writeChain.then(async () => {
      const tmp = `${this.file}.tmp`;
      await fs.writeFile(tmp, JSON.stringify(this.state, null, 2));
      await fs.rename(tmp, this.file);
    });
    return this.writeChain;
  }
}
