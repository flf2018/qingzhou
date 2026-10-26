<script setup>
import { computed, onMounted, onUnmounted, ref } from "vue";
import brandIcon from "./assets/chenglian.png";
import { version as appVersion } from "../package.json";

const desktop = window.desktop;
const page = ref("nodes");
const search = ref("");
const filter = ref("all");
const busy = ref(false);
const error = ref("");
const showImport = ref(false);
const importContent = ref("");
const state = ref({
    revision: -1,
    profiles: [],
    binaries: {},
    selectedId: null,
    core: { phase: "stopped", profileId: null, startedAt: null },
    logs: [],
    systemProxy: true,
    proxyActive: false,
    tunEnabled: false,
    routingMode: "smart",
    tunActive: false,
    administrator: false,
    measurements: {},
    measuringId: null,
    bundled: {},
});
const selected = computed(() =>
    state.value.profiles.find((item) => item.id === state.value.selectedId),
);
const runningProfile = computed(() =>
    state.value.profiles.find((item) => item.id === state.value.core.profileId),
);
const running = computed(
    () =>
        state.value.core.phase === "running" &&
        (!state.value.tunEnabled || state.value.tunActive),
);
const connectionStatus = computed(() => {
    const phase = state.value.connectionHealth?.phase;
    return ({ healthy: "代理联网正常", degraded: "代理通路异常",
        reconnecting: "正在自动重连", checking: "正在检查代理连接" })[phase]
        || (running.value ? "内核运行中" : state.value.core.phase === "starting"
            ? "内核启动中" : "尚未连接");
});
const connectionWarning = computed(() => {
    const phase = state.value.connectionHealth?.phase;
    return phase === "degraded" ? "代理通路检测失败，正在等待自动恢复；详细原因见运行日志。"
        : phase === "reconnecting" ? "正在恢复当前节点连接，请稍候。" : "";
});
const selectedMeasurement = computed(
    () => state.value.measurements?.[state.value.selectedId] || {},
);
const measuring = ref(false);
const measureStage = (item) =>
    ({ latency: "检测延迟…", download: "下载测速…", upload: "上传测速…" })[
        item?.phase
    ];
const rate = (value) =>
    typeof value === "number" ? `${value.toFixed(2)} Mbps` : "—";
async function measure(id, full = false) {
    if (!desktop || measuring.value || state.value.measuringId) return;
    measuring.value = true;
    error.value = "";
    try {
        const result = await desktop.measure(id, full);
        if (!result.ok) throw new Error(result.error);
        applySnapshot(result.data);
    } catch (cause) {
        error.value = cause.message;
    } finally {
        measuring.value = false;
    }
}
async function cancelMeasure() {
    const result = await desktop?.cancelMeasure();
    if (result?.data) applySnapshot(result.data);
}
const filtered = computed(() =>
    state.value.profiles.filter(
        (item) =>
            (filter.value === "all" || item.kind === filter.value) &&
            `${item.name} ${item.kind} ${item.protocol}`
                .toLowerCase()
                .includes(search.value.toLowerCase()),
    ),
);
const title = computed(
    () =>
        ({ nodes: "代理节点", logs: "运行日志", settings: "偏好设置" })[
            page.value
        ],
);
const subtitle = computed(
    () =>
        ({
            nodes: "管理节点与连接方式",
            logs: "在这里查看内核输出与进程状态。",
            settings: "管理连接与应用偏好",
        })[page.value],
);
const logText = computed(() =>
    state.value.logs
        .map(
            (item) =>
                `[${new Date(item.time).toLocaleTimeString()}] ${item.message}`,
        )
        .join("\n"),
);
let unsubscribe;
function applySnapshot(data) {
    if (data.revision >= state.value.revision) state.value = data;
}
async function act(method, ...args) {
    if (!desktop) {
        error.value = "当前为界面预览，请打开「轻舟」桌面程序后操作。";
        return;
    }
    if (busy.value) return;
    busy.value = true;
    error.value = "";
    try {
        const result = await desktop[method](...args);
        if (!result.ok) throw new Error(result.error);
        if (result.data?.profiles) applySnapshot(result.data);
    } catch (cause) {
        error.value = cause.message;
    } finally {
        busy.value = false;
    }
}
function connect() {
    if (running.value && state.value.core.profileId === selected.value?.id)
        return act("stop");
    return act("start", selected.value?.id);
}
async function remove(item) {
    if (window.confirm(`删除配置「${item.name}」？`))
        await act("remove", item.id);
}
async function submitImport() {
    await act("importText", importContent.value);
    if (desktop && !error.value) {
        showImport.value = false;
        importContent.value = "";
    }
}
onMounted(async () => {
    if (!desktop) return;
    unsubscribe = desktop.onUpdate(applySnapshot);
    await act("snapshot");
});
onUnmounted(() => unsubscribe?.());
</script>

