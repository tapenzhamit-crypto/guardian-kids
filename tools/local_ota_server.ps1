param (
    [int]$Port = 8080
)

# 1. Find local IPv4 address
$localIp = "127.0.0.1"
try {
    $ipObj = Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
        Where-Object { $_.InterfaceAlias -notmatch 'Loopback|vEthernet|Virtual' -and $_.IPAddress -notmatch '^169\.254\.' -and $_.IPAddress -notmatch '^127\.' } |
        Select-Object -First 1
    if ($ipObj) {
        $localIp = $ipObj.IPAddress
    }
} catch {}

# 2. Find latest APK in project
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$projectRoot = (Get-Item "$scriptDir\..").FullName

$apkCandidates = @(
    "$projectRoot\android\app\build\outputs\apk\debug\app-debug.apk",
    "$projectRoot\android\app\build\outputs\apk\release\app-release.apk",
    "$projectRoot\app-debug.apk"
)

$apkPath = $null
foreach ($c in $apkCandidates) {
    if (Test-Path $c) {
        $apkPath = $c
        break
    }
}

# 3. Find an available port and start TCP listener
$candidatePorts = @($Port, 8080, 8088, 8081, 8082, 8085, 8090, 8888) | Select-Object -Unique
$tcpListener = $null
$boundPort = 0

foreach ($p in $candidatePorts) {
    try {
        $candidate = New-Object System.Net.Sockets.TcpListener([System.Net.IPAddress]::Any, $p)
        $candidate.Start()
        $tcpListener = $candidate
        $boundPort = $p
        break
    } catch {
        if ($candidate) {
            try { $candidate.Stop() } catch {}
        }
    }
}

if (-not $tcpListener) {
    Write-Host "ERROR: Could not bind to any port in: $($candidatePorts -join ', ')" -ForegroundColor Red
    pause
    exit 1
}

$Port = $boundPort
$apkUrl = "http://${localIp}:${Port}/app-debug.apk"
$manifestUrl = "http://${localIp}:${Port}/version.json"

Clear-Host
Write-Host "=================================================================" -ForegroundColor Cyan
Write-Host "         GUARDIAN KIDS - LOCAL OTA UPDATE SERVER                 " -ForegroundColor Yellow
Write-Host "=================================================================" -ForegroundColor Cyan

if ($apkPath) {
    $sizeMb = [Math]::Round(((Get-Item $apkPath).Length / 1MB), 2)
    Write-Host "Found APK file : $apkPath ($sizeMb MB)" -ForegroundColor Green
} else {
    Write-Host "WARNING: APK file not found yet!" -ForegroundColor Red
    Write-Host "In Android Studio: Build -> Build Bundle(s) / APK(s) -> Build APK(s)" -ForegroundColor Yellow
}

Write-Host ""
Write-Host "-----------------------------------------------------------------" -ForegroundColor Gray
Write-Host "ENTER THIS URL IN GUARDIAN SETTINGS ON PHONE:" -ForegroundColor White
Write-Host "DIRECT APK URL : $apkUrl" -ForegroundColor Green
Write-Host "OR MANIFEST URL: $manifestUrl" -ForegroundColor Cyan
Write-Host "-----------------------------------------------------------------" -ForegroundColor Gray
Write-Host "Server is listening on port $Port (No admin rights required)..." -ForegroundColor White
Write-Host "Close this window to stop the server.`n" -ForegroundColor Gray

# Sync local version.json in project root with current local IP & port
try {
    $vFile = "$projectRoot\version.json"
    if (Test-Path $vFile) {
        $manifestObj = Get-Content $vFile -Raw -Encoding UTF8 | ConvertFrom-Json
        $manifestObj.apkUrl = $apkUrl
        $manifestJson = $manifestObj | ConvertTo-Json -Depth 5
        [System.IO.File]::WriteAllText($vFile, $manifestJson, [System.Text.Encoding]::UTF8)
    }
} catch {}

