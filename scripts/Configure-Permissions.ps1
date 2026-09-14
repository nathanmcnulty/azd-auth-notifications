[CmdletBinding(SupportsShouldProcess)]
param()

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

function Get-EnvironmentValue([string] $Name) {
    $value = (& azd env get-value $Name 2>$null | Out-String).Trim()
    if ($LASTEXITCODE -ne 0 -or -not $value) { throw "$Name is required from the initialized azd environment." }
    return $value
}
foreach ($command in @('az', 'azd')) { if (-not (Get-Command $command -ErrorAction SilentlyContinue)) { throw "Required command '$command' was not found." } }
$tenantId = Get-EnvironmentValue 'AZURE_TENANT_ID'
$subscriptionId = Get-EnvironmentValue 'AZURE_SUBSCRIPTION_ID'
$principalId = Get-EnvironmentValue 'AZURE_WORKLOAD_PRINCIPAL_ID'
$clientId = Get-EnvironmentValue 'AZURE_WORKLOAD_CLIENT_ID'
$account = & az account show --subscription $subscriptionId --query tenantId -o tsv
if ($LASTEXITCODE -ne 0 -or $account.Trim() -ne $tenantId) { throw 'Azure CLI tenant does not match AZURE_TENANT_ID.' }

$functionName = Get-EnvironmentValue 'AZURE_FUNCTION_APP_NAME'
$resourceGroup = Get-EnvironmentValue 'AZURE_RESOURCE_GROUP'
$functionIdentity = & az functionapp identity show --subscription $subscriptionId --resource-group $resourceGroup --name $functionName --output json | ConvertFrom-Json
if ($LASTEXITCODE -ne 0 -or $functionIdentity.type -notmatch 'UserAssigned') { throw 'The expected Function App user-assigned identity was not found.' }
$matchingIdentity = @($functionIdentity.userAssignedIdentities.psobject.Properties.Value | Where-Object { $_.principalId -eq $principalId -and $_.clientId -eq $clientId })
if ($matchingIdentity.Count -ne 1) { throw 'The Function App identity does not match the azd environment workload identity.' }

function ConvertFrom-JwtPayload([Parameter(Mandatory)][string] $Token) {
    $segments = $Token.Split('.')
    if ($segments.Count -ne 3) { throw 'Azure CLI returned an invalid Microsoft Graph access token.' }
    $payload = $segments[1].Replace('-', '+').Replace('_', '/')
    switch ($payload.Length % 4) { 2 { $payload += '==' } 3 { $payload += '=' } 1 { throw 'Azure CLI returned an invalid Microsoft Graph access token.' } }
    try { return [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($payload)) | ConvertFrom-Json } catch { throw 'Azure CLI returned an unreadable Microsoft Graph access token.' }
}
function Assert-GraphUri([Parameter(Mandatory)][string] $Uri) {
    try { $parsed = [uri]$Uri } catch { throw 'Microsoft Graph request URI is invalid.' }
    if ($parsed.Scheme -ne 'https' -or $parsed.Host -ne 'graph.microsoft.com' -or $parsed.Port -ne 443 -or $parsed.UserInfo -or
        ($parsed.AbsolutePath -ne '/v1.0' -and -not $parsed.AbsolutePath.StartsWith('/v1.0/')) -or $parsed.Fragment) {
        throw 'Microsoft Graph request URI is outside the approved v1.0 endpoint.'
    }
    return $parsed.AbsoluteUri
}
$graphToken = (& az account get-access-token --subscription $subscriptionId --resource-type ms-graph --query accessToken -o tsv | Out-String).Trim()
if ($LASTEXITCODE -ne 0 -or -not $graphToken) { throw 'Unable to obtain a Microsoft Graph access token for the selected subscription.' }
$tokenPayload = ConvertFrom-JwtPayload $graphToken
if ([string]$tokenPayload.tid -ne $tenantId) { throw 'Microsoft Graph access token tenant does not match AZURE_TENANT_ID.' }
$graphHeaders = @{ Authorization = "Bearer $graphToken"; Accept = 'application/json' }
function Invoke-GraphRequest {
    param([Parameter(Mandatory)][ValidateSet('GET', 'POST')][string] $Method, [Parameter(Mandatory)][string] $Uri, [object] $Body)
    $approvedUri = Assert-GraphUri $Uri
    try {
        if ($Method -eq 'POST') { return Invoke-RestMethod -Method POST -Uri $approvedUri -Headers $graphHeaders -ContentType 'application/json' -Body ($Body | ConvertTo-Json -Compress) }
        return Invoke-RestMethod -Method GET -Uri $approvedUri -Headers $graphHeaders
    } catch { throw "Microsoft Graph $Method request failed for the approved endpoint: $($_.Exception.Message)" }
}
$graphServicePrincipal = Invoke-GraphRequest -Method GET -Uri "https://graph.microsoft.com/v1.0/servicePrincipals(appId='00000003-0000-0000-c000-000000000000')?`$select=id,appRoles"
if (-not $graphServicePrincipal.id) { throw 'Microsoft Graph service principal was not found in this tenant.' }
$workload = Invoke-GraphRequest -Method GET -Uri "https://graph.microsoft.com/v1.0/servicePrincipals/${principalId}?`$select=id,appId"
if ($workload.id -ne $principalId -or $workload.appId -ne $clientId) { throw 'The workload service principal does not match the deployed client ID.' }

function Get-AppRoleAssignments {
    $uri = "https://graph.microsoft.com/v1.0/servicePrincipals/$principalId/appRoleAssignments?`$select=appRoleId,resourceId"
    $assignments = @()
    do {
        $response = Invoke-GraphRequest -Method GET -Uri $uri
        $assignments += @($response.value)
        $nextLink = $response.PSObject.Properties['@odata.nextLink']
        $uri = if ($nextLink) { [string]$nextLink.Value } else { $null }
    } while ($uri)
    return @($assignments)
}
$assignments = @(Get-AppRoleAssignments)

foreach ($permission in @('AuditLog.Read.All', 'User.Read.All')) {
    $role = @($graphServicePrincipal.appRoles | Where-Object { $_.value -eq $permission -and $_.allowedMemberTypes -contains 'Application' })
    if ($role.Count -ne 1) { throw "Microsoft Graph application role '$permission' could not be resolved exactly once." }
    if (@($assignments | Where-Object { $_.resourceId -eq $graphServicePrincipal.id -and $_.appRoleId -eq $role[0].id }).Count -gt 0) { Write-Host "$permission is already assigned."; continue }
    if ($WhatIfPreference) { Write-Host "[WhatIf] Assign $permission to $clientId."; continue }
    if ($PSCmdlet.ShouldProcess($clientId, "Assign Microsoft Graph application permission $permission")) {
        $body = @{ principalId = $principalId; resourceId = $graphServicePrincipal.id; appRoleId = $role[0].id }
        [void](Invoke-GraphRequest -Method POST -Uri "https://graph.microsoft.com/v1.0/servicePrincipals/$principalId/appRoleAssignments" -Body $body)
    }
}
Write-Host 'Microsoft Graph application permissions are reconciled for the exact deployed workload identity.'
