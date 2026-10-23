const { spawn, execFile } = require("node:child_process");
const { promisify } = require("node:util");
const { normalizeXrayConfig } = require("./xray-compat.cjs");
const execute = promisify(execFile);
async function validateCore(binary, kind, configPath) {
    try {
        await execute(
            binary,
            kind === "Xray"
                ? ["run", "-test", "-config", configPath]
                : ["check", "-c", configPath],
            { windowsHide: true, timeout: 15000, maxBuffer: 1024 * 1024 },
        );
    } catch (error) {
        throw new Error(
            `内核配置检查失败：${(error.stderr || error.stdout || error.message).trim().slice(-5000)}`,
        );
    }
}
const fs = require("node:fs/promises");
const path = require("node:path");
const net = require("node:net");
const { setTimeout: delay } = require("node:timers/promises");

async function waitForListener(child, profile) {
    if (!profile.port) return; // Test process fixtures may omit a proxy listener.
    for (let i = 0; i < 100; i++) {
        if (child.exitCode !== null || child.signalCode)
            throw new Error("内核启动后退出，请查看运行日志。");
        const ready = await new Promise((resolve) => {
            const socket = net.connect({
                host: profile.host || "127.0.0.1",
                port: profile.port,
            });
            socket.setTimeout(150);
            socket.once("connect", () => {
                socket.destroy();
                resolve(true);
            });
            socket.once("error", () => {
                socket.destroy();
                resolve(false);
            });
            socket.once("timeout", () => {
                socket.destroy();
                resolve(false);
            });
        });
        if (ready) return;
        await delay(50);
    }
    throw new Error("内核没有打开本地代理端口，请检查配置和端口占用。");
}
async function checkPorts(profile) {
    if (!profile.config?.inbounds) return;
    for (const inbound of profile.config.inbounds) {
        const port = inbound.port || inbound.listen_port;
        if (
            !Number.isInteger(port) ||
            !["127.0.0.1", "::1", "localhost"].includes(inbound.listen)
        )
            continue;
        await new Promise((resolve, reject) => {
            const server = net.createServer();
            server.once("error", () =>
                reject(
                    new Error(
                        `本地端口 ${port} 已被占用，请停止其他占用此端口的代理客户端。`,
                    ),
                ),
            );
            server.listen(port, inbound.listen, () => server.close(resolve));
        });
    }
}

class CoreController {
    constructor(
        directory,
        changed,
        log,
        spawnProcess = spawn,
        validate = validateCore,
    ) {
        this.directory = directory;
        this.changed = changed;
        this.log = log;
        this.spawnProcess = spawnProcess;
        this.validate = validate;
        this.child = null;
        this.state = { phase: "stopped", profileId: null, startedAt: null };
        this.busy = false;
    }
    update(state) {
        this.state = state;
        this.changed(state);
    }
    async start(profile, binary) {
        if (this.busy) throw new Error("内核正在切换，请稍候。");
        this.busy = true;
        try {
            await this.stop();
            await fs.access(binary);
            await checkPorts(profile);
            await fs.mkdir(this.directory, { recursive: true });
            const configPath = path.join(this.directory, "active-config.json");
            const runtime =
                profile.kind === "Xray"
                    ? normalizeXrayConfig(profile.config)
                    : { config: profile.config, migrated: 0 };
            await fs.writeFile(configPath, JSON.stringify(runtime.config), {
                mode: 0o600,
            });
            if (runtime.migrated)
                this.log(
                    `已自动兼容 ${runtime.migrated} 处旧版 mKCP 参数，原始节点配置未改动。`,
                );
            await this.validate(binary, profile.kind, configPath);
            const args =
                profile.kind === "sing-box"
                    ? ["run", "-c", configPath]
                    : ["run", "-config", configPath];
            this.update({
                phase: "starting",
                profileId: profile.id,
                startedAt: null,
            });
            const child = this.spawnProcess(binary, args, {
                cwd: path.dirname(binary),
                windowsHide: true,
                stdio: ["ignore", "pipe", "pipe"],
            });
            this.child = child;
            for (const stream of [child.stdout, child.stderr])
                stream?.on("data", (data) =>
                    this.log(data.toString().slice(0, 16000)),
                );
            child.on("exit", (code) => {
                if (this.child !== child) return;
                this.child = null;
                this.update({
                    phase: "stopped",
                    profileId: null,
                    startedAt: null,
                });
                this.log(`内核进程已退出（${code ?? "signal"}）。`);
            });
            child.on("error", (error) => {
                this.log(`启动失败：${error.message}`);
                if (this.child === child) {
                    this.child = null;
                    this.update({
                        phase: "stopped",
                        profileId: null,
                        startedAt: null,
                    });
                }
            });
            await new Promise((resolve, reject) => {
                child.once("spawn", resolve);
                child.once("error", reject);
            });
            await waitForListener(child, profile);
            if (this.child === child)
                this.update({
                    phase: "running",
                    profileId: profile.id,
                    startedAt: Date.now(),
                });
            // Running reports process liveness only, never implies network reachability.
        } catch (error) {
            await this.stop();
            throw error;
        } finally {
            this.busy = false;
        }
    }
    async stop() {
        const child = this.child;
        if (!child) return;
        await new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                cleanup();
                reject(new Error("内核进程未退出，请检查进程后重试。"));
            }, 5000);
            const done = () => {
                cleanup();
                resolve();
            };
            const cleanup = () => {
                clearTimeout(timer);
                child.removeListener("exit", done);
            };
            child.once("exit", done);
            child.kill();
        });
    }
}
module.exports = { CoreController };
