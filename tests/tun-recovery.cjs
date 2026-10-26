// Exercise the real main-process IPC flow, replacing privileged OS operations.
const { app } = require("electron");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
app.disableHardwareAcceleration();
const directory = fs.mkdtempSync(path.join(os.tmpdir(), "chenglian-recovery-"));
app.setPath("userData", directory);
let activeTun, healthJournal, monitor, simulatedOffline = false, coreStarts = 0, osOffline = true, networkChecks = 0;
const config = {
    inbounds: [{ protocol: "http", listen: "127.0.0.1", port: 10808 }],
    outbounds: [{ protocol: "freedom" }],
};
fs.writeFileSync(
    path.join(directory, "profiles.json"),
    JSON.stringify({
        profiles: [
            {
                id: "test",
                name: "recovery",
                kind: "Xray",
                config,
                host: "127.0.0.1",
                port: 10808,
            },
        ],
        selectedId: "test",
        binaries: {},
        systemProxy: true,
        tunEnabled: true,
    }),
);
function replace(module, update) {
    const name = require.resolve(module);
    const original = require(name);
    require.cache[name].exports = { ...original, ...update };
}
const { ConnectionRecovery } = require("../electron/recovery.cjs");
const { HealthJournal } = require("../electron/health-journal.cjs");
replace("../electron/health-journal.cjs", {
    HealthJournal: class extends HealthJournal {
        constructor(...args) { super(...args); healthJournal = this; }
    },
});
replace("../electron/recovery.cjs", {
    ConnectionRecovery: class extends ConnectionRecovery {
        constructor(options) {
            super({ ...options, probe: async (session) => {
                if (simulatedOffline) throw Error("Simulated idle connection failure");
                await options.probe(session);
            } });
            monitor = this;
        }
    },
});
replace("../electron/core.cjs", {
    CoreController: class {
        constructor(_dir, changed) {
            this.changed = changed;
            this.child = null;
            this.state = { phase: "stopped" };
        }
        async start(profile) {
            coreStarts++;
            this.child = {};
            this.state = { phase: "running", profileId: profile.id };
            this.changed(this.state);
        }
        async stop() {
            this.child = null;
            this.state = { phase: "stopped" };
            this.changed(this.state);
        }
    },
});
replace("../electron/proxy.cjs", {
    SystemProxy: class {
        constructor() {
            this.active = false;
        }
        async restore() {
            this.active = false;
        }
        async enable() {
            this.active = true;
        }
    },
});
replace("../electron/tun.cjs", {
    isAdministrator: async () => true,
    physicalNetwork: async () => {
        networkChecks++;
        return { interfaceName: "fixture", dns: "192.0.2.53" };
    },
    TunController: class {
        constructor(_dir, _host, changed) {
            activeTun = this;
            this.changed = changed;
            this.child = null;
            this.phase = "stopped";
        }
        get active() {
            return this.phase === "running";
        }
        update(phase) {
            this.phase = phase;
            this.changed(phase);
        }
        async start() {
            this.child = {};
            this.update("checking");
        }
        async stop() {
            this.child = null;
            this.update("stopped");
        }
    },
});
replace("../electron/measure.cjs", { transfer: async () => ({ status: 204 }) });
replace("../electron/connectivity.cjs", {
    systemProbe: async () => {
        if (osOffline) throw Error("Simulated OS network failure");
    },
});
const timer = setTimeout(() => app.exit(1), 15000);
app.on("browser-window-created", (_event, window) =>
    window.webContents.once("did-finish-load", async () => {
        try {
            const result = await window.webContents.executeJavaScript(
                `(async()=>{const start=await window.desktop.start('test'); const after=await window.desktop.snapshot();return {start,after};})()`,
            );
            assert.equal(result.start.ok, false);
            assert.match(result.start.error, /回退到系统代理/);
            assert.equal(result.after.data.tunEnabled, false);
            assert.equal(result.after.data.tunActive, false);
            assert.equal(result.after.data.core.phase, "running");
            assert.equal(result.after.data.proxyActive, true);
            assert.ok(monitor.session);
            const initialStarts = coreStarts;
            simulatedOffline = true;
            await monitor.check();
            assert.equal(coreStarts, initialStarts);
            await monitor.check();
            assert.equal(coreStarts, initialStarts + 1);
            simulatedOffline = false;
            await monitor.check();
            const recovered = await window.webContents.executeJavaScript("window.desktop.snapshot()");
            assert.equal(recovered.data.core.phase, "running");
            assert.equal(recovered.data.proxyActive, true);
            const off = await window.webContents.executeJavaScript("window.desktop.setTun(false)");
            assert.equal(off.ok, true);
            assert.equal(off.data.core.phase, "stopped");
            assert.equal(off.data.proxyActive, false);
            assert.equal(monitor.session, null);
            await monitor.check();
            assert.equal(coreStarts, initialStarts + 1);
            // Exercise a live TUN session recovering after idle failure too.
            osOffline = false;
            await window.webContents.executeJavaScript("window.desktop.setTun(true)");
            const tunStart = await window.webContents.executeJavaScript("window.desktop.start('test')");
            assert.equal(tunStart.ok, true);
            const beforeTunRecovery = coreStarts, beforeNetworkChecks = networkChecks;
            simulatedOffline = true;
            await monitor.check();
            await monitor.check();
            simulatedOffline = false;
            await monitor.check();
            const tunRecovered = await window.webContents.executeJavaScript("window.desktop.snapshot()");
            assert.equal(tunRecovered.data.tunActive, true);
            assert.equal(tunRecovered.data.tunEnabled, true);
            assert.equal(coreStarts, beforeTunRecovery + 1);
            assert.equal(networkChecks, beforeNetworkChecks + 1);
            // A failed automatic TUN check must not silently save TUN=false.
            simulatedOffline = true;
            osOffline = true;
            monitor.session.retryAt = 0;
            await monitor.check();
            await monitor.check();
            const failedRetry = await window.webContents.executeJavaScript("window.desktop.snapshot()");
            assert.equal(failedRetry.data.tunEnabled, true);
            assert.equal(failedRetry.data.proxyActive, false);
            assert.equal(failedRetry.data.connectionHealth.phase, "degraded");
            assert.ok(monitor.session);
            osOffline = false;
            simulatedOffline = false;
            monitor.session.retryAt = 0;
            await monitor.check();
            assert.equal(activeTun.active, true);
            // An unexpected TUN exit must clean up without cancelling user intent.
            activeTun.child = null;
            activeTun.update("stopped");
            await new Promise(resolve => setTimeout(resolve, 30));
            assert.ok(monitor.session, "Unexpected TUN exit cancelled automatic recovery");
            monitor.session.retryAt = 0;
            await monitor.check();
            await monitor.check();
            const restarted = await window.webContents.executeJavaScript("window.desktop.snapshot()");
            assert.equal(restarted.data.tunActive, true);
            await window.webContents.executeJavaScript("window.desktop.stop()");
            assert.equal(monitor.session, null);
            await healthJournal.pending;
            const journal = fs.readFileSync(path.join(directory, "connection-health.jsonl"), "utf8");
            assert.ok(journal.includes('"phase":"degraded"'));
            console.log(
                "TUN failure rolls back to system proxy; node-page switch can stop an active connection. No OS settings changed.",
            );
            clearTimeout(timer);
            app.quit();
        } catch (error) {
            console.error(error);
            clearTimeout(timer);
            app.exit(1);
        }
    }),
);
require("../electron/main.cjs");
