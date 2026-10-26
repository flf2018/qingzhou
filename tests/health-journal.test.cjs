const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { HealthJournal } = require("../electron/health-journal.cjs");

test("health journal persists checks in order, excludes node configs and rotates", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "qingzhou-journal-"));
    try {
        const journal = new HealthJournal(directory, 600);
        await Promise.all(Array.from({ length: 12 }, (_, checkedAt) =>
            journal.record({ phase: "degraded", checkedAt, error: "probe timeout",
                config: { password: "must-not-be-written" } })));
        const current = await fs.readFile(journal.file, "utf8");
        const previous = await fs.readFile(journal.file + ".1", "utf8");
        assert.ok(Buffer.byteLength(current) <= 600);
        assert.ok(Buffer.byteLength(previous) <= 600);
        assert.equal((previous + current).includes("must-not-be-written"), false);
        const rows = (previous + current).trim().split("\n").map(line => JSON.parse(line));
        assert.equal(rows.at(-1).checkedAt, 11);
        for (let i = 1; i < rows.length; i++)
            assert.equal(rows[i].checkedAt, rows[i - 1].checkedAt + 1);
    } finally {
        await fs.rm(directory, { recursive: true, force: true });
    }
});
