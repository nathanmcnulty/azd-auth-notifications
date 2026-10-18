#Requires -Version 7.6
[CmdletBinding(SupportsShouldProcess, ConfirmImpact = 'High')]
param(
    [Parameter(Mandatory)][ValidatePattern('^[^@\s]+@[^@\s]+$')][string] $AdminUpn,
    [Parameter(Mandatory)][guid] $UserId,
    [switch] $UseCachedWam
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
Import-Module (Join-Path $PSScriptRoot 'TeamsLifecycle.psm1') -Force

function Get-Env([string]$Name, [switch]$Required) {
    $value = (& azd env get-value $Name 2>$null | Out-String).Trim()
    $missing = $LASTEXITCODE -ne 0 -or $value -match '^ERROR: key not found in environment values:'
    if ($Required -and ($missing -or -not $value)) { throw "$Name is required from the initialized azd environment." }
    if ($missing) { return '' }
    $value
}
function Set-Env([string]$Name, [string]$Value) {
    & azd env set $Name $Value | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "Unable to checkpoint $Name in the azd environment." }
}
function Clear-Env([string]$Name) {
    & azd env unset $Name | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "Unable to clear $Name from the azd environment." }
}
function Set-RemovalState([string]$Phase, [string]$InstallationId, [string]$InstallationUserId, [string]$CatalogAppId,
    [string]$TenantId, [string]$WorkloadClientId, [string]$WorkloadPrincipalId, [string]$EnvironmentName) {
    $json = @{
        version = 1; phase = $Phase; installationId = $InstallationId; installationUserId = $InstallationUserId
        catalogAppId = $CatalogAppId; tenantId = $TenantId; workloadClientId = $WorkloadClientId
        workloadPrincipalId = $WorkloadPrincipalId; environmentName = $EnvironmentName
    } |
        ConvertTo-Json -Compress
    Set-Env TEAMS_INSTALL_REMOVAL_STATE ([Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($json)))
}
function Get-RemovalState {
    $encoded = Get-Env TEAMS_INSTALL_REMOVAL_STATE
    if (-not $encoded) { return $null }
    try { $state = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($encoded)) | ConvertFrom-Json -ErrorAction Stop }
    catch { throw 'Recorded Teams installation removal state is malformed.' }
    if ($state.version -ne 1 -or $state.phase -notin @('delete-pending', 'absence-verified') -or
        -not $state.installationId -or -not $state.installationUserId -or -not $state.catalogAppId -or
        -not $state.tenantId -or -not $state.workloadClientId -or -not $state.workloadPrincipalId -or -not $state.environmentName) {
        throw 'Recorded Teams installation removal state is invalid.'
    }
    [void](ConvertTo-TeamsGraphSegment ([string]$state.installationId) 'Pending Teams installation ID')
    [void](ConvertTo-TeamsGraphSegment ([string]$state.catalogAppId) 'Pending Teams catalog app ID')
    $state
}
function Clear-RemovalReceipt {
    $failures = [Collections.Generic.List[string]]::new()
    foreach ($name in @('TEAMS_INSTALLATION_ID', 'TEAMS_INSTALLATION_USER_ID', 'TEAMS_INSTALL_OWNERSHIP')) {
        if (-not (Get-Env $name)) { continue }
        $cleared = $false
        for ($attempt = 1; $attempt -le 3 -and -not $cleared; $attempt++) {
            try { Clear-Env $name; $cleared = $true } catch { if ($attempt -eq 3) { $failures.Add($name) } }
        }
    }
    if ($failures.Count -gt 0) {
        throw "The installation is absent, but receipt cleanup is incomplete. Rerun this command to clear: $($failures -join ', ')."
    }
    for ($attempt = 1; $attempt -le 3; $attempt++) {
        try { Clear-Env 'TEAMS_INSTALL_REMOVAL_STATE'; return } catch { if ($attempt -eq 3) { throw } }
    }
}
function Assert-GraphUri([string]$Uri) {
    $parsed = [uri]$Uri
    if ($parsed.Scheme -ne 'https' -or $parsed.Host -ne 'graph.microsoft.com' -or $parsed.Port -ne 443 -or $parsed.UserInfo -or
        ($parsed.AbsolutePath -ne '/v1.0' -and -not $parsed.AbsolutePath.StartsWith('/v1.0/')) -or $parsed.Fragment) {
        throw 'Graph request URI is outside graph.microsoft.com v1.0.'
    }
    $parsed.AbsoluteUri
}
function Get-TokenTenant([string]$Token) {
    $parts = $Token.Split('.')
    if ($parts.Count -ne 3) { throw 'Invalid Graph token.' }
    $body = $parts[1].Replace('-', '+').Replace('_', '/')
    switch ($body.Length % 4) {
        2 { $body += '==' }
        3 { $body += '=' }
        1 { throw 'Invalid Graph token.' }
    }
    ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($body)) | ConvertFrom-Json).tid
}

