[CmdletBinding(SupportsShouldProcess)]
param(
    [Parameter(Mandatory)][ValidatePattern('^[^@\s]+@[^@\s]+$')][string] $AdminUpn,
    [Parameter(Mandatory)][guid] $UserId,
    [string] $PackagePath = (Join-Path (Split-Path $PSScriptRoot -Parent) 'teams-app/auth-notifications.zip'),
    [switch] $UseCachedWam,
    [switch] $AdoptExisting,
    [switch] $UpdateExisting
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
function Get-Env([string]$Name, [switch]$Required) {
    $v = (& azd env get-value $Name 2>$null | Out-String).Trim()
    $missing = $LASTEXITCODE -ne 0 -or $v -match '^ERROR: key not found in environment values:'
    if ($Required -and ($missing -or -not $v)) {
        throw "$Name is required from the initialized azd environment."
    }
    if ($missing) { return '' }
    $v
}
function Set-Env([string]$Name, [string]$Value) {
    & azd env set $Name $Value | Out-Null
    if ($LASTEXITCODE -ne 0) {
        throw "Unable to checkpoint $Name in the azd environment."
    }
}
function Assert-GraphUri([string]$Uri) {
    $u = [uri]$Uri
    if ($u.Scheme -ne 'https' -or $u.Host -ne 'graph.microsoft.com' -or $u.Port -ne 443 -or $u.UserInfo -or ($u.AbsolutePath -ne '/v1.0' -and -not $u.AbsolutePath.StartsWith('/v1.0/')) -or $u.Fragment) {
        throw 'Graph request URI is outside graph.microsoft.com v1.0.'
    }
    $u.AbsoluteUri
}
function Get-TokenTenant([string]$Token) {
    $p = $Token.Split('.')
    if ($p.Count -ne 3) {
        throw 'Invalid Graph token.'
    }
    $b = $p[1].Replace('-', '+').Replace('_', '/')
    switch ($b.Length % 4) {
        2 {
            $b += '=='
        }3 {
            $b += '='
        }1 {
            throw 'Invalid Graph token.'
        }
    }
    ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($b)) | ConvertFrom-Json).tid
}
function Get-CanonicalPackageHash([string]$Path) {
    $archive = [IO.Compression.ZipFile]::OpenRead($Path)
    try {
        $entries = foreach ($entry in $archive.Entries | Where-Object { -not $_.FullName.EndsWith('/') }) {
            $stream = $entry.Open()
            try {
                $hash = [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($stream)).ToLowerInvariant()
            }
            finally { $stream.Dispose() }
            "$($entry.FullName.Replace('\', '/'))`0$hash"
        }
        $bytes = [Text.Encoding]::UTF8.GetBytes((@($entries | Sort-Object) -join "`n"))
        [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($bytes)).ToLowerInvariant()
    }
    finally { $archive.Dispose() }
}

