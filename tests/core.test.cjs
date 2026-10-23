const { test } = require("node:test");
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const { once } = require("node:events");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const { CoreController } = require("../electron/core.cjs");

async function setup(t, runner) {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "v2rayn-core-"));
    const updates = [],
        logs = [];
    const core = new CoreController(
        directory,
        (state) => updates.push(state),
        (message) => logs.push(message),
        runner,
        async () => {},
    );
    t.after(async () => {
        await core.stop();
        await fs.rm(directory, { recursive: true, force: true });
    });
    return { core, directory, updates, logs };
}
const profile = {
    id: "test",
    kind: "Xray",
    config: { inbounds: [], outbounds: [] },
};
test("启动真实子进程，保留参数边界，写配置并在停止时清理状态", async (t) => {
    let captured;
    const { core, directory, logs } = await setup(
        t,
        (binary, args, options) => {
            captured = { binary, args, options };
            return spawn(
                process.execPath,
                [
                    "-e",
                    "console.log('core-ready'); setInterval(() => {}, 1000)",
                ],
                options,
            );
        },
    );
    await core.start(profile, process.execPath);
    assert.equal(core.state.phase, "running");
    assert.deepEqual(captured.args, [
        "run",
        "-config",
        path.join(directory, "active-config.json"),
    ]);
    assert.equal(captured.options.shell, undefined);
    assert.deepEqual(
        JSON.parse(
            await fs.readFile(
                path.join(directory, "active-config.json"),
                "utf8",
            ),
        ),
        profile.config,
    );
    const stream = core.child.stdout;
    await once(stream, "data");
    assert.ok(logs.some((message) => message.includes("core-ready")));
    await core.stop();
    assert.equal(core.child, null);
    assert.equal(core.state.phase, "stopped");
});
test("不存在的内核不能报告为运行中", async (t) => {
    const { core, directory } = await setup(t);
    await assert.rejects(() =>
        core.start(profile, path.join(directory, "missing-core")),
    );
    assert.equal(core.child, null);
    assert.equal(core.state.phase, "stopped");
});
test("配置预检失败时不启动内核进程", async (t) => {
    const { directory } = await setup(t);
    let spawned = false;
    const core = new CoreController(
        directory,
        () => {},
        () => {},
        () => {
            spawned = true;
        },
        async () => {
            throw new Error("fixture config rejected");
        },
    );
    await assert.rejects(
        () => core.start(profile, process.execPath),
        /fixture config rejected/,
    );
    assert.equal(spawned, false);
    assert.equal(core.child, null);
    assert.equal(core.state.phase, "stopped");
});
test("内核自行退出会恢复停止状态；sing-box 使用正确参数", async (t) => {
    let captured;
    const { core } = await setup(t, (_binary, args, options) => {
        captured = args;
        return spawn(process.execPath, ["-e", "process.exit(2)"], options);
    });
    await core.start({ ...profile, kind: "sing-box" }, process.execPath);
    assert.equal(captured[1], "-c");
    if (core.child) await once(core.child, "exit");
    assert.equal(core.state.phase, "stopped");
    assert.equal(core.child, null);
});
