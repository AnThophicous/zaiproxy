$ErrorActionPreference = "Stop"

$Root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$RemoteUrl = if ($env:ZAI_PROXY_REMOTE_URL) { $env:ZAI_PROXY_REMOTE_URL } else { "https://github.com/AnThophicous/zaiproxy.git" }
$RemoteBranch = if ($env:ZAI_PROXY_REMOTE_BRANCH) { $env:ZAI_PROXY_REMOTE_BRANCH } else { "main" }
$RemoteRef = "refs/remotes/zai-proxy-updater/$RemoteBranch"
$BaseUrl = if ($env:ZAI_PROXY_BASE_URL) { $env:ZAI_PROXY_BASE_URL } else { "http://127.0.0.1:3000/v1" }
$Model = if ($env:ZAI_PROXY_MODEL) { $env:ZAI_PROXY_MODEL } else { "GLM-5.2" }
$SmallModel = if ($env:ZAI_PROXY_SMALL_MODEL) { $env:ZAI_PROXY_SMALL_MODEL } else { "GLM-5-Turbo" }
$Stamp = Get-Date -Format "yyyyMMdd-HHmmss"
$Package = Get-Content (Join-Path $Root "package.json") -Raw | ConvertFrom-Json
$Version = if ($Package.version) { $Package.version } else { "0.0.0" }
$AppName = "ZAI Proxy $Version"

function Test-Cmd($Name) { return [bool](Get-Command $Name -ErrorAction SilentlyContinue) }

function Log($Level, $Message) {
  $Color = switch ($Level) {
    "OK" { "Green" }
    "WARN" { "Yellow" }
    "FAIL" { "Red" }
    default { "Cyan" }
  }
  Write-Host ("[{0,-4}] {1}" -f $Level, $Message) -ForegroundColor $Color
}

function Box($Title) {
  Write-Host "+------------------------------------------------------------+" -ForegroundColor White
  Write-Host ("| {0,-58} |" -f $Title) -ForegroundColor White
  Write-Host "+------------------------------------------------------------+" -ForegroundColor White
}

function Run-Progress($Label, [scriptblock]$Block) {
  Write-Host -NoNewline "$Label "
  $Job = Start-Job -ScriptBlock $Block
  $Frames = @("/", "-", "\", "|")
  $Index = 0
  while ($Job.State -eq "Running") {
    Write-Host -NoNewline ("`r{0} [{1}] {2,2}%" -f $Label, $Frames[$Index % 4], (($Index * 7) % 97))
    Start-Sleep -Milliseconds 80
    $Index++
  }
  $Output = Receive-Job $Job -ErrorAction SilentlyContinue
  $Failed = $Job.State -ne "Completed"
  Remove-Job $Job -Force
  if ($Failed) {
    Write-Host ("`r{0} [!] failed" -f $Label)
    if ($Output) { Write-Host $Output }
    throw "$Label failed"
  }
  Write-Host ("`r{0} [#] 100%" -f $Label)
}

function Backup-File($Path) {
  if (Test-Path $Path) {
    Copy-Item $Path "$Path.bak.$Stamp" -Force
    Log "INFO" "Backup: $Path.bak.$Stamp"
  }
}

function Ensure-EnvLine($Path, $Key, $Value) {
  $Dir = Split-Path -Parent $Path
  New-Item -ItemType Directory -Force -Path $Dir | Out-Null
  if (!(Test-Path $Path)) { New-Item -ItemType File -Force -Path $Path | Out-Null }
  $Content = Get-Content $Path -Raw
  if ($Content -notmatch "(?m)^\s*$([regex]::Escape($Key))=") {
    Add-Content $Path "$Key=$Value"
  }
}

function Strip-Jsonc($Text) {
  $NoBlock = [regex]::Replace($Text, "/\*.*?\*/", "", "Singleline")
  return [regex]::Replace($NoBlock, "(^|[^:])//.*", '$1', "Multiline")
}

function Convert-ToHashTree($Value) {
  if ($null -eq $Value) { return $null }
  if ($Value -is [System.Collections.IDictionary]) {
    $Out = [ordered]@{}
    foreach ($Key in $Value.Keys) { $Out[$Key] = Convert-ToHashTree $Value[$Key] }
    return $Out
  }
  if ($Value -is [System.Collections.IEnumerable] -and $Value -isnot [string]) {
    return @($Value | ForEach-Object { Convert-ToHashTree $_ })
  }
  if ($Value.PSObject -and $Value.PSObject.Properties.Count -gt 0 -and $Value.GetType().Name -eq "PSCustomObject") {
    $Out = [ordered]@{}
    foreach ($Prop in $Value.PSObject.Properties) { $Out[$Prop.Name] = Convert-ToHashTree $Prop.Value }
    return $Out
  }
  return $Value
}

function Read-JsonObject($Path) {
  if (!(Test-Path $Path) -or ((Get-Item $Path).Length -eq 0)) { return [ordered]@{} }
  try {
    $Json = Strip-Jsonc (Get-Content $Path -Raw)
    try { return $Json | ConvertFrom-Json -AsHashtable }
    catch { return Convert-ToHashTree ($Json | ConvertFrom-Json) }
  } catch {
    return [ordered]@{}
  }
}

function Write-JsonObject($Path, $Data) {
  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $Path) | Out-Null
  $Data | ConvertTo-Json -Depth 30 | Set-Content -Path $Path -Encoding UTF8
}