<template>
    <div class="app-shell">
        <aside class="sidebar">
            <a class="brand" href="#" @click.prevent="page = 'nodes'"
                ><img class="brand-icon" :src="brandIcon" alt="轻舟图标" />
                <span class="brand-wordmark"
                    >轻舟<small>清晰连接 · 自在访问</small></span
                ></a
            >
            <div class="workspace">
                <span class="workspace-symbol">私</span
                ><span>本地配置<small>仅保存在此设备</small></span
                ><span class="workspace-dot"></span>
            </div>
            <div class="nav-label">工作空间</div>
            <nav aria-label="主导航">
                <button
                    :class="{ active: page === 'nodes' }"
                    @click="page = 'nodes'"
                >
                    <svg viewBox="0 0 24 24">
                        <rect x="3" y="3" width="7" height="7" rx="2" />
                        <rect x="14" y="3" width="7" height="7" rx="2" />
                        <rect x="3" y="14" width="7" height="7" rx="2" />
                        <rect x="14" y="14" width="7" height="7" rx="2" /></svg
                    >代理节点<span class="nav-count">{{
                        state.profiles.length
                    }}</span>
                </button>
                <button
                    :class="{ active: page === 'logs' }"
                    @click="page = 'logs'"
                >
                    <svg viewBox="0 0 24 24">
                        <path d="m5 7 5 5-5 5M13 17h6" /></svg
                    >运行日志
                </button>
                <button
                    :class="{ active: page === 'settings' }"
                    @click="page = 'settings'"
                >
                    <svg viewBox="0 0 24 24">
                        <path d="M4 7h16M4 17h16" />
                        <circle cx="9" cy="7" r="3" />
                        <circle cx="15" cy="17" r="3" /></svg
                    >偏好设置
                </button>
            </nav>
            <div class="sidebar-bottom">
                <div class="edition-tag"><span></span> 连接，由你掌握</div>
                <p>本地保存，安心使用。</p>
                <div class="version">
                    v{{ appVersion }} <span>独立运行</span>
                </div>
            </div>
        </aside>

        <main>
            <header class="topbar">
                <div>
                    <strong>轻舟</strong><span>/</span>{{ title }}
                </div>
                <span class="local-label"
                    ><span></span
                    >{{ desktop ? "本地运行" : "浏览器预览" }}</span
                >
            </header>
            <div class="content">
                <div class="page-heading">
                    <div>

                        <h1>{{ title }}</h1>
                        <p>{{ subtitle }}</p>
                    </div>
                    <button
                        v-if="page === 'nodes'"
                        class="button primary"
                        :disabled="busy"
                        @click="
                            showImport = true;
                            error = '';
                        "
                    >
                        <span class="plus">+</span> 导入节点
                    </button>
                </div>

                <div v-if="error" class="error-banner" role="alert">
                    <span>{{ error }}</span
                    ><button aria-label="关闭提示" @click="error = ''">
                        ×
                    </button>
                </div>

                <template v-if="page === 'nodes'">
                    <section class="connection-panel" aria-label="连接状态">
                        <div class="connection-info">
                            <div class="section-kicker">
                                <span
                                    :class="['status-dot', { running: running && state.connectionHealth?.phase === 'healthy' }]"
                                ></span
                                >{{
                                    connectionStatus
                                }}
                            </div>
                            <h2>
                                {{
                                    runningProfile?.name ||
                                    selected?.name ||
                                    "连接准备就绪"
                                }}
                            </h2>
                            <p>
                                {{
                                    connectionWarning || (running
                                        ? `本地代理 ${runningProfile?.host}:${runningProfile?.port} 已就绪 · ${state.tunActive ? "TUN 已接管流量" : state.proxyActive ? "系统代理已开启" : "仅本地代理"}`
                                        : "内核已内置，导入节点或订阅后即可连接。")
                                }}
                            </p>
                            <div class="connection-tags">
                                <span
                                    ><i></i>
                                    {{
                                        selected?.protocol || "双引擎支持"
                                    }}</span
                                ><span>{{
                                    state.routingMode === "global"
                                        ? "全局代理"
                                        : "智能分流"
                                }}</span
                                ><span>{{
                                    state.tunEnabled
                                        ? state.tunActive
                                            ? "TUN 已开启"
                                            : "TUN 模式"
                                        : state.proxyActive
                                          ? "系统代理已开启"
                                          : state.systemProxy
                                            ? "自动系统代理"
                                            : "仅本地代理"
                                }}</span>
                            </div>
                        </div>
                        <div class="connection-action">
                            <button
                                class="power-button"
                                :class="{ connected: running }"
                                :disabled="busy || !selected"
                                :aria-label="
                                    running ? '断开或切换连接' : '连接节点'
                                "
                                @click="connect"
                            >
                                <svg viewBox="0 0 32 32">
                                    <path d="M16 4v12M9 8a11 11 0 1 0 14 0" />
                                </svg></button
                            ><span>{{
                                running && state.core.profileId === selected?.id
                                    ? "断开连接"
                                    : running
                                      ? "切换节点"
                                      : "连接"
                            }}</span>
                        </div>
                    </section>

                    <div class="connection-options">
                        <section
                            class="tun-mode-bar routing-mode-bar"
                            aria-label="代理分流模式"
                        >
                            <div>
                                <h3>代理模式</h3>
                                <p>
                                    {{
                                        state.routingMode === "global"
                                            ? "所有公网流量走节点 · 内网直连"
                                            : "国内域名、国内 IP 与内网直连 · 其余走节点"
                                    }}<span class="mode-hint">切换后需重新连接</span>
                                </p>
                            </div>
                            <div
                                class="routing-tabs"
                                role="group"
                                aria-label="智能分流或全局代理"
                            >
                                <button
                                    v-for="mode in ['smart', 'global']"
                                    :key="mode"
                                    :aria-pressed="state.routingMode === mode"
                                    :class="{ active: state.routingMode === mode }"
                                    :disabled="busy || !!state.measuringId"
                                    @click="act('setRoutingMode', mode)"
                                >
                                    {{ mode === "smart" ? "智能分流" : "全局代理" }}
                                </button>
                            </div>
                        </section>
                        <section class="tun-mode-bar" aria-label="TUN 全局接管">
                            <div>
                                <h3>TUN 全局接管</h3>
                                <p>
                                    {{
                                        state.tunActive
                                            ? "联网检查已通过 · TCP / UDP 与 DNS 接管中"
                                            : state.tunPhase === "checking"
                                              ? "正在验证网络，失败会自动撤销接管"
                                              : "切换模式会断开连接 · 开启需管理员授权"
                                    }}
                                </p>
                            </div>
                            <button
                                class="tun-switch"
                                :class="{ enabled: state.tunEnabled }"
                                role="switch"
                                :aria-checked="state.tunEnabled"
                                :aria-label="state.tunEnabled ? '关闭 TUN' : '开启 TUN'"
                                :disabled="busy || state.tunPhase === 'stopping'"
                                :aria-pressed="state.tunEnabled"
                                @click="act('setTun', !state.tunEnabled)"
                            >
                                <span class="switch-knob"></span>
                                <span class="sr-only">{{ state.tunEnabled ? "关闭 TUN" : "开启 TUN" }}</span>
                            </button>
                        </section>
                    </div>

                    <section class="metrics" aria-label="配置概览">
                        <div>
                            <span class="metric-icon">↗</span>
                            <div>
                                <span>本地监听端口</span
                                ><strong
                                    >{{ selected?.port || "—"
                                    }}<small>{{
                                        selected ? "PORT" : "等待配置"
                                    }}</small></strong
                                >
                            </div>
                        </div>
                        <div>
                            <span class="metric-icon">◈</span>
                            <div>
                                <span>可用配置</span
                                ><strong
                                    >{{ state.profiles.length
                                    }}<small>个节点</small></strong
                                >
                            </div>
                        </div>
                        <div>
                            <span class="metric-icon">⌘</span>
                            <div>
                                <span>内置引擎</span
                                ><strong
                                    >{{ Object.keys(state.binaries).length
                                    }}<small>/ 2 已就绪</small></strong
                                >
                            </div>
                        </div>
                    </section>

                    <section class="nodes-section">
                        <div class="list-heading">
                            <h2>
                                我的节点
                                <span>{{ state.profiles.length }}</span>
                            </h2>
                            <div class="view-hint">配置保存在此设备</div>
                        </div>
                        <div class="toolbar">
                            <div class="filter-tabs" aria-label="内核筛选">
                                <button
                                    v-for="kind in ['all', 'Xray', 'sing-box']"
                                    :key="kind"
                                    :class="{ active: filter === kind }"
                                    @click="filter = kind"
                                >
                                    {{ kind === "all" ? "全部节点" : kind }}
                                </button>
                            </div>
                            <label class="search"
                                ><svg viewBox="0 0 24 24">
                                    <circle cx="10.5" cy="10.5" r="6.5" />
                                    <path d="m16 16 5 5" /></svg
                                ><input
                                    v-model="search"
                                    placeholder="搜索名称、协议…"
                                    aria-label="搜索节点"
                                /><kbd>/</kbd></label
                            >
                        </div>
                        <div v-if="filtered.length" class="node-grid">
                            <article
                                v-for="item in filtered"
                                :key="item.id"
                                :class="[
                                    'node-card',
                                    { selected: item.id === state.selectedId },
                                ]"
                            >
                                <button
                                    class="node-select"
                                    :disabled="busy"
                                    @click="act('select', item.id)"
                                >
                                    <div class="node-card-top">
                                        <span class="node-avatar">{{
                                            item.kind === "Xray" ? "X" : "S"
                                        }}</span
                                        ><span class="node-protocol">{{
                                            item.protocol
                                        }}</span
                                        ><span class="radio"
                                            ><span
                                                v-if="
                                                    item.id === state.selectedId
                                                "
                                            ></span
                                        ></span>
                                    </div>
                                    <h3>{{ item.name }}</h3>
                                    <p>
                                        {{ item.kind }} <span>·</span>
                                        {{ item.host }}:{{ item.port }}
                                    </p>
                                    <div class="node-card-bottom">
                                        <span
                                            :class="{
                                                live:
                                                    item.id ===
                                                    state.core.profileId,
                                            }"
                                            ><i></i
                                            >{{
                                                item.id === state.core.profileId
                                                    ? "运行中"
                                                    : "本地配置"
                                            }}</span
                                        ><span
                                            :title="
                                                state.measurements?.[item.id]
                                                    ?.error ||
                                                '通过节点请求 HTTPS 服务的响应时间'
                                            "
                                            >{{
                                                measureStage(
                                                    state.measurements?.[
                                                        item.id
                                                    ],
                                                ) ||
                                                (state.measurements?.[item.id]
                                                    ?.latencyMs != null
                                                    ? `${state.measurements[item.id].latencyMs} ms`
                                                    : state.measurements?.[
                                                            item.id
                                                        ]?.error
                                                      ? "检测失败"
                                                      : "延迟未测")
                                            }}</span
                                        >
                                    </div>
                                </button>
                                <div class="node-tools">
                                    <button
                                        class="measure-node"
                                        :disabled="
                                            busy ||
                                            measuring ||
                                            !!state.measuringId
                                        "
                                        @click="measure(item.id)"
                                    >
                                        测延迟</button
                                    ><button
                                        class="delete-node"
                                        :disabled="
                                            busy ||
                                            item.id === state.core.profileId ||
                                            item.id === state.measuringId
                                        "
                                        aria-label="删除配置"
                                        @click="remove(item)"
                                    >
                                        删除
                                    </button>
                                </div>
                            </article>
                        </div>
                        <div v-else class="empty-state">
                            <div class="empty-art">
                                <div class="orbit orbit-one"></div>
                                <div class="orbit orbit-two"></div>
                                <span class="empty-core"
                                    ><svg viewBox="0 0 40 40">
                                        <rect
                                            x="10"
                                            y="7"
                                            width="20"
                                            height="26"
                                            rx="4"
                                        />
                                        <path
                                            d="M15 15h10M15 21h10M15 27h4"
                                        /></svg></span
                                ><span class="satellite one"></span
                                ><span class="satellite two"></span>
                            </div>
                            <h3>
                                {{
                                    search || filter !== "all"
                                        ? "没有匹配的节点"
                                        : "添加你的第一个节点"
                                }}
                            </h3>
                            <p>
                                {{
                                    search || filter !== "all"
                                        ? "试试其他名称，或切换内核筛选。"
                                        : "粘贴节点链接或订阅地址，无需另外配置内核。"
                                }}
                            </p>
                            <button
                                v-if="!search && filter === 'all'"
                                class="button secondary"
                                :disabled="busy"
                                @click="
                                    showImport = true;
                                    error = '';
                                "
                            >
                                + 导入第一个节点
                            </button>
                        </div>
                    </section>
                    <section class="speed-panel">
                        <div class="speed-heading">
                            <div>
                                <h2>网络测速</h2>
                                <p>
                                    {{
                                        selected
                                            ? `通过「${selected.name}」检测 · 约消耗最多 12 MB`
                                            : "选择节点后可检测延迟和下载、上传速度"
                                    }}
                                </p>
                            </div>
                            <button
                                v-if="state.measuringId"
                                class="button secondary"
                                @click="cancelMeasure"
                            >
                                取消检测
                            </button>
                            <button
                                v-else
                                class="button secondary"
                                :disabled="busy || measuring || !selected"
                                @click="measure(selected.id, true)"
                            >
                                开始测速
                            </button>
                        </div>
                        <div class="speed-values">
                            <div>
                                <small>HTTP 延迟</small
                                ><strong>{{
                                    selectedMeasurement.latencyMs != null
                                        ? `${selectedMeasurement.latencyMs} ms`
                                        : "—"
                                }}</strong>
                            </div>
                            <div>
                                <small>下载速度</small
                                ><strong>{{
                                    rate(selectedMeasurement.downloadMbps)
                                }}</strong>
                            </div>
                            <div>
                                <small>上传速度</small
                                ><strong>{{
                                    rate(selectedMeasurement.uploadMbps)
                                }}</strong>
                            </div>
                        </div>
                        <p
                            v-if="
                                measureStage(selectedMeasurement) ||
                                selectedMeasurement.error ||
                                selectedMeasurement.testedAt
                            "
                            class="speed-note"
                            role="status"
                        >
                            {{
                                measureStage(selectedMeasurement) ||
                                selectedMeasurement.error ||
                                `最近检测 ${new Date(selectedMeasurement.testedAt).toLocaleTimeString()} · 测速结果受节点和测试服务影响`
                            }}
                        </p>
                    </section>

                    <div class="help-strip">
                        <span class="help-icon">i</span>
                        <p>
                            首次使用？<strong
                                >导入节点或订阅 → 选择节点 → 连接</strong
                            ><span
                                >连接时自动设置系统代理，断开后恢复原来的设置。</span
                            >
                        </p>
                        <button
                            @click="
                                showImport = true;
                                error = '';
                            "
                        >
                            导入节点 <span>↗</span>
                        </button>
                    </div>
                </template>

                <template v-else-if="page === 'settings'">
                    <section class="settings-card">
                        <div class="settings-heading">
                            <h2>系统代理</h2>
                            <p>
                                连接时接管支持 Windows
                                系统代理的应用，断开和退出时恢复原来的设置。
                            </p>
                        </div>
                        <div class="setting-row">
                            <div>
                                <h3>连接后自动设置系统代理</h3>
                                <p>HTTP / HTTPS · 独立运行，无需其他代理程序</p>
                            </div>
                            <button
                                class="button"
                                :class="
                                    state.systemProxy ? 'primary' : 'secondary'
                                "
                                :disabled="busy || state.tunEnabled"
                                :aria-pressed="state.systemProxy"
                                @click="
                                    act('setSystemProxy', !state.systemProxy)
                                "
                            >
                                {{
                                    state.tunEnabled
                                        ? "TUN 模式下暂停"
                                        : state.systemProxy
                                          ? "已开启"
                                          : "已关闭"
                                }}
                            </button>
                        </div>
                    </section>
                    <section class="settings-card">
                        <div class="settings-heading">
                            <h2>内置代理引擎</h2>
                            <p>
                                Xray 和 sing-box
                                已随程序提供，会根据节点类型自动选择，无需手动安装。
                            </p>
                        </div>
                        <div
                            v-for="kind in ['Xray', 'sing-box']"
                            :key="kind"
                            class="setting-row"
                        >
                            <span class="node-avatar">{{
                                kind === "Xray" ? "X" : "S"
                            }}</span>
                            <div>
                                <h3>{{ kind }}</h3>
                                <p
                                    class="binary-path"
                                    :title="state.binaries[kind]"
                                >
                                    {{
                                        state.bundled[kind]
                                            ? `已内置 · v${state.bundled[kind]}`
                                            : "随桌面程序内置"
                                    }}
                                </p>
                            </div>
                            <button
                                class="button secondary"
                                :disabled="busy"
                                @click="act('chooseBinary', kind)"
                            >
                                {{ "替换内核（高级）" }}
                            </button>
                        </div>
                    </section>
                    <section class="settings-card">
                        <div class="settings-heading">
                            <h2>关于此版本</h2>
                            <p>轻舟 · v{{ appVersion }}</p>
                        </div>
                        <div class="about-copy">
                            <p>
                                导入你的节点或订阅，选择线路后即可连接。连接引擎已随程序提供，不需要另行安装。
                            </p>
                            <p>
                                系统代理适用于遵循 Windows 代理设置的应用；TUN
                                模式通过虚拟网卡接管流量，局域网保持直连。断开或退出时清理连接设置。
                            </p>
                            <p>
                                连接状态表示本地代理已经就绪，远程线路能否访问仍取决于节点和网络。自定义配置需提供
                                HTTP 入站，才能自动设置系统代理。
                            </p>
                            <p>
                                节点信息保存在此设备。分享日志前，请注意其中可能包含的地址和连接信息。
                            </p>
                        </div>
                    </section></template
                >

                <template v-else
                    ><section class="logs-card">
                        <div class="logs-heading">
                            <h2>内核输出</h2>
                            <span :class="['process-badge', { live: running }]"
                                ><i></i
                                >{{
                                    running ? "进程运行中" : "进程未运行"
                                }}</span
                            >
                        </div>
                        <pre v-if="logText" class="log-output">{{
                            logText
                        }}</pre>
                        <div v-else class="log-empty">
                            <span>›_</span>
                            <h3>一切从启动开始</h3>
                            <p>
                                启动内核后，这里会显示它的标准输出和错误日志。
                            </p>
                            <button
                                class="button secondary"
                                @click="page = 'nodes'"
                            >
                                返回代理节点
                            </button>
                        </div>
                    </section>
                    <p class="log-note">
                        仅保留本次会话最近 300
                        条输出。日志可能包含节点地址，请谨慎分享。
                    </p></template
                >

                <footer>
                    <span
                        ><span class="footer-dot"></span>
                        {{ running ? "内核进程运行中" : "内核未运行" }}</span
                    ><span
                        >轻舟
                        <span class="footer-divider">/</span>
                        清晰连接 · 自在访问</span
                    >
                </footer>
            </div>
        </main>
        <div
            v-if="showImport"
            class="modal-backdrop"
            @click.self="!busy && (showImport = false)"
        >
            <section
                class="import-modal"
                role="dialog"
                aria-modal="true"
                aria-labelledby="import-title"
            >
                <div class="modal-heading">
                    <div>
                        <h2 id="import-title">导入节点或订阅</h2>
                        <p>直接粘贴链接，内核由程序自动选择。</p>
                    </div>
                    <button
                        class="close-modal"
                        :disabled="busy"
                        aria-label="关闭导入窗口"
                        @click="showImport = false"
                    >
                        ×
                    </button>
                </div>
                <form @submit.prevent="submitImport">
                    <label for="node-links"
                        >节点链接 / 订阅地址 / JSON 配置</label
                    ><textarea
                        id="node-links"
                        v-model="importContent"
                        :disabled="busy"
                        spellcheck="false"
                        placeholder="vless://…&#10;vmess://…&#10;trojan://…&#10;或粘贴 https:// 开头的订阅地址"
                        autofocus
                    ></textarea>
                    <p class="import-help">
                        支持
                        VLESS、VMess、Trojan、Shadowsocks、Hysteria2、TUIC，多个节点每行一个。
                    </p>
                    <p v-if="error" class="import-error" role="alert">
                        {{ error }}
                    </p>
                    <div class="modal-actions">
                        <button
                            type="button"
                            class="button secondary"
                            :disabled="busy"
                            @click="
                                act('importConfig').then(() => {
                                    if (!error && desktop) showImport = false;
                                })
                            "
                        >
                            从 JSON 文件导入</button
                        ><button
                            class="button primary"
                            :disabled="busy || !importContent.trim()"
                            type="submit"
                        >
                            {{ busy ? "正在导入…" : "导入节点" }}
                        </button>
                    </div>
                </form>
            </section>
        </div>
    </div>
</template>
