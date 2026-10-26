// The parent test supplies a process-local CA; no OS trust store changes.
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const https = require("node:https");
const path = require("node:path");
const os = require("node:os");
const assert = require("node:assert/strict");
const { once } = require("node:events");
const { transfer } = require("../../electron/measure.cjs");
const { freePort } = require("../../electron/tun.cjs");
const { CoreController } = require("../../electron/core.cjs");
(async () => {
    const server = https.createServer(
        {
            cert: fs.readFileSync(path.join(__dirname, "localhost-cert.pem")),
            key: fs.readFileSync(path.join(__dirname, "localhost-key.pem")),
        },
        (req, res) => res.writeHead(req.url === "/challenge" ? 403 : 204).end(),
    );
    server.listen(0);
    await once(server, "listening");
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "chenglian-tls-"));
    const core = new CoreController(
        dir,
        () => {},
        () => {},
    );
    try {
        const port = await freePort();
        await core.start(
            {
                id: "tls",
                kind: "Xray",
                host: "127.0.0.1",
                port,
                config: {
                    inbounds: [{ protocol: "http", listen: "127.0.0.1", port }],
                    outbounds: [{ protocol: "freedom" }],
                },
            },
            path.resolve(__dirname, "../../vendor/cores/xray/xray.exe"),
        );
        const result = transfer(
            port,
            `https://localhost:${server.address().port}/latency`,
            { budget: 3000 },
        );
        if (process.env.NODE_EXTRA_CA_CERTS) {
            assert.equal((await result).status, 204);
            const options = { budget: 3000, method: "HEAD",
                acceptStatus: status => status >= 200 && status < 600 };
            assert.equal((await transfer(port,
                `https://localhost:${server.address().port}/challenge`, options)).status, 403);
            // A trusted certificate with the wrong domain must still fail,
            // even when HTTP challenges are accepted for health monitoring.
            await assert.rejects(transfer(port,
                `https://127.0.0.1:${server.address().port}/challenge`, options),
                /IP.*not in.*cert|altnames|alternative names/i);
        } else await assert.rejects(result, /self.signed certificate/i);
        console.log("HTTPS CONNECT proxy and certificate validation verified.");
    } finally {
        await core.stop();
        server.closeAllConnections();
        server.close();
        await fsp.rm(dir, { recursive: true, force: true });
    }
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
