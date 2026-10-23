const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const net = require("node:net");
const http = require("node:http");
const { once } = require("node:events");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const {
    applyRouting,
    applyTunRouting,
    datasets,
    PRIVATE_CIDRS,
    DIRECT,
    DOMESTIC_DNS,
    REMOTE_DNS,
} = require("../electron/routing.cjs");
const { CoreController } = require("../electron/core.cjs");
const { freePort, createTunConfig } = require("../electron/tun.cjs");
const root = path.resolve(__dirname, "..");
function profile(kind, port, serverPort) {
    return {
        id: "route-fixture",
        kind,
        host: "127.0.0.1",
        port,
        config:
            kind === "Xray"
                ? {
                      inbounds: [
                          { protocol: "http", listen: "127.0.0.1", port },
                      ],
                      outbounds: [
                          {
                              tag: "proxy",
                              protocol: "socks",
                              settings: {
                                  servers: [
                                      {
                                          address: "127.0.0.1",
                                          port: serverPort,
                                      },
                                  ],
                              },
                          },
                      ],
                  }
                : {
                      inbounds: [
                          {
                              type: "http",
                              listen: "127.0.0.1",
                              listen_port: port,
                          },
                      ],
                      outbounds: [
                          {
                              tag: "proxy",
                              type: "socks",
                              server: "127.0.0.1",
                              server_port: serverPort,
                              version: "5",
                          },
                      ],
                  },
    };
}
test("routing modes use complete offline datasets and preserve saved node configs", () => {
    assert.ok(
        datasets()
            .domains.rules.flatMap((rule) => Object.values(rule)[0])
            .includes("baidu.com"),
    );
    assert.ok(datasets().ip.rules[0].ip_cidr.length > 5000);
    for (const kind of ["Xray", "sing-box"]) {
        const original = profile(kind, 18080, 18081),
            before = JSON.stringify(original);
        const smart = applyRouting(original, "smart"),
            global = applyRouting(original, "global");
        assert.equal(JSON.stringify(original), before);
        assert.ok(smart.config.outbounds.some((o) => o.tag === DIRECT));
        if (kind === "Xray") {
            assert.ok(
                smart.config.routing.rules.some((r) => r.ip?.length > 5000),
            );
            assert.equal(
                global.config.routing.rules.some((r) => r.ip?.length > 5000),
                false,
            );
            assert.equal(
                smart.config.dns.servers[0].tag,
                "qingzhou-domestic-query",
            );
        } else {
            assert.equal(smart.config.route.rule_set.length, 2);
            assert.equal(global.config.route.rule_set.length, 0);
            assert.ok(
                smart.config.dns.rules.some((r) => r.server === DOMESTIC_DNS),
            );
            assert.equal(smart.config.dns.final, REMOTE_DNS);
        }
    }
    assert.throws(() => applyRouting(profile("Xray", 1, 2), "invalid"), /无效/);
    for (const mode of ["smart", "global"]) {
        const config = createTunConfig({
            port: 18080,
            username: "u",
            password: "p",
            coreBinary: "xray.exe",
            logFile: "fixture.log",
            routingMode: mode,
        });
        assert.deepEqual(
            config.inbounds[0].route_exclude_address,
            PRIVATE_CIDRS,
        );
        assert.equal(
            config.route.rules.some((r) =>
                r.rule_set?.includes("qingzhou-cn-ip"),
            ),
            mode === "smart",
        );
    }
});
async function marker(label) {
    const sockets = new Set();
    const server = net.createServer((socket) => {
        sockets.add(socket);
        socket.on("close", () => sockets.delete(socket));
        socket.on("error", () => {});
        let pending = Buffer.alloc(0),
            stage = 0;
        socket.on("data", (data) => {
            pending = Buffer.concat([pending, data]);
            if (stage === 0) {
                if (pending.length < 2 || pending.length < 2 + pending[1])
                    return;
                pending = pending.subarray(2 + pending[1]);
                socket.write(Buffer.from([5, 0]));
                stage = 1;
            }
            if (stage === 1) {
                if (pending.length < 5) return;
                const size =
                    pending[3] === 1
                        ? 10
                        : pending[3] === 4
                          ? 22
                          : 7 + pending[4];
                if (pending.length < size) return;
                pending = pending.subarray(size);
                socket.write(Buffer.from([5, 0, 0, 1, 127, 0, 0, 1, 0, 0]));
                stage = 2;
            }
            if (stage === 2 && pending.includes(Buffer.from("\r\n\r\n"))) {
                socket.end(
                    `HTTP/1.1 200 OK\r\nContent-Length: ${label.length}\r\nConnection: close\r\n\r\n${label}`,
                );
                stage = 3;
            }
        });
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    return {
        port: server.address().port,
        close: () => {
            for (const socket of sockets) socket.destroy();
            server.close();
        },
    };
}
function request(port, target) {
    return new Promise((resolve, reject) => {
        const req = http.get(
            {
                host: "127.0.0.1",
                port,
                path: `http://${target}/fixture`,
                headers: { Host: target, Connection: "close" },
                agent: false,
                timeout: 5000,
            },
            (res) => {
                let body = "";
                res.on("data", (b) => (body += b));
                res.on("end", () => resolve(body));
            },
        );
        req.on("error", reject);
        req.on("timeout", () =>
            req.destroy(Error("Routing request timed out")),
        );
    });
}
test(
    "real Xray and sing-box route domestic domains/IPs, foreign destinations and company-private IPs correctly",
    { skip: process.platform !== "win32", timeout: 60000 },
    async () => {
        const direct = await marker("DIRECT"),
            proxy = await marker("PROXY");
        try {
            for (const kind of ["Xray", "sing-box"])
                for (const mode of ["smart", "global"]) {
                    const directory = await fs.mkdtemp(
                        path.join(os.tmpdir(), "qingzhou-route-"),
                    );
                    const port = await freePort(),
                        prepared = applyRouting(
                            profile(kind, port, proxy.port),
                            mode,
                        );
                    // Both exits are local recording proxies. The unmodified native
                    // routing engine chooses between them; no external or DB access.
                    prepared.config.outbounds = prepared.config.outbounds.map(
                        (o) =>
                            o.tag !== DIRECT
                                ? o
                                : kind === "Xray"
                                  ? {
                                        tag: DIRECT,
                                        protocol: "socks",
                                        settings: {
                                            servers: [
                                                {
                                                    address: "127.0.0.1",
                                                    port: direct.port,
                                                },
                                            ],
                                        },
                                    }
                                  : {
                                        tag: DIRECT,
                                        type: "socks",
                                        server: "127.0.0.1",
                                        server_port: direct.port,
                                        version: "5",
                                    },
                    );
                    const hosts = {
                        "www.baidu.com": ["1.1.1.1"],
                        "qingzhou-routing-test.cn": ["1.1.1.1"],
                        "www.example.net": ["223.5.5.5"],
                        "www.openai.com": ["1.1.1.1"],
                    };
                    if (kind === "Xray") prepared.config.dns.hosts = hosts;
                    else
                        prepared.config.dns.servers =
                            prepared.config.dns.servers.map((s) => ({
                                type: "hosts",
                                tag: s.tag,
                                predefined: hosts,
                            }));
                    const logs = [];
                    const core = new CoreController(
                        directory,
                        () => {},
                        (message) => logs.push(message),
                    );
                    try {
                        await core
                            .start(
                                prepared,
                                path.join(
                                    root,
                                    "vendor/cores",
                                    kind === "Xray"
                                        ? "xray/xray.exe"
                                        : "sing-box/sing-box.exe",
                                ),
                            )
                            .catch((error) => {
                                error.message +=
                                    "\n" +
                                    kind +
                                    " " +
                                    mode +
                                    "\n" +
                                    logs.slice(-10).join("\n");
                                throw error;
                            });
                        for (const [target, expected] of [
                            [
                                "www.baidu.com",
                                mode === "smart" ? "DIRECT" : "PROXY",
                            ],
                            [
                                "qingzhou-routing-test.cn",
                                mode === "smart" ? "DIRECT" : "PROXY",
                            ],
                            [
                                "223.5.5.5",
                                mode === "smart" ? "DIRECT" : "PROXY",
                            ],
                            [
                                "www.example.net",
                                mode === "smart" ? "DIRECT" : "PROXY",
                            ],
                            ["www.openai.com", "PROXY"],
                            ["1.1.1.1", "PROXY"],
                            ["10.80.46.21:1521", "DIRECT"],
                            ["192.168.1.1", "DIRECT"],
                        ]) {
                            assert.equal(
                                await request(port, target),
                                expected,
                                `${kind} ${mode} ${target}\n${logs.join("\n").slice(-2000)}`,
                            );
                        }
                    } finally {
                        await core.stop();
                        await fs.rm(directory, {
                            recursive: true,
                            force: true,
                        });
                    }
                }
        } finally {
            direct.close();
            proxy.close();
        }
    },
);
test(
    "bundled sing-box validates smart/global TUN policies with local rule files",
    { skip: process.platform !== "win32" },
    async () => {
        const directory = await fs.mkdtemp(
            path.join(os.tmpdir(), "qingzhou-tun-routes-"),
        );
        try {
            for (const mode of ["smart", "global"]) {
                const file = path.join(directory, mode + ".json");
                await fs.writeFile(
                    file,
                    JSON.stringify(
                        createTunConfig({
                            port: 18080,
                            username: "u",
                            password: "p",
                            coreBinary: path.join(
                                root,
                                "vendor/cores/xray/xray.exe",
                            ),
                            logFile: path.join(directory, "tun.log"),
                            routingMode: mode,
                        }),
                    ),
                );
                await promisify(execFile)(
                    path.join(root, "vendor/cores/sing-box/sing-box.exe"),
                    ["check", "-c", file],
                    { windowsHide: true },
                );
            }
        } finally {
            await fs.rm(directory, { recursive: true, force: true });
        }
    },
);
