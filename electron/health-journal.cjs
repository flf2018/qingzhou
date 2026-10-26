const fs = require("node:fs/promises");
const path = require("node:path");

// Persist connection checks, not raw core output or imported node credentials.
class HealthJournal {
    constructor(directory, maxBytes = 1024 * 1024) {
        this.file = path.join(directory, "connection-health.jsonl");
        this.maxBytes = maxBytes;
        this.pending = Promise.resolve();
    }
    record({ phase, checkedAt, error }) {
        const line = JSON.stringify({
            time: new Date().toISOString(), phase, checkedAt,
            error: error ? String(error).slice(0, 1500) : null,
        }) + "\n";
        const write = async () => {
            await fs.mkdir(path.dirname(this.file), { recursive: true });
            const size = await fs.stat(this.file).then(s => s.size, e => {
                if (e.code === "ENOENT") return 0;
                throw e;
            });
            if (size + Buffer.byteLength(line) > this.maxBytes && size) {
                await fs.rm(this.file + ".1", { force: true });
                await fs.rename(this.file, this.file + ".1");
            }
            await fs.appendFile(this.file, line, { mode: 0o600 });
        };
        this.pending = this.pending.catch(() => {}).then(write);
        return this.pending;
    }
}
module.exports = { HealthJournal };
