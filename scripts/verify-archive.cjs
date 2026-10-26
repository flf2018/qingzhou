// Run the ZIP exactly as a user would after extracting it to a fresh folder.
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const { version } = require("../package.json");
const execute = promisify(execFile);
(async () => {
    const root = path.resolve(__dirname, "..");
    const archive = process.argv[2] ? path.resolve(process.argv[2])
        : path.join(root, `release/QingZhou-${version}-win-x64.zip`);
    const directory = await fs.mkdtemp(
        path.join(os.tmpdir(), "chenglian-zip-"),
    );
    try {
        await execute(
            await require("app-builder-lib/out/toolsets/7zip").getPath7za(),
            ["x", archive, `-o${directory}`, "-y"],
            { windowsHide: true, maxBuffer: 1024 * 1024 },
        );
        for (const file of [
            "QingZhou.exe",
            "resources/app.asar",
            "resources/TunHost.exe",
            "resources/cores/xray/xray.exe",
            "resources/cores/sing-box/sing-box.exe",
            "resources/routing/china-domains.json",
            "resources/routing/china-ip.json",
        ])
            await fs.access(path.join(directory, file));
        const result = await execute(
            process.execPath,
            [
                path.join(root, "tests/verify-exe.cjs"),
                path.join(directory, "QingZhou.exe"),
            ],
            {
                windowsHide: true,
                timeout: 90000,
                maxBuffer: 1024 * 1024,
                cwd: root,
            },
        );
        process.stdout.write(result.stdout);
        console.log(
            "Fresh ZIP extraction verified; all bundled resources are present.",
        );
    } finally {
        const target = path.resolve(directory);
        if (
            !target.startsWith(path.resolve(os.tmpdir()) + path.sep) ||
            !path.basename(target).startsWith("chenglian-zip-")
        )
            throw Error("Unexpected archive verification directory");
        await fs.rm(target, {
            recursive: true,
            force: true,
            maxRetries: 10,
            retryDelay: 200,
        });
    }
})().catch((error) => {
    console.error(error.message);
    if (error.stderr) console.error(error.stderr);
    process.exitCode = 1;
});
