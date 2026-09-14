[CmdletBinding(SupportsShouldProcess)]
param(
    [Parameter(Mandatory)][guid] $UserId,
    [switch] $HealthOnly,
    [ValidateSet('email', 'teams')][string] $Channel
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
function Get-EnvironmentValue([string] $Name) {
    $value = (& azd env get-value $Name 2>$null | Out-String).Trim()
    if ($LASTEXITCODE -ne 0 -or -not $value) { throw "$Name is required from the azd environment." }
    return $value
}
$subscriptionId = Get-EnvironmentValue 'AZURE_SUBSCRIPTION_ID'
$tenantId = Get-EnvironmentValue 'AZURE_TENANT_ID'
$resourceGroup = Get-EnvironmentValue 'AZURE_RESOURCE_GROUP'
$functionName = Get-EnvironmentValue 'AZURE_FUNCTION_APP_NAME'
$environmentName = Get-EnvironmentValue 'AZURE_ENV_NAME'
$pilotIds = (Get-EnvironmentValue 'PILOT_USER_IDS') -split ',' | ForEach-Object { $_.Trim() }
if ($pilotIds -notcontains $UserId.Guid) { throw 'UserId must be explicitly configured in PILOT_USER_IDS.' }
$accountTenant = (& az account show --subscription $subscriptionId --query tenantId -o tsv | Out-String).Trim()
if ($LASTEXITCODE -ne 0 -or $accountTenant -ne $tenantId) { throw 'Azure tenant does not match the selected environment.' }
$function = & az functionapp show --subscription $subscriptionId --resource-group $resourceGroup --name $functionName --output json | ConvertFrom-Json
if ($LASTEXITCODE -ne 0 -or $function.tags.'azd-env-name' -ne $environmentName -or $function.tags.workload -ne 'auth-notifications') { throw 'Function does not belong to this notification environment.' }
$hostProperty = $function.PSObject.Properties['defaultHostName']
$liveHost = if ($hostProperty) { [string]$hostProperty.Value } else { [string]$function.properties.defaultHostName }
$functionUrl = "https://$liveHost"
if ($functionUrl -ne (Get-EnvironmentValue 'AZURE_FUNCTION_APP_URL')) { throw 'Function URL does not match the live Azure resource.' }
if (-not $HealthOnly -and -not $PSCmdlet.ShouldProcess($UserId.Guid, 'Send synthetic notifications through the configured pilot and administrator routes')) { return }
$functionKey = (& az functionapp keys list --subscription $subscriptionId --resource-group $resourceGroup --name $functionName --query functionKeys.default -o tsv | Out-String).Trim()
if ($LASTEXITCODE -ne 0 -or -not $functionKey) { throw 'Function key could not be obtained.' }
try {
    $headers = @{ 'x-functions-key' = $functionKey }
    $health = Invoke-RestMethod -Uri "$functionUrl/api/health" -Headers $headers
    if ($health.status -ne 'ready') { throw 'Function is not ready.' }
    if ($HealthOnly) { $health; return }
    if ($health.collectionEnabled) { throw 'Pause collection before running a synthetic delivery test.' }
    $requestBody = @{ userId = $UserId.Guid }
    if ($Channel) { $requestBody.channel = $Channel }
    $result = Invoke-RestMethod -Method POST -Uri "$functionUrl/api/test-delivery" -Headers $headers -ContentType 'application/json' -Body ($requestBody | ConvertTo-Json) -TimeoutSec 90
    $result
    if (@($result.deliveries).Count -eq 0 -or @($result.deliveries | Where-Object status -NE 'accepted').Count -gt 0) { throw ('Delivery routes not accepted: ' + (($result.deliveries | ForEach-Object { $codeProperty = $_.PSObject.Properties['code']; $code = if ($codeProperty) { $codeProperty.Value } else { 'none' }; "$($_.status):$code" }) -join ', ')) }
    Write-Host 'All selected routes were accepted by their provider. Confirm recipient receipt separately.'
}
finally {
    $functionKey = $null
    $headers = $null
}
