const fs = require("node:fs/promises");
const path = require("node:path");
const net = require("node:net");
const dgram = require("node:dgram");
const { randomUUID } = require("node:crypto");
const { spawn, execFile } = require("node:child_process");
const { promisify } = require("node:util");
const { setTimeout: delay } = require("node:timers/promises");
const execute = promisify(execFile);
const { applyTunRouting } = require("./routing.cjs");

async function isAdministrator() {
    const { stdout } = await execute(
        "powershell.exe",
        [
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            "[Security.Principal.WindowsPrincipal]::new([Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)",
        ],
        { windowsHide: true },
    );
    return stdout.trim().toLowerCase() === "true";
}
async function elevate(executable, args) {
    // Pass data through the environment, never interpolate paths into shell code.
    const script =
        "$r = $env:CHENGLIAN_ELEVATE | ConvertFrom-Json; try { Start-Process -FilePath $r.exe -ArgumentList $r.args -Verb RunAs -ErrorAction Stop | Out-Null } catch { [Console]::Error.WriteLine('管理员授权已取消或启动失败。'); exit 1 }";
    const quote = (value) =>
        '"' +
        value.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/g, "$1$1") +
        '"';
    await execute(
        "powershell.exe",
        ["-NoProfile", "-NonInteractive", "-Command", script],
        {
            windowsHide: true,
            env: {
                ...process.env,
                CHENGLIAN_ELEVATE: JSON.stringify({
                    exe: executable,
                    args: args.map(quote).join(" "),
                }),
            },
        },
    );
}
async function freePort() {
    for (let attempt = 0; attempt < 20; attempt++) {
        const udp = dgram.createSocket("udp4");
        const tcp = net.createServer();
        try {
            await new Promise((resolve, reject) => {
                udp.once("error", reject);
                udp.bind(0, "127.0.0.1", resolve);
            });
            const port = udp.address().port;
            await new Promise((resolve, reject) => {
                tcp.once("error", reject);
                tcp.listen(port, "127.0.0.1", resolve);
            });
            return port;
        } catch (error) {
            if (attempt === 19) throw error;
        } finally {
            if (tcp.listening)
                await new Promise((resolve) => tcp.close(resolve));
            try {
                udp.close();
            } catch {}
        }
    }
}
function bootstrapDomains(profile) {
    const domains = new Set();
    const add = (value) => {
        if (typeof value === "string" && value && !net.isIP(value))
            domains.add(value);
    };
    for (const outbound of profile.config.outbounds || []) {
        add(outbound.server);
        for (const server of [
            ...(outbound.settings?.vnext || []),
            ...(outbound.settings?.servers || []),
        ])
            add(server.address);
    }
    return [...domains];
}
async function physicalNetwork() {
    const script =
        "$ErrorActionPreference='Stop'; [Console]::OutputEncoding=[Text.UTF8Encoding]::new(); $physical=@(Get-NetAdapter -Physical | Where-Object Status -eq 'Up'); $routes=@(Get-NetRoute -DestinationPrefix '0.0.0.0/0' | Where-Object { $_.InterfaceIndex -in $physical.ifIndex } | Sort-Object @{Expression={ $_.RouteMetric + $_.InterfaceMetric }}); if (!$routes.Count) { throw 'No active physical gateway' }; $route=$routes[0]; $dns=(Get-DnsClientServerAddress -InterfaceIndex $route.InterfaceIndex -AddressFamily IPv4).ServerAddresses | Select-Object -First 1; @{interfaceName=$route.InterfaceAlias; dns=$dns} | ConvertTo-Json -Compress";
    const { stdout } = await execute(
        "powershell.exe",
        ["-NoProfile", "-NonInteractive", "-Command", script],
        { windowsHide: true, timeout: 10000 },
    );
    const network = JSON.parse(stdout.replace(/^\uFEFF/, "").trim());
    if (
        !network.interfaceName ||
        !net.isIP(network.dns) ||
        network.dns.startsWith("127.")
    )
        throw new Error(
            "无法取得物理网卡的 DNS 地址，请检查当前网络后重试 TUN。",
        );
    return network;
}
async function physicalDnsServer() {
    return (await physicalNetwork()).dns;
}
function prepareTunProfile(
    profile,
    port,
    username,
    password,
    { interfaceName, healthPort } = {},
) {
    const prepared = structuredClone(profile);
    if (interfaceName) {
        for (const outbound of prepared.config.outbounds || []) {
            if (profile.kind === "Xray") {
                if (
                    ["freedom", "blackhole", "dns", "loopback"].includes(
                        outbound.protocol,
                    )
                )
                    continue;
                outbound.streamSettings ??= {};
                outbound.streamSettings.sockopt ??= {};
                outbound.streamSettings.sockopt.interface = interfaceName;
            } else if (
                !["direct", "selector", "urltest", "block", "dns"].includes(
                    outbound.type,
                )
            ) {
                outbound.bind_interface = interfaceName;
            }
        }
        if (profile.kind === "sing-box")
            for (const server of prepared.config.dns?.servers || []) {
                if (server.tag === "qingzhou-domestic-dns")
                    server.bind_interface = interfaceName;
            }
        // Bind the node itself, especially mKCP/QUIC UDP sockets. Process-based
        // re-proxying is a fallback, not the upstream transport for the node.
    }
    if (healthPort)
        prepared.config.inbounds.push(
            profile.kind === "Xray"
                ? {
                      tag: "chenglian-health",
                      protocol: "http",
                      listen: "127.0.0.1",
                      port: healthPort,
                  }
                : {
                      tag: "chenglian-health",
                      type: "http",
                      listen: "127.0.0.1",
                      listen_port: healthPort,
                  },
        );
    // A dedicated authenticated SOCKS bridge avoids changing imported listeners.
    const tag = `chenglian-tun-${randomUUID()}`;
    prepared.config.inbounds.push(
        profile.kind === "Xray"
            ? {
                  tag,
                  protocol: "socks",
                  listen: "127.0.0.1",
                  port,
                  settings: {
                      auth: "password",
                      accounts: [{ user: username, pass: password }],
                      udp: true,
                  },
              }
            : {
                  tag,
                  type: "socks",
                  listen: "127.0.0.1",
                  listen_port: port,
                  users: [{ username, password }],
              },
    );
    if (
        prepared.config.inbounds.some(
            (i) => i.type === "tun" || i.protocol === "tun",
        )
    )
        throw new Error(
            "此配置已经包含 TUN 入站，请先移除自定义 TUN 入站再使用应用的 TUN 开关。",
        );
    return prepared;
}
function createTunConfig({
    port,
    username,
    password,
    coreBinary,
    logFile,
    bootstrapDns = "1.1.1.1",
    domains = [],
    interfaceName,
    routingMode = "smart",
    routingRoot,
}) {
    return applyTunRouting(
        {
            log: {
                level: "info",
                timestamp: true,
                output: logFile,
                disabled: false,
            },
            dns: {
                servers: [
                    {
                        type: "udp",
                        tag: "bootstrap-dns",
                        server: bootstrapDns,
                        ...(interfaceName
                            ? { bind_interface: interfaceName }
                            : {}),
                    },
                    {
                        type: "https",
                        tag: "remote-dns",
                        server: "1.1.1.1",
                        server_port: 443,
                        path: "/dns-query",
                        tls: {
                            enabled: true,
                            server_name: "cloudflare-dns.com",
                        },
                        detour: "node",
                    },
                ],
                final: "remote-dns",
                rules: domains.length
                    ? [
                          {
                              domain: domains,
                              action: "route",
                              server: "bootstrap-dns",
                          },
                      ]
                    : [],
                strategy: "ipv4_only",
            },
            inbounds: [
                {
                    type: "tun",
                    tag: "tun-in",
                    interface_name: "QingZhou",
                    address: ["172.28.255.1/30", "fdfe:dcba:9876::1/126"],
                    mtu: 1500,
                    auto_route: true,
                    // Avoid global WFP DNS blocking of other adapters and clients.
                    // DNS is explicitly hijacked on the TUN interface instead.
                    strict_route: false,
                    dns_mode: "hijack",
                    stack: "mixed",
                },
            ],
            outbounds: [
                {
                    type: "socks",
                    tag: "node",
                    server: "127.0.0.1",
                    server_port: port,
                    version: "5",
                    username,
                    password,
                },
                {
                    type: "direct",
                    tag: "direct",
                    ...(interfaceName ? { bind_interface: interfaceName } : {}),
                },
            ],
            route: {
                auto_detect_interface: !interfaceName,
                default_domain_resolver: "remote-dns",
                rules: [
                    // Core traffic must escape through the physical interface, including
                    // its DNS. Exact process paths avoid bypassing unrelated applications.
                    {
                        process_path: [coreBinary],
                        action: "route",
                        outbound: "direct",
                    },
                    { port: 53, action: "hijack-dns" },
                    {
                        ip_is_private: true,
                        action: "route",
                        outbound: "direct",
                    },
                ],
                final: "node",
            },
        },
        routingMode,
        routingRoot,
    );
}

