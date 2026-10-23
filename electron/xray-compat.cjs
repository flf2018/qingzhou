// Compatibility is tied to the bundled Xray 26.3.27 FinalMask schema.
// Convert a runtime copy only; never rewrite the user's imported configuration.
const { isDeepStrictEqual } = require("node:util");
const headers = {
    srtp: "srtp",
    utp: "utp",
    "wechat-video": "wechat",
    dtls: "dtls",
    wireguard: "wireguard",
    dns: "dns",
};
const own = (object, key) => Object.prototype.hasOwnProperty.call(object, key);

function normalizeXrayConfig(source) {
    const config = structuredClone(source);
    let migrated = 0;
    function visit(value) {
        if (!value || typeof value !== "object") return;
        const kcp = value.kcpSettings;
        if (
            kcp &&
            typeof kcp === "object" &&
            (own(kcp, "header") || own(kcp, "seed"))
        ) {
            const active = ["kcp", "mkcp"].includes(value.network);
            if (active) {
                const masks = [];
                if (
                    kcp.header != null &&
                    (typeof kcp.header !== "object" ||
                        Array.isArray(kcp.header))
                )
                    throw new Error("旧版 mKCP header 格式无效。");
                const { type = "none", ...settings } = kcp.header || {};
                if (type !== "none") {
                    if (!own(headers, type))
                        throw new Error(
                            "该 mKCP 伪装类型无法自动兼容，请使用匹配版本的完整配置。",
                        );
                    masks.push({
                        type: `header-${headers[type]}`,
                        ...(Object.keys(settings).length && { settings }),
                    });
                }
                // Even an explicitly empty seed selects AES-GCM in legacy Xray.
                // A missing/null seed selects its original XOR authenticator.
                if (kcp.seed != null) {
                    if (typeof kcp.seed !== "string")
                        throw new Error("旧版 mKCP seed 必须是字符串。");
                    masks.push({
                        type: "mkcp-aes128gcm",
                        settings: { password: kcp.seed },
                    });
                } else masks.push({ type: "mkcp-original" });
                const previous = value.finalmask?.udp;
                if (
                    previous != null &&
                    (!Array.isArray(previous) ||
                        (previous.length &&
                            !isDeepStrictEqual(previous, masks)))
                )
                    throw new Error(
                        "节点同时包含旧版 mKCP 参数和自定义 FinalMask，无法安全合并，请检查配置。",
                    );
                value.finalmask = { ...value.finalmask, udp: masks };
            }
            delete kcp.header;
            delete kcp.seed;
            migrated++;
        }
        for (const child of Object.values(value)) visit(child);
    }
    visit(config);
    return { config, migrated };
}
module.exports = { normalizeXrayConfig };