function Maybe-UpdateSelf {
  if ($env:ZAI_PROXY_SKIP_UPDATE -eq "1") { return }
  if (!(Test-Cmd git) -or !(Test-Path (Join-Path $Root ".git"))) {
    Log "WARN" "Git repo nao detectado; updater ignorado."
    return
  }

  Box "Updater"
  Log "INFO" "Verificando $RemoteUrl ($RemoteBranch)"
  Push-Location $Root
  try {
    Write-Progress -Activity "ZAI Proxy updater" -Status "Fetching remote" -PercentComplete 20
    git fetch --quiet $RemoteUrl "${RemoteBranch}:${RemoteRef}"
    Write-Progress -Activity "ZAI Proxy updater" -Status "Comparing commits" -PercentComplete 50
    $Current = git rev-parse --short HEAD
    $Remote = git rev-parse --short $RemoteRef
    $Behind = [int](git rev-list --count "HEAD..$RemoteRef")
    $Ahead = [int](git rev-list --count "$RemoteRef..HEAD")
    Write-Host "  Local : $Current"
    Write-Host "  Remote: $Remote"
    Write-Host "  Behind: $Behind commit(s)"
    Write-Host "  Ahead : $Ahead commit(s)"

    if ($Behind -eq 0) {
      Log "OK" "ZAI Proxy esta atualizado."
      return
    }

    git --no-pager log --oneline --decorate --max-count=8 "HEAD..$RemoteRef"
    $ShouldUpdate = $false
    if ($Behind -gt 5) {
      Log "WARN" "Instalacao mais de 5 commits atrasada. Atualizacao automatica obrigatoria."
      $ShouldUpdate = $true
    } else {
      $Answer = Read-Host "Atualizar agora para $Remote? [y/N]"
      $ShouldUpdate = $Answer -match "^(y|yes|s|sim)$"
    }
    if (!$ShouldUpdate) { return }

    $Dirty = (git status --porcelain)
    $Stashed = $false
    if ($Dirty) {
      Log "WARN" "Worktree suja; criando stash temporario."
      git stash push -u -m "zai-proxy-installer-$Stamp" | Out-Null
      $Stashed = $true
    }

    Write-Progress -Activity "ZAI Proxy updater" -Status "Fast-forward update" -PercentComplete 80
    git merge --ff-only $RemoteRef
    if ($Stashed) {
      Log "WARN" "Reaplicando stash temporario."
      git stash pop | Out-Null
    }
    Log "OK" "Atualizado para $(git rev-parse --short HEAD)."
    Write-Progress -Activity "ZAI Proxy updater" -Completed
    $Installer = $MyInvocation.MyCommand.Path
    if (Test-Path $Installer) {
      Log "INFO" "Reiniciando instalador atualizado."
      $env:ZAI_PROXY_SKIP_UPDATE = "1"
      & powershell -NoProfile -ExecutionPolicy Bypass -File $Installer
      exit $LASTEXITCODE
    }
  } finally {
    Pop-Location
  }
}

