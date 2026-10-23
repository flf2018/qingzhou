const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const { SystemProxy } = require("../electron/proxy.cjs");
const original = {
    ProxyEnable: { exists: true, value: 0, kind: "DWord" },
    ProxyServer: { exists: false, value: null, kind: "String" },
    ProxyOverride: { exists: true, value: "<local>", kind: "String" },
    AutoConfigURL: {
        exists: true,
        value: "https://example.com/previous.pac",
        kind: "String",
    },
};
async function setup(t) {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "v2rayn-proxy-"));
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
    const registry = { current: structuredClone(original), fail: false };
    const adapter = async (request) => {
        if (request.operation === "read")
            return structuredClone(registry.current);
        if (registry.fail) {
            registry.fail = false;
            registry.current.ProxyEnable = structuredClone(
                request.values.ProxyEnable,
            );
            throw new Error("simulated partial write");
        }
        registry.current = structuredClone(request.values);
        return { ok: true };
    };
    return {
        directory,
        registry,
        adapter,
        proxy: new SystemProxy(directory, adapter),
    };
}
const profile = { httpPort: 10808, httpHost: "127.0.0.1" };
test("启用代理前备份，停止时恢复 PAC 和原有设置", async (t) => {
    const { proxy, registry } = await setup(t);
    await proxy.enable(profile);
    assert.equal(proxy.active, true);
    assert.equal(
        registry.current.ProxyServer.value,
        "http=127.0.0.1:10808;https=127.0.0.1:10808",
    );
    assert.equal(registry.current.AutoConfigURL.exists, false);
    await proxy.restore();
    assert.deepEqual(registry.current, original);
    assert.equal(proxy.active, false);
});
test("崩溃后重新启动可以恢复代理，其他程序的新设置不会被覆盖", async (t) => {
    const { directory, proxy, adapter, registry } = await setup(t);
    await proxy.enable(profile);
    await new SystemProxy(directory, adapter).restore();
    assert.deepEqual(registry.current, original);
    await proxy.enable(profile);
    registry.current.ProxyServer.value = "other-proxy:9090";
    const changed = structuredClone(registry.current);
    await proxy.restore();
    assert.deepEqual(registry.current, changed);
});
test("部分写入失败会回滚，SOCKS-only 配置不会修改系统代理", async (t) => {
    const { proxy, registry } = await setup(t);
    registry.fail = true;
    await assert.rejects(() => proxy.enable(profile), /partial write/);
    assert.deepEqual(registry.current, original);
    await assert.rejects(() => proxy.enable({}), /HTTP 入站/);
    assert.deepEqual(registry.current, original);
});
