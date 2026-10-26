const https = require("node:https");

function systemProbe(url, budget = 8000, request = https.get, expectedStatus = 204) {
    return new Promise((resolve, reject) => {
        let settled = false;
        const finish = (error) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            error ? reject(error) : resolve();
        };
        const timer = setTimeout(() => {
            finish(new Error("TUN 联网检查超时"));
            req.destroy();
        }, budget);
        // No explicit proxy: resolve via Windows and traverse the OS routes.
        const req = request(
            url,
            {
                agent: false,
                family: 4,
                method: expectedStatus === null ? "HEAD" : "GET",
                headers: { "Cache-Control": "no-cache" },
            },
            (response) => {
                response.resume();
                finish(
                    (expectedStatus === null || response.statusCode === expectedStatus)
                        ? null
                        : new Error(
                              `TUN 联网检查返回 HTTP ${response.statusCode}`,
                          ),
                );
                req.destroy();
            },
        );
        req.once("error", finish);
    });
}
async function verifyConnectivity(probe) {
    const failures = [];
    const targets = [
        "https://www.gstatic.com/generate_204",
        "https://cp.cloudflare.com/generate_204",
    ];
    for (const target of targets) {
        try {
            await probe(target);
            return;
        } catch (error) {
            failures.push(`${new URL(target).hostname}: ${error.message}`);
        }
    }
    throw new Error(`网络连通性检查失败（${failures.join("；")}）`);
}
async function verifyTunConnectivity(probe = systemProbe) {
    // A literal public IP avoids physical-adapter DNS mapping the health domain
    // to a domestic/direct destination. TLS still verifies the IP certificate.
    await probe("https://1.1.1.1/cdn-cgi/trace", 8000, undefined, 200);
}
async function verifySessionConnectivity(session, { transfer, system = systemProbe }) {
    if (session.port) await verifyConnectivity(async (url) => {
        const result = await transfer(session.port, url, { budget: 8000 });
        if (result.status !== 204) throw Error("节点响应异常");
    });
    if (session.tun) await verifyTunConnectivity(system);
    // The dedicated health inbound and literal-IP TUN probe bypass normal
    // domain routing/DNS. Check the browser's path too, with TLS validation on.
    // A Cloudflare challenge is reachable HTTPS, not a disconnected node.
    const target = "https://chatgpt.com/";
    try {
        if (session.tun) await system(target, 8000, undefined, null);
        else if (session.httpPort || session.port) await transfer(
            session.httpPort || session.port, target, {
                budget: 8000, method: "HEAD",
                proxyHost: session.httpHost || "127.0.0.1",
                acceptStatus: status => status >= 200 && status < 600,
            },
        );
    } catch (error) {
        throw new Error(`ChatGPT 实际访问路径检查失败：${error.message}`);
    }
}
module.exports = { systemProbe, verifyConnectivity, verifyTunConnectivity, verifySessionConnectivity };
