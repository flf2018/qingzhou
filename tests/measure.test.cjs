const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const path = require("node:path");
const { once } = require("node:events");
const { setTimeout: delay } = require("node:timers/promises");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const {
    MeasurementController,
    measurementProfile,
    DOWNLOAD_BYTES,
    UPLOAD_BYTES,
    transfer,
} = require("../electron/measure.cjs");

test("measurement copies config and replaces privileged/listening inbounds without changing saved nodes", () => {
    const config = {
        inbounds: [
            { type: "tun" },
            {
                type: "mixed",
                tag: "keep-routing-tag",
                listen: "127.0.0.1",
                listen_port: 10808,
            },
        ],
        outbounds: [{ type: "direct" }],
        experimental: { clash_api: { external_controller: "127.0.0.1:9090" } },
    };
    const original = { kind: "sing-box", config };
    const cloned = measurementProfile(original, 23456);
    assert.equal(original.config.inbounds.length, 2);
    assert.equal(cloned.config.inbounds.length, 1);
    assert.equal(cloned.config.inbounds[0].listen_port, 23456);
    assert.equal(cloned.config.inbounds[0].tag, "keep-routing-tag");
    assert.equal(cloned.config.experimental, undefined);
    assert.deepEqual(cloned.config.outbounds, config.outbounds);
});

test(
    "real Xray and sing-box measure latency, download and upload through isolated proxy processes",
    { skip: process.platform !== "win32", timeout: 30000 },
    async () => {
        let uploaded = 0;
        const server = http.createServer((req, res) => {
            if (req.url === "/latency") {
                setTimeout(() => {
                    res.writeHead(204);
                    res.end();
                }, 30);
            } else if (req.url === "/down") {
                res.writeHead(200, { "Content-Length": DOWNLOAD_BYTES });
                res.end(Buffer.alloc(DOWNLOAD_BYTES));
            } else if (req.url === "/up") {
                req.on("data", (chunk) => (uploaded += chunk.length));
                req.on("end", () => res.end("ok"));
            } else res.writeHead(503).end();
        });
        server.listen(0, "127.0.0.1");
        await once(server, "listening");
        const base = `http://127.0.0.1:${server.address().port}`;
        try {
            for (const kind of ["Xray", "sing-box"]) {
                const phases = [];
                const measure = new MeasurementController(
                    () => {
                        phases.push(measure.results.fixture?.phase);
                    },
                    () => {},
                    {
                        latency: base + "/latency",
                        download: base + "/down",
                        upload: base + "/up",
                    },
                );
                const profile = {
                    id: "fixture",
                    kind,
                    config:
                        kind === "Xray"
                            ? {
                                  inbounds: [
                                      {
                                          protocol: "http",
                                          listen: "127.0.0.1",
                                          port: 10808,
                                      },
                                  ],
                                  outbounds: [{ protocol: "freedom" }],
                              }
                            : {
                                  inbounds: [
                                      {
                                          type: "mixed",
                                          listen: "127.0.0.1",
                                          listen_port: 10808,
                                      },
                                  ],
                                  outbounds: [{ type: "direct" }],
                              },
                };
                await measure.measure(
                    profile,
                    path.resolve(
                        __dirname,
                        kind === "Xray"
                            ? "../vendor/cores/xray/xray.exe"
                            : "../vendor/cores/sing-box/sing-box.exe",
                    ),
                    true,
                );
                const result = measure.results.fixture;
                assert.equal(result.phase, "done", result.error);
                assert.ok(result.latencyMs >= 30);
                assert.ok(result.downloadMbps > 0);
                assert.ok(result.uploadMbps > 0);
                assert.ok(
                    phases.includes("download") && phases.includes("upload"),
                );
                assert.equal(measure.busyId, null);
            }
            assert.equal(uploaded, UPLOAD_BYTES * 2);
        } finally {
            server.closeAllConnections();
            server.close();
        }
    },
);

test(
    "cancel and error paths stop temporary cores; concurrent requests do not spawn more cores",
    { skip: process.platform !== "win32", timeout: 15000 },
    async () => {
        const server = http.createServer(() => {});
        server.listen(0, "127.0.0.1");
        await once(server, "listening");
        const measure = new MeasurementController(
            () => {},
            () => {},
            { latency: `http://127.0.0.1:${server.address().port}/wait` },
        );
        const profile = {
            id: "cancel",
            kind: "Xray",
            config: {
                inbounds: [
                    { protocol: "http", listen: "127.0.0.1", port: 10808 },
                ],
                outbounds: [{ protocol: "freedom" }],
            },
        };
        try {
            const pending = measure.measure(
                profile,
                path.resolve(__dirname, "../vendor/cores/xray/xray.exe"),
            );
            await assert.rejects(
                measure.measure(profile, "unused"),
                /已有检测/,
            );
            await delay(200);
            await measure.stop();
            await pending;
            assert.equal(measure.results.cancel.error, "检测已取消。");
            assert.equal(measure.busyId, null);
            await measure.measure(profile, "missing.exe");
            assert.equal(measure.results.cancel.phase, "error");
            assert.equal(measure.busyId, null);
        } finally {
            server.closeAllConnections();
            server.close();
        }
    },
);

test("transfer enforces response byte limit and timeout", async () => {
    const server = http.createServer((req, res) => {
        if (req.url.includes("large")) res.end(Buffer.alloc(100));
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    try {
        await assert.rejects(
            transfer(server.address().port, "http://fixture/large", {
                limit: 10,
            }),
            /流量上限/,
        );
        await assert.rejects(
            transfer(server.address().port, "http://fixture/hang", {
                budget: 50,
            }),
            /测速超时/,
        );
    } finally {
        server.closeAllConnections();
        server.close();
    }
});

test(
    "HTTPS measurements use a real CONNECT tunnel and validate TLS certificates",
    { skip: process.platform !== "win32", timeout: 15000 },
    async () => {
        const env = { ...process.env };
        delete env.NODE_EXTRA_CA_CERTS;
        await promisify(execFile)(
            process.execPath,
            [path.join(__dirname, "fixtures/tls-measure.cjs")],
            { env, windowsHide: true },
        );
        env.NODE_EXTRA_CA_CERTS = path.join(
            __dirname,
            "fixtures/localhost-cert.pem",
        );
        await promisify(execFile)(
            process.execPath,
            [path.join(__dirname, "fixtures/tls-measure.cjs")],
            { env, windowsHide: true },
        );
    },
);
