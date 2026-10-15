Set-StrictMode -Version Latest

function ConvertTo-TeamsGraphSegment {
    [CmdletBinding()]
    param([Parameter(Mandatory)][object] $Value, [Parameter(Mandatory)][string] $Name)

    if ($Value -isnot [string]) {
        throw "$Name must be a string."
    }
    $text = [string]$Value
    if ($text.Length -lt 1 -or $text.Length -gt 512 -or $text -match '[\x00-\x1f\x7f]') {
        throw "$Name is malformed."
    }
    [uri]::EscapeDataString($text)
}

function Assert-TeamsInstallation {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][object] $Installation,
        [Parameter(Mandatory)][string] $InstallationId,
        [Parameter(Mandatory)][string] $CatalogAppId,
        [Parameter(Mandatory)][string] $ExternalId,
        [Parameter(Mandatory)][string] $Version
    )

    if ([string]$Installation.id -cne $InstallationId -or
        [string]$Installation.teamsApp.id -cne $CatalogAppId -or
        [string]$Installation.teamsApp.externalId -cne $ExternalId -or
        [string]$Installation.teamsAppDefinition.version -cne $Version -or
        [string]$Installation.teamsAppDefinition.publishingState -cne 'published') {
        throw 'The exact Teams installation does not match the recorded catalog app, workload, or published package version.'
    }
    $Installation
}

function Assert-TeamsTenantContext {
    [CmdletBinding()]
    param([Parameter(Mandatory)][string] $ExpectedTenantId, [Parameter(Mandatory)][string] $ActualTenantId)

    if ($ActualTenantId -cne $ExpectedTenantId) { throw 'Graph authentication tenant mismatch.' }
}

function Get-TeamsCreatedInstallationId {
    [CmdletBinding()]
    param([Parameter(Mandatory)][object] $Response, [Parameter(Mandatory)][string] $UserId)

    $bodyProperty = $Response.PSObject.Properties['Body']
    $body = if ($bodyProperty) { $bodyProperty.Value } else { $Response }
    $idProperty = if ($null -ne $body) { $body.PSObject.Properties['id'] } else { $null }
    $id = if ($idProperty) { [string]$idProperty.Value } else { '' }
    if (-not $id) {
        $headersProperty = $Response.PSObject.Properties['Headers']
        $headers = if ($headersProperty) { $headersProperty.Value } else { $null }
        $location = if ($headers -is [Collections.IDictionary]) { [string]$headers['Location'] } elseif ($headers) { [string]$headers.Location } else { '' }
        if ($location) {
            $parsed = [uri]$location
            $userSegment = ConvertTo-TeamsGraphSegment $UserId 'Teams installation user ID'
            $prefix = "/v1.0/users/$userSegment/teamwork/installedApps/"
            if ($parsed.Scheme -cne 'https' -or $parsed.Host -cne 'graph.microsoft.com' -or $parsed.Query -or $parsed.Fragment -or
                -not $parsed.AbsolutePath.StartsWith($prefix, [StringComparison]::Ordinal)) {
                throw 'The personal Teams app installation response Location is outside the exact user installation collection.'
            }
            $id = [uri]::UnescapeDataString($parsed.AbsolutePath.Substring($prefix.Length))
        }
    }
    if (-not $id) { throw 'The personal Teams app installation response did not contain an installation ID; ownership remains uncertain.' }
    [void](ConvertTo-TeamsGraphSegment $id 'Teams installation ID')
    $id
}

function Get-TeamsInstallCreateErrorKind {
    [CmdletBinding()]
    param([Parameter(Mandatory)][string] $Message)

    if ($Message -match '\b409\b|Conflict|already installed') {
        return 'conflict'
    }
    if ($Message -match 'blocked by app permission policy|app is blocked|not allowed.*app') { return 'policy' }
    'uncertain'
}

