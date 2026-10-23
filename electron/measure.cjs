const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const https = require("node:https");
const tls = require("node:tls");
const { performance } = require("node:perf_hooks");
const { CoreController } = require("./core.cjs");
const { freePort } = require("./tun.cjs");
const DOWNLOAD_BYTES = 10 * 1024 * 1024;
const UPLOAD_BYTES = 2 * 1024 * 1024;

function measurementProfile(profile, port) {
    const prepared = structuredClone(profile);
    const first = prepared.config.inbounds.find((i) =>
        ["http", "socks", "mixed"].includes(i.type || i.protocol),
    );
    // Measurements never inherit a TUN device or occupy the user's proxy ports.
    prepared.config.inbounds =
        profile.kind === "Xray"
            ? [
                  {
                      tag: first?.tag || "measurement",
                      protocol: "http",
                      listen: "127.0.0.1",
                      port,
                  },
              ]
            : [
                  {
                      tag: first?.tag || "measurement",
                      type: "http",
                      listen: "127.0.0.1",
                      listen_port: port,
                  },
              ];
    if (prepared.config.experimental) delete prepared.config.experimental;
    if (prepared.config.api) delete prepared.config.api;
    if (prepared.config.log)
        prepared.config.log =
            profile.kind === "Xray"
                ? { loglevel: "warning" }
                : { level: "warn" };
    prepared.host = "127.0.0.1";
    prepared.port = port;
    return prepared;
}

function proxyAgent(proxyPort, target, signal) {
    const agent = new https.Agent({ keepAlive: false });
    agent.createConnection = (_options, callback) => {
        const connect = http.request({
            host: "127.0.0.1",
            port: proxyPort,
            method: "CONNECT",
            path: `${target.hostname}:${target.port || 443}`,
            signal,
        });
        connect.once("error", callback);
        connect.once("connect", (response, socket, head) => {
            connect.removeListener("error", callback);
            if (response.statusCode !== 200) {
                socket.destroy();
                callback(new Error("节点未能建立测速连接。"));
                return;
            }
            if (head.length) socket.unshift(head);
            const secure = tls.connect({
                socket,
                servername: target.hostname,
                rejectUnauthorized: true,
            });
            const abort = () => secure.destroy(new Error("测速已取消。"));
            signal.addEventListener("abort", abort, { once: true });
            secure.once("close", () =>
                signal.removeEventListener("abort", abort),
            );
            secure.once("error", callback);
            secure.once("secureConnect", () => {
                secure.removeListener("error", callback);
                callback(null, secure);
            });
        });
        connect.end();
    };
    return agent;
}

// Fixed provider URLs are selected by the main process, never by renderer IPC.
// The injectable URLs below are exclusively for local integration fixtures.
function transfer(
    proxyPort,
    url,
    {
        signal,
        method = "GET",
        body,
        limit = 1024,
        budget = 10000,
        partial = false,
    } = {},
) {
    return new Promise((resolve, reject) => {
        const target = new URL(url);
        const controller = new AbortController();
        const abort = () => controller.abort();
        signal?.addEventListener("abort", abort, { once: true });
        if (signal?.aborted) controller.abort();
        const agent =
            target.protocol === "https:"
                ? proxyAgent(proxyPort, target, controller.signal)
                : undefined;
        const started = performance.now();
        let bytes = 0,
            settled = false,
            responseStatus;
        const finish = (error, timedOut = false) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            signal?.removeEventListener("abort", abort);
            agent?.destroy();
            if (
                timedOut &&
                partial &&
                bytes > 0 &&
                !signal?.aborted &&
                responseStatus === 200
            )
                error = null;
            if (error) reject(error);
            else
                resolve({
                    bytes: body?.length || bytes,
                    milliseconds: Math.max(1, performance.now() - started),
                    status: responseStatus,
                });
        };
        const timer = setTimeout(() => {
            finish(new Error("测速超时，请检查节点连接。"), true);
            controller.abort();
        }, budget);
        const request = (target.protocol === "https:" ? https : http).request(
            target.protocol === "https:"
                ? {
                      hostname: target.hostname,
                      port: target.port || 443,
                      path: target.pathname + target.search,
                      method,
                      agent,
                      signal: controller.signal,
                      headers: body
                          ? {
                                "Content-Type": "application/octet-stream",
                                "Content-Length": body.length,
                            }
                          : { "Accept-Encoding": "identity" },
                  }
                : {
                      host: "127.0.0.1",
                      port: proxyPort,
                      path: target.href,
                      method,
                      agent: false,
                      signal: controller.signal,
                      headers: {
                          Host: target.host,
                          ...(body ? { "Content-Length": body.length } : {}),
                      },
                  },
            (response) => {
                responseStatus = response.statusCode;
                if (responseStatus < 200 || responseStatus >= 300) {
                    response.destroy();
                    finish(new Error(`测速服务返回 HTTP ${responseStatus}。`));
                    return;
                }
                response.on("data", (chunk) => {
                    bytes += chunk.length;
                    if (bytes > limit) {
                        response.destroy();
                        finish(new Error("测速响应超过流量上限。"));
                    }
                });
                response.once("end", () => finish());
                response.once("error", (error) => finish(error));
            },
        );
        request.once("error", (error) => finish(error));
        request.end(body);
    });
}

