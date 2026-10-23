// Runs in the main process even when the window is hidden in the tray.
class ConnectionRecovery {
    constructor({ probe, reconnect, busy, log, now = Date.now, interval = 60000,
        cooldown = 180000, schedule = setTimeout, cancel = clearTimeout }) {
        Object.assign(this, { probe, reconnect, busy, log, now, interval,
            cooldown, schedule, cancel });
        this.session = null;
        this.checking = false;
    }
    start(session) {
        this.stop();
        this.session = { ...session, failures: 0, retryAt: 0 };
        this.arm(this.interval);
    }
    stop() {
        this.session = null;
        this.cancel(this.timer);
        this.timer = null;
    }
    arm(wait) {
        this.cancel(this.timer);
        this.timer = this.schedule(() => { void this.check(); }, wait);
        this.timer?.unref?.();
    }
    resume() {
        if (this.session) this.arm(5000);
    }
    async check() {
        const session = this.session;
        if (!session) return;
        if (this.checking || this.busy()) {
            this.arm(this.interval);
            return;
        }
        this.checking = true;
        try {
            await this.probe(session);
            if (this.session === session) session.failures = 0;
        } catch {
            // Old probes must never reconnect after a user stop/node switch.
            if (this.session !== session || this.busy()) return;
            session.failures++;
            if (session.failures < 2 || this.now() < session.retryAt) return;
            session.retryAt = this.now() + this.cooldown;
            this.log("代理通路连续检测失败，正在重新连接当前节点。");
            try {
                await this.reconnect(session);
                if (this.session === session) {
                    session.failures = 0;
                    this.log("当前节点已重新连接并通过联网检查。");
                }
            } catch (error) {
                if (this.session === session)
                    this.log(`自动重连失败，稍后重试：${error.message}`);
            }
        } finally {
            this.checking = false;
            if (this.session) this.arm(this.interval);
        }
    }
}
function prepareHealthProfile(profile, port) {
    const prepared = structuredClone(profile);
    prepared.config.inbounds.push(profile.kind === "Xray"
        ? { tag: "chenglian-health", protocol: "http", listen: "127.0.0.1", port }
        : { tag: "chenglian-health", type: "http", listen: "127.0.0.1", listen_port: port });
    return prepared;
}
module.exports = { ConnectionRecovery, prepareHealthProfile };
