const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const net = require("node:net");
const http = require("node:http");
const dgram = require("node:dgram");
const { spawn, execFile } = require("node:child_process");
const { promisify } = require("node:util");
const { once } = require("node:events");
const { setTimeout: delay } = require("node:timers/promises");
const {
    prepareTunProfile,
    createTunConfig,
    freePort,
    bootstrapDomains,
    physicalNetwork,
} = require("../electron/tun.cjs");
const { CoreController } = require("../electron/core.cjs");
const execute = promisify(execFile);
const root = path.resolve(__dirname, "..");
const singbox = path.join(root, "vendor/cores/sing-box/sing-box.exe");
const xray = path.join(root, "vendor/cores/xray/xray.exe");
const host = path.join(root, "build/TunHost.exe");
const windows = process.platform === "win32";

test("TUN bridge preserves original nodes, authenticates SOCKS and guards routing loops", () => {
    const original = {
        kind: "Xray",
        config: {
            inbounds: [],
            outbounds: [
                { protocol: "vmess", settings: { secret: "preserved" } },
            ],
        },
    };
    const prepared = prepareTunProfile(original, 13333, "user", "secret");
    assert.equal(original.config.inbounds.length, 0);
    assert.deepEqual(prepared.config.outbounds, original.config.outbounds);
    assert.deepEqual(prepared.config.inbounds[0].settings.accounts, [
        { user: "user", pass: "secret" },
    ]);
    assert.equal(prepared.config.inbounds[0].settings.udp, true);
    const config = createTunConfig({
        port: 13333,
        username: "user",
        password: "secret",
        coreBinary: xray,
        logFile: "test.log",
    });
    assert.equal(config.inbounds[0].auto_route, true);
    assert.equal(config.inbounds[0].strict_route, false);
    assert.equal(config.inbounds[0].dns_mode, "hijack");
    assert.equal(config.route.auto_detect_interface, true);
    assert.deepEqual(config.route.rules[0].process_path, [xray]);
    assert.equal(config.route.rules[0].outbound, "direct");
    assert.equal(
        config.dns.servers.find((server) => server.tag === "remote-dns").detour,
        "node",
    );
    assert.deepEqual(
        bootstrapDomains({
            config: {
                outbounds: [
                    {
                        settings: {
                            vnext: [
                                { address: "node.example.com" },
                                { address: "1.2.3.4" },
                            ],
                        },
                    },
                    { server: "node.example.com" },
                    { server: "second.example.com" },
                ],
            },
        }),
        ["node.example.com", "second.example.com"],
    );
    assert.equal(config.route.final, "node");
    assert.equal(config.dns.strategy, "ipv4_only");
    const pinned = prepareTunProfile(original, 13333, "u", "p", {
        interfaceName: "WLAN",
        healthPort: 13334,
    });
    assert.equal(
        pinned.config.outbounds[0].streamSettings.sockopt.interface,
        "WLAN",
    );
    assert.equal(original.config.outbounds[0].streamSettings, undefined);
    assert.equal(pinned.config.inbounds[0].port, 13334);
    const pinnedTun = createTunConfig({
        port: 13333,
        username: "u",
        password: "p",
        coreBinary: xray,
        logFile: "test.log",
        interfaceName: "WLAN",
    });
    assert.equal(
        pinnedTun.outbounds.find((outbound) => outbound.tag === "direct")
            .bind_interface,
        "WLAN",
    );
    assert.equal(
        pinnedTun.outbounds.find((outbound) => outbound.tag === "node")
            .bind_interface,
        undefined,
    );
    assert.equal(pinnedTun.route.auto_detect_interface, false);
    assert.throws(
        () =>
            prepareTunProfile(
                { kind: "sing-box", config: { inbounds: [{ type: "tun" }] } },
                13333,
                "a",
                "b",
            ),
        /已经包含 TUN/,
    );
});

test(
    "bundled sing-box accepts production TUN config, including DNS and both IP families",
    { skip: !windows },
    async () => {
        const dir = await fs.mkdtemp(
            path.join(os.tmpdir(), "chenglian-tun-check-"),
        );
        const config = path.join(dir, "tun.json");
        await fs.writeFile(
            config,
            JSON.stringify(
                createTunConfig({
                    port: 13333,
                    username: "u",
                    password: "p",
                    coreBinary: xray,
                    domains: ["node.example.com"],
                    bootstrapDns: "192.168.1.1",
                    logFile: path.join(dir, "tun.log"),
                }),
            ),
        );
        await execute(singbox, ["check", "-c", config], { windowsHide: true });
    },
);

