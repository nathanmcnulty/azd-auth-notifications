[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Invoke-CheckedCommand {
    param(
        [Parameter(Mandatory)][string] $Command,
        [Parameter(Mandatory)][string[]] $Arguments,
        [switch] $DiscardOutput
    )

    if ($DiscardOutput) { & $Command @Arguments | Out-Null }
    else { & $Command @Arguments }
    if ($LASTEXITCODE -ne 0) {
        throw "Repository validation command failed with exit code $LASTEXITCODE`: $Command $($Arguments -join ' ')"
    }
}

$repositoryRoot = Split-Path $PSScriptRoot -Parent
Push-Location $repositoryRoot
try {
    Invoke-CheckedCommand -Command 'npm' -Arguments @('ci')
    Invoke-CheckedCommand -Command 'npm' -Arguments @('test')
    Invoke-CheckedCommand -Command 'npm' -Arguments @('run', 'build')
    Invoke-CheckedCommand -Command 'az' -Arguments @('bicep', 'build', '--file', 'infra/main.bicep', '--stdout') -DiscardOutput
    Invoke-CheckedCommand -Command 'git' -Arguments @('diff', '--check')
}
finally {
    Pop-Location
}
