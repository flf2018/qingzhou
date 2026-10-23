$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new()
$request = $env:V2RAYN_PROXY_REQUEST | ConvertFrom-Json
$key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Software\Microsoft\Windows\CurrentVersion\Internet Settings', $true)
if (!$key) { throw 'Cannot open current-user Internet Settings' }
try {
    if ($request.operation -eq 'read') {
        $result = @{}
        foreach ($name in @('ProxyEnable','ProxyServer','ProxyOverride','AutoConfigURL')) {
            $exists = $key.GetValueNames() -contains $name
            $result[$name] = @{ exists = $exists; value = $null; kind = 'String' }
            if ($exists) { $result[$name].value = $key.GetValue($name); $result[$name].kind = $key.GetValueKind($name).ToString() }
        }
        $result | ConvertTo-Json -Depth 5 -Compress
        return
    }
    if ($request.operation -ne 'write') { throw 'Unknown proxy operation' }
    foreach ($property in $request.values.PSObject.Properties) {
        if ($property.Name -notin @('ProxyEnable','ProxyServer','ProxyOverride','AutoConfigURL')) { throw 'Unknown registry value' }
        if (!$property.Value.exists) { $key.DeleteValue($property.Name, $false); continue }
        $kind = [Enum]::Parse([Microsoft.Win32.RegistryValueKind], [string]$property.Value.kind)
        $value = $property.Value.value
        if ($kind -eq [Microsoft.Win32.RegistryValueKind]::DWord) { $value = [int]$value }
        $key.SetValue($property.Name, $value, $kind)
    }
    $key.Flush()
    Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public static class ProxyRefresh { [DllImport("wininet.dll", SetLastError=true)] public static extern bool InternetSetOption(IntPtr h, int option, IntPtr buffer, int length); }'
    if (![ProxyRefresh]::InternetSetOption([IntPtr]::Zero,39,[IntPtr]::Zero,0)) { throw 'Internet settings refresh failed' }
    if (![ProxyRefresh]::InternetSetOption([IntPtr]::Zero,37,[IntPtr]::Zero,0)) { throw 'Internet options refresh failed' }
    '{"ok":true}'
} finally { $key.Dispose() }
