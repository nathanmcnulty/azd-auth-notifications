BeforeAll {
    $script:adminUpn = 'admin@example.com'
    $script:tenantId = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
    $script:userId = '11111111-1111-1111-1111-111111111111'
    $script:clientId = '22222222-2222-2222-2222-222222222222'
    $script:principalId = '33333333-3333-3333-3333-333333333333'
    $script:catalogId = 'catalog/id'
    $script:installationId = 'opaque/install=id'
    $script:version = '1.2.3'
    $script:repositoryRoot = Split-Path $PSScriptRoot -Parent

    $manifest = @{
        id = $clientId; version = $version; validDomains = @('auth.example.test')
        bots = @(@{ botId = $clientId; scopes = @('personal'); isNotificationOnly = $true })
    } | ConvertTo-Json -Depth 10
    $script:packagePath = Join-Path $TestDrive 'auth-notifications.zip'
    $archive = [IO.Compression.ZipFile]::Open($packagePath, [IO.Compression.ZipArchiveMode]::Create)
    try {
        $entry = $archive.CreateEntry('manifest.json')
        $writer = [IO.StreamWriter]::new($entry.Open())
        try { $writer.Write($manifest) } finally { $writer.Dispose() }
    }
    finally { $archive.Dispose() }

    $script:originalModulePath = $env:PSModulePath
    $moduleRoot = Join-Path $TestDrive 'modules/Microsoft.Graph.Authentication'
    New-Item -ItemType Directory -Force -Path $moduleRoot | Out-Null
    @'
function Connect-MgGraph { param($TenantId, $Scopes, $ContextScope, [switch]$NoWelcome) }
function Get-MgContext { [pscustomobject]@{ TenantId = $global:FakeTenantId; Account = $global:FakeAdminUpn } }
function Invoke-MgGraphRequest {
    [CmdletBinding()]
    param($Method, $Uri, $Body, $ContentType, $OutputType, $InputFilePath, $ResponseHeadersVariable, $StatusCodeVariable)
    $response = & $global:FakeGraphHandler ([string]$Method) ([string]$Uri) $Body $InputFilePath
    if ($ResponseHeadersVariable) { Set-Variable -Name $ResponseHeadersVariable -Scope 1 -Value $response.Headers }
    if ($StatusCodeVariable) { Set-Variable -Name $StatusCodeVariable -Scope 1 -Value $response.StatusCode }
    if ($response -and $response.PSObject.Properties['Body']) { return $response.Body }
    $response
}
Export-ModuleMember -Function Connect-MgGraph, Get-MgContext, Invoke-MgGraphRequest
'@ | Set-Content -LiteralPath (Join-Path $moduleRoot 'Microsoft.Graph.Authentication.psm1')
    $env:PSModulePath = "$(Split-Path $moduleRoot -Parent)$([IO.Path]::PathSeparator)$originalModulePath"

    function global:azd {
        $commandArgs = @($args)
        $global:LASTEXITCODE = 0
        if ($commandArgs[0] -eq 'env' -and $commandArgs[1] -eq 'get-value') {
            $name = [string]$commandArgs[2]
            if ($global:FakeEnvironment.ContainsKey($name)) { return [string]$global:FakeEnvironment[$name] }
            $global:LASTEXITCODE = 1
            return "ERROR: key not found in environment values: $name"
        }
        if ($commandArgs[0] -eq 'env' -and $commandArgs[1] -eq 'set') {
            $global:FakeEnvironment[[string]$commandArgs[2]] = [string]$commandArgs[3]
            $global:FakeSetNames.Add([string]$commandArgs[2])
            return
        }
        if ($commandArgs[0] -eq 'env' -and $commandArgs[1] -eq 'unset') {
            $name = [string]$commandArgs[2]
            if ($global:FakeUnsetFailures.ContainsKey($name) -and $global:FakeUnsetFailures[$name] -gt 0) {
                $global:FakeUnsetFailures[$name]--
                $global:LASTEXITCODE = 1
                return
            }
            $global:FakeEnvironment.Remove($name)
            $global:FakeUnsetNames.Add($name)
            return
        }
        throw "Unexpected fake azd call: $($commandArgs -join ' ')"
    }
    function global:az {
        $commandArgs = @($args)
        $global:LASTEXITCODE = 0
        if (($commandArgs -join ' ') -match '^functionapp show ') {
            return (@{ tags = @{ 'azd-env-name' = 'test-env' } } | ConvertTo-Json -Compress)
        }
        if (($commandArgs -join ' ') -match '^functionapp identity show ') {
            return (@{ userAssignedIdentities = @{ '/subscriptions/test/identity' = @{ clientId = $global:FakeClientId; principalId = $global:FakePrincipalId } } } | ConvertTo-Json -Depth 5 -Compress)
        }
        throw "Unexpected fake az call: $($commandArgs -join ' ')"
    }
    function New-FakeEnvironment {
        @{
            AZURE_TENANT_ID = $tenantId; AZURE_WORKLOAD_CLIENT_ID = $clientId
            AZURE_FUNCTION_APP_URL = 'https://auth.example.test'; AZURE_SUBSCRIPTION_ID = 'subscription-id'
            AZURE_RESOURCE_GROUP = 'resource-group'; AZURE_FUNCTION_APP_NAME = 'function-name'
            AZURE_ENV_NAME = 'test-env'; AZURE_WORKLOAD_PRINCIPAL_ID = $principalId
            PILOT_USER_IDS = $userId; TEAMS_CATALOG_APP_ID = $catalogId; TEAMS_CATALOG_OWNERSHIP = 'created'
            TEAMS_INSTALLATION_ID = $installationId; TEAMS_INSTALLATION_USER_ID = $userId
            TEAMS_INSTALL_OWNERSHIP = 'created'; TEAMS_PACKAGE_VERSION = $version
        }
    }
    function New-FakeInstallation {
        [pscustomobject]@{
            id = $installationId
            teamsApp = [pscustomobject]@{ id = $catalogId; externalId = $clientId }
            teamsAppDefinition = [pscustomobject]@{ version = $version; publishingState = 'published' }
        }
    }
    function New-FakeGraphNotFoundError {
        $exception = [Exception]::new('Graph resource was not found.')
        $exception | Add-Member -NotePropertyName ResponseStatusCode -NotePropertyValue 404
        $record = [Management.Automation.ErrorRecord]::new($exception, 'Request_ResourceNotFound', [Management.Automation.ErrorCategory]::ObjectNotFound, $null)
        $record.ErrorDetails = [Management.Automation.ErrorDetails]::new('{"error":{"code":"Request_ResourceNotFound","message":"Resource not found."}}')
        $record
    }
    function New-FakeRemovalState([string]$Phase, [string]$Id = $installationId, [string]$User = $userId, [string]$Catalog = $catalogId) {
        $json = @{
            version = 1; phase = $Phase; installationId = $Id; installationUserId = $User; catalogAppId = $Catalog
            tenantId = $tenantId; workloadClientId = $clientId; workloadPrincipalId = $principalId; environmentName = 'test-env'
        } | ConvertTo-Json -Compress
        [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($json))
    }
}

