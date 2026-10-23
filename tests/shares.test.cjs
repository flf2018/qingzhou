const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const { parseText, parseLink, importText } = require("../electron/shares.cjs");
const execute = promisify(execFile);
const uuid = "a5b642ce-c9db-4325-b0f9-a8cbfe419b99";
const links = [
    `vless://${uuid}@example.com:443?security=tls&type=ws&host=example.com&path=%2Fws#VLESS%20WS`,
    "vmess://" +
        Buffer.from(
            JSON.stringify({
                add: "example.com",
                port: 443,
                id: uuid,
                net: "tcp",
                tls: "tls",
                ps: "VMess",
            }),
        ).toString("base64"),
    "trojan://test-password@example.com:443?sni=example.com#Trojan",
    "ss://" +
        Buffer.from("aes-128-gcm:example-password").toString("base64url") +
        "@example.com:443#SS",
    "hy2://test-password@example.com:443?sni=example.com#HY2",
    `tuic://${uuid}:test-password@example.com:443?sni=example.com&alpn=h3#TUIC`,
];
test("解析常见节点链接、保持传输配置并生成 HTTP 入站", () => {
    const profiles = parseText(links.join("\n"));
    assert.equal(profiles.length, 6);
    assert.equal(profiles[0].name, "VLESS WS");
    assert.equal(
        profiles[0].config.outbounds[0].streamSettings.wsSettings.path,
        "/ws",
    );
    assert.equal(profiles[0].httpPort, 10808);
    assert.equal(profiles[4].kind, "sing-box");
    assert.equal(profiles[4].config.outbounds[0].password, "test-password");
    assert.equal(profiles[5].config.outbounds[0].uuid, uuid);
});
test("支持 Base64 订阅，遇到无效条目不半途导入，错误不泄漏原链接凭据", () => {
    assert.equal(
        parseText(Buffer.from(links.join("\n")).toString("base64")).length,
        6,
    );
    assert.throws(
        () => parseText(links[0] + "\ninvalid-secret-url"),
        (error) =>
            !error.message.includes("secret-url") &&
            error.message.includes("第 2 个"),
    );
    assert.throws(
        () => parseText("ss://secret@example.com:443?plugin=test"),
        /第 1 个/,
    );
    assert.throws(() => parseText("a".repeat(2 * 1024 * 1024 + 1)), /2 MB/);
});
test("下载订阅并解析，对网络失败返回可读错误", async () => {
    const profiles = await importText(
        "https://example.com/sub",
        async () => new Response(Buffer.from(links[0]).toString("base64")),
    );
    assert.equal(profiles.length, 1);
    await assert.rejects(
        () =>
            importText("https://example.com/private-secret", async () => {
                throw new Error("private-secret");
            }),
        /订阅下载失败/,
    );
});
test(
    "用随包提供的真实内核验证生成的六种配置",
    { skip: process.platform !== "win32" },
    async (t) => {
        const directory = await fs.mkdtemp(
            path.join(os.tmpdir(), "v2rayn-shares-"),
        );
        t.after(() => fs.rm(directory, { recursive: true, force: true }));
        for (let i = 0; i < links.length; i++) {
            const profile = parseLink(links[i]);
            const config = path.join(directory, `${i}.json`);
            await fs.writeFile(config, JSON.stringify(profile.config));
            const binary = path.resolve(
                profile.kind === "Xray"
                    ? "vendor/cores/xray/xray.exe"
                    : "vendor/cores/sing-box/sing-box.exe",
            );
            await execute(
                binary,
                profile.kind === "Xray"
                    ? ["run", "-test", "-config", config]
                    : ["check", "-c", config],
                { windowsHide: true, timeout: 15000 },
            );
        }
    },
);
