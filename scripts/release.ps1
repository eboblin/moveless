# Выпускает moveless в Schwung Manager.
# Обычный коммит в main ничего не публикует. Эта команда поднимает version
# в module.json, прогоняет проверки, пушит main, ставит тег vX.Y.Z и ждёт,
# пока GitHub Actions соберёт архив и обновит release.json.
#
#   npm run release
#   npm run release -- minor
#   npm run release -- major
#   npm run release -- 0.2.0

param(
    [Parameter(Position = 0)]
    [string]$Version = "patch"
)

$ErrorActionPreference = "Stop"
# В PowerShell 7 ненулевой код git сам прерывает скрипт. Отсутствие тега — норма.
$PSNativeCommandUseErrorActionPreference = $false
$Root = Split-Path -Parent $PSScriptRoot
$Manifest = Join-Path $Root "module.json"
$Utf8 = New-Object System.Text.UTF8Encoding $false

function Invoke-Checked {
    param([scriptblock]$Command)
    & $Command
    if ($LASTEXITCODE -ne 0) {
        throw "команда завершилась с кодом $LASTEXITCODE"
    }
}

function Get-NextVersion {
    param([version]$Current, [string]$Spec)
    $spec = $Spec.Trim().TrimStart("v", "V")
    switch ($spec) {
        "patch" { return "{0}.{1}.{2}" -f $Current.Major, $Current.Minor, ($Current.Build + 1) }
        "minor" { return "{0}.{1}.0" -f $Current.Major, ($Current.Minor + 1) }
        "major" { return "{0}.0.0" -f ($Current.Major + 1) }
        default {
            if ($spec -notmatch '^\d+\.\d+\.\d+$') {
                throw "версия должна быть patch, minor, major или номер вида 1.2.3"
            }
            return $spec
        }
    }
}

Set-Location $Root

$branch = git branch --show-current
if ($LASTEXITCODE -ne 0) { throw "не удалось прочитать текущую ветку" }
if ($branch -ne "main") {
    throw "релиз ставится с ветки main, сейчас $branch"
}

$dirty = git status --porcelain
if ($LASTEXITCODE -ne 0) { throw "не удалось прочитать git status" }
if ($dirty) {
    throw "сначала закоммить или убери незакоммиченные изменения. релиз помечает текущий main, а не черновик."
}

Write-Host "сверка с origin/main"
Invoke-Checked { git fetch origin }
$behind = git rev-list --count HEAD..origin/main
$ahead = git rev-list --count origin/main..HEAD
if ($LASTEXITCODE -ne 0) { throw "не удалось сравнить main с origin" }
if ([int]$behind -gt 0 -and [int]$ahead -gt 0) {
    throw "локальный main разошёлся с origin/main. сначала сложи историю."
}
if ([int]$behind -gt 0) {
    Write-Host "подтягиваю origin/main"
    Invoke-Checked { git pull --ff-only origin main }
}

$raw = [IO.File]::ReadAllText($Manifest)
$versionMatch = [regex]::Match($raw, '"version"\s*:\s*"(\d+\.\d+\.\d+)"')
if (-not $versionMatch.Success) {
    throw "в module.json нет version вида 1.2.3"
}
$currentText = $versionMatch.Groups[1].Value
$current = [version]$currentText
$next = Get-NextVersion $current $Version
$nextVersion = [version]$next
if ($nextVersion -le $current) {
    throw "новая версия $next не выше текущей $currentText"
}
$tag = "v$next"

$localTag = git rev-parse -q --verify "refs/tags/$tag"
if ($localTag) { throw "тег $tag уже есть локально" }
$remoteTag = git ls-remote --tags origin "refs/tags/$tag"
if ($LASTEXITCODE -ne 0) { throw "не удалось проверить тег на origin" }
if ($remoteTag) { throw "тег $tag уже есть на origin" }

$remote = git remote get-url origin
if ($remote -notmatch 'github\.com[:/]([^/]+)/([^/\s]+?)(?:\.git)?$') {
    throw "origin не похож на GitHub-репозиторий: $remote"
}
$repo = "$($Matches[1])/$($Matches[2])"

$bytes = [IO.File]::ReadAllBytes($Manifest)
$quoted = $versionMatch.Value
$replacement = [regex]::Replace($quoted, '\d+\.\d+\.\d+', $next)
$updated = $raw.Remove($versionMatch.Index, $versionMatch.Length).Insert($versionMatch.Index, $replacement)
if ($updated -eq $raw) { throw "не смог заменить version в module.json" }
[IO.File]::WriteAllText($Manifest, $updated, $Utf8)

try {
    Write-Host "проверки перед $tag"
    Invoke-Checked { npm test }
    Invoke-Checked { npm run typecheck }
} catch {
    [IO.File]::WriteAllBytes($Manifest, $bytes)
    throw
}

Write-Host "коммит $tag"
Invoke-Checked { git add -- module.json }
Invoke-Checked { git commit -m "Release $tag so Schwung Manager can offer this build." }
Invoke-Checked { git push origin HEAD:main }
Invoke-Checked { git tag $tag }
try {
    Invoke-Checked { git push origin $tag }
} catch {
    throw "коммит уже на main, а тег $tag не ушёл. когда починишь пуш: git push origin $tag"
}

$sha = (git rev-parse HEAD).Trim()
if ($LASTEXITCODE -ne 0 -or -not $sha) { throw "не удалось прочитать коммит релиза" }
$url = "https://api.github.com/repos/$repo/actions/runs?per_page=20"
$deadline = (Get-Date).AddMinutes(15)
$run = $null
Write-Host "жду сборку $tag"
while ((Get-Date) -lt $deadline) {
    $body = curl.exe -sS $url
    if ($LASTEXITCODE -ne 0) { throw "GitHub API не ответил. тег $tag уже отправлен, сборку смотри в Actions." }
    $data = $body | ConvertFrom-Json
    if (-not $data.workflow_runs) {
        $message = $data.message
        if ($message) { throw "GitHub API: $message. тег $tag уже отправлен." }
    }
    $run = @($data.workflow_runs) | Where-Object { $_.head_sha -eq $sha -and $_.name -eq "Release" } | Select-Object -First 1
    if ($run -and $run.status -eq "completed") { break }
    if ($run) { Write-Host "сборка: $($run.status)" } else { Write-Host "сборка ещё не появилась" }
    Start-Sleep -Seconds 20
}

if (-not $run -or $run.status -ne "completed") {
    throw "сборка $tag не закончилась за 15 минут: https://github.com/$repo/actions"
}
if ($run.conclusion -ne "success") {
    throw "сборка $tag закончилась как $($run.conclusion): $($run.html_url)"
}

Write-Host "сборка прошла: $($run.html_url)"
Write-Host "подтягиваю release.json"
Invoke-Checked { git pull --ff-only origin main }
Write-Host "релиз $tag опубликован: https://github.com/$repo/releases/tag/$tag"
Write-Host "Schwung Manager увидит его по release.json на main."
