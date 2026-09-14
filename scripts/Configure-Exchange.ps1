[CmdletBinding(SupportsShouldProcess)]
param(
    [switch] $DisableWAM,
    [ValidatePattern('^[^@\s]+@[^@\s]+$')][string] $AdminUpn,
    [string] $OtherMailbox
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

function Get-EnvironmentValue([string] $Name) {
    $value = (& azd env get-value $Name 2>$null | Out-String).Trim()
    if ($LASTEXITCODE -ne 0 -or -not $value) { throw "$Name is required from the initialized azd environment." }
    return $value
}
function Assert-ExactFunctionIdentity([string] $SubscriptionId, [string] $ResourceGroup, [string] $FunctionName, [string] $PrincipalId, [string] $ClientId) {
    $functionIdentity = & az functionapp identity show --subscription $SubscriptionId --resource-group $ResourceGroup --name $FunctionName --output json | ConvertFrom-Json
    if ($LASTEXITCODE -ne 0 -or $functionIdentity.type -notmatch 'UserAssigned') { throw 'The expected Function App user-assigned identity was not found.' }
    $matches = @($functionIdentity.userAssignedIdentities.PSObject.Properties.Value | Where-Object { $_.principalId -eq $PrincipalId -and $_.clientId -eq $ClientId })
    if ($matches.Count -ne 1) { throw 'The Function App identity does not match the azd environment workload identity.' }
}

foreach ($command in @('az', 'azd')) { if (-not (Get-Command $command -ErrorAction SilentlyContinue)) { throw "Required command '$command' was not found." } }
if (-not (Get-Module ExchangeOnlineManagement -ListAvailable)) { throw 'ExchangeOnlineManagement is required. Install it, then retry.' }

$tenantId = Get-EnvironmentValue 'AZURE_TENANT_ID'
$subscriptionId = Get-EnvironmentValue 'AZURE_SUBSCRIPTION_ID'
$resourceGroup = Get-EnvironmentValue 'AZURE_RESOURCE_GROUP'
$functionName = Get-EnvironmentValue 'AZURE_FUNCTION_APP_NAME'
$principalId = Get-EnvironmentValue 'AZURE_WORKLOAD_PRINCIPAL_ID'
$clientId = Get-EnvironmentValue 'AZURE_WORKLOAD_CLIENT_ID'
$senderId = Get-EnvironmentValue 'EMAIL_SENDER_USER_ID'
$senderGuid = [guid]::Empty
if (-not [guid]::TryParse($senderId, [ref]$senderGuid)) { throw 'EMAIL_SENDER_USER_ID must be an Entra user object ID UUID.' }
$accountTenant = (& az account show --subscription $subscriptionId --query tenantId -o tsv | Out-String).Trim()
if ($LASTEXITCODE -ne 0 -or $accountTenant -ne $tenantId) { throw 'Azure CLI tenant does not match AZURE_TENANT_ID.' }
Assert-ExactFunctionIdentity -SubscriptionId $subscriptionId -ResourceGroup $resourceGroup -FunctionName $functionName -PrincipalId $principalId -ClientId $clientId

Import-Module ExchangeOnlineManagement
$connectParameters = @{ Organization = $tenantId; ShowBanner = $false }
if ($DisableWAM) { $connectParameters.DisableWAM = $true }
if ($AdminUpn) { $connectParameters.UserPrincipalName = $AdminUpn }
Connect-ExchangeOnline @connectParameters
try {
    $connections = @(Get-ConnectionInformation)
    $expectedConnections = @($connections | Where-Object { [string]$_.TenantID -ceq $tenantId })
    if ($expectedConnections.Count -ne 1) { throw 'Exchange Online is not connected to the exact AZURE_TENANT_ID. Disconnect and sign in through the expected administrator account.' }
    $sender = Get-Mailbox -Identity $senderId -ErrorAction Stop
    if ([string]$sender.ExternalDirectoryObjectId -ne $senderId) { throw 'EMAIL_SENDER_USER_ID did not resolve to the exact sender mailbox.' }
    $senderAddress = [string]$sender.PrimarySmtpAddress
    if (-not $senderAddress) { throw 'The sender mailbox does not have a primary SMTP address.' }

    $scopeName = "authnotify-$clientId"
    $assignmentName = "$scopeName-mailsend"
    $expectedFilter = "ExternalDirectoryObjectId -eq '$senderId'"
    $servicePrincipals = @(Get-ServicePrincipal -Identity $clientId -ErrorAction SilentlyContinue)
    if ($servicePrincipals.Count -gt 1) { throw 'More than one Exchange service-principal pointer matched the exact workload client ID.' }
    $servicePrincipal = if ($servicePrincipals.Count -eq 1) { $servicePrincipals[0] } else { $null }
    if ($servicePrincipal -and ([string]$servicePrincipal.AppId -ne $clientId -or [string]$servicePrincipal.ObjectId -ne $principalId)) {
        throw 'The existing Exchange service-principal pointer does not match the exact workload client and principal IDs.'
    }

    $scope = Get-ManagementScope -Identity $scopeName -ErrorAction SilentlyContinue
    if ($scope -and [string]$scope.RecipientFilter -cne $expectedFilter) { throw "The existing management scope '$scopeName' has a different recipient filter." }
    $assignment = Get-ManagementRoleAssignment -Identity $assignmentName -ErrorAction SilentlyContinue
    if ($assignment -and -not $servicePrincipal) { throw 'An existing role assignment cannot be adopted without the exact Exchange service principal.' }
    if ($assignment) {
        if ([string]$assignment.Role -ne 'Application Mail.Send' -or [string]$assignment.CustomResourceScope -ne $scopeName) {
            throw "The existing role assignment '$assignmentName' is not the expected scoped Application Mail.Send assignment."
        }
        if ($servicePrincipal -and [string]$assignment.RoleAssignee -notin @([string]$servicePrincipal.ObjectId, [string]$servicePrincipal.Identity)) {
            throw "The existing role assignment '$assignmentName' is not bound to the expected Exchange service principal."
        }
    }

    if ($WhatIfPreference) {
        if (-not $servicePrincipal) { [void]$PSCmdlet.ShouldProcess($clientId, 'Create Exchange service-principal pointer bound to the managed identity') }
        if (-not $scope) { [void]$PSCmdlet.ShouldProcess($senderAddress, "Create mailbox scope $scopeName") }
        if (-not $assignment) { [void]$PSCmdlet.ShouldProcess($senderAddress, "Create scoped Application Mail.Send assignment $assignmentName") }
        return
    }

    if (-not $servicePrincipal -and $PSCmdlet.ShouldProcess($clientId, 'Create Exchange service-principal pointer bound to the managed identity')) {
        New-ServicePrincipal -AppId $clientId -ObjectId $principalId -DisplayName 'Authentication notifications' | Out-Null
        $servicePrincipals = @(Get-ServicePrincipal -Identity $clientId)
        if ($servicePrincipals.Count -ne 1) { throw 'The created Exchange service-principal pointer could not be resolved exactly once.' }
        $servicePrincipal = $servicePrincipals[0]
        if ([string]$servicePrincipal.AppId -ne $clientId -or [string]$servicePrincipal.ObjectId -ne $principalId) { throw 'The created Exchange service-principal pointer did not bind to the expected identity.' }
    }
    if (-not $servicePrincipal) { throw 'The exact Exchange service-principal pointer is unavailable.' }
    if (-not $scope -and $PSCmdlet.ShouldProcess($senderAddress, "Create mailbox scope $scopeName")) {
        New-ManagementScope -Name $scopeName -RecipientRestrictionFilter $expectedFilter | Out-Null
        $scope = Get-ManagementScope -Identity $scopeName
        if (-not $scope -or [string]$scope.RecipientFilter -cne $expectedFilter) { throw 'The created management scope did not match the exact sender mailbox.' }
    }
    if (-not $scope) { throw "The exact management scope '$scopeName' is unavailable." }
    if (-not $assignment -and $PSCmdlet.ShouldProcess($senderAddress, "Create scoped Application Mail.Send assignment $assignmentName")) {
        New-ManagementRoleAssignment -Name $assignmentName -Role 'Application Mail.Send' -App $servicePrincipal.ObjectId -CustomResourceScope $scopeName | Out-Null
        $assignment = Get-ManagementRoleAssignment -Identity $assignmentName
        if (-not $assignment -or [string]$assignment.Role -ne 'Application Mail.Send' -or [string]$assignment.CustomResourceScope -ne $scopeName) { throw 'The created role assignment did not match the expected scope.' }
    }
    if (-not $assignment) { throw "The exact role assignment '$assignmentName' is unavailable." }

    $senderAuthorization = @(Test-ServicePrincipalAuthorization -Identity $servicePrincipal.Identity -Resource $senderAddress)
    if (-not ($senderAuthorization | Where-Object { $_.RoleName -eq 'Application Mail.Send' -and $_.InScope -eq $true })) { throw 'Exchange did not report Application Mail.Send in scope for the exact sender mailbox.' }
    if ($OtherMailbox) {
        $other = Get-Mailbox -Identity $OtherMailbox -ErrorAction Stop
        if ([string]$other.ExternalDirectoryObjectId -eq $senderId) { throw 'OtherMailbox must be different from the configured sender mailbox.' }
        $otherAuthorization = @(Test-ServicePrincipalAuthorization -Identity $servicePrincipal.Identity -Resource ([string]$other.PrimarySmtpAddress))
        if ($otherAuthorization | Where-Object { $_.RoleName -eq 'Application Mail.Send' -and $_.InScope -eq $true }) {
            throw 'The workload unexpectedly has Application Mail.Send in scope for OtherMailbox.'
        }
        $otherAuthorization | Format-Table
    }
    Write-Host "Exchange Application RBAC is verified for sender $senderAddress."
} finally {
    Disconnect-ExchangeOnline -Confirm:$false -ErrorAction SilentlyContinue
}