function Assert-TeamsRemovalReceipt {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][Collections.IDictionary] $Receipt,
        [Parameter(Mandatory)][string] $ExpectedUserId
    )

    foreach ($name in @('CatalogId', 'CatalogOwnership', 'InstallationId', 'InstallationUserId', 'InstallationOwnership', 'PackageVersion')) {
        if (-not $Receipt[$name]) { throw "The Teams removal receipt is missing $name." }
    }
    if ([string]$Receipt.InstallationOwnership -cne 'created') {
        throw 'Only an exact installation with a created ownership receipt can be removed; adopted or unproven installations are retained.'
    }
    if ([string]$Receipt.CatalogOwnership -notin @('created', 'adopted') -or
        [string]$Receipt.InstallationUserId -cne $ExpectedUserId -or
        [string]$Receipt.PackageVersion -notmatch '^\d+\.\d+\.\d+$') {
        throw 'The Teams lifecycle receipt does not match this user or has invalid ownership metadata.'
    }
    [void](ConvertTo-TeamsGraphSegment ([string]$Receipt.CatalogId) 'Teams catalog app ID')
    [void](ConvertTo-TeamsGraphSegment ([string]$Receipt.InstallationId) 'Teams installation ID')
}

function Get-TeamsInstallationUri {
    [CmdletBinding()]
    param([Parameter(Mandatory)][string] $UserId, [Parameter(Mandatory)][string] $InstallationId)

    $userSegment = ConvertTo-TeamsGraphSegment $UserId 'Teams installation user ID'
    $installationSegment = ConvertTo-TeamsGraphSegment $InstallationId 'Teams installation ID'
    "https://graph.microsoft.com/v1.0/users/$userSegment/teamwork/installedApps/$installationSegment`?`$expand=teamsApp,teamsAppDefinition"
}

function Test-TeamsGraphNotFoundError {
    [CmdletBinding()]
    param([Parameter(Mandatory)][Management.Automation.ErrorRecord] $ErrorRecord)

    $exception = $ErrorRecord.Exception
    $responseStatusProperty = $exception.PSObject.Properties['ResponseStatusCode']
    $statusProperty = $exception.PSObject.Properties['StatusCode']
    $responseProperty = $exception.PSObject.Properties['Response']
    $response = if ($responseProperty) { $responseProperty.Value } else { $null }
    $nestedStatusProperty = if ($null -ne $response) { $response.PSObject.Properties['StatusCode'] } else { $null }
    $statusCandidates = @(
        $(if ($responseStatusProperty) { $responseStatusProperty.Value }),
        $(if ($statusProperty) { $statusProperty.Value }),
        $(if ($nestedStatusProperty) { $nestedStatusProperty.Value })
    )
    $statusCode = $null
    foreach ($candidate in $statusCandidates) {
        if ($null -eq $candidate) { continue }
        try { $statusCode = [int]$candidate } catch { continue }
        break
    }
    if ($statusCode -ne 404) { return $false }

    $errorCode = ''
    $codeProperty = $exception.PSObject.Properties['Code']
    $errorProperty = $exception.PSObject.Properties['Error']
    $structuredError = if ($errorProperty) { $errorProperty.Value } else { $null }
    $nestedCodeProperty = if ($null -ne $structuredError) { $structuredError.PSObject.Properties['Code'] } else { $null }
    foreach ($candidate in @(
            $(if ($codeProperty) { $codeProperty.Value }),
            $(if ($nestedCodeProperty) { $nestedCodeProperty.Value })
        )) {
        if ($candidate) { $errorCode = [string]$candidate; break }
    }
    if (-not $errorCode -and $ErrorRecord.ErrorDetails -and $ErrorRecord.ErrorDetails.Message) {
        try {
            $details = $ErrorRecord.ErrorDetails.Message | ConvertFrom-Json -ErrorAction Stop
            $errorCode = [string]$details.error.code
        }
        catch { return $false }
    }
    $errorCode -in @('Request_ResourceNotFound', 'ResourceNotFound', 'itemNotFound', 'NotFound')
}