foreach ($command in @('azd', 'az')) {
    if (-not(Get-Command $command -ErrorAction SilentlyContinue)) {
        throw "Required command '$command' was not found."
    }
}
$tenantId = Get-Env AZURE_TENANT_ID -Required
$clientId = Get-Env AZURE_WORKLOAD_CLIENT_ID -Required
$functionUrl = Get-Env AZURE_FUNCTION_APP_URL -Required
$subscriptionId = Get-Env AZURE_SUBSCRIPTION_ID -Required
$resourceGroup = Get-Env AZURE_RESOURCE_GROUP -Required
$functionName = Get-Env AZURE_FUNCTION_APP_NAME -Required
$environmentName = Get-Env AZURE_ENV_NAME -Required
$principalId = Get-Env AZURE_WORKLOAD_PRINCIPAL_ID -Required
$appInfo = & az functionapp show --subscription $subscriptionId --resource-group $resourceGroup --name $functionName --query '{tags:tags}' -o json | ConvertFrom-Json
$identity = & az functionapp identity show --subscription $subscriptionId --resource-group $resourceGroup --name $functionName -o json | ConvertFrom-Json
if ($LASTEXITCODE -ne 0 -or $appInfo.tags.'azd-env-name' -cne $environmentName -or @($identity.userAssignedIdentities.PSObject.Properties.Value | Where-Object { $_.clientId -ceq $clientId -and $_.principalId -ceq $principalId }).Count -ne 1) {
    throw 'Function deployment identity or azd environment tag does not match this installer target.'
}
$pilots = @((Get-Env PILOT_USER_IDS -Required) -split ',' | ForEach-Object { $_.Trim() } | Where-Object { $_ })
if ($pilots -notcontains $UserId.Guid) {
    throw 'UserId must be one of PILOT_USER_IDS; broad Teams installation is not supported.'
}
$functionHost = ([uri]$functionUrl).Host
if (-not $functionHost -or ([uri]$functionUrl).Scheme -ne 'https') {
    throw 'AZURE_FUNCTION_APP_URL must be HTTPS.'
}
$package = (Resolve-Path -LiteralPath $PackagePath -ErrorAction Stop).Path
$packageHash = Get-CanonicalPackageHash $package
$archive = [IO.Compression.ZipFile]::OpenRead($package)
try {
    $entry = $archive.GetEntry('manifest.json')
    if (-not $entry) { throw 'Package is missing manifest.json.' }
    $reader = [IO.StreamReader]::new($entry.Open())
    try { $manifest = $reader.ReadToEnd() | ConvertFrom-Json } finally { $reader.Dispose() }
} finally { $archive.Dispose() }
$bots = @($manifest.bots)
if ([string]$manifest.id -cne $clientId -or $bots.Count -ne 1 -or
    [string]$bots[0].botId -cne $clientId -or @($bots[0].scopes).Count -ne 1 -or
    [string]$bots[0].scopes[0] -cne 'personal' -or $bots[0].isNotificationOnly -ne $true -or
    [string]$manifest.version -notmatch '^\d+\.\d+\.\d+$' -or
    @($manifest.validDomains).Count -ne 1 -or [string]$manifest.validDomains[0] -cne $functionHost) {
    throw 'Teams package does not exactly match the deployed personal bot identity, version, or Function host.'
}

