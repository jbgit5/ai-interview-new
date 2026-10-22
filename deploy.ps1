[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$ProjectRoot = $PSScriptRoot
$ConfigPath = Join-Path $ProjectRoot '.deploy-config.ps1'
$RemoteScriptSource = Join-Path $ProjectRoot 'deploy-screeno.sh'

function Stop-Deploy([string]$Message) {
    Write-Host "`nDEPLOYMENT STOPPED: $Message" -ForegroundColor Red
    exit 1
}

if (-not (Test-Path -LiteralPath $ConfigPath -PathType Leaf)) {
    Stop-Deploy "Missing .deploy-config.ps1. Copy .deploy-config.example.ps1 to .deploy-config.ps1 and set your EC2 host."
}
if (-not (Test-Path -LiteralPath $RemoteScriptSource -PathType Leaf)) {
    Stop-Deploy 'deploy-screeno.sh is missing. Keep it beside deploy.ps1.'
}

. $ConfigPath
if (-not (Get-Variable -Name DeployConfig -Scope Script -ErrorAction SilentlyContinue)) {
    Stop-Deploy '.deploy-config.ps1 must define $DeployConfig as a hashtable.'
}

$requiredConfig = @('Host', 'User', 'SshKeyPath', 'RemoteDeployScript', 'PublicUrl', 'CheckPublicUrl')
foreach ($name in $requiredConfig) {
    if (-not $DeployConfig.ContainsKey($name) -or [string]::IsNullOrWhiteSpace([string]$DeployConfig[$name])) {
        Stop-Deploy "Missing configuration value: $name"
    }
}
if ([string]$DeployConfig.Host -match 'REPLACE_WITH|YOUR_EC2_HOST') {
    Stop-Deploy 'Set Host in .deploy-config.ps1 to your EC2 public IP or DNS name.'
}

$HostName = [string]$DeployConfig.Host
$SshUser = [string]$DeployConfig.User
$SshKey = [string]$DeployConfig.SshKeyPath
$RemoteAppDir = [string]$DeployConfig.RemoteAppDir
$RemoteDeployScript = [string]$DeployConfig.RemoteDeployScript
$PublicUrl = [string]$DeployConfig.PublicUrl
$CheckPublicUrl = [bool]$DeployConfig.CheckPublicUrl
$Target = "$SshUser@$HostName"

if (-not (Test-Path -LiteralPath $SshKey -PathType Leaf)) { Stop-Deploy "SSH private key not found: $SshKey" }
if (-not (Test-Path -LiteralPath (Join-Path $ProjectRoot 'package.json') -PathType Leaf)) { Stop-Deploy 'package.json not found. Put deploy.ps1 in your project root.' }
if (-not (Test-Path -LiteralPath (Join-Path $ProjectRoot 'package-lock.json') -PathType Leaf)) { Stop-Deploy 'package-lock.json not found. This workflow expects npm ci/npm lockfile.' }
if (-not (Test-Path -LiteralPath (Join-Path $ProjectRoot '.env.local') -PathType Leaf)) { Stop-Deploy '.env.local was not found. Your known local build requires it; this file will not be uploaded.' }
if (-not (Test-Path -LiteralPath (Join-Path $ProjectRoot 'public') -PathType Container)) { Stop-Deploy 'public directory not found.' }
if (-not (Test-Path -LiteralPath (Join-Path $ProjectRoot 'next.config.mjs') -PathType Leaf)) { Stop-Deploy 'next.config.mjs not found. Update the script if your app uses a different config filename.' }

$sshCommand = Get-Command ssh -ErrorAction SilentlyContinue
$scpCommand = Get-Command scp -ErrorAction SilentlyContinue
$npmCommand = Get-Command npm.cmd -ErrorAction SilentlyContinue
if (-not $npmCommand) { $npmCommand = Get-Command npm -ErrorAction SilentlyContinue }
if (-not $sshCommand -or -not $scpCommand) { Stop-Deploy 'OpenSSH ssh.exe and scp.exe must be installed and available in PATH.' }
if (-not $npmCommand) { Stop-Deploy 'npm was not found in PATH.' }

$sshBaseArgs = @('-i', $SshKey, '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=3')
function Invoke-Remote([string]$RemoteCommand) {
    & $sshCommand.Source @sshBaseArgs $Target $RemoteCommand
    if ($LASTEXITCODE -ne 0) { throw "SSH command failed with exit code $LASTEXITCODE." }
}
function Get-NormalizedSha256([string]$Path) {
    $content = [System.IO.File]::ReadAllText($Path)
    $content = [regex]::Replace($content, "`r`n?", "`n")
    $bytes = [System.Text.UTF8Encoding]::new($false).GetBytes($content)
    $sha = [System.Security.Cryptography.SHA256]::Create()
    try {
        return ([System.BitConverter]::ToString($sha.ComputeHash($bytes))).Replace('-', '').ToLowerInvariant()
    } finally { $sha.Dispose() }
}

$timestamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$tempRoot = Join-Path $env:TEMP "screeno-deploy-$timestamp"
$zipPath = Join-Path $tempRoot "screeno-deploy-$timestamp.zip"
New-Item -ItemType Directory -Path $tempRoot -Force | Out-Null

try {
    Write-Host "`n[1/7] Checking SSH connection and preparing server directories..." -ForegroundColor Cyan
    Invoke-Remote "mkdir -p /home/ubuntu/apps/deploy-incoming /home/ubuntu/apps/backups && chmod 700 /home/ubuntu/apps/backups /home/ubuntu/apps/deploy-incoming"

    Write-Host "`n[2/7] Building the production application locally..." -ForegroundColor Cyan
    Push-Location $ProjectRoot
    try {
        & $npmCommand.Source run build
        if ($LASTEXITCODE -ne 0) { throw "npm run build failed with exit code $LASTEXITCODE. Production was not changed." }
    } finally { Pop-Location }

    $buildIdPath = Join-Path $ProjectRoot '.next/BUILD_ID'
    if (-not (Test-Path -LiteralPath $buildIdPath -PathType Leaf)) { throw 'Build did not produce .next/BUILD_ID. Production was not changed.' }
    $buildId = (Get-Content -LiteralPath $buildIdPath -Raw).Trim()
    if ([string]::IsNullOrWhiteSpace($buildId)) { throw 'The generated .next/BUILD_ID is empty. Production was not changed.' }
    Write-Host "Build succeeded. Build ID: $buildId" -ForegroundColor Green

    Write-Host "`n[3/7] Packaging only the deployment artifacts..." -ForegroundColor Cyan
    $pathsToZip = @(
        (Join-Path $ProjectRoot '.next'),
        (Join-Path $ProjectRoot 'public'),
        (Join-Path $ProjectRoot 'next.config.mjs')
    )
    Compress-Archive -LiteralPath $pathsToZip -DestinationPath $zipPath -CompressionLevel Optimal -Force

    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $archive = [System.IO.Compression.ZipFile]::OpenRead($zipPath)
    try {
        $entryNames = @($archive.Entries | ForEach-Object { $_.FullName.Replace('\', '/') })
        if (-not ($entryNames -contains '.next/BUILD_ID')) { throw 'Deployment ZIP does not contain .next/BUILD_ID. Production was not changed.' }
        if (-not ($entryNames -contains 'next.config.mjs')) { throw 'Deployment ZIP does not contain next.config.mjs. Production was not changed.' }
        if ($entryNames | Where-Object { $_ -match '(^|/)(\.env[^/]*|node_modules)(/|$)' }) { throw 'Deployment ZIP unexpectedly contains environment files or node_modules.' }
    } finally { $archive.Dispose() }

    $zipHash = (Get-FileHash -LiteralPath $zipPath -Algorithm SHA256).Hash.ToLowerInvariant()
    $packageHash = Get-NormalizedSha256 (Join-Path $ProjectRoot 'package.json')
    $lockHash = Get-NormalizedSha256 (Join-Path $ProjectRoot 'package-lock.json')
    Write-Host "Package created. SHA-256: $zipHash" -ForegroundColor Green

    Write-Host "`n[4/7] Uploading the server deployment script..." -ForegroundColor Cyan
    $remoteScriptTemp = "$RemoteDeployScript.uploading"
    & $scpCommand.Source @sshBaseArgs $RemoteScriptSource "${Target}:$remoteScriptTemp"
    if ($LASTEXITCODE -ne 0) { throw "Could not upload deployment script; SCP exit code $LASTEXITCODE." }
    Invoke-Remote "mv '$remoteScriptTemp' '$RemoteDeployScript' && chmod 750 '$RemoteDeployScript'"

    Write-Host "`n[5/7] Uploading the verified build ZIP..." -ForegroundColor Cyan
    $remoteZip = "/home/ubuntu/apps/deploy-incoming/screeno-$timestamp.zip"
    & $scpCommand.Source @sshBaseArgs $zipPath "${Target}:$remoteZip"
    if ($LASTEXITCODE -ne 0) { throw "Build upload failed; SCP exit code $LASTEXITCODE." }

    Write-Host "`n[6/7] Deploying on AWS (backup, restart, and local health check)..." -ForegroundColor Cyan
    $remoteCommand = "bash '$RemoteDeployScript' '$remoteZip' '$zipHash' '$packageHash' '$lockHash'"
    Invoke-Remote $remoteCommand

    if ($CheckPublicUrl) {
        Write-Host "`n[7/7] Checking public website: $PublicUrl" -ForegroundColor Cyan
        $publicHealthy = $false
        for ($attempt = 1; $attempt -le 4; $attempt++) {
            try {
                $response = Invoke-WebRequest -Uri $PublicUrl -Method Get -TimeoutSec 15 -MaximumRedirection 5 -UseBasicParsing
                $statusCode = [int]$response.StatusCode
                if ($statusCode -ge 200 -and $statusCode -lt 400) { $publicHealthy = $true; break }
                Write-Host "Public health check attempt $attempt returned HTTP $statusCode." -ForegroundColor Yellow
            } catch {
                Write-Host "Public health check attempt $attempt failed: $($_.Exception.Message)" -ForegroundColor Yellow
            }
            Start-Sleep -Seconds 4
        }
        if (-not $publicHealthy) {
            Write-Host 'Public health check failed. Requesting rollback to the previous production build...' -ForegroundColor Yellow
            try { Invoke-Remote "bash '$RemoteDeployScript' --rollback" }
            catch { throw "Public health check failed and the rollback command also reported an error. Check the AWS server immediately. Details: $($_.Exception.Message)" }
            throw "Public health check failed. The server-side script was asked to roll back. Check $PublicUrl and PM2 logs."
        }
        Write-Host 'Public website health check passed.' -ForegroundColor Green
    } else {
        Write-Host "`n[7/7] Public URL check disabled by configuration." -ForegroundColor Yellow
    }

    Write-Host "`nDEPLOYMENT SUCCEEDED. Previous production version is retained in the single backup archive on AWS." -ForegroundColor Green
} catch {
    Write-Host "`nERROR: $($_.Exception.Message)" -ForegroundColor Red
    exit 1
} finally {
    if (Test-Path -LiteralPath $tempRoot) {
        Remove-Item -LiteralPath $tempRoot -Recurse -Force -ErrorAction SilentlyContinue
    }
}
