const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const { existsSync } = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const net = require("node:net");
const dgram = require("node:dgram");
const http = require("node:http");
const { once } = require("node:events");
const { spawn, execFile } = require("node:child_process");
const { promisify } = require("node:util");
const { normalizeXrayConfig } = require("../electron/xray-compat.cjs");
const { parseLink } = require("../electron/shares.cjs");
const { CoreController } = require("../electron/core.cjs");
const execute = promisify(execFile);
const uuid = "a5b642ce-c9db-4325-b0f9-a8cbfe419b99";
const settings = (seed) => ({
    mtu: 1350,
    tti: 50,
    uplinkCapacity: 5,
    downlinkCapacity: 20,
    congestion: false,
    readBufferSize: 2,
    writeBufferSize: 2,
    header: { type: "utp" },
    ...(seed !== undefined && { seed }),
});
function clientConfig(kcp, port = 10808, remotePort = 18080) {
    return {
        log: { loglevel: "warning" },
        inbounds: [
            { protocol: "http", listen: "127.0.0.1", port, settings: {} },
        ],
        outbounds: [
            {
                tag: "proxy",
                protocol: "vmess",
                settings: {
                    vnext: [
                        {
                            address: "127.0.0.1",
                            port: remotePort,
                            users: [{ id: uuid, security: "auto" }],
                        },
                    ],
                },
                streamSettings: {
                    network: "kcp",
                    security: "none",
                    kcpSettings: kcp,
                },
            },
        ],
    };
}
test("旧版 utp/seed 转换为等价 UDP 掩码，顺序正确，不改动原始配置", () => {
    const source = clientConfig(settings("test-seed"));
    const before = structuredClone(source);
    const result = normalizeXrayConfig(source);
    const stream = result.config.outbounds[0].streamSettings;
    assert.deepEqual(source, before);
    assert.equal(result.migrated, 1);
    assert.deepEqual(stream.finalmask.udp, [
        { type: "header-utp" },
        { type: "mkcp-aes128gcm", settings: { password: "test-seed" } },
    ]);
    assert.equal(stream.kcpSettings.mtu, 1350);
    assert.ok(!Object.hasOwn(stream.kcpSettings, "header"));
    assert.ok(!Object.hasOwn(stream.kcpSettings, "seed"));
    assert.deepEqual(normalizeXrayConfig(result.config).config, result.config);
    assert.equal(normalizeXrayConfig(result.config).migrated, 0);
});
test("区分空 seed 和未配置 seed，不覆盖用户已有 FinalMask", () => {
    assert.equal(
        normalizeXrayConfig(clientConfig(settings(""))).config.outbounds[0]
            .streamSettings.finalmask.udp[1].type,
        "mkcp-aes128gcm",
    );
    assert.equal(
        normalizeXrayConfig(clientConfig(settings(undefined))).config
            .outbounds[0].streamSettings.finalmask.udp[1].type,
        "mkcp-original",
    );
    const source = clientConfig(settings("test"));
    source.outbounds[0].streamSettings.finalmask = {
        udp: [{ type: "salamander", settings: { password: "other" } }],
    };
    assert.throws(() => normalizeXrayConfig(source), /无法安全合并/);
    const inactive = clientConfig(settings("unused"));
    inactive.outbounds[0].streamSettings.network = "tcp";
    const stream =
        normalizeXrayConfig(inactive).config.outbounds[0].streamSettings;
    assert.equal(stream.finalmask, undefined);
    assert.ok(!Object.hasOwn(stream.kcpSettings, "header"));
});
test("支持 VMess KCP 分享链接，保留 seed 和 wechat-video 伪装", () => {
    const link =
        "vmess://" +
        Buffer.from(
            JSON.stringify({
                add: "127.0.0.1",
                port: 18080,
                id: uuid,
                net: "kcp",
                type: "wechat-video",
                path: "test-seed",
            }),
        ).toString("base64");
    const profile = parseLink(link);
    assert.deepEqual(profile.config.outbounds[0].streamSettings.finalmask.udp, [
        { type: "header-wechat" },
        { type: "mkcp-aes128gcm", settings: { password: "test-seed" } },
    ]);
});
test(
    "迁移后的各种伪装通过内置真实 Xray 配置校验",
    { skip: process.platform !== "win32" },
    async (t) => {
        const directory = await fs.mkdtemp(
            path.join(os.tmpdir(), "chenglian-mkcp-config-"),
        );
        t.after(() => fs.rm(directory, { recursive: true, force: true }));
        for (const header of [
            "none",
            "utp",
            "srtp",
            "wechat-video",
            "dtls",
            "wireguard",
            "dns",
        ]) {
            for (const seed of [undefined, "", "test-seed"]) {
                const kcp = settings(seed);
                kcp.header.type = header;
                const file = path.join(directory, "client.json");
                await fs.writeFile(
                    file,
                    JSON.stringify(
                        normalizeXrayConfig(clientConfig(kcp)).config,
                    ),
                );
                await execute(
                    path.resolve("vendor/cores/xray/xray.exe"),
                    ["run", "-test", "-config", file],
                    { windowsHide: true, timeout: 10000 },
                );
            }
        }
    },
);
async function freeTcpPort() {
    const server = net.createServer();
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const port = server.address().port;
    await new Promise((resolve) => server.close(resolve));
    return port;
}
async function freeUdpPort() {
    const socket = dgram.createSocket("udp4");
    socket.bind(0, "127.0.0.1");
    await once(socket, "listening");
    const port = socket.address().port;
    await new Promise((resolve) => socket.close(resolve));
    return port;
}
function requestThroughProxy(port, targetPort) {
    return new Promise((resolve, reject) => {
        const request = http.get(
            {
                host: "127.0.0.1",
                port,
                path: `http://127.0.0.1:${targetPort}/legacy`,
                headers: {
                    Host: `127.0.0.1:${targetPort}`,
                    Connection: "close",
                },
                timeout: 8000,
            },
            (response) => {
                const chunks = [];
                response.on("data", (chunk) => chunks.push(chunk));
                response.on("end", () =>
                    resolve(Buffer.concat(chunks).toString()),
                );
                response.on("error", reject);
            },
        );
        request.on("error", reject);
        request.on("timeout", () =>
            request.destroy(new Error("Legacy mKCP request timed out")),
        );
    });
}
const legacyCore = path.resolve(".cache/cores/xray-25.12.8/xray.exe");
test(
    "新内核迁移后能够通过旧版服务端实际转发 HTTP（utp/seed、空 seed、原始混淆）",
    { skip: process.platform !== "win32" || !existsSync(legacyCore) },
    async (t) => {
        const directory = await fs.mkdtemp(
            path.join(os.tmpdir(), "chenglian-mkcp-wire-"),
        );
        const target = http.createServer((_request, response) =>
            response.end("legacy-mkcp-forwarding-ok"),
        );
        target.listen(0, "127.0.0.1");
        await once(target, "listening");
        t.after(async () => {
            target.closeAllConnections();
            await new Promise((resolve) => target.close(resolve));
            await fs.rm(directory, { recursive: true, force: true });
        });
        for (const [header, seed] of [
            ["utp", "test-seed"],
            ["utp", ""],
            ["none", undefined],
        ]) {
            const kcp = settings(seed);
            kcp.header.type = header;
            const remotePort = await freeUdpPort();
            const port = await freeTcpPort();
            const serverConfig = {
                log: { loglevel: "info" },
                inbounds: [
                    {
                        listen: "127.0.0.1",
                        port: remotePort,
                        protocol: "vmess",
                        settings: { clients: [{ id: uuid }] },
                        streamSettings: {
                            network: "kcp",
                            security: "none",
                            kcpSettings: kcp,
                        },
                    },
                ],
                outbounds: [{ protocol: "freedom" }],
            };
            const file = path.join(directory, "server.json");
            await fs.writeFile(file, JSON.stringify(serverConfig));
            const server = spawn(legacyCore, ["run", "-config", file], {
                windowsHide: true,
                stdio: ["ignore", "pipe", "pipe"],
            });
            const serverExit = once(server, "exit");
            const client = new CoreController(
                path.join(directory, "client"),
                () => {},
                () => {},
            );
            try {
                await new Promise((resolve, reject) => {
                    let output = "";
                    const timer = setTimeout(() => {
                        cleanup();
                        reject(new Error("Legacy server startup timed out"));
                    }, 5000);
                    const read = (data) => {
                        output += data.toString();
                        if (/core: Xray .* started/.test(output)) {
                            cleanup();
                            resolve();
                        }
                    };
                    const failed = () => {
                        cleanup();
                        reject(
                            new Error("Legacy server exited during startup"),
                        );
                    };
                    const cleanup = () => {
                        clearTimeout(timer);
                        server.stdout.off("data", read);
                        server.stderr.off("data", read);
                        server.off("exit", failed);
                    };
                    server.stdout.on("data", read);
                    server.stderr.on("data", read);
                    server.once("exit", failed);
                });
                await client.start(
                    {
                        id: "legacy-regression",
                        kind: "Xray",
                        port,
                        host: "127.0.0.1",
                        config: clientConfig(kcp, port, remotePort),
                    },
                    path.resolve("vendor/cores/xray/xray.exe"),
                );
                assert.equal(
                    await requestThroughProxy(port, target.address().port),
                    "legacy-mkcp-forwarding-ok",
                );
            } finally {
                await client.stop();
                if (server.exitCode === null) server.kill();
                await serverExit;
            }
        }
    },
);