$scopes = @('AppCatalog.ReadWrite.All', 'TeamsAppInstallation.ReadWriteForUser', 'User.Read')
$token = $null
$useGraphModule = $false
if ($UseCachedWam) {
    $module = Get-Module Microsoft.Graph.Authentication -ListAvailable | Sort-Object Version -Descending | Select-Object -First 1
    if (-not $module) {
        throw 'Microsoft.Graph.Authentication is required for cached WAM authentication.'
    }
    $dep = Join-Path $module.ModuleBase 'Dependencies'
    foreach ($dll in @('Microsoft.IdentityModel.Abstractions.dll', 'Desktop\Microsoft.Identity.Client.dll', 'Microsoft.Identity.Client.NativeInterop.dll', 'Microsoft.Identity.Client.Broker.dll')) {
        Add-Type -Path (Join-Path $dep $dll)
    }
    $graphClientId = '14d82eec-204b-4c2f-b7e8-296a70dab67e'
    $builder = [Microsoft.Identity.Client.PublicClientApplicationBuilder]::Create($graphClientId).WithAuthority("https://login.microsoftonline.com/$tenantId").WithRedirectUri("ms-appx-web://microsoft.aad.brokerplugin/$graphClientId")
    $broker = [Microsoft.Identity.Client.BrokerOptions]::new([Microsoft.Identity.Client.BrokerOptions+OperatingSystems]::Windows)
    $broker.ListOperatingSystemAccounts = $true
    $app = [Microsoft.Identity.Client.Broker.BrokerExtension]::WithBroker($builder, $broker).Build()
    $accounts = @($app.GetAccountsAsync().GetAwaiter().GetResult() | Where-Object Username -ieq $AdminUpn)
    if ($accounts.Count -ne 1) {
        throw 'Expected cached WAM administrator account was not found uniquely.'
    }
    $result = $app.AcquireTokenSilent([string[]]($scopes | ForEach-Object { "https://graph.microsoft.com/$_" }), $accounts[0]).ExecuteAsync().GetAwaiter().GetResult()
    $token = $result.AccessToken
    if ($result.TenantId -cne $tenantId) {
        throw 'Cached WAM token tenant mismatch.'
    }
}
else {
    Import-Module Microsoft.Graph.Authentication
    Connect-MgGraph -TenantId $tenantId -Scopes $scopes -ContextScope Process -NoWelcome
    $ctx = Get-MgContext
    if (-not $ctx -or $ctx.TenantId -cne $tenantId -or [string]$ctx.Account -ine $AdminUpn) {
        throw 'Normal Graph sign-in does not match the requested administrator and tenant.'
    }
    $useGraphModule = $true
}
if (-not $useGraphModule -and (-not $token -or (Get-TokenTenant $token) -cne $tenantId)) {
    throw 'Graph token does not match the expected tenant.'
}
$headers = @{Authorization = "Bearer $token"
    Accept = 'application/json'
}
function Invoke-Graph([string]$Method, [string]$Uri, [object]$Body, [string]$File) {
    $url = Assert-GraphUri $Uri
    if ($useGraphModule) {
        if ($File) {
            return Invoke-MgGraphRequest -Method $Method -Uri $url -InputFilePath $File -ContentType 'application/zip' -OutputType PSObject
        }
        if ($Body) {
            return Invoke-MgGraphRequest -Method $Method -Uri $url -Body ($Body | ConvertTo-Json -Compress) -ContentType 'application/json' -OutputType PSObject
        }
        return Invoke-MgGraphRequest -Method $Method -Uri $url -OutputType PSObject
    }
    if ($File) {
        return Invoke-RestMethod -Method $Method -Uri $url -Headers $headers -ContentType 'application/zip' -InFile $File
    }
    if ($Body) {
        return Invoke-RestMethod -Method $Method -Uri $url -Headers $headers -ContentType 'application/json' -Body ($Body | ConvertTo-Json -Compress)
    }
    Invoke-RestMethod -Method $Method -Uri $url -Headers $headers
}
function Get-Paged([string]$Uri) {
    $items = @()
    do {
        $r = Invoke-Graph GET $Uri $null $null
        $items += @($r.value)
        $p = $r.PSObject.Properties['@odata.nextLink']
        $Uri = if ($p) {
            [string]$p.Value
        }
        else {
            $null
        }
    }while ($Uri)
    @($items)
}
function Set-PackageReceipt {
    Set-Env TEAMS_PACKAGE_VERSION ([string]$manifest.version)
    Set-Env TEAMS_PACKAGE_SHA256 $packageHash
    Set-Env TEAMS_PACKAGE_HASH_FORMAT 'canonical-content-v1'
}
function Set-InstallationReceipt([object]$Installation, [string]$Ownership) {
    Set-Env TEAMS_INSTALLATION_ID ([string]$Installation.id)
    Set-Env TEAMS_INSTALLATION_USER_ID $UserId.Guid
    Set-Env TEAMS_INSTALL_OWNERSHIP $Ownership
}
function Get-CatalogDefinitions([string]$CatalogId) {
    @(Get-Paged "https://graph.microsoft.com/v1.0/appCatalogs/teamsApps/$CatalogId/appDefinitions")
}
function Wait-CatalogDefinition([string]$CatalogId, [string]$Version) {
    for ($attempt = 1; $attempt -le 18; $attempt++) {
        try {
            $definition = @(Get-CatalogDefinitions $CatalogId | Where-Object {
                    [string]$_.version -ceq $Version -and [string]$_.publishingState -ceq 'published'
                }) | Select-Object -First 1
            if ($definition) { return $definition }
        }
        catch {
            if ($attempt -eq 18) { throw 'The Teams catalog definition could not be read after waiting for propagation.' }
        }
        Start-Sleep -Seconds 5
    }
    throw "Teams catalog app version '$Version' was not visible as published after waiting for propagation."
}

