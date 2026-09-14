[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

foreach ($command in @('az', 'azd', 'node')) {
    if (-not (Get-Command $command -ErrorAction SilentlyContinue)) { throw "Required command '$command' was not found." }
}

function Get-EnvironmentValue([string] $Name) {
    $value = (& azd env get-value $Name 2>$null | Out-String).Trim()
    if ($LASTEXITCODE -ne 0) { return '' }
    return $value
}
function Set-EnvironmentValue([string] $Name, [string] $Value) {
    & azd env set $Name $Value | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "Unable to save azd environment value '$Name'." }
    [Environment]::SetEnvironmentVariable($Name, $Value, 'Process')
}
function Read-ChannelList([string] $Prompt) {
    $value = (Read-Host "$Prompt (email, teams; comma-separated)").Trim().ToLowerInvariant()
    if (-not $value) { return '' }
    $items = @($value -split ',' | ForEach-Object { $_.Trim() } | Where-Object { $_ })
    $invalid = @($items | Where-Object { $_ -notin @('email', 'teams') })
    if ($items.Count -ne @($items | Select-Object -Unique).Count -or $invalid.Count -gt 0) {
        throw 'Channels may contain only email and teams, once each.'
    }
    return ($items -join ',')
}
function Assert-GuidList([string] $Name, [string] $Value) {
    if (-not $Value) { return }
    foreach ($item in @($Value -split ',' | ForEach-Object { $_.Trim() } | Where-Object { $_ })) {
        $parsed = [guid]::Empty
        if (-not [guid]::TryParse($item, [ref]$parsed)) { throw "$Name contains invalid object ID '$item'." }
    }
}

$subscriptionId = Get-EnvironmentValue 'AZURE_SUBSCRIPTION_ID'
$tenantId = Get-EnvironmentValue 'AZURE_TENANT_ID'
$environmentName = Get-EnvironmentValue 'AZURE_ENV_NAME'
if (-not $subscriptionId -or -not $tenantId -or -not $environmentName) {
    throw 'Initialize the azd environment and set AZURE_SUBSCRIPTION_ID, AZURE_TENANT_ID, and AZURE_ENV_NAME first.'
}
$account = & az account show --subscription $subscriptionId --query '{tenantId:tenantId,id:id}' -o json | ConvertFrom-Json
if ($account.id -ne $subscriptionId -or $account.tenantId -ne $tenantId) {
    throw 'The Azure CLI subscription or tenant does not match the selected azd environment. Sign in through the normal broker or browser flow, then retry.'
}

$nonInteractive = $env:AZD_NON_INTERACTIVE -eq 'true' -or $env:CI -eq 'true'
$defaults = @{ COLLECTION_ENABLED = 'false'; AUDIT_OVERLAP_MINUTES = '60'; ALL_USERS = 'false'; HELPDESK_TEXT = '' }
foreach ($entry in $defaults.GetEnumerator()) { if (-not (Get-EnvironmentValue $entry.Key)) { Set-EnvironmentValue $entry.Key $entry.Value } }

if (-not (Get-EnvironmentValue 'USER_CHANNELS')) {
    if ($nonInteractive) { throw 'USER_CHANNELS is required for noninteractive provisioning.' }
    Set-EnvironmentValue 'USER_CHANNELS' (Read-ChannelList 'End-user delivery channels')
}
if (-not (Get-EnvironmentValue 'ADMIN_CHANNELS') -and -not $nonInteractive) {
    $adminPrompt = 'Administrator delivery channels; leave blank for none'
    Set-EnvironmentValue 'ADMIN_CHANNELS' (Read-ChannelList $adminPrompt)
}
$userChannels = Get-EnvironmentValue 'USER_CHANNELS'
$adminChannels = Get-EnvironmentValue 'ADMIN_CHANNELS'
if (-not $userChannels) { throw 'USER_CHANNELS must include at least one channel.' }
if (($userChannels + ',' + $adminChannels) -match '(^|,)email(,|$)' -and -not (Get-EnvironmentValue 'EMAIL_SENDER_USER_ID')) {
    if ($nonInteractive) { throw 'EMAIL_SENDER_USER_ID is required when email is selected.' }
    Set-EnvironmentValue 'EMAIL_SENDER_USER_ID' (Read-Host 'Email sender Entra user object ID').Trim()
    Assert-GuidList 'EMAIL_SENDER_USER_ID' (Get-EnvironmentValue 'EMAIL_SENDER_USER_ID')
}
foreach ($name in @('AZURE_TENANT_ID', 'USER_CHANNELS', 'ADMIN_CHANNELS', 'ADMIN_USER_IDS', 'PILOT_USER_IDS', 'ALL_USERS', 'COLLECTION_ENABLED', 'EMAIL_SENDER_USER_ID', 'HELPDESK_TEXT', 'AUDIT_OVERLAP_MINUTES')) {
    [Environment]::SetEnvironmentVariable($name, (Get-EnvironmentValue $name), 'Process')
}
& node --import tsx --input-type=module --eval "import { parseConfig } from './src/core.ts'; parseConfig(process.env);" 
if ($LASTEXITCODE -ne 0) { throw 'Runtime configuration validation failed.' }
Write-Host "Configuration validated for tenant $tenantId and subscription $subscriptionId. Collection remains paused."
