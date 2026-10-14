# clare installer for Windows — connects Claude Code on this computer to clare.
#
#   $env:CLARE_CODE='<enrollment-code>'; irm __CLARE_WEB_URL__/install.ps1 | iex
#
# Downloads one small program (clare.exe), then Windows asks "Do you want to allow
# this app to make changes?" once — click Yes so it can install Claude Code managed settings.
#
# For testing: $env:CLARE_BINARY skips the download; $env:CLARE_API_URL,
# $env:CLARE_WEB_URL and $env:CLARE_RELEASES_URL override the built-in addresses.

$ErrorActionPreference = 'Stop'

function Fail([string]$msg) {
  Write-Host ''
  Write-Host "  $msg" -ForegroundColor Red
  Write-Host ''
  exit 1
}

$Code = $env:CLARE_CODE
if (-not $Code -and $args.Count -gt 0) { $Code = [string]$args[0] }
$Api = if ($env:CLARE_API_URL) { $env:CLARE_API_URL } else { '__CLARE_API_URL__' }
$Web = if ($env:CLARE_WEB_URL) { $env:CLARE_WEB_URL } else { '__CLARE_WEB_URL__' }
$Releases = if ($env:CLARE_RELEASES_URL) { $env:CLARE_RELEASES_URL } else { '__CLARE_RELEASES_URL__' }

Write-Host ''
if (-not $Code) { Fail 'The enrollment code is missing. In your clare dashboard choose Add a device, open the link, and copy the command from there.' }
if ($Api -like '*__CLARE_*') { Fail 'This installer has no server address yet. Build it with scripts/build.mjs (or set $env:CLARE_API_URL).' }
if ($Web -like '*__CLARE_*') { $Web = '' }

if ($env:PROCESSOR_ARCHITECTURE -ne 'AMD64' -and $env:PROCESSOR_ARCHITEW6432 -ne 'AMD64') {
  Fail "Sorry, this kind of computer isn't supported yet."
}

$dir = Join-Path $env:TEMP ('clare-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $dir | Out-Null
$bin = Join-Path $dir 'clare.exe'

if ($env:CLARE_BINARY) {
  Copy-Item $env:CLARE_BINARY $bin
} else {
  if ($Releases -like '*__CLARE_*') { Fail 'This installer has no download address yet. Build it with scripts/build.mjs (or set $env:CLARE_RELEASES_URL).' }
  Write-Host '  Downloading clare...'
  try {
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    Invoke-WebRequest -Uri "$Releases/clare-windows-amd64.exe" -OutFile $bin -UseBasicParsing
  } catch {
    Fail "Couldn't download clare. Check your internet connection and try again."
  }
}

# --no-browser: the person is already on the enrollment page, which offers the browser step.
$enrollArgs = @('enroll', $Code, '--api', $Api, '--no-browser', '--pause')
if ($Web) { $enrollArgs += @('--web', $Web) }

Write-Host ''
Write-Host '  Windows will ask if clare can make changes. Click "Yes" to finish setting up.'
Write-Host ''

try {
  # A new window opens with administrator rights; it waits for Enter before closing.
  $p = Start-Process -FilePath $bin -ArgumentList $enrollArgs -Verb RunAs -Wait -PassThru
} catch {
  Fail 'clare needs permission to set up. Run the command again and click "Yes".'
}

Remove-Item -Recurse -Force $dir -ErrorAction SilentlyContinue
if ($p.ExitCode -eq 0) {
  Write-Host "  All set! Claude Code on this computer is now connected to clare." -ForegroundColor Green
} else {
  Write-Host "  Setup didn't finish. Check the other window for what went wrong, then try again." -ForegroundColor Yellow
}
Write-Host ''
