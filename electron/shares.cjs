const { parseConfig } = require("./profiles.cjs");
const { normalizeXrayConfig } = require("./xray-compat.cjs");
const MAX_SIZE = 2 * 1024 * 1024;
function base64(value) {
    if (!/^[A-Za-z0-9+/=_\s-]+$/.test(value))
        throw new Error("Base64 数据格式不正确。");
    return Buffer.from(
        value.replace(/-/g, "+").replace(/_/g, "/"),
        "base64",
    ).toString("utf8");
}
function endpoint(url) {
    const port = Number(url.port || 443);
    if (!url.hostname || !Number.isInteger(port) || port < 1 || port > 65535)
        throw new Error("节点服务器或端口无效。");
    return { address: url.hostname.replace(/^\[|\]$/g, ""), port };
}
function transport(params) {
    const type = params.get("type") || "tcp";
    if (
        ![
            "tcp",
            "raw",
            "ws",
            "grpc",
            "xhttp",
            "httpupgrade",
            "kcp",
            "mkcp",
        ].includes(type)
    )
        throw new Error(`暂不支持 ${type} 传输，请导入完整 JSON 配置。`);
    const stream = { network: type };
    const security = params.get("security") || "none";
    if (!["none", "tls", "reality"].includes(security))
        throw new Error("不支持的传输安全类型。");
    stream.security = security;
    if (["kcp", "mkcp"].includes(type)) {
        stream.kcpSettings = {
            header: { type: params.get("headerType") || "none" },
            ...(params.has("seed") && { seed: params.get("seed") }),
        };
    }
    const serverName =
        params.get("sni") || params.get("peer") || params.get("host");
    if (security === "tls")
        stream.tlsSettings = {
            ...(serverName && { serverName }),
            ...(params.get("fp") && { fingerprint: params.get("fp") }),
            ...(params.get("alpn") && { alpn: params.get("alpn").split(",") }),
        };
    if (security === "reality") {
        if (!params.get("pbk") || !serverName)
            throw new Error("REALITY 链接缺少公钥或 SNI。");
        stream.realitySettings = {
            serverName,
            fingerprint: params.get("fp") || "chrome",
            publicKey: params.get("pbk"),
            shortId: params.get("sid") || "",
            ...(params.get("spx") && { spiderX: params.get("spx") }),
        };
    }
    if (type === "ws")
        stream.wsSettings = {
            path: params.get("path") || "/",
            ...(params.get("host") && {
                headers: { Host: params.get("host") },
            }),
        };
    if (type === "grpc")
        stream.grpcSettings = {
            serviceName: params.get("serviceName") || "",
            multiMode: params.get("mode") === "multi",
        };
    if (type === "xhttp")
        stream.xhttpSettings = {
            path: params.get("path") || "/",
            host: params.get("host") || "",
            mode: params.get("mode") || "auto",
        };
    if (type === "httpupgrade")
        stream.httpupgradeSettings = {
            path: params.get("path") || "/",
            host: params.get("host") || "",
        };
    return ["kcp", "mkcp"].includes(type)
        ? normalizeXrayConfig({ stream }).config.stream
        : stream;
}
function xrayProfile(outbound, name) {
    return parseConfig(
        JSON.stringify({
            log: { loglevel: "warning" },
            inbounds: [
                {
                    tag: "http",
                    listen: "127.0.0.1",
                    port: 10808,
                    protocol: "http",
                    settings: {},
                },
                {
                    tag: "socks",
                    listen: "127.0.0.1",
                    port: 10809,
                    protocol: "socks",
                    settings: { auth: "noauth", udp: true },
                },
            ],
            outbounds: [
                { tag: "proxy", ...outbound },
                { tag: "direct", protocol: "freedom" },
            ],
            routing: {
                domainStrategy: "AsIs",
                rules: [
                    {
                        type: "field",
                        ip: [
                            "127.0.0.0/8",
                            "::1/128",
                            "10.0.0.0/8",
                            "172.16.0.0/12",
                            "192.168.0.0/16",
                        ],
                        outboundTag: "direct",
                    },
                ],
            },
        }),
        `${name || "导入节点"}.json`,
    );
}
function parseLink(line) {
    if (line.startsWith("vmess://")) {
        const node = JSON.parse(base64(line.slice(8)));
        const port = Number(node.port);
        if (
            !node.add ||
            !node.id ||
            !Number.isInteger(port) ||
            port < 1 ||
            port > 65535
        )
            throw new Error("VMess 参数不完整。");
        if (
            node.type &&
            node.type !== "none" &&
            !["kcp", "mkcp"].includes(node.net)
        )
            throw new Error("VMess 链接的伪装方式暂不支持，请导入完整 JSON。");
        const params = new URLSearchParams({
            type: node.net || "tcp",
            security: node.tls || "none",
        });
        for (const key of ["host", "path", "sni", "alpn", "fp"])
            if (node[key]) params.set(key, node[key]);
        if (node.net === "grpc") params.set("serviceName", node.path || "");
        if (["kcp", "mkcp"].includes(node.net)) {
            params.set("headerType", node.type || "none");
            if (typeof node.seed === "string") params.set("seed", node.seed);
            else if (typeof node.path === "string" && node.path)
                params.set("seed", node.path);
        }
        return xrayProfile(
            {
                protocol: "vmess",
                settings: {
                    vnext: [
                        {
                            address: node.add,
                            port,
                            users: [
                                {
                                    id: node.id,
                                    alterId: Number(node.aid || 0),
                                    security: node.scy || "auto",
                                },
                            ],
                        },
                    ],
                },
                streamSettings: transport(params),
            },
            node.ps || node.add,
        );
    }
    let link = line;
    if (
        line.startsWith("ss://") &&
        !line.slice(5).split("#")[0].includes("@")
    ) {
        const [encoded, fragment] = line.slice(5).split("#");
        link = `ss://${base64(encoded)}${fragment ? `#${fragment}` : ""}`;
    }
    const url = new URL(link);
    const protocol = url.protocol.slice(0, -1);
    const { address, port } = endpoint(url);
    const name = decodeURIComponent(url.hash.slice(1)) || address;
    const username = decodeURIComponent(url.username);
    const password = decodeURIComponent(url.password);
    const params = url.searchParams;
    if (protocol === "vless" || protocol === "trojan") {
        if (!username) throw new Error("节点凭据不能为空。");
        if (protocol === "trojan" && !params.has("security"))
            params.set("security", "tls");
        const settings =
            protocol === "vless"
                ? {
                      vnext: [
                          {
                              address,
                              port,
                              users: [
                                  {
                                      id: username,
                                      encryption:
                                          params.get("encryption") || "none",
                                      ...(params.get("flow") && {
                                          flow: params.get("flow"),
                                      }),
                                  },
                              ],
                          },
                      ],
                  }
                : { servers: [{ address, port, password: username }] };
        return xrayProfile(
            { protocol, settings, streamSettings: transport(params) },
            name,
        );
    }
    if (protocol === "ss") {
        if (params.has("plugin"))
            throw new Error("Shadowsocks 插件暂不支持，请导入完整 JSON。");
        const credentials = password
            ? `${username}:${password}`
            : base64(username);
        const separator = credentials.indexOf(":");
        if (separator < 1 || separator === credentials.length - 1)
            throw new Error("Shadowsocks 凭据格式无效。");
        return xrayProfile(
            {
                protocol: "shadowsocks",
                settings: {
                    servers: [
                        {
                            address,
                            port,
                            method: credentials.slice(0, separator),
                            password: credentials.slice(separator + 1),
                        },
                    ],
                },
            },
            name,
        );
    }
    if (["hy2", "hysteria2", "tuic"].includes(protocol)) {
        if (!username || (protocol === "tuic" && !password))
            throw new Error("节点凭据不能为空。");
        const tls = {
            enabled: true,
            server_name: params.get("sni") || address,
            ...(params.get("alpn") && { alpn: params.get("alpn").split(",") }),
        };
        if (["1", "true"].includes(params.get("insecure"))) tls.insecure = true;
        const outbound = {
            type: protocol === "tuic" ? "tuic" : "hysteria2",
            tag: "proxy",
            server: address,
            server_port: port,
            tls,
        };
        if (protocol === "tuic")
            Object.assign(outbound, {
                uuid: username,
                password,
                congestion_control: params.get("congestion_control") || "cubic",
                udp_relay_mode: params.get("udp_relay_mode") || "native",
            });
        else {
            outbound.password = password ? `${username}:${password}` : username;
            if (params.get("obfs")) {
                if (
                    params.get("obfs") !== "salamander" ||
                    !params.get("obfs-password")
                )
                    throw new Error("不支持的 Hysteria2 混淆配置。");
                outbound.obfs = {
                    type: "salamander",
                    password: params.get("obfs-password"),
                };
            }
        }
        return parseConfig(
            JSON.stringify({
                log: { level: "warn" },
                inbounds: [
                    {
                        type: "mixed",
                        tag: "mixed",
                        listen: "127.0.0.1",
                        listen_port: 10808,
                    },
                ],
                outbounds: [outbound, { type: "direct", tag: "direct" }],
                route: {
                    rules: [{ ip_is_private: true, outbound: "direct" }],
                    final: "proxy",
                },
            }),
            `${name}.json`,
        );
    }
    throw new Error("不支持该节点协议，请导入完整 JSON 配置。");
}
function parseText(text) {
    if (typeof text !== "string" || Buffer.byteLength(text) > MAX_SIZE)
        throw new Error("导入内容不能超过 2 MB。");
    let content = text.trim();
    if (content.startsWith("{")) return [parseConfig(content, "导入配置.json")];
    if (!content.includes("://")) content = base64(content).trim();
    const lines = content
        .split(/\r?\n/)
        .map((item) => item.trim())
        .filter((item) => item && !item.startsWith("#"));
    if (!lines.length || lines.length > 1000)
        throw new Error("请粘贴节点链接，最多一次导入 1000 个节点。");
    return lines.map((line, index) => {
        try {
            return parseLink(line);
        } catch {
            throw new Error(
                `第 ${index + 1} 个节点链接无效或包含尚未支持的参数，请检查链接，或改用完整 JSON 配置。`,
            );
        }
    });
}
async function importText(text, fetcher = fetch) {
    let content = text.trim();
    if (/^https?:\/\//i.test(content) && !/\s/.test(content)) {
        let response;
        try {
            response = await fetcher(content, {
                signal: AbortSignal.timeout(30000),
                headers: { "User-Agent": "v2rayN-Electron/0.2.0" },
            });
        } catch {
            throw new Error("订阅下载失败，请检查地址和当前网络。");
        }
        if (!response.ok)
            throw new Error(`订阅服务器返回 HTTP ${response.status}。`);
        const reader = response.body.getReader();
        const chunks = [];
        let size = 0;
        try {
            for (;;) {
                const { done, value } = await reader.read();
                if (done) break;
                size += value.byteLength;
                if (size > MAX_SIZE) throw new Error("订阅内容超过 2 MB。");
                chunks.push(Buffer.from(value));
            }
        } finally {
            await reader.cancel().catch(() => {});
        }
        content = Buffer.concat(chunks).toString("utf8");
    }
    return parseText(content);
}
module.exports = { parseText, parseLink, importText, xrayProfile };