function Prepare-Proxy {
  Box "Runtime"
  Push-Location $Root
  try {
    Ensure-EnvLine (Join-Path $Root ".env") "ZAI_DEFAULT_MODEL" $Model
    if (Test-Cmd npm) {
      Write-Progress -Activity "$AppName runtime" -Status "Preparing dependencies" -PercentComplete 30
      if (!(Test-Path (Join-Path $Root "node_modules"))) { npm install }
      Write-Progress -Activity "$AppName runtime" -Status "Building proxy" -PercentComplete 75
      npm run build
      Write-Progress -Activity "$AppName runtime" -Completed
    } else {
      Log "WARN" "npm nao encontrado; dependencias/build ignorados."
    }
  } finally {
    Pop-Location
  }
}

function Configure-Zed {
  $Path = Join-Path $env:APPDATA "Zed\settings.json"
  Backup-File $Path
  $Data = Read-JsonObject $Path
  if (!$Data.Contains("language_models")) { $Data["language_models"] = [ordered]@{} }
  if (!$Data["language_models"].Contains("openai_compatible")) { $Data["language_models"]["openai_compatible"] = [ordered]@{} }
  $Data["language_models"]["openai_compatible"]["ZAI Proxy"] = [ordered]@{
    api_url = $BaseUrl
    available_models = @([ordered]@{
      name = $Model
      display_name = $AppName
      max_tokens = 200000
      max_output_tokens = 32000
      max_completion_tokens = 32000
      capabilities = [ordered]@{
        tools = $true
        images = $false
        parallel_tool_calls = $true
        prompt_cache_key = $true
        chat_completions = $true
        interleaved_reasoning = $false
      }
    })
  }
  if (!$Data.Contains("agent")) { $Data["agent"] = [ordered]@{} }
  if (!$Data["agent"].Contains("default_model")) {
    $Data["agent"]["default_model"] = [ordered]@{ provider = "openai_compatible"; model = $Model }
  }
  Write-JsonObject $Path $Data
  Log "OK" "Zed configurado."
}

function Configure-Codex {
  $Path = Join-Path $env:USERPROFILE ".codex\config.toml"
  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $Path) | Out-Null
  if (!(Test-Path $Path)) { New-Item -ItemType File -Force -Path $Path | Out-Null }
  Backup-File $Path
  $Text = Get-Content $Path -Raw
  $Block = @"
# BEGIN ZAI Proxy
[model_providers.zai-proxy]
name = "$AppName"
base_url = "$BaseUrl"
env_key = ""
wire_api = "responses"
query_params = {}
request_max_retries = 2
stream_max_retries = 1
stream_idle_timeout_ms = 300000
# END ZAI Proxy
"@
  $Text = [regex]::Replace($Text, "# BEGIN [^\n]*Z\.ai Proxy.*?# END [^\n]*Z\.ai Proxy", "", "Singleline")
  if ($Text -match "# BEGIN ZAI Proxy") {
    $Text = [regex]::Replace($Text, "# BEGIN ZAI Proxy.*?# END ZAI Proxy", $Block, "Singleline")
  } else {
    if ($Text -notmatch "(?m)^model_provider\s*=") {
      $Text = "model = `"$Model`"`nmodel_provider = `"zai-proxy`"`n" + $Text
    }
    $Text = $Text.TrimEnd() + "`n`n" + $Block + "`n"
  }
  Set-Content -Path $Path -Encoding UTF8 -Value $Text
  Log "OK" "Codex provider zai-proxy configurado."
}

