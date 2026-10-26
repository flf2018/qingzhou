const {
    app,
    BrowserWindow,
    ipcMain,
    dialog,
    Menu,
    Tray,
    nativeImage,
    powerMonitor,
} = require("electron");
const fs = require("node:fs/promises");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { ProfileStore, parseConfig } = require("./profiles.cjs");
const { CoreController } = require("./core.cjs");
const { ConnectionRecovery, prepareHealthProfile } = require("./recovery.cjs");
const { HealthJournal } = require("./health-journal.cjs");
const { importText } = require("./shares.cjs");
const { SystemProxy } = require("./proxy.cjs");
const { randomUUID } = require("node:crypto");
const { MeasurementController, transfer } = require("./measure.cjs");
const { systemProbe, verifyConnectivity, verifyTunConnectivity, verifySessionConnectivity } = require("./connectivity.cjs");
const { applyRouting, modeOf } = require("./routing.cjs");
const { setTimeout: delay } = require("node:timers/promises");
const {
    TunController,
    prepareTunProfile,
    freePort,
    isAdministrator,
    elevate,
    bootstrapDomains,
    physicalNetwork,
} = require("./tun.cjs");
const persistentDataDirectory = app.getPath("userData");
app.setName("轻舟");
app.setPath("userData", persistentDataDirectory);
const coreManifest = require("../vendor/cores/manifest.json");
let window,
    tray,
    store,
    core,
    proxy,
    tun,
    measurement,
    recovery,
    administrator = false,
    administratorChecked = false,
    quitting = false;
let administratorCheck;
let trayState;
let quitRequested = false;
function checkAdministrator() {
    if (!administratorCheck) {
        administratorCheck = (
            process.platform === "win32"
                ? isAdministrator()
                : Promise.resolve(false)
        )
            .then((value) => {
                administrator = value;
                administratorChecked = true;
                broadcast();
                return value;
            })
            .catch((error) => {
                administratorCheck = null;
                log("管理员权限检查失败，开启 TUN 时会重试。");
                throw error;
            });
    }
    return administratorCheck;
}
const logs = [];
let revision = 0;
const page = path.join(__dirname, "../dist/index.html");
const coreRoot = app.isPackaged
    ? path.join(process.resourcesPath, "cores")
    : path.join(__dirname, "../vendor/cores");
