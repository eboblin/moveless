# Забирает живой проект с Move в assets/factory.json.
# Сначала новый путь, если файла нет — старый ptnmove.
#
#   powershell -File scripts/pull-project.ps1
#   powershell -File scripts/pull-project.ps1 -MoveHost move.local -Port 7700

param(
    [string]$MoveHost = "move.local",
    [int]$Port = 7700
)

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot
$Out = Join-Path $Root "assets\factory.json"
$Dist = Join-Path $Root "dist"
$base = "http://${MoveHost}:$Port"
$cookie = Join-Path $Dist "pull-cookies.txt"
$body = Join-Path $Dist "pull-body.txt"
$headers = Join-Path $Dist "pull-headers.txt"

$Candidates = @(
    "/data/UserData/schwung/moveless/project.json",
    "/data/UserData/schwung/ptnmove/project.json"
)

function Invoke-Checked {
    param([scriptblock]$Command)
    & $Command
    if ($LASTEXITCODE -ne 0) {
        throw "команда завершилась с кодом $LASTEXITCODE"
    }
}

function Test-StoredProject {
    param([string]$Text)
    if ([string]::IsNullOrWhiteSpace($Text)) { return $false }
    try {
        $data = $Text | ConvertFrom-Json
    } catch {
        return $false
    }
    return ($null -ne $data.version) -and ($null -ne $data.project)
}

New-Item -ItemType Directory -Path $Dist -Force | Out-Null

Write-Host "сессия Schwung Manager $base"
Invoke-Checked { curl.exe -sS -c $cookie -o NUL "$base/modules" }

$saved = $null
$used = $null
foreach ($path in $Candidates) {
    $query = [uri]::EscapeDataString($path)
    Write-Host "пробую $path"
    & curl.exe -sS -D $headers -o $body -b $cookie -c $cookie "$base/files/download?path=$query"
    if ($LASTEXITCODE -ne 0) { continue }
    $headerText = Get-Content $headers -Raw
    if ($headerText -notmatch 'HTTP/\d(?:\.\d)?\s+200') { continue }
    $text = Get-Content $body -Raw -Encoding utf8
    if (-not (Test-StoredProject $text)) { continue }
    $saved = $text
    $used = $path
    break
}

if (-not $saved) {
    throw "Schwung Manager не отдал project.json. Проверь, что Move доступен на $base и файл лежит в schwung/moveless или schwung/ptnmove."
}

$utf8 = New-Object System.Text.UTF8Encoding $false
[System.IO.File]::WriteAllText($Out, $saved.TrimEnd(), $utf8)
Write-Host "завод: assets/factory.json"
Write-Host "источник: $used"
