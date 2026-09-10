# AeroPTT - Robust Standalone PowerShell Web & PTT Relay Server (Zero Dependencies)
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$publicDir = Join-Path $PSScriptRoot "public"

# Find local IP address
$ip = (Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue | Where-Object { $_.InterfaceAlias -notlike "*Loopback*" -and $_.IPAddress -notlike "169.254*" } | Select-Object -First 1).IPAddress
if (-not $ip) { $ip = "127.0.0.1" }

# Function to find an open port
function Get-FreePort([int]$startPort) {
    for ($p = $startPort; $p -lt ($startPort + 50); $p++) {
        try {
            $t = New-Object System.Net.Sockets.TcpListener([System.Net.IPAddress]::Any, $p)
            $t.Start()
            $t.Stop()
            return $p
        } catch {}
    }
    return $startPort
}

$port = Get-FreePort 8080
$wsPort = 8081

Clear-Host
Write-Host "================================================================" -ForegroundColor Cyan
Write-Host "             AEROPTT - TACTICAL WALKIE-TALKIE                   " -ForegroundColor Yellow
Write-Host "================================================================" -ForegroundColor Cyan
Write-Host " [OK] Server started successfully!" -ForegroundColor Green
Write-Host " [PC] Local URL:       http://localhost:$port" -ForegroundColor White
Write-Host " [PHONE] Mobile URL:  http://${ip}:${port}" -ForegroundColor Yellow
Write-Host "================================================================" -ForegroundColor Cyan
Write-Host " -> Open the Mobile URL on phones in the same Wi-Fi network" -ForegroundColor Green
Write-Host " -> Or scan the QR code inside the app" -ForegroundColor Green
Write-Host " -> Press Ctrl+C in this window to stop server" -ForegroundColor Gray
Write-Host "================================================================" -ForegroundColor Cyan

# Start Raw TCP-based HTTP Server (No http.sys conflicts)
$tcpListener = New-Object System.Net.Sockets.TcpListener([System.Net.IPAddress]::Any, $port)
$tcpListener.Start()

while ($true) {
    try {
        $client = $tcpListener.AcceptTcpClient()
        [System.Threading.ThreadPool]::QueueUserWorkItem({
            param($c)
            try {
                $stream = $c.GetStream()
                $reader = New-Object System.IO.StreamReader($stream, [System.Text.Encoding]::ASCII)
                $requestLine = $reader.ReadLine()
                if ([string]::IsNullOrEmpty($requestLine)) { $c.Close(); return }

                $parts = $requestLine.Split(' ')
                if ($parts.Length -lt 2) { $c.Close(); return }
                $reqPath = $parts[1].Split('?')[0].TrimStart('/')
                if ([string]::IsNullOrEmpty($reqPath)) { $reqPath = "index.html" }

                $targetFile = Join-Path $using:publicDir $reqPath
                if (Test-Path $targetFile -PathType Leaf) {
                    $bytes = [System.IO.File]::ReadAllBytes($targetFile)
                    $ext = [System.IO.Path]::GetExtension($targetFile).ToLower()
                    $mime = switch ($ext) {
                        ".html" { "text/html; charset=utf-8" }
                        ".css"  { "text/css; charset=utf-8" }
                        ".js"   { "application/javascript; charset=utf-8" }
                        ".json" { "application/json; charset=utf-8" }
                        ".svg"  { "image/svg+xml" }
                        ".png"  { "image/png" }
                        default { "application/octet-stream" }
                    }

                    $header = "HTTP/1.1 200 OK`r`n" +
                              "Content-Type: $mime`r`n" +
                              "Content-Length: $($bytes.Length)`r`n" +
                              "Access-Control-Allow-Origin: *`r`n" +
                              "Cache-Control: no-cache`r`n" +
                              "Connection: close`r`n`r`n"
                    $hBytes = [System.Text.Encoding]::ASCII.GetBytes($header)
                    $stream.Write($hBytes, 0, $hBytes.Length)
                    $stream.Write($bytes, 0, $bytes.Length)
                } else {
                    $notFound = [System.Text.Encoding]::ASCII.GetBytes("HTTP/1.1 404 Not Found`r`nContent-Length: 0`r`nConnection: close`r`n`r`n")
                    $stream.Write($notFound, 0, $notFound.Length)
                }
            } catch {}
            finally {
                try { $c.Close() } catch {}
            }
        }, $client) | Out-Null
    } catch {
        break
    }
}
