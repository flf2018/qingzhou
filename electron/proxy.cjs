const fs = require("node:fs/promises");
const path = require("node:path");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const execute = promisify(execFile);
async function windowsAdapter(request) {
    if (process.platform !== "win32")
        throw new Error("当前仅 Windows 支持自动设置系统代理。");
    const script = await fs.readFile(
        path.join(__dirname, "windows-proxy.ps1"),
        "utf8",
    );
    const powershell = path.join(
        process.env.SystemRoot || "C:\\Windows",
        "System32/WindowsPowerShell/v1.0/powershell.exe",
    );
    const { stdout } = await execute(
        powershell,
        [
            "-NoProfile",
            "-NonInteractive",
            "-EncodedCommand",
            Buffer.from(script, "utf16le").toString("base64"),
        ],
        {
            windowsHide: true,
            encoding: "utf8",
            timeout: 20000,
            env: {
                ...process.env,
                V2RAYN_PROXY_REQUEST: JSON.stringify(request),
            },
        },
    );
    return JSON.parse(stdout.replace(/^\uFEFF/, "").trim());
}
function value(data, kind = "String") {
    return { exists: true, value: data, kind };
}
function same(left, right) {
    return (
        Boolean(left?.exists) === Boolean(right?.exists) &&
        (!left?.exists ||
            (left.kind === right.kind && left.value === right.value))
    );
}
class SystemProxy {
    constructor(directory, adapter = windowsAdapter) {
        this.file = path.join(directory, "system-proxy-backup.json");
        this.adapter = adapter;
        this.active = false;
        this.pending = Promise.resolve();
    }
    exclusive(operation) {
        const result = this.pending.then(operation);
        this.pending = result.catch(() => {});
        return result;
    }
    enable(profile) {
        return this.exclusive(async () => {
            if (
                !Number.isInteger(profile.httpPort) ||
                profile.httpPort < 1 ||
                profile.httpPort > 65535 ||
                !["127.0.0.1", "::1", "localhost"].includes(profile.httpHost)
            )
                throw new Error(
                    "配置缺少无需认证的本地 HTTP 入站，无法设置系统代理。请关闭自动系统代理，或导入包含 HTTP 入站的配置。",
                );
            await this.restoreInternal();
            const previous = await this.adapter({ operation: "read" });
            const host =
                profile.httpHost === "::1" ? "[::1]" : profile.httpHost;
            const proxyAddress = `${host}:${profile.httpPort}`;
            const applied = {
                ProxyEnable: value(1, "DWord"),
                ProxyServer: value(
                    `http=${proxyAddress};https=${proxyAddress}`,
                ),
                ProxyOverride: value("localhost;127.*;[::1];<local>"),
                AutoConfigURL: { exists: false, value: null, kind: "String" },
            };
            await fs.mkdir(path.dirname(this.file), { recursive: true });
            await fs.writeFile(
                this.file,
                JSON.stringify({ previous, applied, pending: true }),
                { mode: 0o600 },
            );
            try {
                await this.adapter({ operation: "write", values: applied });
                await fs.writeFile(
                    this.file,
                    JSON.stringify({ previous, applied, pending: false }),
                    { mode: 0o600 },
                );
                this.active = true;
            } catch (error) {
                // A failed notification can occur after registry values were already written.
                await this.restoreInternal();
                throw error;
            }
        });
    }
    restore() {
        return this.exclusive(() => this.restoreInternal());
    }
    async restoreInternal() {
        let saved;
        try {
            saved = JSON.parse(await fs.readFile(this.file, "utf8"));
        } catch (error) {
            if (error.code === "ENOENT") {
                this.active = false;
                return;
            }
            throw error;
        }
        const current = await this.adapter({ operation: "read" });
        // Another application may have changed the proxy. Never overwrite its new settings.
        if (
            Object.keys(saved.applied).every(
                (key) =>
                    same(current[key], saved.applied[key]) ||
                    (saved.pending && same(current[key], saved.previous[key])),
            )
        ) {
            await this.adapter({ operation: "write", values: saved.previous });
        }
        await fs.unlink(this.file);
        this.active = false;
    }
}
module.exports = { SystemProxy, windowsAdapter };
