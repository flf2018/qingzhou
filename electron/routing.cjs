const fs = require("node:fs");
const path = require("node:path");
const PRIVATE_CIDRS = [
    "127.0.0.0/8",
    "10.0.0.0/8",
    "172.16.0.0/12",
    "192.168.0.0/16",
    "169.254.0.0/16",
    "100.64.0.0/10",
    "::1/128",
    "fc00::/7",
    "fe80::/10",
];
const LOCAL_DOMAINS = ["local", "lan", "internal", "corp", "home.arpa"];
const DEFAULT_RULE_ROOT =
    process.resourcesPath && !process.defaultApp
        ? path.join(process.resourcesPath, "routing")
        : path.join(__dirname, "../vendor/routing");
const DIRECT = "qingzhou-direct";
const DOMESTIC_DNS = "qingzhou-domestic-dns";
const REMOTE_DNS = "qingzhou-remote-dns";
const CN_DOMAINS = "qingzhou-cn-domains";
const CN_IP = "qingzhou-cn-ip";
function modeOf(value) {
    if (!["smart", "global"].includes(value))
        throw new Error("无效的分流模式。");
    return value;
}
const cache = new Map();
function datasets(root = DEFAULT_RULE_ROOT) {
    if (!cache.has(root)) {
        const domains = JSON.parse(
            fs.readFileSync(path.join(root, "china-domains.json"), "utf8"),
        );
        const ip = JSON.parse(
            fs.readFileSync(path.join(root, "china-ip.json"), "utf8"),
        );
        if (!domains.rules?.length || !ip.rules?.[0]?.ip_cidr?.length)
            throw Error("国内分流规则文件不完整，请重新安装轻舟。");
        cache.set(root, { domains, ip });
    }
    return cache.get(root);
}
function xrayDomains(root) {
    const prefixes = {
        domain: "full:",
        domain_suffix: "domain:",
        domain_keyword: "keyword:",
        domain_regex: "regexp:",
    };
    return datasets(root).domains.rules.flatMap((rule) =>
        Object.entries(rule).flatMap(([key, values]) =>
            values.map((value) => prefixes[key] + value),
        ),
    );
}
function localSets(root = DEFAULT_RULE_ROOT) {
    datasets(root);
    return [
        {
            type: "local",
            tag: CN_DOMAINS,
            format: "source",
            path: path.join(root, "china-domains.json"),
        },
        {
            type: "local",
            tag: CN_IP,
            format: "source",
            path: path.join(root, "china-ip.json"),
        },
    ];
}
function proxyTag(config, kind) {
    const isProxy = (o) =>
        kind === "Xray"
            ? !["freedom", "blackhole", "dns", "loopback"].includes(o.protocol)
            : !["direct", "block", "dns"].includes(o.type);
    const preferred = kind === "sing-box" && config.route?.final;
    const outbound =
        (preferred &&
            config.outbounds.find((o) => o.tag === preferred && isProxy(o))) ||
        config.outbounds.find(isProxy) ||
        config.outbounds[0];
    if (!outbound) throw Error("节点缺少出站配置。");
    outbound.tag ||= "qingzhou-node";
    return outbound.tag;
}
function bootstrapNames(config) {
    const net = require("node:net"),
        names = [];
    for (const outbound of config.outbounds) {
        for (const address of [
            outbound.server,
            ...(outbound.settings?.vnext || []).map((s) => s.address),
            ...(outbound.settings?.servers || []).map((s) => s.address),
        ])
            if (typeof address === "string" && address && !net.isIP(address))
                names.push(address);
    }
    return [...new Set(names)];
}
function applyRouting(profile, mode = "smart", root = DEFAULT_RULE_ROOT) {
    modeOf(mode);
    const copy = structuredClone(profile),
        config = copy.config;
    const proxy = proxyTag(config, copy.kind),
        smart = mode === "smart";
    if (config.outbounds.some((o) => o.tag === DIRECT))
        throw Error("配置使用了轻舟保留的出站名称，请先调整自定义配置。");
    if (copy.kind === "Xray") {
        const domains = smart ? xrayDomains(root) : [];
        const local = [
            "full:localhost",
            ...LOCAL_DOMAINS.map((d) => "domain:" + d),
        ];
        const bootstrap = bootstrapNames(config).map((d) => "full:" + d);
        config.outbounds.push({
            tag: DIRECT,
            protocol: "freedom",
            settings: { domainStrategy: "UseIPv4" },
        });
        config.dns = {
            ...(config.dns || {}),
            queryStrategy: "UseIPv4",
            tag: "qingzhou-dns",
            servers: [
                {
                    address: "223.5.5.5",
                    domains: [...local, ...bootstrap, ...domains],
                    skipFallback: true,
                    tag: "qingzhou-domestic-query",
                },
                {
                    address: "https://1.1.1.1/dns-query",
                    tag: "qingzhou-remote-query",
                },
            ],
        };
        config.routing = {
            domainStrategy: smart ? "IPOnDemand" : "IPOnDemand",
            rules: [
                { type: "field", inboundTag: ["chenglian-health"], outboundTag: proxy },
                {
                    type: "field",
                    inboundTag: ["qingzhou-domestic-query"],
                    outboundTag: DIRECT,
                },
                {
                    type: "field",
                    inboundTag: ["qingzhou-remote-query"],
                    outboundTag: proxy,
                },
                { type: "field", domain: local, outboundTag: DIRECT },
                ...(smart
                    ? [{ type: "field", domain: domains, outboundTag: DIRECT }]
                    : []),
                { type: "field", ip: PRIVATE_CIDRS, outboundTag: DIRECT },
                ...(smart
                    ? [
                          {
                              type: "field",
                              ip: datasets(root).ip.rules[0].ip_cidr,
                              outboundTag: DIRECT,
                          },
                      ]
                    : []),
                { type: "field", network: "tcp,udp", outboundTag: proxy },
            ],
        };
    } else {
        config.outbounds.push({
            type: "direct",
            tag: DIRECT,
            domain_resolver: DOMESTIC_DNS,
        });
        const servers = (config.dns?.servers || []).filter(
            (s) => ![DOMESTIC_DNS, REMOTE_DNS].includes(s.tag),
        );
        config.dns = {
            ...(config.dns || {}),
            strategy: "ipv4_only",
            reverse_mapping: true,
            servers: [
                ...servers,
                { type: "udp", tag: DOMESTIC_DNS, server: "223.5.5.5" },
                {
                    type: "https",
                    tag: REMOTE_DNS,
                    server: "1.1.1.1",
                    server_port: 443,
                    path: "/dns-query",
                    tls: { enabled: true, server_name: "cloudflare-dns.com" },
                    detour: proxy,
                },
            ],
            final: REMOTE_DNS,
            rules: [
                {
                    domain: ["localhost", ...bootstrapNames(config)],
                    action: "route",
                    server: DOMESTIC_DNS,
                },
                {
                    domain_suffix: LOCAL_DOMAINS,
                    action: "route",
                    server: DOMESTIC_DNS,
                },
                ...(smart
                    ? [
                          {
                              rule_set: CN_DOMAINS,
                              action: "route",
                              server: DOMESTIC_DNS,
                          },
                      ]
                    : []),
            ],
        };
        for (const outbound of config.outbounds)
            if (outbound.server && !outbound.domain_resolver)
                outbound.domain_resolver = DOMESTIC_DNS;
        config.route = {
            ...(config.route || {}),
            default_domain_resolver: REMOTE_DNS,
            rule_set: smart ? localSets(root) : [],
            rules: [
                { inbound: ["chenglian-health"], action: "route", outbound: proxy },
                { domain: ["localhost"], action: "route", outbound: DIRECT },
                {
                    domain_suffix: LOCAL_DOMAINS,
                    action: "route",
                    outbound: DIRECT,
                },
                ...(smart
                    ? [
                          {
                              rule_set: CN_DOMAINS,
                              action: "route",
                              outbound: DIRECT,
                          },
                      ]
                    : []),
                { action: "resolve", strategy: "ipv4_only" },
                { ip_cidr: PRIVATE_CIDRS, action: "route", outbound: DIRECT },
                ...(smart
                    ? [{ rule_set: CN_IP, action: "route", outbound: DIRECT }]
                    : []),
            ],
            final: proxy,
        };
    }
    return copy;
}
function applyTunRouting(config, mode = "smart", root = DEFAULT_RULE_ROOT) {
    modeOf(mode);
    // Preserve private/company-VPN routes in the OS instead of pinning them to
    // the public uplink. This applies in both modes, including global proxy.
    config.inbounds.find((i) => i.type === "tun").route_exclude_address =
        PRIVATE_CIDRS;
    config.dns.reverse_mapping = true;
    if (mode === "smart") {
        config.route.rule_set = localSets(root);
        config.dns.servers.push({
            type: "udp",
            tag: DOMESTIC_DNS,
            server: "223.5.5.5",
            ...(config.outbounds.find((o) => o.tag === "direct").bind_interface
                ? {
                      bind_interface: config.outbounds.find(
                          (o) => o.tag === "direct",
                      ).bind_interface,
                  }
                : {}),
        });
        config.dns.rules.push({
            rule_set: CN_DOMAINS,
            action: "route",
            server: DOMESTIC_DNS,
        });
        config.route.rules.push(
            { rule_set: CN_DOMAINS, action: "route", outbound: "direct" },
            { rule_set: CN_IP, action: "route", outbound: "direct" },
        );
    }
    return config;
}
module.exports = {
    applyRouting,
    applyTunRouting,
    modeOf,
    PRIVATE_CIDRS,
    DIRECT,
    DOMESTIC_DNS,
    REMOTE_DNS,
    CN_DOMAINS,
    CN_IP,
    DEFAULT_RULE_ROOT,
    datasets,
};