$catalogApp = $null
$catalogWasCreated = $false
$recorded = Get-Env TEAMS_CATALOG_APP_ID
$catalogOwnership = Get-Env TEAMS_CATALOG_OWNERSHIP
$recordedPackageHash = Get-Env TEAMS_PACKAGE_SHA256
if ($recorded -and $catalogOwnership -and $catalogOwnership -notin @('created', 'adopted')) {
    throw 'Recorded Teams catalog ownership state is invalid.'
}
# Installed definitions are authoritative for a rerun even while catalog replicas lag.
if ($recorded) {
    $installedUri = "https://graph.microsoft.com/v1.0/users/$($UserId.Guid)/teamwork/installedApps?`$expand=teamsApp,teamsAppDefinition"
    $existingInstalls = @(Get-Paged $installedUri | Where-Object { [string]$_.teamsApp.id -ceq $recorded })
    if ($existingInstalls.Count -gt 1) { throw 'Multiple personal installations match the recorded catalog ID.' }
    if ($existingInstalls.Count -eq 1) {
        $existing = $existingInstalls[0]
        if ([string]$existing.teamsApp.externalId -cne $clientId -or
            [string]$existing.teamsAppDefinition.version -cne [string]$manifest.version -or
            [string]$existing.teamsAppDefinition.publishingState -cne 'published') {
            throw 'Installed app identity or published version differs from this package.'
        }
        if ($recordedPackageHash -and $recordedPackageHash -cne $packageHash) {
            throw 'The Teams package bytes differ from the recorded deployment; increment the manifest version before updating.'
        }
        if (-not $catalogOwnership) {
            if (-not $AdoptExisting) {
                throw 'The recorded Teams app predates ownership receipts. Rerun with -AdoptExisting after verifying that it belongs to this deployment.'
            }
            if ($PSCmdlet.ShouldProcess($recorded, 'Adopt the recorded Teams catalog app and write ownership receipts')) {
                Set-Env TEAMS_CATALOG_OWNERSHIP 'adopted'
                Set-PackageReceipt
            }
        }
        elseif (-not $recordedPackageHash -and $PSCmdlet.ShouldProcess($recorded, 'Record the verified Teams package provenance')) {
            Set-PackageReceipt
        }
        if ($PSCmdlet.ShouldProcess($UserId.Guid, 'Record verified existing Teams installation')) {
            $existingOwnership = Get-Env TEAMS_INSTALL_OWNERSHIP
            if ($existingOwnership -notin @('created', 'adopted')) {
                if (-not $AdoptExisting) {
                    throw 'The Teams app is already installed without a matching creation receipt. Rerun with -AdoptExisting after verifying the installation.'
                }
                $existingOwnership = 'adopted'
            }
            Set-InstallationReceipt $existing $existingOwnership
            Set-Env TEAMS_CATALOG_UPDATE_STATUS 'complete'
        }
        Write-Host "Verified existing personal Teams installation for $UserId."
        return
    }
}
$filter = [uri]::EscapeDataString("externalId eq '$clientId'")
$catalog = @(Get-Paged "https://graph.microsoft.com/v1.0/appCatalogs/teamsApps?`$filter=$filter" | Where-Object { [string]$_.externalId -ceq $clientId })
if ($catalog.Count -eq 0 -and $recorded) {
    $catalogApp = Invoke-Graph GET "https://graph.microsoft.com/v1.0/appCatalogs/teamsApps/${recorded}?`$expand=appDefinitions" $null $null
}
elseif ($catalog.Count -eq 1) {
    $catalogApp = $catalog[0]
}
elseif ($catalog.Count -gt 1) {
    throw 'More than one catalog app matches the workload client ID.'
}
if (-not $catalogApp) {
    if (-not $PSCmdlet.ShouldProcess($clientId, 'Publish Teams package')) {
        return
    }
    Set-Env TEAMS_PACKAGE_VERSION ([string]$manifest.version)
    Set-Env TEAMS_PACKAGE_SHA256 $packageHash
    Set-Env TEAMS_PACKAGE_HASH_FORMAT 'canonical-content-v1'
    Set-Env TEAMS_CATALOG_OWNERSHIP 'create-pending'
    $catalogApp = Invoke-Graph POST 'https://graph.microsoft.com/v1.0/appCatalogs/teamsApps' $null $package
    if (-not $catalogApp.id) {
        throw 'Catalog publish returned no ID.'
    }
    $catalogWasCreated = $true
    if ($PSCmdlet.ShouldProcess([string]$catalogApp.id, 'Checkpoint catalog ID in local azd state')) {
        Set-Env TEAMS_CATALOG_APP_ID ([string]$catalogApp.id)
        Set-Env TEAMS_CATALOG_OWNERSHIP 'created'
    }
}
elseif ($recorded -and $recorded -cne $catalogApp.id) {
    throw 'Catalog app does not match recorded catalog ID.'
}
elseif (-not $recorded) {
    if ([string]$catalogApp.externalId -cne $clientId -or [string]$catalogApp.distributionMethod -cne 'organization') {
        throw 'Existing catalog app identity is not the expected organization app.'
    }
    if (-not $AdoptExisting) {
        throw 'Existing catalog app requires -AdoptExisting after ownership review.'
    }
    if (-not $PSCmdlet.ShouldProcess([string]$catalogApp.id, 'Adopt catalog app in local azd state')) {
        return
    }
    Set-Env TEAMS_CATALOG_APP_ID ([string]$catalogApp.id)
    Set-Env TEAMS_CATALOG_OWNERSHIP 'adopted'
    Set-PackageReceipt
    $catalogOwnership = 'adopted'
}
if ($recorded -and -not $catalogOwnership) {
    if (-not $AdoptExisting) {
        throw 'The recorded Teams catalog app predates ownership receipts. Rerun with -AdoptExisting after verifying that it belongs to this deployment.'
    }
    if ($PSCmdlet.ShouldProcess([string]$catalogApp.id, 'Adopt the recorded Teams catalog app and write ownership receipts')) {
        Set-Env TEAMS_CATALOG_OWNERSHIP 'adopted'
        Set-PackageReceipt
        $catalogOwnership = 'adopted'
    }
}
if ([string]$catalogApp.externalId -cne $clientId -or [string]$catalogApp.distributionMethod -cne 'organization') {
    throw 'Catalog app identity is not the expected organization app.'
}
$recordedPackageHash = Get-Env TEAMS_PACKAGE_SHA256
if ($recordedPackageHash -and $recordedPackageHash -cne $packageHash -and (Get-Env TEAMS_PACKAGE_VERSION) -ceq [string]$manifest.version) {
    throw 'The Teams package bytes differ from the recorded deployment; increment the manifest version before updating.'
}
$allDefinitions = @(Get-CatalogDefinitions ([string]$catalogApp.id))
$newerDefinitions = @($allDefinitions | Where-Object {
        [string]$_.version -match '^\d+\.\d+\.\d+$' -and [version]$_.version -gt [version]$manifest.version
    })
