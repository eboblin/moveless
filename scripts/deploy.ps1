# Собирает ptnmove и ставит его через Schwung Manager.
# Модуль оказывается в /data/UserData/schwung/modules/overtake/ptnmove.
#
#   powershell -File scripts/deploy.ps1
#   powershell -File scripts/deploy.ps1 -MoveHost move.local -Port 7700
#   powershell -File scripts/deploy.ps1 -PackageOnly

param(
    [string]$MoveHost = "move.local",
    [int]$Port = 7700,
    [switch]$PackageOnly,
    [switch]$SkipDsp
)

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot
$Stage = Join-Path $Root "dist\ptnmove"
$Tarball = Join-Path $Root "dist\ptnmove-module.tar.gz"
$Dsp = Join-Path $Root "dsp.so"

function Invoke-Checked {
    param([scriptblock]$Command)
    & $Command
    if ($LASTEXITCODE -ne 0) {
        throw "команда завершилась с кодом $LASTEXITCODE"
    }
}

Set-Location $Root

Write-Host "сборка ui.js"
Invoke-Checked { npm run build }

if (-not $SkipDsp) {
    $voice = Join-Path $Root "dsp\src\voice.c"
    $dspFresh = (Test-Path $Dsp) -and ((Get-Item $Dsp).LastWriteTime -ge (Get-Item $voice).LastWriteTime)
    if (-not $dspFresh) {
        Write-Host "сборка dsp.so под AArch64"
        Invoke-Checked { docker build -t ptnmove-dsp (Join-Path $Root "dsp") }
        $srcMount = (Join-Path $Root "dsp") -replace '\\', '/'
        $outMount = $Root -replace '\\', '/'
        Invoke-Checked {
            docker run --rm -v "${srcMount}:/src" -v "${outMount}:/out" ptnmove-dsp bash -lc "aarch64-linux-gnu-gcc -O2 -Wall -Werror -shared -fPIC -o /out/dsp.so src/voice.c -lm -Wl,--version-script=src/plugin.lds"
        }
    }
}

if (-not (Test-Path $Dsp)) {
    throw "нет dsp.so. Собери его без -SkipDsp: в образ нужен Docker."
}

Write-Host "пакет dist/ptnmove-module.tar.gz"
if (Test-Path $Stage) { Remove-Item -Recurse -Force $Stage }
New-Item -ItemType Directory -Path $Stage | Out-Null
Copy-Item (Join-Path $Root "module.json") $Stage
Copy-Item (Join-Path $Root "ui.js") $Stage
Copy-Item $Dsp $Stage
if (Test-Path $Tarball) { Remove-Item -Force $Tarball }
Invoke-Checked { tar -czf $Tarball -C (Join-Path $Root "dist") ptnmove }

$listing = tar -tf $Tarball
foreach ($name in @("ptnmove/module.json", "ptnmove/ui.js", "ptnmove/dsp.so")) {
    if ($listing -notcontains $name) {
        throw "в архиве нет $name"
    }
}

if ($PackageOnly) {
    Write-Host "архив готов: $Tarball"
    Write-Host "установка: powershell -File scripts/deploy.ps1"
    exit 0
}

$base = "http://${MoveHost}:$Port"
$cookie = Join-Path $Root "dist\deploy-cookies.txt"
$headers = Join-Path $Root "dist\deploy-headers.txt"
Write-Host "установка через $base"
Invoke-Checked { curl.exe -sS -c $cookie -o NUL "$base/modules" }
$csrfLine = Get-Content $cookie | Where-Object { $_ -notmatch '^#' -and $_ -match 'csrf_token' } | Select-Object -Last 1
if (-not $csrfLine) {
    throw "Schwung Manager не отдал csrf_token. Открой $base и проверь, что страница модулей жива."
}
$token = ($csrfLine -split "`t")[-1].Trim()

Invoke-Checked {
    curl.exe -sS -D $headers -o NUL -b $cookie -c $cookie `
        -F "csrf_token=$token" `
        -F "source=tarball" `
        -F "file=@$Tarball;type=application/gzip" `
        "$base/modules/install-custom"
}

$headerText = Get-Content $headers -Raw
if ($headerText -notmatch 'HTTP/\d(?:\.\d)?\s+303') {
    throw "менеджер не принял архив:`n$headerText"
}
$location = ([regex]::Match($headerText, '(?im)^Location:\s*(\S+)')).Groups[1].Value
$flash = ""
if ($location -match 'flash=([^&]+)') {
    $flash = [uri]::UnescapeDataString($Matches[1].Replace('+', ' '))
}
if ($flash -notmatch 'Installed') {
    throw "установка не прошла: $flash"
}

Write-Host $flash
Write-Host "модуль: /data/UserData/schwung/modules/overtake/ptnmove"
Write-Host "на Move открой раздел overtake в Schwung и выбери ptnmove."
Write-Host "если ptnmove уже запускали после загрузки, перезапусти Move, чтобы подхватить новый dsp.so."
Write-Host "выйти из модуля: Shift + касание громкости + нажатие джога."