foreach ($command in @('azd', 'az')) {
    if (-not (Get-Command $command -ErrorAction SilentlyContinue)) { throw "Required command '$command' was not found." }
}
$tenantId = Get-Env AZURE_TENANT_ID -Required
$clientId = Get-Env AZURE_WORKLOAD_CLIENT_ID -Required
$subscriptionId = Get-Env AZURE_SUBSCRIPTION_ID -Required
$resourceGroup = Get-Env AZURE_RESOURCE_GROUP -Required
$functionName = Get-Env AZURE_FUNCTION_APP_NAME -Required
$environmentName = Get-Env AZURE_ENV_NAME -Required
$principalId = Get-Env AZURE_WORKLOAD_PRINCIPAL_ID -Required
$appInfo = & az functionapp show --subscription $subscriptionId --resource-group $resourceGroup --name $functionName --query '{tags:tags}' -o json | ConvertFrom-Json
$identity = & az functionapp identity show --subscription $subscriptionId --resource-group $resourceGroup --name $functionName -o json | ConvertFrom-Json
if ($LASTEXITCODE -ne 0 -or $appInfo.tags.'azd-env-name' -cne $environmentName -or
    @($identity.userAssignedIdentities.PSObject.Properties.Value | Where-Object { $_.clientId -ceq $clientId -and $_.principalId -ceq $principalId }).Count -ne 1) {
    throw 'Function deployment identity or azd environment tag does not match this removal target.'
}
$pilots = @((Get-Env PILOT_USER_IDS -Required) -split ',' | ForEach-Object { $_.Trim() } | Where-Object { $_ })
if ($pilots -notcontains $UserId.Guid) { throw 'UserId must be one of PILOT_USER_IDS; broad Teams removal is not supported.' }

$catalogId = Get-Env TEAMS_CATALOG_APP_ID -Required
$removalState = Get-RemovalState
if ($removalState -and ([string]$removalState.tenantId -cne $tenantId -or
    [string]$removalState.workloadClientId -cne $clientId -or
    [string]$removalState.workloadPrincipalId -cne $principalId -or
    [string]$removalState.environmentName -cne $environmentName)) {
    throw 'The Teams removal checkpoint does not match this tenant and deployment identity.'
}
if ($removalState -and $removalState.phase -eq 'absence-verified') {
    if ([string]$removalState.installationUserId -cne $UserId.Guid -or [string]$removalState.catalogAppId -cne $catalogId) {
        throw 'The verified-absence checkpoint does not match this pilot and catalog receipt.'
    }
    $remainingInstallationId = Get-Env TEAMS_INSTALLATION_ID
    $remainingInstallationUser = Get-Env TEAMS_INSTALLATION_USER_ID
    $remainingInstallationOwnership = Get-Env TEAMS_INSTALL_OWNERSHIP
    if (($remainingInstallationId -and $remainingInstallationId -cne [string]$removalState.installationId) -or
        ($remainingInstallationUser -and $remainingInstallationUser -cne [string]$removalState.installationUserId) -or
        ($remainingInstallationOwnership -and $remainingInstallationOwnership -cne 'created')) {
        throw 'The remaining Teams installation receipt does not match the verified-absence checkpoint.'
    }
    if (-not $PSCmdlet.ShouldProcess($UserId.Guid, 'Finish clearing the exact Teams installation receipt after verified absence')) { return }
    Clear-RemovalReceipt
    Write-Host "Finished clearing the Teams installation receipt after previously verified absence for $UserId."
    return
}

$catalogOwnership = Get-Env TEAMS_CATALOG_OWNERSHIP -Required
$installationId = Get-Env TEAMS_INSTALLATION_ID -Required
$installationUser = Get-Env TEAMS_INSTALLATION_USER_ID -Required
$installationOwnership = Get-Env TEAMS_INSTALL_OWNERSHIP -Required
$packageVersion = Get-Env TEAMS_PACKAGE_VERSION -Required
if ($removalState -and $removalState.phase -eq 'delete-pending') {
    if ([string]$removalState.installationId -cne $installationId -or
        [string]$removalState.installationUserId -cne $installationUser -or
        [string]$removalState.catalogAppId -cne $catalogId) {
        throw 'The pending Teams removal checkpoint does not match the exact installation receipt.'
    }
}
$receipt = @{
    CatalogId = $catalogId; CatalogOwnership = $catalogOwnership; InstallationId = $installationId
    InstallationUserId = $installationUser; InstallationOwnership = $installationOwnership; PackageVersion = $packageVersion
}
Assert-TeamsRemovalReceipt $receipt $UserId.Guid

