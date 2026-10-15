#Requires -Version 7.6
[CmdletBinding()]
param(
    [string[]] $Path = @(
        'tests/TeamsLifecycle.Scripts.Tests.ps1',
        'tests/TeamsLifecycle.Tests.ps1'
    )
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

if ($PSVersionTable.PSVersion -lt [version]'7.6.0' -or -not [Environment]::Is64BitProcess) {
    throw 'Teams lifecycle validation requires 64-bit PowerShell 7.6 or newer.'
}
$resolvedPaths = foreach ($testPath in $Path) {
    if (-not (Test-Path -LiteralPath $testPath -PathType Leaf)) {
        throw "Required Teams lifecycle test file does not exist: $testPath"
    }
    (Resolve-Path -LiteralPath $testPath -ErrorAction Stop).Path
}
if (@($resolvedPaths).Count -eq 0) { throw 'No Teams lifecycle test files were selected.' }

Import-Module Pester -RequiredVersion 5.7.1 -Force -ErrorAction Stop
$result = Invoke-Pester -Path $resolvedPaths -Output Detailed -PassThru -ErrorAction Stop
if ($null -eq $result -or $result.TotalCount -le 0 -or $result.Result -ne 'Passed' -or
    $result.PassedCount -ne $result.TotalCount -or $result.FailedCount -ne 0 -or
    $result.FailedBlocksCount -ne 0 -or $result.FailedContainersCount -ne 0 -or
    $result.NotRunCount -ne 0) {
    throw 'Teams lifecycle Pester validation did not execute and pass every discovered test.'
}
$result