function Configure-OpenCode {
  $Path = Join-Path $env:APPDATA "opencode\opencode.jsonc"
  Backup-File $Path
  $Data = Read-JsonObject $Path
  if (!$Data.Contains('$schema')) { $Data['$schema'] = "https://opencode.ai/config.json" }
  if (!$Data.Contains("model")) { $Data["model"] = "z.ai/$Model" }
  if (!$Data.Contains("small_model")) { $Data["small_model"] = "z.ai/$SmallModel" }
  if (!$Data.Contains("provider")) { $Data["provider"] = [ordered]@{} }
  $Models = [ordered]@{}
  $Models[$Model] = [ordered]@{ name = $Model; limit = [ordered]@{ context = 200000; output = 32000 } }
  $Models[$SmallModel] = [ordered]@{ name = $SmallModel; limit = [ordered]@{ context = 200000; output = 32000 } }
  $Data["provider"]["z.ai"] = [ordered]@{
    npm = "@ai-sdk/openai-compatible"
    name = $AppName
    options = [ordered]@{ baseURL = $BaseUrl }
    models = $Models
  }
  Write-JsonObject $Path $Data
  Log "OK" "OpenCode configurado."
}

function Configure-Aider {
  [Environment]::SetEnvironmentVariable("OPENAI_API_BASE", $BaseUrl, "User")
  Log "OK" "Aider/OpenAI base URL configurado."
}

function Configure-Claude {
  Log "WARN" "Claude Code detectado, mas nao alterado: ele nao consome provider OpenAI-compatible de forma segura."
}

$Clients = @()
if ((Test-Cmd zed) -or (Test-Path (Join-Path $env:APPDATA "Zed\settings.json"))) { $Clients += @{ id = "zed"; name = "Zed" } }
if ((Test-Cmd codex) -or (Test-Path (Join-Path $env:USERPROFILE ".codex\config.toml"))) { $Clients += @{ id = "codex"; name = "OpenAI Codex CLI" } }
if ((Test-Cmd opencode) -or (Test-Path (Join-Path $env:APPDATA "opencode\opencode.jsonc"))) { $Clients += @{ id = "opencode"; name = "OpenCode" } }
if (Test-Cmd aider) { $Clients += @{ id = "aider"; name = "Aider/OpenAI env" } }
if ((Test-Cmd claude) -or (Test-Cmd claude-code)) { $Clients += @{ id = "claude"; name = "Claude Code (note only)" } }

Clear-Host
Box "$AppName installer"
Write-Host "  Source : $RemoteUrl"
Write-Host "  Branch : $RemoteBranch"
Write-Host "  Base   : $BaseUrl"
Write-Host "  Model  : $Model"
Write-Host ""
Maybe-UpdateSelf

Box "Target clients"
Write-Host "  0) Todos os detectados"
for ($i = 0; $i -lt $Clients.Count; $i++) {
  Write-Host ("  {0}) {1}" -f ($i + 1), $Clients[$i].name)
}
Write-Host ""
$Choice = Read-Host "Selecao"

Prepare-Proxy

function Install-One($Id) {
  switch ($Id) {
    "zed" { Configure-Zed }
    "codex" { Configure-Codex }
    "opencode" { Configure-OpenCode }
    "aider" { Configure-Aider }
    "claude" { Configure-Claude }
  }
}

if ($Choice -eq "0") {
  foreach ($Client in $Clients) { Install-One $Client.id }
} elseif ($Choice -match "^\d+$" -and [int]$Choice -ge 1 -and [int]$Choice -le $Clients.Count) {
  Install-One $Clients[[int]$Choice - 1].id
} else {
  throw "Opcao invalida."
}

Box "Done"
Log "OK" "$AppName configurado."
Write-Host "Servidor: npm start"