while ($true) {
    try {
        $client = $tcpListener.AcceptTcpClient()
        $stream = $client.GetStream()
        $reader = New-Object System.IO.StreamReader($stream)
        $requestLine = $reader.ReadLine()

        if (-not $requestLine) {
            $client.Close()
            continue
        }

        $parts = $requestLine.Split(" ")
        $method = $parts[0]
        $rawPath = if ($parts.Length -gt 1) { $parts[1] } else { "/" }
        $path = $rawPath.TrimStart('/')

        Write-Host "[$(Get-Date -Format 'HH:mm:ss')] $method $rawPath" -ForegroundColor Yellow

        if ($path -eq "version.json") {
            $vFile = "$projectRoot\version.json"
            $json = if (Test-Path $vFile) {
                Get-Content $vFile -Raw -Encoding UTF8
            } else {
                @{
                    versionCode = 2
                    versionName = "2.3.0"
                    apkUrl = $apkUrl
                    changelog = "Guardian Kids Update"
                } | ConvertTo-Json
            }

            $bodyBytes = [System.Text.Encoding]::UTF8.GetBytes($json)
            $header = "HTTP/1.1 200 OK`r`nContent-Type: application/json; charset=utf-8`r`nContent-Length: $($bodyBytes.Length)`r`nAccess-Control-Allow-Origin: *`r`nConnection: close`r`n`r`n"
            $headerBytes = [System.Text.Encoding]::ASCII.GetBytes($header)
            $stream.Write($headerBytes, 0, $headerBytes.Length)
            $stream.Write($bodyBytes, 0, $bodyBytes.Length)
            $stream.Flush()
            Write-Host "  -> Delivered version.json manifest" -ForegroundColor Green
        }
        elseif ($path -match '\.apk$' -or $path -eq "" -or $path -eq "app-debug.apk") {
            if ($apkPath -and (Test-Path $apkPath)) {
                $fileInfo = Get-Item $apkPath
                $header = "HTTP/1.1 200 OK`r`nContent-Type: application/vnd.android.package-archive`r`nContent-Length: $($fileInfo.Length)`r`nContent-Disposition: attachment; filename=`"app-debug.apk`"`r`nAccess-Control-Allow-Origin: *`r`nConnection: close`r`n`r`n"
                $headerBytes = [System.Text.Encoding]::ASCII.GetBytes($header)
                $stream.Write($headerBytes, 0, $headerBytes.Length)

                $fileStream = [System.IO.File]::OpenRead($apkPath)
                $chunkBuffer = New-Object byte[] 65536
                $read = 0
                while (($read = $fileStream.Read($chunkBuffer, 0, $chunkBuffer.Length)) -gt 0) {
                    $stream.Write($chunkBuffer, 0, $read)
                }
                $fileStream.Close()
                $stream.Flush()
                Write-Host "  -> Delivered APK file ($([Math]::Round($fileInfo.Length/1MB, 2)) MB)" -ForegroundColor Green
            } else {
                $errMsg = "APK file not found on server."
                $bodyBytes = [System.Text.Encoding]::UTF8.GetBytes($errMsg)
                $header = "HTTP/1.1 404 Not Found`r`nContent-Type: text/plain`r`nContent-Length: $($bodyBytes.Length)`r`n`r`n"
                $headerBytes = [System.Text.Encoding]::ASCII.GetBytes($header)
                $stream.Write($headerBytes, 0, $headerBytes.Length)
                $stream.Write($bodyBytes, 0, $bodyBytes.Length)
                $stream.Flush()
                Write-Host "  -> 404 APK Not Found" -ForegroundColor Red
            }
        }
        else {
            $html = "<html><body><h1>Guardian Kids Local OTA Server</h1><p><a href='/app-debug.apk'>Download app-debug.apk</a></p><p><a href='/version.json'>View version.json</a></p></body></html>"
            $bodyBytes = [System.Text.Encoding]::UTF8.GetBytes($html)
            $header = "HTTP/1.1 200 OK`r`nContent-Type: text/html; charset=utf-8`r`nContent-Length: $($bodyBytes.Length)`r`nConnection: close`r`n`r`n"
            $headerBytes = [System.Text.Encoding]::ASCII.GetBytes($header)
            $stream.Write($headerBytes, 0, $headerBytes.Length)
            $stream.Write($bodyBytes, 0, $bodyBytes.Length)
            $stream.Flush()
        }

        $client.Close()
    } catch {
        # Silent ignore connection reset
    }
}