function Wait-TeamsCatalogDefinition {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][scriptblock] $GetDefinitions,
        [Parameter(Mandatory)][string] $CatalogAppId,
        [Parameter(Mandatory)][string] $Version,
        [ValidateRange(1, 100)][int] $Attempts = 18,
        [ValidateRange(0, 300)][int] $DelaySeconds = 5,
        [scriptblock] $Sleep = { param($Seconds) Start-Sleep -Seconds $Seconds }
    )

    [void](ConvertTo-TeamsGraphSegment $CatalogAppId 'Teams catalog app ID')
    for ($attempt = 1; $attempt -le $Attempts; $attempt++) {
        try {
            $matches = @(& $GetDefinitions $CatalogAppId | Where-Object {
                    [string]$_.version -ceq $Version -and [string]$_.publishingState -ceq 'published'
                })
            if ($matches.Count -eq 1) { return $matches[0] }
            if ($matches.Count -gt 1) { throw 'The catalog contains multiple published definitions for the requested version.' }
        }
        catch {
            if ($attempt -eq $Attempts) { throw 'The Teams catalog definition could not be read after waiting for propagation.' }
        }
        if ($attempt -lt $Attempts) { & $Sleep $DelaySeconds }
    }
    throw "Teams catalog app version '$Version' was not visible as published after waiting for propagation."
}

function Get-ExactTeamsInstallation {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][scriptblock] $InvokeGraph,
        [Parameter(Mandatory)][string] $UserId,
        [Parameter(Mandatory)][string] $InstallationId,
        [Parameter(Mandatory)][string] $CatalogAppId,
        [Parameter(Mandatory)][string] $ExternalId,
        [Parameter(Mandatory)][string] $Version
    )

    $uri = Get-TeamsInstallationUri $UserId $InstallationId
    $installation = & $InvokeGraph GET $uri $null $null
    Assert-TeamsInstallation $installation $InstallationId $CatalogAppId $ExternalId $Version
}

function Wait-ExactTeamsInstallation {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][scriptblock] $InvokeGraph,
        [Parameter(Mandatory)][string] $UserId,
        [Parameter(Mandatory)][string] $InstallationId,
        [Parameter(Mandatory)][string] $CatalogAppId,
        [Parameter(Mandatory)][string] $ExternalId,
        [Parameter(Mandatory)][string] $Version,
        [ValidateRange(1, 100)][int] $Attempts = 12,
        [ValidateRange(0, 300)][int] $DelaySeconds = 5,
        [scriptblock] $Sleep = { param($Seconds) Start-Sleep -Seconds $Seconds }
    )

    $lastError = $null
    for ($attempt = 1; $attempt -le $Attempts; $attempt++) {
        try {
            return Get-ExactTeamsInstallation $InvokeGraph $UserId $InstallationId $CatalogAppId $ExternalId $Version
        }
        catch {
            $lastError = $_
            if (-not (Test-TeamsGraphNotFoundError $_)) { throw }
            if ($attempt -lt $Attempts) { & $Sleep $DelaySeconds }
        }
    }
    throw [InvalidOperationException]::new('The exact Teams installation was not visible and valid after waiting for propagation.', $lastError.Exception)
}

function Remove-ExactTeamsInstallation {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][scriptblock] $InvokeGraph,
        [Parameter(Mandatory)][string] $UserId,
        [Parameter(Mandatory)][string] $InstallationId,
        [Parameter(Mandatory)][string] $CatalogAppId,
        [Parameter(Mandatory)][string] $ExternalId,
        [Parameter(Mandatory)][string] $Version
    )

    $uri = Get-TeamsInstallationUri $UserId $InstallationId
    $deleteUri = $uri.Substring(0, $uri.IndexOf('?'))
    try {
        [void](Get-ExactTeamsInstallation $InvokeGraph $UserId $InstallationId $CatalogAppId $ExternalId $Version)
    }
    catch {
        if (Test-TeamsGraphNotFoundError $_) { return }
        throw
    }
    [void](& $InvokeGraph DELETE $deleteUri $null $null)
    try {
        [void](& $InvokeGraph GET $uri $null $null)
    }
    catch {
        if (Test-TeamsGraphNotFoundError $_) {
            return
        }
        throw
    }
    throw 'The exact Teams installation is still present after deletion.'
}

Export-ModuleMember -Function ConvertTo-TeamsGraphSegment, Assert-TeamsInstallation, Assert-TeamsTenantContext, Get-TeamsCreatedInstallationId, Get-TeamsInstallCreateErrorKind, Test-TeamsGraphNotFoundError, Assert-TeamsRemovalReceipt, Get-TeamsInstallationUri, Wait-TeamsCatalogDefinition, Get-ExactTeamsInstallation, Wait-ExactTeamsInstallation, Remove-ExactTeamsInstallation