class TunController {
    constructor(directory, hostBinary, changed, log) {
        Object.assign(this, { directory, hostBinary, changed, log });
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
    async start(binary, options) {
        if (this.child) throw new Error("TUN 尚未停止。");
        const configPath = path.join(this.directory, "tun-config.json");
        const logFile = path.join(this.directory, "tun.log");
        await fs.writeFile(logFile, "");
        await fs.writeFile(
            configPath,
            JSON.stringify(createTunConfig({ ...options, logFile })),
            { mode: 0o600 },
        );
        try {
            await execute(binary, ["check", "-c", configPath], {
                windowsHide: true,
                timeout: 15000,
            });
        } catch (error) {
            throw new Error(
                `TUN 配置检查失败：${(error.stderr || error.message).slice(-3000)}`,
            );
        }
        this.update("starting");
        const child = spawn(this.hostBinary, [binary, configPath], {
            windowsHide: true,
            stdio: ["pipe", "pipe", "pipe"],
        });
        this.child = child;
        this.exited = new Promise((resolve) => {
            child.once("error", (error) => {
                this.log(`TUN 启动失败：${error.message}`);
                resolve();
            });
            child.once("exit", (code) => {
                this.log(`TUN 已退出（${code ?? "signal"}）。`);
                resolve();
            });
        }).then(() => {
            if (this.child === child) {
                clearInterval(this.timer);
                this.child = null;
                this.update("stopped");
            }
        });
        child.stdin.on("error", () => {});
        child.stderr.on("data", (data) =>
            this.log(`TUN：${data.toString().slice(0, 4000)}`),
        );
        // Drain the supervisor's bounded PID output.
        child.stdout.on("data", () => {});
        let offset = 0;
        let initialLog = "";
        const readLog = async () => {
            const file = await fs.open(logFile, "r");
            try {
                const size = (await file.stat()).size;
                if (size < offset) offset = 0;
                const buffer = Buffer.alloc(
                    Math.min(Math.max(size - offset, 0), 16000),
                );
                if (!buffer.length) return initialLog;
                const { bytesRead } = await file.read(
                    buffer,
                    0,
                    buffer.length,
                    offset,
                );
                offset += bytesRead;
                const value = buffer.subarray(0, bytesRead).toString();
                this.log(value);
                initialLog = (initialLog + value).slice(-32000);
                return initialLog;
            } finally {
                await file.close();
            }
        };
        try {
            for (let i = 0; i < 200; i++) {
                const value = await readLog();
                if (this.child !== child)
                    throw new Error("TUN 启动失败，请查看运行日志。");
                if (value.includes("sing-box started")) {
                    this.update("checking");
                    this.log("TUN 内核已启动，正在验证网络连通性。");
                    this.timer = setInterval(
                        () => readLog().catch(() => {}),
                        1000,
                    );
                    return;
                }
                await delay(100);
            }
            throw new Error(
                "TUN 启动超时，请检查管理员权限或其他 VPN 的占用。",
            );
        } catch (error) {
            await this.stop();
            throw error;
        }
    }
    async stop() {
        clearInterval(this.timer);
        const child = this.child;
        if (!child) return;
        this.update("stopping");
        // Closing stdin requests Ctrl+C from the supervisor, allowing sing-box
        // to dispose its Wintun, route, DNS and dynamic WFP resources normally.
        child.stdin.end("stop\n");
        await Promise.race([
            this.exited,
            delay(18000, undefined, { ref: false }).then(() => {
                if (this.child === child)
                    throw new Error("TUN 清理尚未完成，请重试停止。");
            }),
        ]);
    }
}
module.exports = {
    TunController,
    prepareTunProfile,
    createTunConfig,
    freePort,
    isAdministrator,
    elevate,
    bootstrapDomains,
    physicalDnsServer,
    physicalNetwork,
};
