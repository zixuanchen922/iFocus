param(
  [string]$IpAddress = ""
)

$ErrorActionPreference = "Stop"
$repoRoot = Split-Path -Parent $PSScriptRoot
$certDirectory = Join-Path $repoRoot "certs"
$pfxFile = Join-Path $certDirectory "ifocus.pfx"
$passphraseFile = Join-Path $certDirectory "ifocus-pfx-passphrase.txt"
$rootCaFile = Join-Path $certDirectory "ifocus-rootCA.cer"
$rootSubject = "CN=iFocus Local Development CA"

function Find-LanAddress {
  $addresses = @(& ipconfig.exe | ForEach-Object {
    if ($_ -match "IPv4[^:]*:\s*(\d+\.\d+\.\d+\.\d+)") { $Matches[1] }
  }) | Where-Object { $_ -notlike "127.*" -and $_ -notlike "169.254.*" } | Select-Object -Unique
  if (-not $addresses) { throw "No LAN IPv4 address found. Pass -IpAddress explicitly." }

  $preferred = $addresses | Where-Object { $_ -like "192.168.*" } | Select-Object -First 1
  if (-not $preferred) {
    $preferred = $addresses | Where-Object {
      $_ -match "^172\.(1[6-9]|2\d|3[01])\." -or $_ -like "10.*"
    } | Select-Object -First 1
  }
  if ($preferred) { return $preferred }
  return $addresses[0]
}

function New-RandomPassphrase {
  $bytes = New-Object byte[] 32
  $generator = New-Object System.Security.Cryptography.RNGCryptoServiceProvider
  try { $generator.GetBytes($bytes) } finally { $generator.Dispose() }
  return [Convert]::ToBase64String($bytes)
}

if (-not $IpAddress) { $IpAddress = Find-LanAddress }
$parsedAddress = $null
if (-not [System.Net.IPAddress]::TryParse($IpAddress, [ref]$parsedAddress)) {
  throw "Invalid IP address: $IpAddress"
}

New-Item -ItemType Directory -Force -Path $certDirectory | Out-Null

$rootCertificate = Get-ChildItem Cert:\CurrentUser\My |
  Where-Object {
    $_.Subject -eq $rootSubject -and
    $_.HasPrivateKey -and
    $_.NotAfter -gt (Get-Date).AddDays(30)
  } |
  Sort-Object NotAfter -Descending |
  Select-Object -First 1

if (-not $rootCertificate) {
  Write-Host "Creating the iFocus local development CA..."
  $rootCertificate = New-SelfSignedCertificate `
    -Type Custom `
    -Subject $rootSubject `
    -FriendlyName "iFocus Local Development CA" `
    -KeyAlgorithm RSA `
    -KeyLength 2048 `
    -HashAlgorithm SHA256 `
    -KeyExportPolicy NonExportable `
    -KeyUsage CertSign, CRLSign, DigitalSignature `
    -TextExtension @("2.5.29.19={critical}{text}ca=1&pathlength=1") `
    -CertStoreLocation "Cert:\CurrentUser\My" `
    -NotAfter (Get-Date).AddYears(5)
}

Export-Certificate -Cert $rootCertificate -FilePath $rootCaFile -Force | Out-Null
$trustedRoot = Get-ChildItem Cert:\CurrentUser\Root | Where-Object { $_.Thumbprint -eq $rootCertificate.Thumbprint }
if (-not $trustedRoot) {
  Write-Host "Trusting the iFocus CA for the current Windows user..."
  & certutil.exe -user -addstore -f Root $rootCaFile | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "Failed to trust the iFocus CA in the current user store." }
}

Write-Host "Creating a server certificate for localhost and $IpAddress..."
$serverCertificate = New-SelfSignedCertificate `
  -Type Custom `
  -Subject "CN=$IpAddress" `
  -FriendlyName "iFocus HTTPS $IpAddress" `
  -Signer $rootCertificate `
  -KeyAlgorithm RSA `
  -KeyLength 2048 `
  -HashAlgorithm SHA256 `
  -KeyExportPolicy Exportable `
  -KeyUsage DigitalSignature, KeyEncipherment `
  -TextExtension @(
    "2.5.29.17={text}DNS=localhost&IPAddress=127.0.0.1&IPAddress=::1&IPAddress=$IpAddress",
    "2.5.29.37={text}1.3.6.1.5.5.7.3.1"
  ) `
  -CertStoreLocation "Cert:\CurrentUser\My" `
  -NotAfter (Get-Date).AddYears(2)

$passphrase = New-RandomPassphrase
$securePassphrase = ConvertTo-SecureString -String $passphrase -AsPlainText -Force
Export-PfxCertificate `
  -Cert $serverCertificate `
  -FilePath $pfxFile `
  -Password $securePassphrase `
  -ChainOption BuildChain `
  -Force | Out-Null
Set-Content -LiteralPath $passphraseFile -Value $passphrase -Encoding Ascii -NoNewline

Write-Host ""
Write-Host "Certificates created:"
Write-Host "  Server PFX: $pfxFile"
Write-Host "  PFX passphrase: $passphraseFile"
Write-Host "  Mobile CA file: $rootCaFile"
Write-Host ""
Write-Host "Next: npm run build, then npm run demo:video"
Write-Host "Phone page: https://${IpAddress}:4174/?camera=1"
Write-Host "MJPEG feed: https://${IpAddress}:4174/video_feed"
Write-Warning "Install only ifocus-rootCA.cer on the phone. The CA private key stays in the Windows certificate store."