function binaries() {
    return Object.fromEntries(
        Object.entries(coreManifest).map(([kind, info]) => {
            const custom = store.data.binaries[kind];
            return [
                kind,
                custom &&
                path.basename(custom).toLowerCase() === info.executable
                    ? custom
                    : path.join(coreRoot, info.directory, info.executable),
            ];
        }),
    );
}
let connectionBusy = false;
async function connection(operation) {
    if (connectionBusy) throw new Error("连接正在切换，请稍候。");
    connectionBusy = true;
    try {
        return await operation();
    } finally {
        connectionBusy = false;
        broadcast();
    }
}
async function stopConnection(preserveRecovery = false) {
    if (!preserveRecovery) recovery?.stop();
    await tun?.stop();
    await proxy.restore();
    await core.stop();
}
const snapshot = () => ({
    ...store.snapshot(),
    binaries: binaries(),
    bundled: Object.fromEntries(
        Object.entries(coreManifest).map(([kind, info]) => [
            kind,
            info.version,
        ]),
    ),
    proxyActive: proxy?.active || false,
    tunEnabled: store.data.tunEnabled === true,
    tunActive: tun?.active || false,
    tunPhase: tun?.phase || "stopped",
    administrator,
    administratorChecked,
    measurements: measurement?.results || {},
    measuringId: measurement?.busyId || null,
    core: core.state,
    connectionHealth: recovery?.state,
    logs,
    revision: ++revision,
});
function showWindow() {
    if (!window || window.isDestroyed()) return;
    if (window.isMinimized()) window.restore();
    window.setSkipTaskbar(false);
    window.show();
    window.focus();
}
function updateTray() {
    if (!tray || tray.isDestroyed()) return;
    const active = !!(core?.child || tun?.child);
    const key = `${active}:${connectionBusy}`;
    if (trayState === key) return;
    trayState = key;
    tray.setToolTip(`轻舟 · ${active ? "已连接" : "未连接"}`);
    tray.setContextMenu(
        Menu.buildFromTemplate([
            { label: "打开轻舟", click: showWindow },
            { label: "隐藏到托盘", click: () => window?.hide() },
            { type: "separator" },
            {
                label: "断开连接",
                enabled: active && !connectionBusy,
                click: () =>
                    connection(stopConnection).catch((error) =>
                        dialog.showErrorBox("断开失败", error.message),
                    ),
            },
            { label: "退出轻舟", click: () => app.quit() },
        ]),
    );
}
const broadcast = () => {
    updateTray();
    if (window && !window.isDestroyed())
        window.webContents.send("update", snapshot());
};
function log(message) {
    logs.push({ time: new Date().toISOString(), message });
    if (logs.length > 300) logs.shift();
    broadcast();
}
function handle(channel, callback) {
    ipcMain.handle(channel, async (event, ...args) => {
        if (
            event.sender !== window?.webContents ||
            event.senderFrame?.url !== pathToFileURL(page).href
        )
            throw new Error("不允许的调用来源。");
        try {
            const result = await callback(...args);
            return { ok: true, data: result ?? snapshot() };
        } catch (error) {
            return { ok: false, error: error.message };
        }
    });
}
async function launch() {
    let locked = app.requestSingleInstanceLock();
    if (!locked && process.argv.includes("--tun-elevated")) {
        // The original instance releases its lock after UAC accepts the handoff.
        for (let i = 0; i < 150 && !locked; i++) {
            await delay(100);
            locked = app.requestSingleInstanceLock();
        }
    }
    if (!locked) {
        app.quit();
        return;
    }
    app.on("second-instance", showWindow);
    app.whenReady()
        .then(async () => {
            // Separate storage prevents an experimental UI from changing the original client's data.
            store = new ProfileStore(app.getPath("userData"));
            await store.load();
            proxy = new SystemProxy(app.getPath("userData"));
            await proxy.restore();
            measurement = new MeasurementController(broadcast, log);
            tun = new TunController(
                app.getPath("userData"),
                app.isPackaged
                    ? path.join(process.resourcesPath, "TunHost.exe")
                    : path.join(__dirname, "../build/TunHost.exe"),
                (phase) => {
                    broadcast();
                    if (phase === "stopped" && core?.child && !connectionBusy)
                        unexpectedStop("TUN 意外退出，正在恢复连接。");
                },
                log,
            );
            core = new CoreController(
                app.getPath("userData"),
                (state) => {
                    broadcast();
                    if (state.phase === "stopped" && !connectionBusy)
                        unexpectedStop("节点内核意外退出，正在恢复连接。");
                },
                log,
            );
            function unexpectedStop(reason) {
                if (quitRequested) return;
                connection(async () => {
                    log(reason);
                    await stopConnection(true);
                    recovery?.interrupted(reason);
                }).catch(error => log(error.message));
            }
            let suspended = false;
            const healthJournal = new HealthJournal(app.getPath("userData"));
            recovery = new ConnectionRecovery({
                busy: () => connectionBusy || quitting || quitRequested || suspended,
                log,
                changed: (state) => {
                    broadcast();
                    healthJournal.record(state).catch(() =>
                        log("连接诊断日志写入失败。"));
                },
                probe: async (session) => {
                    if (core.state.phase !== "running") throw Error("内核已停止");
                    await verifySessionConnectivity(session, { transfer, system: systemProbe });
                },
                reconnect: (session) => connection(async () => {
                    if (recovery.session !== session || quitRequested) return;
                    await startConnection(session.id, true);
                    await recovery.probe(session);
                }),
            });
            powerMonitor.on("suspend", () => { suspended = true; });
            powerMonitor.on("resume", () => {
                suspended = false;
                recovery.resume();
            });
            powerMonitor.on("unlock-screen", () => recovery.resume());
            handle("snapshot", () => snapshot());
            handle("set-routing-mode", (mode) =>
                connection(async () => {
                    modeOf(mode);
                    await stopConnection();
                    store.data.routingMode = mode;
                    await store.save();
                    log(
                        `已切换为${mode === "smart" ? "智能分流（国内及内网直连）" : "全局代理（保留内网直连）"}，连接后生效。`,
                    );
                }),
            );
            async function requestElevation() {
                await measurement.stop();
                await stopConnection();
                const executable =
                    process.env.PORTABLE_EXECUTABLE_FILE || process.execPath;
                const args = [
                    ...(!app.isPackaged ? [app.getAppPath()] : []),
                    "--tun-elevated",
                    `--user-data-dir=${app.getPath("userData")}`,
                ];
                try {
                    await elevate(executable, args);
                } catch {
                    throw new Error("管理员授权已取消或启动失败，TUN 未开启。");
                }
                quitting = true;
                app.quit();
            }
            handle("set-tun", (enabled) =>
                connection(async () => {
                    if (typeof enabled !== "boolean")
                        throw new Error("无效的 TUN 设置。");
                    if (process.platform !== "win32")
                        throw new Error("当前 TUN 功能仅支持 Windows。");
                    await stopConnection();
                    const previous = store.data.tunEnabled;
                    store.data.tunEnabled = enabled;
                    await store.save();
                    if (enabled && !(await checkAdministrator())) {
                        try {
                            await requestElevation();
                        } catch (error) {
                            store.data.tunEnabled = previous;
                            await store.save();
                            throw error;
                        }
                    }
                }),
            );
            handle("import-text", async (text) => {
                const profiles = await importText(text);
                store.data.profiles.push(...profiles);
                store.data.selectedId ??= profiles[0]?.id;
                await store.save();
                broadcast();
            });
            handle("set-system-proxy", (enabled) =>
                connection(async () => {
                    if (typeof enabled !== "boolean")
                        throw new Error("无效的系统代理设置。");
                    if (!enabled) await proxy.restore();
                    else if (
                        core.state.phase === "running" &&
                        !store.data.tunEnabled
                    ) {
                        const profile = store.data.profiles.find(
                            (item) => item.id === core.state.profileId,
                        );
                        if (profile) await proxy.enable(profile);
                    }
                    store.data.systemProxy = enabled;
                    await store.save();
                }),
            );
            handle("import-config", async () => {
                const result = await dialog.showOpenDialog(window, {
                    title: "导入完整内核配置",
                    properties: ["openFile"],
                    filters: [{ name: "JSON 配置", extensions: ["json"] }],
                });
                if (result.canceled) return;
                const filename = result.filePaths[0];
                if ((await fs.stat(filename)).size > 5 * 1024 * 1024)
                    throw new Error("配置文件不能超过 5 MB。");
                const profile = parseConfig(
                    (await fs.readFile(filename, "utf8")).replace(
                        /^\uFEFF/,
                        "",
                    ),
                    filename,
                );
                store.data.profiles.push(profile);
                store.data.selectedId ??= profile.id;
                await store.save();
                broadcast();
            });
            handle("choose-binary", async (kind) => {
                if (!["Xray", "sing-box"].includes(kind))
                    throw new Error("无效的内核类型。");
                const result = await dialog.showOpenDialog(window, {
                    title: `选择 ${kind} 可执行文件`,
                    properties: ["openFile"],
                });
                if (!result.canceled) {
                    if (
                        path.basename(result.filePaths[0]).toLowerCase() !==
                        coreManifest[kind].executable
                    )
                        throw new Error(
                            `请选择 ${coreManifest[kind].executable}。连接引擎已经内置，通常无需替换。`,
                        );
                    store.data.binaries[kind] = result.filePaths[0];
                    await store.save();
                    broadcast();
                }
            });
            handle("select", async (id) => {
                if (!store.data.profiles.some((profile) => profile.id === id))
                    throw new Error("节点不存在。");
                store.data.selectedId = id;
                await store.save();
                broadcast();
            });
            handle("remove", async (id) => {
                if (measurement.busyId === id)
                    throw new Error("请先等待此节点检测完成。");
                if (core.state.profileId === id)
                    throw new Error("请先停止此节点的内核。");
                store.data.profiles = store.data.profiles.filter(
                    (profile) => profile.id !== id,
                );
                delete measurement.results[id];
                if (store.data.selectedId === id)
                    store.data.selectedId = store.data.profiles[0]?.id ?? null;
                await store.save();
                broadcast();
            });
            async function startConnection(id, recovering = false) {
                const profile = store.data.profiles.find(
                    (profile) => profile.id === id,
                );
                if (!profile) throw new Error("请先导入并选择配置。");
                if (
                    store.data.tunEnabled &&
                    !(await checkAdministrator())
                ) {
                    await requestElevation();
                    return;
                }
                if (
                    !store.data.tunEnabled &&
                    store.data.systemProxy !== false &&
                    !profile.httpPort
                )
                    throw new Error(
                        "该配置没有 HTTP 入站，请导入节点链接，或先关闭自动系统代理。",
                    );
                const binary = binaries()[profile.kind];
                await stopConnection(recovering);
                let tunAttempted = false, healthPort;
                try {
                    healthPort = await freePort();
                    const runtimeProfile = applyRouting(
                        profile,
                        store.data.routingMode || "smart",
                    );
                    let bridge;
                    if (store.data.tunEnabled) {
                        const network = await physicalNetwork();
                        bridge = {
                            port: await freePort(),
                            username: randomUUID(),
                            password: randomUUID(),
                            coreBinary: binary,
                            routingMode: store.data.routingMode || "smart",
                            domains: bootstrapDomains(profile),
                            bootstrapDns: network.dns,
                            interfaceName: network.interfaceName,
                            healthPort,
                        };
                        log(`TUN 上游网卡：${network.interfaceName}。`);
                    }
                    await core.start(
                        bridge
                            ? prepareTunProfile(
                                  runtimeProfile,
                                  bridge.port,
                                  bridge.username,
                                  bridge.password,
                                  bridge,
                              )
                            : prepareHealthProfile(runtimeProfile, healthPort),
                        binary,
                    );
                    if (bridge) {
                        log("正在检查节点连接，检查通过后再开启 TUN。");
                        await verifyConnectivity(async (url) => {
                            const result = await transfer(
                                bridge.healthPort,
                                url,
                                { budget: 8000 },
                            );
                            if (result.status !== 204)
                                throw new Error("节点响应异常");
                        });
                        tunAttempted = true;
                        await tun.start(
                            path.join(coreRoot, "sing-box", "sing-box.exe"),
                            bridge,
                        );
                        await verifyTunConnectivity(systemProbe);
                        if (!tun.child) throw new Error("TUN 已退出");
                        tun.update("running");
                        log(
                            "TUN 已通过实际联网检查：接管 TCP / UDP 与 DNS。",
                        );
                    } else if (store.data.systemProxy !== false)
                        await proxy.enable(profile);
                    const session = { id, port: healthPort, tun: !!bridge,
                        httpPort: profile.httpPort, httpHost: profile.httpHost };
                    if (recovering && recovery.session) Object.assign(recovery.session, session);
                    else if (session.port || session.tun) recovery.start(session);
                    if (core.state.phase !== "running")
                        throw new Error("内核已经退出，请查看日志。");
                } catch (error) {
                    log(`连接检查失败：${error.message}`);
                    await stopConnection(recovering);
                    if (tunAttempted && !recovering) {
                        store.data.tunEnabled = false;
                        await store.save();
                        if (
                            store.data.systemProxy !== false &&
                            profile.httpPort
                        ) {
                            let recovered = false;
                            try {
                                await core.start(
                                    prepareHealthProfile(applyRouting(
                                        profile,
                                        store.data.routingMode || "smart",
                                    ), healthPort),
                                    binary,
                                );
                                await proxy.enable(profile);
                                recovered = true;
                            } catch {
                                await stopConnection(recovering);
                            }
                            if (recovered) {
                                const session = { id, port: healthPort, tun: false,
                                    httpPort: profile.httpPort, httpHost: profile.httpHost };
                                if (recovering && recovery.session) Object.assign(recovery.session, session);
                                else recovery.start(session);
                                log("TUN 联网检查失败，已关闭 TUN 并回退到系统代理。");
                                throw new Error(
                                    "TUN 联网检查失败，已关闭 TUN 并回退到系统代理。",
                                );
                            }
                        }
                        throw new Error(
                            "TUN 联网检查失败，已关闭 TUN 并撤销接管，请查看日志。",
                        );
                    }
                    throw error;
                }
            }
            handle("start", (id) => connection(async () => {
                recovery.stop();
                await startConnection(id);
            }));
            handle("stop", () => connection(stopConnection));
            handle("measure", async (id, full) => {
                if (typeof full !== "boolean")
                    throw new Error("无效的检测类型。");
                const profile = store.data.profiles.find(
                    (item) => item.id === id,
                );
                if (!profile) throw new Error("请先选择节点。");
                await measurement.measure(
                    profile,
                    binaries()[profile.kind],
                    full,
                );
            });
            handle("cancel-measure", async () => {
                await measurement.stop();
            });
            Menu.setApplicationMenu(null);
            window = new BrowserWindow({
                show: false,
                width: 1080,
                height: 720,
                minWidth: 960,
                minHeight: 640,
                backgroundColor: "#f5f6f8",
                title: "轻舟",
                skipTaskbar: false,
                icon: path.join(__dirname, "../build/chenglian.png"),
                webPreferences: {
                    preload: path.join(__dirname, "preload.cjs"),
                    contextIsolation: true,
                    nodeIntegration: false,
                    sandbox: true,
                },
            });
            tray = new Tray(
                nativeImage
                    .createFromPath(
                        path.join(__dirname, "../build/chenglian.png"),
                    )
                    .resize({ width: 20, height: 20 }),
            );
            tray.on("click", showWindow);
            tray.on("double-click", showWindow);
            updateTray();
            window.on("close", (event) => {
                if (quitRequested) return;
                event.preventDefault();
                window.hide();
            });
            window.once("ready-to-show", () => {
                window.show();
                // PowerShell is intentionally outside the path to the first
                // visible frame. TUN operations await the same shared promise.
                setImmediate(() => {
                    if (!window.isDestroyed())
                        checkAdministrator().catch(() => {});
                });
            });
            window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
            window.webContents.on("will-navigate", (event) =>
                event.preventDefault(),
            );
            window.webContents.session.setPermissionRequestHandler(
                (_contents, _permission, callback) => callback(false),
            );
            await window.loadFile(page);
        })
        .catch((error) => {
            dialog.showErrorBox("启动失败", error.message);
            app.quit();
        });
    app.on("window-all-closed", () => app.quit());
    app.on("will-quit", () => {
        if (tray && !tray.isDestroyed()) tray.destroy();
    });
    app.on("before-quit", (event) => {
        quitRequested = true;
        if (
            quitting ||
            (!core?.child &&
                !proxy?.active &&
                !tun?.child &&
                !measurement?.busyId)
        )
            return;
        event.preventDefault();
        Promise.all([measurement?.stop(), stopConnection()])
            .then(() => {
                quitting = true;
                app.quit();
            })
            .catch((error) => {
                quitRequested = false;
                showWindow();
                dialog.showErrorBox("内核未停止", error.message);
            });
    });
}
launch().catch((error) => {
    dialog.showErrorBox("启动失败", error.message);
    app.quit();
});