if ($newerDefinitions.Count -gt 0) {
    throw "The Teams catalog contains newer version '$($newerDefinitions[0].version)'; refusing to install or downgrade to '$($manifest.version)'."
}
$definitions = @($allDefinitions | Where-Object { [string]$_.version -ceq [string]$manifest.version -and [string]$_.publishingState -ceq 'published' })
if ($definitions.Count -eq 0) {
    if (-not $UpdateExisting -and $catalogOwnership -eq 'adopted') {
        throw 'Updating an adopted Teams catalog app requires -UpdateExisting after verifying the new package and version.'
    }
    if (-not $UpdateExisting -and $catalogOwnership -eq 'created' -and -not $catalogWasCreated) {
        throw 'The catalog does not contain the package version in published state; rerun with -UpdateExisting only after reviewing the package version.'
    }
    if (-not $PSCmdlet.ShouldProcess([string]$catalogApp.id, 'Publish a new Teams catalog app definition')) {
        return
    }
    Set-PackageReceipt
    Set-Env TEAMS_CATALOG_UPDATE_STATUS 'update-pending'
    [void](Invoke-Graph POST "https://graph.microsoft.com/v1.0/appCatalogs/teamsApps/$($catalogApp.id)/appDefinitions" $null $package)
    $definitions = @(Wait-CatalogDefinition ([string]$catalogApp.id) ([string]$manifest.version))
}
if ($definitions.Count -ne 1) {
    throw 'The catalog does not contain exactly one published package definition for this version.'
}
$installUri = "https://graph.microsoft.com/v1.0/users/$($UserId.Guid)/teamwork/installedApps?`$expand=teamsApp"
$installs = @(Get-Paged $installUri | Where-Object { [string]$_.teamsApp.externalId -ceq $clientId })
if ($installs.Count -gt 1) {
    throw 'More than one matching personal installation exists.'
}
if ($installs.Count -eq 0) {
    if (-not $PSCmdlet.ShouldProcess($UserId.Guid, 'Install Teams app in personal scope')) {
        return
    }
    Set-Env TEAMS_INSTALL_OWNERSHIP 'create-pending'
    $body = @{'teamsApp@odata.bind' = "https://graph.microsoft.com/v1.0/appCatalogs/teamsApps/$($catalogApp.id)" }
    $installSubmitted = $false
    for ($attempt = 1; $attempt -le 18 -and -not $installSubmitted; $attempt++) {
        try {
            [void](Invoke-Graph POST "https://graph.microsoft.com/v1.0/users/$($UserId.Guid)/teamwork/installedApps" $body $null)
            $installSubmitted = $true
        }
        catch {
            $message = $_.Exception.Message
            if ($message -match '\b409\b|Conflict|already installed') {
                $installSubmitted = $true
                continue
            }
            if ($message -notmatch 'blocked by app permission policy|app is blocked|not allowed.*app') { throw }
            if ($attempt -eq 18) {
                throw 'Teams policy still blocks this personal installation. Make the app available to the exact pilot user, wait for policy propagation, and rerun this command.'
            }
            Write-Host "Waiting for administrator-owned Teams app policy to propagate (attempt $attempt of 18)..."
            Start-Sleep -Seconds 10
        }
    }
    if (-not $installSubmitted) { throw 'The personal Teams app installation request was not accepted.' }
    $installs = @(Get-Paged $installUri | Where-Object { [string]$_.teamsApp.externalId -ceq $clientId })
    if ($installs.Count -ne 1) {
        for ($attempt = 1; $attempt -le 12 -and $installs.Count -eq 0; $attempt++) {
            Start-Sleep -Seconds 5
            $installs = @(Get-Paged $installUri | Where-Object { [string]$_.teamsApp.externalId -ceq $clientId })
        }
    }
    if ($installs.Count -ne 1) {
        throw 'Personal installation was not visible after waiting for propagation.'
    }
}
if ($PSCmdlet.ShouldProcess($UserId.Guid, 'Record Teams installation in local azd state')) {
    $installationOwnership = Get-Env TEAMS_INSTALL_OWNERSHIP
    if ($installationOwnership -eq 'create-pending') { $installationOwnership = 'created' }
    if (-not $installationOwnership) {
        if (-not $AdoptExisting) {
            throw 'The Teams app is already installed without a matching creation receipt. Rerun with -AdoptExisting after verifying the installation.'
        }
        $installationOwnership = 'adopted'
    }
    Set-InstallationReceipt $installs[0] $installationOwnership
    Set-Env TEAMS_CATALOG_UPDATE_STATUS 'complete'
}
Write-Host "Teams personal app is installed for $UserId."
