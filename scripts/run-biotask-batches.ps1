param(
    [string]$ConfigPath = (Join-Path $PSScriptRoot "..\config\Biotask-batch-runner.json"),
    [switch]$DryRun,
    [switch]$PlanJson
)

$ErrorActionPreference = "Stop"

function Resolve-RepoRoot {
    return (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..")).Path
}

function Read-JsonConfig {
    param([string]$Path)

    if (-not (Test-Path -LiteralPath $Path)) {
        throw "Config file not found: $Path"
    }

    return Get-Content -LiteralPath $Path -Raw -Encoding UTF8 | ConvertFrom-Json
}

function Get-ConfigValue {
    param(
        [object]$Config,
        [string]$Name,
        [object]$Default
    )

    if ($Config.PSObject.Properties.Name -contains $Name -and $null -ne $Config.$Name) {
        return $Config.$Name
    }
    return $Default
}

function Convert-ToWslPath {
    param([string]$Path)

    $resolved = (Resolve-Path -LiteralPath $Path).Path
    if ($resolved -match '^([A-Za-z]):\\(.*)$') {
        $drive = $matches[1].ToLowerInvariant()
        $rest = $matches[2] -replace '\\', '/'
        return "/mnt/$drive/$rest"
    }

    if (Get-Command wsl.exe -ErrorAction SilentlyContinue) {
        try {
            $converted = & wsl.exe wslpath -a $resolved 2>$null
            if ($LASTEXITCODE -eq 0 -and $converted) {
                return ($converted -join "`n").Trim()
            }
        } catch {
            # Fall through to the explicit error below.
        }
    }

    throw "Cannot convert path to WSL path: $resolved"
}

function Quote-BashArg {
    param([object]$Value)

    $text = [string]$Value
    return "'" + ($text -replace "'", "'\''") + "'"
}

function Build-BatchCommand {
    param(
        [string]$RepoWslPath,
        [string]$BunPath,
        [string[]]$Tasks,
        [object]$Config,
        [string]$Timestamp,
        [int]$Concurrency
    )

    $args = @(
        "src/harness/evaluation/cli.ts"
    )

    foreach ($task in $Tasks) {
        $args += @("--task", $task)
    }

    $optionMap = [ordered]@{
        "--tasks-dir" = (Get-ConfigValue $Config "tasksDir" "tasks")
        "--runs-dir" = (Get-ConfigValue $Config "runsDir" "output/runs")
        "--max-rounds" = (Get-ConfigValue $Config "maxRounds" 5)
        "--max-turns-per-round" = (Get-ConfigValue $Config "maxTurnsPerRound" $null)
        "--timeout-seconds" = (Get-ConfigValue $Config "timeoutSeconds" 7200)
        "--concurrency" = $Concurrency
        "--worker-timeout-grace-seconds" = (Get-ConfigValue $Config "workerTimeoutGraceSeconds" $null)
        "--temperature" = (Get-ConfigValue $Config "temperature" 1)
        "--thinking" = (Get-ConfigValue $Config "thinking" "disabled")
        "--system-prompt" = (Get-ConfigValue $Config "systemPrompt" $null)
        "--timestamp" = $Timestamp
    }

    foreach ($name in $optionMap.Keys) {
        $value = $optionMap[$name]
        if ($null -ne $value -and "$value" -ne "") {
            $args += @($name, "$value")
        }
    }

    if ([bool](Get-ConfigValue $Config "quiet" $false)) {
        $args += "--quiet"
    }

    $quotedArgs = ($args | ForEach-Object { Quote-BashArg $_ }) -join " "
    $quotedRepo = Quote-BashArg $RepoWslPath
    $quotedBun = Quote-BashArg $BunPath

    return "cd $quotedRepo && export PATH=`"`$HOME/.bun/bin:`$PATH`" && $quotedBun $quotedArgs"
}

function Set-WslEnvironmentForwarding {
    $shareNames = @(
        "API_KEY",
        "BASE_URL",
        "MODEL_NAME",
        "GATEWAY_PROTOCOL",
        "AGENT_LOG_DIR"
    )
    $existing = [Environment]::GetEnvironmentVariable("WSLENV")
    $add = ($shareNames | ForEach-Object { "$_/u" }) -join ":"
    $env:WSLENV = if ($existing) { "$existing`:$add" } else { $add }
}

function Invoke-Main {
    $repoRoot = Resolve-RepoRoot
    $config = Read-JsonConfig $ConfigPath

    $tasks = @()
    foreach ($task in @(Get-ConfigValue $config "tasks" @())) {
        $taskText = "$task".Trim()
        if ($taskText) {
            $tasks += $taskText
        }
    }

    if ($tasks.Count -eq 0) {
        throw "Config must contain a non-empty tasks array."
    }

    $batchSize = [int](Get-ConfigValue $config "batchSize" 3)
    if ($batchSize -lt 1) {
        throw "batchSize must be greater than 0."
    }

    if (-not $DryRun -and [bool](Get-ConfigValue $config "loadLocalConfig" $true)) {
        $localConfig = Join-Path $repoRoot "config\llm-probe.local.ps1"
        if (Test-Path -LiteralPath $localConfig) {
            . $localConfig
        }
    }

    Set-WslEnvironmentForwarding

    $repoWslPath = Convert-ToWslPath $repoRoot
    $bunPath = [string](Get-ConfigValue $config "bunPath" "/home/admin/.bun/bin/bun")
    $prefix = [string](Get-ConfigValue $config "timestampPrefix" "task_batch")
    $stamp = Get-Date -Format "yyyyMMdd_HHmmss"
    $timestamp = "{0}_{1}" -f $prefix, $stamp
    $continueOnFailure = $true
    $command = Build-BatchCommand -RepoWslPath $repoWslPath -BunPath $bunPath -Tasks $tasks -Config $config -Timestamp $timestamp -Concurrency $batchSize

    if ($DryRun) {
        $plan = [pscustomobject]@{
            repoRoot = $repoRoot
            repoWslPath = $repoWslPath
            maxConcurrentTasks = $batchSize
            continueOnFailure = $continueOnFailure
            tasks = $tasks
            timestamp = $timestamp
            command = $command
        }
        if ($PlanJson) {
            [Console]::Out.WriteLine(($plan | ConvertTo-Json -Depth 8))
        } else {
            Write-Host ("[dry-run] {0} task(s), max concurrency {1}: {2}" -f $tasks.Count, $batchSize, ($tasks -join ", "))
            Write-Host $command
        }
        return 0
    }

    Write-Host ("Running {0} task(s) with max concurrency {1}: {2}" -f $tasks.Count, $batchSize, ($tasks -join ", "))
    & wsl.exe -e bash -lc $command
    $exitCode = $LASTEXITCODE
    if ($exitCode -ne 0) {
        Write-Error ("Task pipeline finished with exit code {0}" -f $exitCode) -ErrorAction Continue
        return $exitCode
    }
    return 0
}

try {
    $exitCode = Invoke-Main
    exit $exitCode
} catch {
    Write-Error $_.Exception.Message
    exit 1
}
