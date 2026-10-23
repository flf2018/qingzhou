const fs = require("node:fs/promises");
const path = require("node:path");
const { randomUUID } = require("node:crypto");

// Full configurations stay in the main process. Renderer DTOs omit credentials.
function parseConfig(text, filename = "Imported") {
    const config = JSON.parse(text);
    if (!config || Array.isArray(config) || typeof config !== "object")
        throw new Error("请选择完整的 JSON 内核配置。");
    if (
        !Array.isArray(config.inbounds) ||
        !Array.isArray(config.outbounds) ||
        !config.outbounds.length
    ) {
        throw new Error(
            "配置需要包含 inbounds 和非空的 outbounds。暂不支持分享链接或订阅地址。",
        );
    }
    const isSingbox = config.outbounds.some(
        (item) => typeof item.type === "string",
    );
    const isXray = config.outbounds.some(
        (item) => typeof item.protocol === "string",
    );
    if (isSingbox === isXray)
        throw new Error("无法识别内核类型，请导入 Xray 或 sing-box 完整配置。");
    const kind = isSingbox ? "sing-box" : "Xray";
    const inbound = config.inbounds.find((item) =>
        isSingbox
            ? ["mixed", "socks", "http"].includes(item.type)
            : ["mixed", "socks", "http"].includes(item.protocol),
    );
    const port = isSingbox ? inbound?.listen_port : inbound?.port;
    if (!inbound || !Number.isInteger(port) || port < 1 || port > 65535)
        throw new Error("配置需要有有效的 HTTP / SOCKS 本地监听端口。");
    if (!["127.0.0.1", "::1", "localhost"].includes(inbound.listen))
        throw new Error(
            "本地代理监听地址必须明确设置为 127.0.0.1、::1 或 localhost。",
        );
    const outbound = config.outbounds.find(
        (item) =>
            !["direct", "block", "dns", "freedom", "blackhole"].includes(
                item.type || item.protocol,
            ),
    );
    const httpInbound = config.inbounds.find(
        (item) =>
            ["127.0.0.1", "::1", "localhost"].includes(item.listen) &&
            (isSingbox
                ? ["mixed", "http"].includes(item.type) && !item.users?.length
                : ["http", "mixed"].includes(item.protocol) &&
                  !item.settings?.accounts?.length),
    );
    return {
        id: randomUUID(),
        name: path.basename(filename, path.extname(filename)),
        kind,
        protocol: outbound?.type || outbound?.protocol || "direct",
        port,
        host: inbound.listen,
        httpPort: httpInbound
            ? isSingbox
                ? httpInbound.listen_port
                : httpInbound.port
            : null,
        httpHost: httpInbound?.listen,
        config,
        importedAt: new Date().toISOString(),
    };
}

function publicProfile({ config, ...profile }) {
    return profile;
}

class ProfileStore {
    constructor(directory) {
        this.directory = directory;
        this.file = path.join(directory, "profiles.json");
        this.data = { profiles: [], binaries: {}, selectedId: null };
    }
    async load() {
        try {
            this.data = JSON.parse(await fs.readFile(this.file, "utf8"));
        } catch (error) {
            if (error.code !== "ENOENT")
                throw new Error(
                    "本地配置文件损坏，请先备份后修复 profiles.json。",
                );
        }
        if (!Array.isArray(this.data.profiles) || !this.data.binaries)
            throw new Error("本地配置格式错误。");
        for (const profile of this.data.profiles) {
            const parsed = parseConfig(
                JSON.stringify(profile.config),
                profile.name,
            );
            profile.httpPort = parsed.httpPort;
            profile.httpHost = parsed.httpHost;
        }
    }
    async save() {
        await fs.mkdir(this.directory, { recursive: true });
        const temporary = `${this.file}.tmp`;
        await fs.writeFile(temporary, JSON.stringify(this.data, null, 2), {
            mode: 0o600,
        });
        await fs.rename(temporary, this.file);
    }
    snapshot() {
        return {
            profiles: this.data.profiles.map(publicProfile),
            binaries: { ...this.data.binaries },
            selectedId: this.data.selectedId,
            systemProxy: this.data.systemProxy !== false,
            routingMode:
                this.data.routingMode === "global" ? "global" : "smart",
        };
    }
}
module.exports = { parseConfig, publicProfile, ProfileStore };
