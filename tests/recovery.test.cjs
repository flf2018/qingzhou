const test = require("node:test");
const assert = require("node:assert/strict");
const { ConnectionRecovery } = require("../electron/recovery.cjs");
function fixture(options = {}) {
    let time = 0, reconnects = 0, wait;
    const monitor = new ConnectionRecovery({
        probe: async () => { throw Error("offline"); },
        reconnect: async () => { reconnects++; }, busy: () => false, log: () => {},
        now: () => time, schedule: (_callback, delay) => { wait = delay; }, cancel: () => {},
        ...options,
    });
    monitor.start({ id: "node", port: 10808 });
    return { monitor, advance: (ms) => { time += ms; },
        reconnects: () => reconnects, wait: () => wait };
}
test("recovery requires repeated failures and backs off failed reconnects", async () => {
    let attempts = 0;
    const f = fixture({ reconnect: async () => { attempts++; throw Error("offline"); } });
    await f.monitor.check();
    assert.equal(attempts, 0);
    await f.monitor.check();
    assert.equal(attempts, 1);
    await f.monitor.check();
    assert.equal(attempts, 1);
    f.advance(180000);
    await f.monitor.check();
    assert.equal(attempts, 2);
});
test("healthy traffic clears intermittent failures", async () => {
    let healthy = false;
    const f = fixture({ probe: async () => { if (!healthy) throw Error(); } });
    await f.monitor.check();
    healthy = true;
    await f.monitor.check();
    healthy = false;
    await f.monitor.check();
    assert.equal(f.reconnects(), 0);
    await f.monitor.check();
    assert.equal(f.reconnects(), 1);
});
test("stop or node switch during an in-flight probe cannot reconnect stale node", async () => {
    for (const switchNode of [false, true]) {
        let rejectProbe;
        const f = fixture({ probe: () => new Promise((_resolve, reject) => { rejectProbe = reject; }) });
        f.monitor.session.failures = 1;
        const check = f.monitor.check();
        f.monitor.stop();
        if (switchNode) f.monitor.start({ id: "other" });
        rejectProbe(Error("old failure"));
        await check;
        assert.equal(f.reconnects(), 0);
        assert.equal(f.monitor.session?.id, switchNode ? "other" : undefined);
    }
});
test("background checks are single-flight and resume schedules a prompt check", async () => {
    let resolveProbe, probes = 0;
    const f = fixture({ probe: () => { probes++; return new Promise((resolve) => { resolveProbe = resolve; }); } });
    const first = f.monitor.check();
    await f.monitor.check();
    assert.equal(probes, 1);
    resolveProbe();
    await first;
    f.monitor.resume();
    assert.equal(f.wait(), 5000);
    f.monitor.stop();
    f.monitor.resume();
    assert.equal(f.monitor.session, null);
});
test("connection transitions and sleep defer checks without accumulating failures", async () => {
    let probes = 0;
    const f = fixture({ busy: () => true, probe: async () => { probes++; throw Error(); } });
    await f.monitor.check();
    assert.equal(probes, 0);
    assert.equal(f.monitor.session.failures, 0);
});

test("failed probes and reconnects stay degraded until a real successful probe", async () => {
    const states = [];
    const f = fixture({ changed: state => states.push(state),
        reconnect: async () => { throw Error("node unavailable"); } });
    await f.monitor.check();
    assert.equal(f.monitor.state.phase, "degraded");
    assert.equal(f.monitor.state.error, "offline");
    await f.monitor.check();
    assert.ok(states.some(state => state.phase === "reconnecting"));
    assert.equal(f.monitor.state.phase, "degraded");
    assert.equal(f.monitor.state.error, "node unavailable");
    f.monitor.probe = async () => {};
    await f.monitor.check();
    assert.equal(f.monitor.state.phase, "healthy");
    assert.equal(f.monitor.state.error, null);
});

test("unexpected exit keeps the session and schedules recovery; manual stop cancels it", async () => {
    const f = fixture();
    f.monitor.interrupted("TUN exited");
    assert.equal(f.wait(), 5000);
    assert.equal(f.monitor.state.phase, "degraded");
    await f.monitor.check();
    assert.equal(f.reconnects(), 1);
    f.monitor.stop();
    f.monitor.interrupted("late exit");
    await f.monitor.check();
    assert.equal(f.reconnects(), 1);
    assert.equal(f.monitor.state.phase, "stopped");
});

test("domain path failure gets a fast confirmation and a successful probe clears old cooldown", async () => {
    let healthy = false;
    const f = fixture({ probe: async () => {
        if (!healthy) throw Error("ChatGPT certificate mismatch");
    } });
    assert.equal(f.wait(), 5000);
    await f.monitor.check();
    assert.equal(f.wait(), 5000);
    await f.monitor.check();
    assert.equal(f.reconnects(), 1);
    healthy = true;
    f.monitor.session.retryAt = 180000;
    await f.monitor.check();
    assert.equal(f.wait(), 30000);
    healthy = false;
    await f.monitor.check();
    await f.monitor.check();
    assert.equal(f.reconnects(), 2);
});