// Real Windows console control and crash supervision, without creating a TUN
// device or touching the host's routing table, proxy or adapter DNS.
test(
    "Windows supervisor sends graceful Ctrl+C on stop/desktop EOF and kills descendants if it dies",
    { skip: !windows, timeout: 30000 },
    async () => {
        for (const mode of ["stop", "eof", "host-crash"]) {
            const dir = await fs.mkdtemp(
                path.join(os.tmpdir(), "chenglian-tun-host-"),
            );
            const config = path.join(dir, "fixture.json");
            const log = path.join(dir, "fixture.log");
            await fs.writeFile(
                config,
                JSON.stringify({
                    log: { output: log, level: "info" },
                    inbounds: [
                        {
                            type: "mixed",
                            listen: "127.0.0.1",
                            listen_port: await freePort(),
                        },
                    ],
                    outbounds: [{ type: "direct" }],
                }),
            );
            const child = spawn(host, [singbox, config], {
                windowsHide: true,
                stdio: ["pipe", "pipe", "pipe"],
            });
            let pid,
                errors = "";
            child.stdout.on("data", (data) => {
                pid = Number(/PID:(\d+)/.exec(data.toString())?.[1]) || pid;
            });
            child.stderr.on("data", (data) => {
                errors += data.toString();
            });
            const exited = once(child, "exit");
            try {
                let ready = false;
                for (let i = 0; i < 100; i++) {
                    if (
                        (
                            await fs.readFile(log, "utf8").catch(() => "")
                        ).includes("sing-box started")
                    ) {
                        ready = true;
                        break;
                    }
                    if (child.exitCode !== null) break;
                    await delay(50);
                }
                assert.ok(
                    ready,
                    `Supervisor did not start its child: ${errors}`,
                );
                assert.ok(pid);
                if (mode === "host-crash") child.kill();
                else child.stdin.end(mode === "stop" ? "stop\n" : undefined);
                const [code] = await exited;
                if (mode !== "host-crash") assert.equal(code, 0, errors);
                let alive = true;
                for (let i = 0; i < 40; i++) {
                    try {
                        process.kill(pid, 0);
                    } catch {
                        alive = false;
                        break;
                    }
                    await delay(50);
                }
                assert.equal(alive, false, `${mode} left a running child`);
            } finally {
                if (child.exitCode === null) child.stdin.end();
            }
        }
    },
);

