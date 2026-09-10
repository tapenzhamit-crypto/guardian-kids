# Generate self-signed certificate for AeroPTT HTTPS
$cert = New-SelfSignedCertificate -DnsName "localhost", "192.168.0.15", "AeroPTT" -CertStoreLocation "Cert:\CurrentUser\My" -NotAfter (Get-Date).AddYears(5)
$pwd = ConvertTo-SecureString -String "aeroptt" -Force -AsPlainText
$pfxPath = Join-Path $PSScriptRoot "server.pfx"
Export-PfxCertificate -Cert $cert -FilePath $pfxPath -Password $pwd | Out-Null
Write-Host "[OK] SSL Certificate generated at $pfxPath" -ForegroundColor Green
