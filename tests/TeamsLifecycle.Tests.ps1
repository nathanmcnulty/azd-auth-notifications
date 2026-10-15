BeforeAll {
    Import-Module (Join-Path $PSScriptRoot '../scripts/TeamsLifecycle.psm1') -Force
    $script:userId = '11111111-1111-1111-1111-111111111111'
    $script:catalogId = 'catalog/id with spaces'
    $script:installationId = 'opaque/install id'
    $script:externalId = '22222222-2222-2222-2222-222222222222'
    $script:version = '1.2.3'
    function New-Installation([string]$Id = $script:installationId, [string]$Catalog = $script:catalogId, [string]$External = $script:externalId) {
        [pscustomobject]@{
            id = $Id
            teamsApp = [pscustomobject]@{ id = $Catalog; externalId = $External }
            teamsAppDefinition = [pscustomobject]@{ version = $script:version; publishingState = 'published' }
        }
    }
    function New-GraphNotFoundError {
        $exception = [Exception]::new('Graph resource was not found.')
        $exception | Add-Member -NotePropertyName StatusCode -NotePropertyValue 404
        $record = [Management.Automation.ErrorRecord]::new($exception, 'Request_ResourceNotFound', [Management.Automation.ErrorCategory]::ObjectNotFound, $null)
        $record.ErrorDetails = [Management.Automation.ErrorDetails]::new('{"error":{"code":"Request_ResourceNotFound"}}')
        $record
    }
}

Describe 'exact Teams installation receipts' {
    It 'fails before Pester invocation when a required test file is missing' {
        { & (Join-Path $PSScriptRoot '../scripts/Test-TeamsLifecycle.ps1') -Path (Join-Path $TestDrive 'missing.Tests.ps1') } |
            Should -Throw '*does not exist*'
    }

    It 'reuses the exact catalog ID through definition propagation retries' {
        $state = @{ Calls = [Collections.Generic.List[string]]::new(); Attempt = 0; Version = $version }
        $getDefinitions = {
            param($CatalogAppId)
            $state.Calls.Add($CatalogAppId)
            $state.Attempt++
            if ($state.Attempt -lt 3) { return @() }
            [pscustomobject]@{ version = $state.Version; publishingState = 'published' }
        }.GetNewClosure()

        $definition = Wait-TeamsCatalogDefinition $getDefinitions $catalogId $version -Attempts 3 -DelaySeconds 0

        $definition.version | Should -BeExactly $version
        $state.Calls.Count | Should -Be 3
        ($state.Calls | Select-Object -Unique) | Should -BeExactly $catalogId
    }

    It 'reuses the same escaped recorded ID through propagation retries' {
        $calls = [Collections.Generic.List[string]]::new()
        $state = @{ Attempt = 0; Installation = New-Installation; NotFound = New-GraphNotFoundError }
        $graph = {
            param($Method, $Uri, $Body, $File)
            $calls.Add("$Method $Uri")
            $state.Attempt++
            if ($state.Attempt -lt 3) { throw $state.NotFound }
            $state.Installation
        }.GetNewClosure()

        $result = Wait-ExactTeamsInstallation $graph $userId $installationId $catalogId $externalId $version -Attempts 3 -DelaySeconds 0

        $result.id | Should -BeExactly $installationId
        $calls.Count | Should -Be 3
        @($calls | Select-Object -Unique).Count | Should -Be 1
        $calls[0] | Should -BeExactly "GET https://graph.microsoft.com/v1.0/users/$userId/teamwork/installedApps/opaque%2Finstall%20id?`$expand=teamsApp,teamsAppDefinition"
    }

    It 'rejects a foreign catalog installation returned for the exact ID' {
        $foreignInstallation = New-Installation -Catalog 'foreign-catalog'
        $graph = { param($Method, $Uri, $Body, $File) $foreignInstallation }.GetNewClosure()
        { Get-ExactTeamsInstallation $graph $userId $installationId $catalogId $externalId $version } |
            Should -Throw '*does not match the recorded catalog app*'
    }

    It 'rejects a foreign workload installation returned for the exact ID' {
        $foreignInstallation = New-Installation -External 'foreign-client'
        $graph = { param($Method, $Uri, $Body, $File) $foreignInstallation }.GetNewClosure()
        { Get-ExactTeamsInstallation $graph $userId $installationId $catalogId $externalId $version } |
            Should -Throw '*does not match the recorded catalog app*'
    }

    It 'requires an attributed creation response and refuses a 409 adoption shortcut' {
        $documentedResponse = [pscustomobject]@{ Body = $null; Headers = @{}; StatusCode = 201 }
        { Get-TeamsCreatedInstallationId $documentedResponse $userId } | Should -Throw '*ownership remains uncertain*'
        $locationResponse = [pscustomobject]@{
            Body = $null
            Headers = @{ Location = "https://graph.microsoft.com/v1.0/users/$userId/teamwork/installedApps/opaque%2Finstall%20id" }
            StatusCode = 201
        }
        (Get-TeamsCreatedInstallationId $locationResponse $userId) | Should -BeExactly $installationId
        (Get-TeamsInstallCreateErrorKind 'Graph returned 409 Conflict') | Should -BeExactly 'conflict'
        (Get-TeamsInstallCreateErrorKind 'App is blocked by app permission policy') | Should -BeExactly 'policy'
    }

    It 'fails closed on a tenant mismatch' {
        { Assert-TeamsTenantContext 'tenant-a' 'tenant-b' } | Should -Throw '*tenant mismatch*'
    }
}