$scopes = @('AppCatalog.ReadWrite.All', 'TeamsAppInstallation.ReadWriteForUser', 'User.Read')
$token = $null
$useGraphModule = $false
if ($UseCachedWam) {
    $module = Get-Module Microsoft.Graph.Authentication -ListAvailable | Sort-Object Version -Descending | Select-Object -First 1
    if (-not $module) { throw 'Microsoft.Graph.Authentication is required for cached WAM authentication.' }
    $dependencyPath = Join-Path $module.ModuleBase 'Dependencies'
    foreach ($dll in @('Microsoft.IdentityModel.Abstractions.dll', 'Desktop\Microsoft.Identity.Client.dll', 'Microsoft.Identity.Client.NativeInterop.dll', 'Microsoft.Identity.Client.Broker.dll')) {
        Add-Type -Path (Join-Path $dependencyPath $dll)
    }
    $graphClientId = '14d82eec-204b-4c2f-b7e8-296a70dab67e'
    $builder = [Microsoft.Identity.Client.PublicClientApplicationBuilder]::Create($graphClientId).WithAuthority("https://login.microsoftonline.com/$tenantId").WithRedirectUri("ms-appx-web://microsoft.aad.brokerplugin/$graphClientId")
    $broker = [Microsoft.Identity.Client.BrokerOptions]::new([Microsoft.Identity.Client.BrokerOptions+OperatingSystems]::Windows)
    $broker.ListOperatingSystemAccounts = $true
    $app = [Microsoft.Identity.Client.Broker.BrokerExtension]::WithBroker($builder, $broker).Build()
    $accounts = @($app.GetAccountsAsync().GetAwaiter().GetResult() | Where-Object Username -ieq $AdminUpn)
    if ($accounts.Count -ne 1) { throw 'Expected cached WAM administrator account was not found uniquely.' }
    $result = $app.AcquireTokenSilent([string[]]($scopes | ForEach-Object { "https://graph.microsoft.com/$_" }), $accounts[0]).ExecuteAsync().GetAwaiter().GetResult()
    $token = $result.AccessToken
    Assert-TeamsTenantContext $tenantId ([string]$result.TenantId)
}
else {
    Import-Module Microsoft.Graph.Authentication
    Connect-MgGraph -TenantId $tenantId -Scopes $scopes -ContextScope Process -NoWelcome
    $context = Get-MgContext
    if (-not $context -or [string]$context.Account -ine $AdminUpn) {
        throw 'Normal Graph sign-in does not match the requested administrator and tenant.'
    }
    Assert-TeamsTenantContext $tenantId ([string]$context.TenantId)
    $useGraphModule = $true
}
if (-not $useGraphModule -and (-not $token -or (Get-TokenTenant $token) -cne $tenantId)) { throw 'Graph token does not match the expected tenant.' }
$headers = @{ Authorization = "Bearer $token"; Accept = 'application/json' }
function Invoke-Graph([string]$Method, [string]$Uri, [object]$Body, [string]$File) {
    $url = Assert-GraphUri $Uri
    if ($useGraphModule) {
        if ($Body) { return Invoke-MgGraphRequest -Method $Method -Uri $url -Body ($Body | ConvertTo-Json -Compress) -ContentType 'application/json' -OutputType PSObject }
        return Invoke-MgGraphRequest -Method $Method -Uri $url -OutputType PSObject
    }
    if ($Body) { return Invoke-RestMethod -Method $Method -Uri $url -Headers $headers -ContentType 'application/json' -Body ($Body | ConvertTo-Json -Compress) }
    Invoke-RestMethod -Method $Method -Uri $url -Headers $headers
}

$catalogSegment = ConvertTo-TeamsGraphSegment $catalogId 'Teams catalog app ID'
$catalog = Invoke-Graph GET "https://graph.microsoft.com/v1.0/appCatalogs/teamsApps/$catalogSegment" $null $null
if ([string]$catalog.id -cne $catalogId -or [string]$catalog.externalId -cne $clientId -or [string]$catalog.distributionMethod -cne 'organization') {
    throw 'The exact catalog app does not match the recorded workload identity.'
}
$invokeGraph = { param($Method, $Uri, $Body, $File) Invoke-Graph $Method $Uri $Body $File }
if (-not $PSCmdlet.ShouldProcess("user $($UserId.Guid), installation $installationId", 'Delete the exact recorded personal Teams installation and verify absence')) { return }
Set-RemovalState 'delete-pending' $installationId $UserId.Guid $catalogId $tenantId $clientId $principalId $environmentName
Remove-ExactTeamsInstallation $invokeGraph $UserId.Guid $installationId $catalogId $clientId $packageVersion
Set-RemovalState 'absence-verified' $installationId $UserId.Guid $catalogId $tenantId $clientId $principalId $environmentName
Clear-RemovalReceipt
Write-Host "Verified removal of Teams personal installation $installationId for $UserId. The catalog app was retained."
