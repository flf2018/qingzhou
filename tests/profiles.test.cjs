const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const {
    parseConfig,
    publicProfile,
    ProfileStore,
} = require("../electron/profiles.cjs");

const xray = {
    inbounds: [{ protocol: "socks", listen: "127.0.0.1", port: 10808 }],
    outbounds: [{ protocol: "vless", settings: { secret: "private-value" } }],
};
test("识别两种内核，渲染层 DTO 不包含完整配置和凭据", () => {
    const profile = parseConfig(JSON.stringify(xray), "Tokyo.json");
    assert.equal(profile.kind, "Xray");
    assert.equal(profile.name, "Tokyo");
    assert.equal(profile.port, 10808);
    assert.equal(publicProfile(profile).config, undefined);
    assert.ok(
        !JSON.stringify(publicProfile(profile)).includes("private-value"),
    );
    const singbox = parseConfig(
        JSON.stringify({
            inbounds: [{ type: "mixed", listen: "::1", listen_port: 2080 }],
            outbounds: [{ type: "trojan" }],
        }),
    );
    assert.equal(singbox.kind, "sing-box");
    assert.equal(singbox.port, 2080);
});
test("拒绝无效配置、缺少入站、越界端口与公开监听地址", () => {
    for (const text of [
        "null",
        "[]",
        "{}",
        "{",
        JSON.stringify({ ...xray, inbounds: [] }),
        JSON.stringify({
            ...xray,
            inbounds: [{ protocol: "socks", port: 10808, listen: "0.0.0.0" }],
        }),
        JSON.stringify({
            ...xray,
            inbounds: [{ protocol: "socks", port: 70000, listen: "127.0.0.1" }],
        }),
    ]) {
        assert.throws(() => parseConfig(text));
    }
});
test("持久化后能恢复配置及选择，并明确报告损坏文件", async (t) => {
    const directory = await fs.mkdtemp(
        path.join(os.tmpdir(), "v2rayn-profiles-"),
    );
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
    const store = new ProfileStore(directory);
    await store.load();
    const profile = parseConfig(JSON.stringify(xray));
    store.data.profiles.push(profile);
    store.data.selectedId = profile.id;
    store.data.routingMode = "global";
    await store.save();
    const reopened = new ProfileStore(directory);
    await reopened.load();
    assert.equal(reopened.snapshot().selectedId, profile.id);
    assert.equal(reopened.snapshot().routingMode, "global");
    assert.deepEqual(reopened.data.profiles[0].config, xray);
    await fs.writeFile(store.file, "{corrupt");
    await assert.rejects(() => new ProfileStore(directory).load(), /损坏/);
});
