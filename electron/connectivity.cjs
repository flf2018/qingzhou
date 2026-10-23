const https = require("node:https");

function systemProbe(url, budget = 8000, request = https.get) {
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
                headers: { "Cache-Control": "no-cache" },
            },
            (response) => {
                response.resume();
                finish(
                    response.statusCode === 204
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
    const targets = [
        "https://www.gstatic.com/generate_204",
        "https://cp.cloudflare.com/generate_204",
    ];
    for (const target of targets) {
        try {
            await probe(target);
            return;
        } catch {}
    }
    throw new Error("网络连通性检查失败");
}
module.exports = { systemProbe, verifyConnectivity };