function reader(socket) {
    let pending = Buffer.alloc(0),
        waiter;
    socket.on("data", (data) => {
        pending = Buffer.concat([pending, data]);
        waiter?.();
    });
    return (count) =>
        new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                waiter = null;
                reject(new Error("SOCKS reply timed out"));
            }, 5000);
            waiter = () => {
                if (pending.length >= count) {
                    clearTimeout(timer);
                    const result = pending.subarray(0, count);
                    pending = pending.subarray(count);
                    waiter = null;
                    resolve(result);
                }
            };
            waiter();
        });
}
async function socks(port, command, targetPort) {
    const socket = net.connect(port, "127.0.0.1");
    await once(socket, "connect");
    const read = reader(socket);
    socket.write(Buffer.from([5, 1, 2]));
    assert.deepEqual([...(await read(2))], [5, 2]);
    socket.write(Buffer.from([1, 1, 117, 1, 112])); // RFC1929 u/p
    assert.deepEqual([...(await read(2))], [1, 0]);
    socket.write(
        Buffer.from([
            5,
            command,
            0,
            1,
            127,
            0,
            0,
            1,
            targetPort >> 8,
            targetPort & 255,
        ]),
    );
    const reply = await read(10);
    assert.equal(reply[1], 0);
    return { socket, read, reply };
}
test(
    "TUN forwarding engine and both node cores relay TCP/UDP through the authenticated bridge",
    { skip: !windows, timeout: 30000 },
    async () => {
        const server = http.createServer((_request, response) =>
            response.end("tun-bridge-ok"),
        );
        server.listen(0, "127.0.0.1");
        await once(server, "listening");
        const udp = dgram.createSocket("udp4");
        udp.on("message", (message, remote) =>
            udp.send(message, remote.port, remote.address),
        );
        udp.bind(0, "127.0.0.1");
        await once(udp, "listening");
        const network = await physicalNetwork();
        try {
            for (const kind of ["Xray", "sing-box"]) {
                const port = await freePort(),
                    bridge = await freePort();
                const dir = await fs.mkdtemp(
                    path.join(os.tmpdir(), "chenglian-tun-bridge-"),
                );
                const profile = {
                    id: "fixture",
                    kind,
                    host: "127.0.0.1",
                    port,
                    config:
                        kind === "Xray"
                            ? {
                                  inbounds: [
                                      {
                                          protocol: "http",
                                          listen: "127.0.0.1",
                                          port,
                                      },
                                  ],
                                  outbounds: [{ protocol: "freedom" }],
                              }
                            : {
                                  inbounds: [
                                      {
                                          type: "mixed",
                                          listen: "127.0.0.1",
                                          listen_port: port,
                                      },
                                  ],
                                  outbounds: [{ type: "direct" }],
                              },
                };
                const core = new CoreController(
                    dir,
                    () => {},
                    () => {},
                );
                const forwarding = new CoreController(
                    path.join(dir, "forwarding"),
                    () => {},
                    () => {},
                );
                let tcp, association, client;
                try {
                    await core.start(
                        prepareTunProfile(profile, bridge, "u", "p", {
                            interfaceName: network.interfaceName,
                        }),
                        kind === "Xray" ? xray : singbox,
                    );
                    const entry = await freePort();
                    const config = createTunConfig({
                        port: bridge,
                        username: "u",
                        password: "p",
                        coreBinary: kind === "Xray" ? xray : singbox,
                        logFile: path.join(dir, "forward.log"),
                        interfaceName: network.interfaceName,
                    });
                    // Replace just the privileged TUN ingress with SOCKS for a
                    // host-safe integration test. Keep the real outbound engine,
                    // authentication and physical-interface binding in place.
                    config.inbounds = [
                        {
                            type: "socks",
                            listen: "127.0.0.1",
                            listen_port: entry,
                            users: [{ username: "u", password: "p" }],
                        },
                    ];
                    config.route.rules = []; // Local fixture must traverse node.
                    await forwarding.start(
                        {
                            kind: "sing-box",
                            id: "forward",
                            host: "127.0.0.1",
                            port: entry,
                            config,
                        },
                        singbox,
                    );
                    tcp = await socks(entry, 1, server.address().port);
                    const response = once(tcp.socket, "end");
                    let body = "";
                    tcp.socket.on("data", (data) => {
                        body += data.toString();
                    });
                    tcp.socket.write(
                        `GET / HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n`,
                    );
                    await response;
                    assert.match(body, /tun-bridge-ok/);
                    association = await socks(entry, 3, 0);
                    client = dgram.createSocket("udp4");
                    client.bind(0, "127.0.0.1");
                    await once(client, "listening");
                    const target = udp.address().port;
                    const packet = Buffer.concat([
                        Buffer.from([
                            0,
                            0,
                            0,
                            1,
                            127,
                            0,
                            0,
                            1,
                            target >> 8,
                            target & 255,
                        ]),
                        Buffer.from("tun-udp-ok"),
                    ]);
                    const received = new Promise((resolve, reject) => {
                        const timer = setTimeout(
                            () => reject(new Error("UDP bridge timed out")),
                            5000,
                        );
                        client.once("message", (value) => {
                            clearTimeout(timer);
                            resolve(value);
                        });
                    });
                    client.send(
                        packet,
                        association.reply.readUInt16BE(8),
                        "127.0.0.1",
                    );
                    assert.equal(
                        (await received).subarray(10).toString(),
                        "tun-udp-ok",
                    );
                } finally {
                    tcp?.socket.destroy();
                    association?.socket.destroy();
                    client?.close();
                    await forwarding.stop();
                    await core.stop();
                }
            }
        } finally {
            server.closeAllConnections();
            server.close();
            udp.close();
        }
    },
);
