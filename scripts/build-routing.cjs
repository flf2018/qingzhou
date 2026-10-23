// Extract CN entries from the already verified bundled Xray protobuf datasets.
// Schema: XTLS/Xray-core v26.3.27 app/router/config.proto.
const fs = require("node:fs");
const path = require("node:path");
const { createHash } = require("node:crypto");
function fields(buffer) {
    const result = [];
    let offset = 0;
    const integer = () => {
        let value = 0,
            shift = 0;
        for (let n = 0; n < 10; n++) {
            if (offset >= buffer.length) throw Error("Truncated protobuf");
            const byte = buffer[offset++];
            value += (byte & 127) * 2 ** shift;
            if (!(byte & 128)) return value;
            shift += 7;
        }
        throw Error("Invalid protobuf integer");
    };
    while (offset < buffer.length) {
        const key = integer(),
            tag = Math.floor(key / 8),
            wire = key & 7;
        let value;
        if (wire === 0) value = integer();
        else if (wire === 2) {
            const size = integer();
            if (size > buffer.length - offset)
                throw Error("Invalid protobuf length");
            value = buffer.subarray(offset, offset + size);
            offset += size;
        } else if (wire === 1) {
            offset += 8;
            continue;
        } else if (wire === 5) {
            offset += 4;
            continue;
        } else throw Error("Unsupported protobuf wire");
        result.push({ tag, value });
    }
    return result;
}
function country(data, code) {
    for (const entry of fields(data)) {
        if (entry.tag !== 1 || !Buffer.isBuffer(entry.value)) continue;
        const parts = fields(entry.value);
        if (
            parts
                .find((f) => f.tag === 1)
                ?.value.toString()
                .toLowerCase() === code
        )
            return parts.filter((f) => f.tag === 2).map((f) => fields(f.value));
    }
    throw Error(`Missing ${code} dataset`);
}
function build() {
    const root = path.resolve(__dirname, ".."),
        output = path.join(root, "vendor/routing");
    fs.mkdirSync(output, { recursive: true });
    const sites = fs.readFileSync(
        path.join(root, "vendor/cores/xray/geosite.dat"),
    );
    const ips = fs.readFileSync(path.join(root, "vendor/cores/xray/geoip.dat"));
    const grouped = {
        domain_keyword: [],
        domain_regex: [],
        domain_suffix: ["cn"],
        domain: [],
    };
    const names = ["domain_keyword", "domain_regex", "domain_suffix", "domain"];
    for (const entry of country(sites, "cn")) {
        const kind = entry.find((f) => f.tag === 1)?.value || 0;
        const value = entry.find((f) => f.tag === 2)?.value.toString();
        if (!names[kind] || !value) throw Error("Invalid geosite entry");
        grouped[names[kind]].push(value);
    }
    const cidrs = country(ips, "cn").map((entry) => {
        const bytes = entry.find((f) => f.tag === 1)?.value,
            prefix = entry.find((f) => f.tag === 2)?.value || 0;
        if (
            !bytes ||
            ![4, 16].includes(bytes.length) ||
            prefix > bytes.length * 8
        )
            throw Error("Invalid CIDR");
        const address =
            bytes.length === 4
                ? [...bytes].join(".")
                : Array.from({ length: 8 }, (_, i) =>
                      bytes.readUInt16BE(i * 2).toString(16),
                  ).join(":");
        return `${address}/${prefix}`;
    });
    const domainRules = Object.entries(grouped)
        .filter(([, values]) => values.length)
        .map(([key, values]) => ({ [key]: [...new Set(values)].sort() }));
    fs.writeFileSync(
        path.join(output, "china-domains.json"),
        JSON.stringify({ version: 3, rules: domainRules }),
    );
    fs.writeFileSync(
        path.join(output, "china-ip.json"),
        JSON.stringify({ version: 3, rules: [{ ip_cidr: cidrs }] }),
    );
    fs.writeFileSync(
        path.join(output, "manifest.json"),
        JSON.stringify(
            {
                source: "Loyalsoldier/v2ray-rules-dat via bundled Xray 26.3.27; CN entries only",
                upstream: "https://github.com/Loyalsoldier/v2ray-rules-dat",
                license: "GPL-3.0",
                schema: "https://github.com/XTLS/Xray-core/blob/v26.3.27/app/router/config.proto",
                geositeSha256: createHash("sha256").update(sites).digest("hex"),
                geoipSha256: createHash("sha256").update(ips).digest("hex"),
                domains: domainRules.reduce(
                    (sum, rule) => sum + Object.values(rule)[0].length,
                    0,
                ),
                cidrs: cidrs.length,
            },
            null,
            2,
        ) + "\n",
    );
    console.log(
        `Offline routing rules: ${domainRules.reduce((sum, rule) => sum + Object.values(rule)[0].length, 0)} domains, ${cidrs.length} CN IP ranges.`,
    );
}
if (require.main === module) build();
module.exports = { fields, country, build };