class MeasurementController {
    constructor(changed, log, endpoints = {}) {
        this.changed = changed;
        this.log = log;
        this.results = {};
        this.busyId = null;
        this.abort = null;
        this.pending = null;
        this.endpoints = {
            latency: "https://www.gstatic.com/generate_204",
            download: `https://speed.cloudflare.com/__down?bytes=${DOWNLOAD_BYTES}`,
            upload: "https://speed.cloudflare.com/__up",
            ...endpoints,
        };
    }
    update(id, values) {
        this.results[id] = { ...this.results[id], ...values };
        this.changed();
    }
    async measure(profile, binary, full = false) {
        if (this.busyId) throw new Error("已有检测正在进行，请稍候。");
        this.busyId = profile.id;
        this.abort = new AbortController();
        const signal = this.abort.signal;
        this.pending = this.run(profile, binary, full, signal);
        try {
            return await this.pending;
        } finally {
            this.busyId = null;
            this.abort = null;
            this.pending = null;
            this.changed();
        }
    }
    async run(profile, binary, full, signal) {
        let core, directory;
        this.update(profile.id, {
            phase: "latency",
            error: null,
            latencyMs: null,
            ...(full ? { downloadMbps: null, uploadMbps: null } : {}),
        });
        try {
            directory = await fs.mkdtemp(
                path.join(os.tmpdir(), "chenglian-measure-"),
            );
            core = new CoreController(
                directory,
                () => {},
                () => {},
            );
            const port = await freePort();
            await core.start(measurementProfile(profile, port), binary);
            if (signal.aborted) throw new Error("检测已取消。");
            const latency = await transfer(port, this.endpoints.latency, {
                signal,
                budget: 8000,
            });
            if (latency.status !== 204)
                throw new Error(
                    "延迟检测未收到预期响应，节点可能重定向了请求。",
                );
            this.update(profile.id, {
                latencyMs: Math.round(latency.milliseconds),
            });
            if (full) {
                this.update(profile.id, { phase: "download" });
                const down = await transfer(port, this.endpoints.download, {
                    signal,
                    limit: DOWNLOAD_BYTES,
                    budget: 10000,
                    partial: true,
                });
                if (!down.bytes) throw new Error("测速没有收到下载数据。");
                this.update(profile.id, {
                    downloadMbps: (down.bytes * 8) / down.milliseconds / 1000,
                    phase: "upload",
                });
                const up = await transfer(port, this.endpoints.upload, {
                    signal,
                    method: "POST",
                    body: Buffer.alloc(UPLOAD_BYTES),
                    limit: 65536,
                    budget: 10000,
                });
                this.update(profile.id, {
                    uploadMbps: (up.bytes * 8) / up.milliseconds / 1000,
                });
            }
            this.update(profile.id, {
                phase: "done",
                testedAt: new Date().toISOString(),
            });
        } catch (error) {
            this.update(profile.id, {
                phase: "error",
                error: signal.aborted
                    ? "检测已取消。"
                    : error.message.slice(0, 250),
            });
        } finally {
            try {
                await core?.stop();
            } finally {
                if (directory)
                    await fs.rm(directory, { recursive: true, force: true });
            }
        }
    }
    async stop() {
        this.abort?.abort();
        await this.pending;
    }
}
module.exports = {
    MeasurementController,
    measurementProfile,
    transfer,
    DOWNLOAD_BYTES,
    UPLOAD_BYTES,
};
