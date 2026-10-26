const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const {
    systemProbe,
    verifyConnectivity,
    verifyTunConnectivity,
} = require("../electron/connectivity.cjs");

test("TUN health check uses OS routes/DNS, IPv4 and requires a 204 response", async () => {
    let options;
    const request = (_url, opts, callback) => {
        options = opts;
        const req = new EventEmitter();
        req.destroy = () => {};
        setImmediate(() => callback({ statusCode: 204, resume() {} }));
        return req;
    };
    await systemProbe("https://test", 1000, request);
    assert.equal(options.agent, false);
    assert.equal(options.family, 4);
    await assert.rejects(
        systemProbe("https://test", 50, (_url, _opts, callback) => {
            const req = new EventEmitter();
            req.destroy = () => {};
            setImmediate(() => callback({ statusCode: 302, resume() {} }));
            return req;
        }),
        /HTTP 302/,
    );
    await assert.rejects(
        systemProbe("https://test", 20, () => {
            const req = new EventEmitter();
            req.destroy = () => {};
            return req;
        }),
        /超时/,
    );
});

test("TUN check uses a literal public IP and requires its expected HTTP status", async () => {
    await verifyTunConnectivity(async (url, budget, request, expected) => {
        assert.equal(new URL(url).hostname, "1.1.1.1");
        assert.equal(budget, 8000);
        assert.equal(expected, 200);
        await systemProbe(url, budget, (_url, options, callback) => {
            assert.equal(options.family, 4);
            const req = new EventEmitter();
            req.destroy = () => {};
            setImmediate(() => callback({ statusCode: 200, resume() {} }));
            return req;
        }, expected);
    });
});
test("health check tries a second provider and never treats total failure as ready", async () => {
    let calls = 0;
    await verifyConnectivity(async () => {
        if (++calls === 1) throw Error("first provider unavailable");
    });
    assert.equal(calls, 2);
    await assert.rejects(
        verifyConnectivity(async () => {
            throw Error("offline");
        }),
        error => /www.gstatic.com: offline/.test(error.message)
            && /cp.cloudflare.com: offline/.test(error.message),
    );
});
