# Offline China routing rules

china-domains.json and china-ip.json are derived from the CN entries of geosite.dat and geoip.dat bundled with Xray 26.3.27. The domain suffix cn is additionally included. scripts/build-routing.cjs performs the conversion to sing-box source format version 3; the JSON files also supply Xray routing rules at runtime.

Upstream data: https://github.com/Loyalsoldier/v2ray-rules-dat (GPL-3.0; full license in LICENSE).
Xray release asset workflow: https://github.com/XTLS/Xray-core/blob/v26.3.27/.github/workflows/scheduled-assets-update.yml
Protobuf schema: https://github.com/XTLS/Xray-core/blob/v26.3.27/app/router/config.proto

Input SHA256 hashes and output entry counts are recorded in manifest.json. These are packaged snapshots, not automatically updated live lists. Rebuild with npm run build:routing after updating the verified bundled input datasets. The conversion script is distributed in this project as editable source.