AfterAll {
    $env:PSModulePath = $originalModulePath
    Remove-Module Microsoft.Graph.Authentication -Force -ErrorAction SilentlyContinue
    foreach ($name in @('azd', 'az')) { Remove-Item "Function:\$name" -Force -ErrorAction SilentlyContinue }
    Remove-Variable FakeTenantId, FakeAdminUpn, FakeClientId, FakePrincipalId, FakeEnvironment, FakeSetNames, FakeUnsetNames, FakeUnsetFailures, FakeGraphCalls, FakeGraphHandler -Scope Global -ErrorAction SilentlyContinue
}

Describe 'Teams lifecycle scripts with fake commands' {
    BeforeEach {
        Remove-Module Microsoft.Graph.Authentication -Force -ErrorAction SilentlyContinue
        $global:FakeTenantId = $tenantId
        $global:FakeAdminUpn = $adminUpn
        $global:FakeClientId = $clientId
        $global:FakePrincipalId = $principalId
        $global:FakeEnvironment = New-FakeEnvironment
        $global:FakeSetNames = [Collections.Generic.List[string]]::new()
        $global:FakeUnsetNames = [Collections.Generic.List[string]]::new()
        $global:FakeUnsetFailures = @{}
        $global:FakeGraphCalls = [Collections.Generic.List[string]]::new()
    }

    It 'refuses installation while exact removal cleanup is pending' {
        $global:FakeEnvironment.TEAMS_INSTALL_REMOVAL_STATE = New-FakeRemovalState -Phase 'absence-verified'
        $global:FakeGraphHandler = { throw 'Graph must not be called while removal cleanup is pending.' }

        { & (Join-Path $repositoryRoot 'scripts/Install-TeamsApp.ps1') -AdminUpn $adminUpn -UserId $userId -PackagePath $packagePath } |
            Should -Throw '*removal cleanup is still pending*'
        $global:FakeGraphCalls.Count | Should -Be 0
    }

    It 'resumes a response-attributed pending create through only the exact recorded installation ID' {
        $global:FakeEnvironment.TEAMS_INSTALL_OWNERSHIP = 'create-attributed-pending'
        $installation = New-FakeInstallation
        $global:FakeGraphHandler = {
            param($Method, $Uri, $Body, $File)
            $global:FakeGraphCalls.Add("$Method $Uri")
            if ($Method -eq 'GET' -and $Uri -match '/installedApps/opaque%2Finstall%3Did\?') { return $installation }
            throw "Unexpected fake Graph call: $Method $Uri"
        }.GetNewClosure()

        & (Join-Path $repositoryRoot 'scripts/Install-TeamsApp.ps1') -AdminUpn $adminUpn -UserId $userId -PackagePath $packagePath

        $global:FakeGraphCalls.Count | Should -Be 1
        $global:FakeGraphCalls[0] | Should -BeExactly "GET https://graph.microsoft.com/v1.0/users/$userId/teamwork/installedApps/opaque%2Finstall%3Did?`$expand=teamsApp,teamsAppDefinition"
        $global:FakeEnvironment.TEAMS_INSTALLATION_ID | Should -BeExactly $installationId
        $global:FakeEnvironment.TEAMS_INSTALL_OWNERSHIP | Should -BeExactly 'created'
    }

    It 'records an unattributed state for the documented 201 response with no body or identity header' {
        foreach ($name in @('TEAMS_INSTALLATION_ID', 'TEAMS_INSTALLATION_USER_ID', 'TEAMS_INSTALL_OWNERSHIP')) {
            $global:FakeEnvironment.Remove($name)
        }
        $global:FakeGraphHandler = {
            param($Method, $Uri, $Body, $File)
            $global:FakeGraphCalls.Add("$Method $Uri")
            if ($Method -eq 'GET' -and $Uri -match '/appCatalogs/teamsApps/catalog%2Fid\?') {
                return [pscustomobject]@{ id = 'catalog/id'; externalId = '22222222-2222-2222-2222-222222222222'; distributionMethod = 'organization' }
            }
            if ($Method -eq 'GET' -and $Uri -match '/appDefinitions$') {
                return [pscustomobject]@{ value = @([pscustomobject]@{ version = '1.2.3'; publishingState = 'published' }) }
            }
            if ($Method -eq 'GET' -and $Uri -match '/installedApps\?') { return [pscustomobject]@{ value = @() } }
            if ($Method -eq 'POST' -and $Uri -match '/installedApps$') {
                return [pscustomobject]@{ Body = $null; Headers = @{}; StatusCode = 201 }
            }
            throw "Unexpected fake Graph call: $Method $Uri"
        }

        { & (Join-Path $repositoryRoot 'scripts/Install-TeamsApp.ps1') -AdminUpn $adminUpn -UserId $userId -PackagePath $packagePath } |
            Should -Throw '*did not contain an installation ID*'
        $global:FakeEnvironment.TEAMS_INSTALL_OWNERSHIP | Should -BeExactly 'create-unattributed'
        $global:FakeEnvironment.ContainsKey('TEAMS_INSTALLATION_ID') | Should -BeFalse
        $global:FakeEnvironment.ContainsKey('TEAMS_INSTALLATION_USER_ID') | Should -BeFalse
    }

    It 'recovers a 409 only through explicit adoption and never makes it removable as created' {
        foreach ($name in @('TEAMS_INSTALLATION_ID', 'TEAMS_INSTALLATION_USER_ID', 'TEAMS_INSTALL_OWNERSHIP')) {
            $global:FakeEnvironment.Remove($name)
        }
        $global:FakeGraphHandler = {
            param($Method, $Uri, $Body, $File)
            if ($Method -eq 'GET' -and $Uri -match '/appCatalogs/teamsApps/catalog%2Fid\?') {
                return [pscustomobject]@{ id = 'catalog/id'; externalId = '22222222-2222-2222-2222-222222222222'; distributionMethod = 'organization' }
            }
            if ($Method -eq 'GET' -and $Uri -match '/appDefinitions$') {
                return [pscustomobject]@{ value = @([pscustomobject]@{ version = '1.2.3'; publishingState = 'published' }) }
            }
            if ($Method -eq 'GET' -and $Uri -match '/installedApps\?') { return [pscustomobject]@{ value = @() } }
            if ($Method -eq 'POST' -and $Uri -match '/installedApps$') { throw '409 Conflict' }
            throw "Unexpected fake Graph call: $Method $Uri"
        }
        { & (Join-Path $repositoryRoot 'scripts/Install-TeamsApp.ps1') -AdminUpn $adminUpn -UserId $userId -PackagePath $packagePath } |
            Should -Throw '*ownership is uncertain*'
        $global:FakeEnvironment.TEAMS_INSTALL_OWNERSHIP | Should -BeExactly 'create-unproven'

        $installation = New-FakeInstallation
        $global:FakeGraphHandler = {
            param($Method, $Uri, $Body, $File)
            if ($Method -eq 'GET' -and $Uri -match '/appCatalogs/teamsApps/catalog%2Fid\?') {
                return [pscustomobject]@{ id = 'catalog/id'; externalId = '22222222-2222-2222-2222-222222222222'; distributionMethod = 'organization' }
            }
            if ($Method -eq 'GET' -and $Uri -match '/appDefinitions$') {
                return [pscustomobject]@{ value = @([pscustomobject]@{ version = '1.2.3'; publishingState = 'published' }) }
            }
            if ($Method -eq 'GET' -and $Uri -match '/installedApps\?') { return [pscustomobject]@{ value = @($installation) } }
            if ($Method -eq 'GET' -and $Uri -match '/installedApps/opaque%2Finstall%3Did\?') { return $installation }
            throw "Unexpected fake Graph call: $Method $Uri"
        }.GetNewClosure()
        & (Join-Path $repositoryRoot 'scripts/Install-TeamsApp.ps1') -AdminUpn $adminUpn -UserId $userId -PackagePath $packagePath -AdoptExisting
        $global:FakeEnvironment.TEAMS_INSTALL_OWNERSHIP | Should -BeExactly 'adopted'
        { & (Join-Path $repositoryRoot 'scripts/Remove-TeamsApp.ps1') -AdminUpn $adminUpn -UserId $userId -Confirm:$false } |
            Should -Throw '*adopted or unproven*'
    }

    It 'runs removal through exact validation, delete, readback, then clears only installation receipts' {
        $installation = New-FakeInstallation
        $state = @{ InstallationReads = 0; NotFound = New-FakeGraphNotFoundError }
        $global:FakeGraphHandler = {
            param($Method, $Uri, $Body, $File)
            $global:FakeGraphCalls.Add("$Method $Uri")
            if ($Method -eq 'GET' -and $Uri -match '/appCatalogs/teamsApps/') {
                return [pscustomobject]@{ id = 'catalog/id'; externalId = '22222222-2222-2222-2222-222222222222'; distributionMethod = 'organization' }
            }
            if ($Uri -match '/installedApps/opaque%2Finstall%3Did') {
                if ($Method -eq 'DELETE') { return $null }
                $state.InstallationReads++
                if ($state.InstallationReads -eq 2) { throw $state.NotFound }
                return $installation
            }
            throw "Unexpected fake Graph call: $Method $Uri"
        }.GetNewClosure()

        & (Join-Path $repositoryRoot 'scripts/Remove-TeamsApp.ps1') -AdminUpn $adminUpn -UserId $userId -Confirm:$false

        $global:FakeEnvironment.ContainsKey('TEAMS_INSTALLATION_ID') | Should -BeFalse
        $global:FakeEnvironment.ContainsKey('TEAMS_INSTALL_REMOVAL_STATE') | Should -BeFalse
        $global:FakeEnvironment.ContainsKey('TEAMS_CATALOG_APP_ID') | Should -BeTrue
        $global:FakeGraphCalls | Should -Contain "DELETE https://graph.microsoft.com/v1.0/users/$userId/teamwork/installedApps/opaque%2Finstall%3Did"
    }

    It 'does not clear receipts when removal readback still finds the installation' {
        $installation = New-FakeInstallation
        $global:FakeGraphHandler = {
            param($Method, $Uri, $Body, $File)
            if ($Method -eq 'GET' -and $Uri -match '/appCatalogs/teamsApps/') {
                return [pscustomobject]@{ id = 'catalog/id'; externalId = '22222222-2222-2222-2222-222222222222'; distributionMethod = 'organization' }
            }
            if ($Method -eq 'GET' -and $Uri -match '/installedApps/') { return $installation }
            if ($Method -eq 'DELETE') { return $null }
        }.GetNewClosure()

        { & (Join-Path $repositoryRoot 'scripts/Remove-TeamsApp.ps1') -AdminUpn $adminUpn -UserId $userId -Confirm:$false } |
            Should -Throw '*still present after deletion*'
        $global:FakeUnsetNames.Count | Should -Be 0
        $global:FakeEnvironment.TEAMS_INSTALLATION_ID | Should -BeExactly $installationId
    }

    It 'refuses a pending removal checkpoint bound to a different installation ID' {
        $global:FakeEnvironment.TEAMS_INSTALL_REMOVAL_STATE = New-FakeRemovalState -Phase 'delete-pending' -Id 'different-installation'
        $global:FakeGraphHandler = { throw 'Graph must not be called for a mismatched removal checkpoint.' }

        { & (Join-Path $repositoryRoot 'scripts/Remove-TeamsApp.ps1') -AdminUpn $adminUpn -UserId $userId -Confirm:$false } |
            Should -Throw '*does not match the exact installation receipt*'
        $global:FakeGraphCalls.Count | Should -Be 0
    }

    It 'finishes only pending receipt cleanup after verified absence without another delete' {
        $installation = New-FakeInstallation
        $state = @{ InstallationReads = 0; NotFound = New-FakeGraphNotFoundError }
        $global:FakeUnsetFailures['TEAMS_INSTALLATION_USER_ID'] = 3
        $global:FakeGraphHandler = {
            param($Method, $Uri, $Body, $File)
            $global:FakeGraphCalls.Add("$Method $Uri")
            if ($Method -eq 'GET' -and $Uri -match '/appCatalogs/teamsApps/') {
                return [pscustomobject]@{ id = 'catalog/id'; externalId = '22222222-2222-2222-2222-222222222222'; distributionMethod = 'organization' }
            }
            if ($Uri -match '/installedApps/opaque%2Finstall%3Did') {
                if ($Method -eq 'DELETE') { return $null }
                $state.InstallationReads++
                if ($state.InstallationReads -eq 2) { throw $state.NotFound }
                return $installation
            }
        }.GetNewClosure()

        { & (Join-Path $repositoryRoot 'scripts/Remove-TeamsApp.ps1') -AdminUpn $adminUpn -UserId $userId -Confirm:$false } |
            Should -Throw '*receipt cleanup is incomplete*'
        $global:FakeEnvironment.ContainsKey('TEAMS_INSTALL_REMOVAL_STATE') | Should -BeTrue
        $removalState = [Text.Encoding]::UTF8.GetString(
            [Convert]::FromBase64String($global:FakeEnvironment.TEAMS_INSTALL_REMOVAL_STATE)
        ) | ConvertFrom-Json
        $removalState.phase | Should -BeExactly 'absence-verified'
        $removalState.installationId | Should -BeExactly 'opaque/install=id'
        $removalState.tenantId | Should -BeExactly $tenantId
        $removalState.workloadPrincipalId | Should -BeExactly $principalId
        @($global:FakeGraphCalls | Where-Object { $_ -like 'DELETE *' }).Count | Should -Be 1

        $global:FakeUnsetFailures.Clear()
        $global:FakeEnvironment.TEAMS_INSTALLATION_ID = 'replacement-installation'
        $global:FakeEnvironment.TEAMS_INSTALL_OWNERSHIP = 'created'
        { & (Join-Path $repositoryRoot 'scripts/Remove-TeamsApp.ps1') -AdminUpn $adminUpn -UserId $userId -Confirm:$false } |
            Should -Throw '*remaining Teams installation receipt does not match*'
        @($global:FakeGraphCalls | Where-Object { $_ -like 'DELETE *' }).Count | Should -Be 1

        $global:FakeEnvironment.Remove('TEAMS_INSTALLATION_ID')
        $global:FakeEnvironment.Remove('TEAMS_INSTALL_OWNERSHIP')
        & (Join-Path $repositoryRoot 'scripts/Remove-TeamsApp.ps1') -AdminUpn $adminUpn -UserId $userId -Confirm:$false
        @($global:FakeGraphCalls | Where-Object { $_ -like 'DELETE *' }).Count | Should -Be 1
        $global:FakeEnvironment.ContainsKey('TEAMS_INSTALLATION_USER_ID') | Should -BeFalse
        $global:FakeEnvironment.ContainsKey('TEAMS_INSTALL_REMOVAL_STATE') | Should -BeFalse
    }
}