Describe 'ownership-bound removal' {
    BeforeEach {
        $receipt = @{
            CatalogId = $catalogId; CatalogOwnership = 'created'; InstallationId = $installationId
            InstallationUserId = $userId; InstallationOwnership = 'created'; PackageVersion = $version
        }
    }

    It 'refuses missing, adopted, and foreign-user receipts' {
        $missing = $receipt.Clone(); $missing.Remove('InstallationId')
        { Assert-TeamsRemovalReceipt $missing $userId } | Should -Throw '*missing InstallationId*'
        $adopted = $receipt.Clone(); $adopted.InstallationOwnership = 'adopted'
        { Assert-TeamsRemovalReceipt $adopted $userId } | Should -Throw '*adopted or unproven*'
        $foreign = $receipt.Clone(); $foreign.InstallationUserId = '33333333-3333-3333-3333-333333333333'
        { Assert-TeamsRemovalReceipt $foreign $userId } | Should -Throw '*does not match this user*'
    }

    It 'deletes only the exact verified installation and requires absent readback' {
        $calls = [Collections.Generic.List[string]]::new()
        $state = @{ ReadCount = 0; Installation = New-Installation; NotFound = New-GraphNotFoundError }
        $graph = {
            param($Method, $Uri, $Body, $File)
            $calls.Add("$Method $Uri")
            if ($Method -eq 'GET') {
                $state.ReadCount++
                if ($state.ReadCount -eq 2) { throw $state.NotFound }
                return $state.Installation
            }
        }.GetNewClosure()

        { Remove-ExactTeamsInstallation $graph $userId $installationId $catalogId $externalId $version } | Should -Not -Throw
        $calls.Count | Should -Be 3
        $calls[1] | Should -BeExactly "DELETE https://graph.microsoft.com/v1.0/users/$userId/teamwork/installedApps/opaque%2Finstall%20id"
        $calls[2] | Should -BeExactly $calls[0]
    }

    It 'fails when deletion readback still returns the installation' {
        $installation = New-Installation
        $graph = { param($Method, $Uri, $Body, $File) if ($Method -eq 'GET') { $installation } }.GetNewClosure()
        { Remove-ExactTeamsInstallation $graph $userId $installationId $catalogId $externalId $version } |
            Should -Throw '*still present after deletion*'
    }

    It 'rejects DNS, timeout, and unstructured 404 text as absence proof' -ForEach @(
        'DNS host not found',
        'The operation timed out',
        '404 Request_ResourceNotFound'
    ) {
        $installation = New-Installation
        $state = @{ Reads = 0; Message = $_ }
        $graph = {
            param($Method, $Uri, $Body, $File)
            if ($Method -eq 'GET') {
                $state.Reads++
                if ($state.Reads -eq 2) { throw $state.Message }
                return $installation
            }
        }.GetNewClosure()
        { Remove-ExactTeamsInstallation $graph $userId $installationId $catalogId $externalId $version } | Should -Throw
    }
}
