Set-StrictMode -Version Latest

function Get-AuthEnvironmentValue {
    param([Parameter(Mandatory)][string] $Name)

    $value = [Environment]::GetEnvironmentVariable($Name)
    if ($value) { return $value }
    $value = (& azd env get-value $Name 2>$null | Out-String).Trim()
    if ($LASTEXITCODE -ne 0 -or -not $value) {
        throw "$Name is required from the selected azd environment."
    }
    return $value
}

function Get-AuthContext {
    $names = @(
        'AZURE_TENANT_ID', 'AZURE_SUBSCRIPTION_ID', 'AZURE_RESOURCE_GROUP',
        'AZURE_FUNCTION_APP_NAME', 'AZURE_FUNCTION_APP_URL',
        'AZURE_WORKLOAD_CLIENT_ID', 'AZURE_WORKLOAD_PRINCIPAL_ID',
        'AZURE_ENV_NAME'
    )
    $values = [ordered]@{}
    foreach ($name in $names) { $values[$name] = Get-AuthEnvironmentValue $name }
    $account = & az account show --subscription $values.AZURE_SUBSCRIPTION_ID --only-show-errors -o json | ConvertFrom-Json
    if ($LASTEXITCODE -ne 0 -or $account.tenantId -cne $values.AZURE_TENANT_ID -or $account.id -cne $values.AZURE_SUBSCRIPTION_ID) {
        throw 'The active Azure CLI tenant and subscription do not match the selected azd environment.'
    }
    [pscustomobject] $values
}

function Get-AuthTeamsEnabled {
    $channels = @(
        (Get-AuthEnvironmentValue 'USER_CHANNELS')
        (Get-AuthEnvironmentValue 'ADMIN_CHANNELS')
    ) -join ','
    return @($channels -split ',' | Where-Object { $_.Trim().ToLowerInvariant() -eq 'teams' }).Count -gt 0
}

function New-AuthFailure {
    param([string] $Code, [string] $Summary, [string] $Remediation)
    New-AzdCheckFailure -Code $Code -Summary $Summary -Expected 'The deployed authentication-notifications environment is valid.' -Remediation $Remediation
}

function Get-ProjectValidationDefinition {
    [CmdletBinding()]
    param([hashtable] $DeliveryParameters = @{})

    $repositoryRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
    $deliveryScript = Join-Path $PSScriptRoot 'Test-NotificationDelivery.ps1'

    New-AzdValidationCheckDefinition `
        -Id 'context.template-root' `
        -Phase context `
        -Title 'Template root is complete' `
        -Summary 'azure.yaml and the vendored component lock are present.' `
        -SideEffect none `
        -Action ({
            foreach ($path in @('azure.yaml', 'azd-components.lock.json')) {
                if (-not (Test-Path -LiteralPath (Join-Path $repositoryRoot $path) -PathType Leaf)) {
                    throw "$path was not found."
                }
            }
        }.GetNewClosure())

    New-AzdValidationCheckDefinition `
        -Id 'context.azure-session' `
        -Phase context `
        -Title 'Azure and azd context is exact' `
        -Summary 'The cached Azure CLI session matches the tenant and subscription selected by azd.' `
        -SideEffect readOnly `
        -Remediation 'Use the normal Azure broker or browser login, select the expected subscription, and rerun validation.' `
        -Action {
            try {
                $context = Get-AuthContext
                New-AzdCheckOutcome -Summary 'The Azure CLI session matches the selected tenant and subscription.' `
                    -Expected 'One exact tenant and subscription.' `
                    -Actual ([ordered] @{ tenantId = $context.AZURE_TENANT_ID; subscriptionId = $context.AZURE_SUBSCRIPTION_ID })
            }
            catch {
                New-AuthFailure -Code 'context.azureSessionInvalid' `
                    -Summary 'The Azure CLI session could not be matched to the selected azd environment.' `
                    -Remediation 'Use the normal Azure broker or browser login, select the expected subscription, and rerun validation.'
            }
        }

    New-AzdValidationCheckDefinition `
        -Id 'runtime.function-app' `
        -Phase runtime `
        -Title 'Function App is running' `
        -Summary 'The deployed authentication-notifications Function App is running.' `
        -SideEffect readOnly `
        -DependsOn 'context.azure-session' `
        -Remediation 'Inspect the Function App deployment and runtime logs, then rerun validation.' `
        -Action {
            try {
                $context = Get-AuthContext
                $function = & az functionapp show --subscription $context.AZURE_SUBSCRIPTION_ID `
                    --resource-group $context.AZURE_RESOURCE_GROUP --name $context.AZURE_FUNCTION_APP_NAME `
                    --only-show-errors -o json | ConvertFrom-Json
                if ($LASTEXITCODE -ne 0 -or $function.tags.'azd-env-name' -cne $context.AZURE_ENV_NAME -or $function.tags.workload -ne 'auth-notifications') {
                    throw 'Function App tags do not match the selected environment.'
                }
                if ($function.properties.state -ne 'Running') {
                    return (New-AuthFailure -Code 'runtime.functionNotRunning' `
                        -Summary 'The Function App is not running.' `
                        -Remediation 'Inspect the Function App deployment and runtime logs, then rerun validation.')
                }
                New-AzdCheckOutcome -Summary 'The authentication-notifications Function App is running.' `
                    -Expected 'Running' -Actual ([string] $function.properties.state)
            }
            catch {
                New-AuthFailure -Code 'runtime.functionReadFailed' `
                    -Summary 'The Function App could not be validated.' `
                    -Remediation 'Confirm Azure resource read access and the Function App deployment, then rerun validation.'
            }
        }

    New-AzdValidationCheckDefinition `
        -Id 'configuration.bot-identity' `
        -Phase configuration `
        -Title 'Azure Bot identity and endpoint are exact' `
        -Summary 'When Teams is selected, Bot Service uses the Function workload identity and message endpoint.' `
        -SideEffect readOnly `
        -DependsOn 'context.azure-session' `
        -Remediation 'Rerun provisioning or correct the Azure Bot identity, endpoint, or Teams channel.' `
        -Action {
            try {
                $context = Get-AuthContext
                if (-not (Get-AuthTeamsEnabled)) {
                    return (New-AzdCheckOutcome -Status skipped -Summary 'Azure Bot validation is not applicable because Teams is not configured.')
                }
                $bots = @(az resource list --subscription $context.AZURE_SUBSCRIPTION_ID --resource-group $context.AZURE_RESOURCE_GROUP `
                    --resource-type Microsoft.BotService/botServices --only-show-errors -o json | ConvertFrom-Json)
                if ($LASTEXITCODE -ne 0 -or $bots.Count -ne 1) { throw 'Expected exactly one Azure Bot resource.' }
                $bot = az resource show --ids $bots[0].id --api-version 2022-09-15 --only-show-errors -o json | ConvertFrom-Json
                if ($LASTEXITCODE -ne 0 -or -not $bot) { throw 'The Azure Bot resource could not be read.' }
                $expectedEndpoint = "$($context.AZURE_FUNCTION_APP_URL)/api/messages"
                if ([string]$bot.properties.msaAppId -cne $context.AZURE_WORKLOAD_CLIENT_ID -or
                    [string]$bot.properties.msaAppTenantId -cne $context.AZURE_TENANT_ID -or
                    [string]$bot.properties.msaAppType -cne 'UserAssignedMSI' -or
                    [string]$bot.properties.endpoint -cne $expectedEndpoint) {
                    throw 'Azure Bot identity, tenant, type, or endpoint does not match the Function deployment.'
                }
                $channelId = [string] $bot.id + '/channels/MsTeamsChannel'
                $channel = az resource show --ids $channelId --api-version 2022-09-15 --only-show-errors -o json | ConvertFrom-Json
                if ($LASTEXITCODE -ne 0 -or $channel.properties.channelName -ne 'MsTeamsChannel' -or $channel.properties.properties.isEnabled -ne $true) {
                    throw 'The Microsoft Teams Bot channel is missing or disabled.'
                }
                New-AzdCheckOutcome -Summary 'Azure Bot identity, tenant, endpoint, and Microsoft Teams channel are exact.' `
                    -Expected ([ordered] @{ endpoint = $expectedEndpoint; teamsChannelEnabled = $true }) `
                    -Actual ([ordered] @{ endpoint = [string] $bot.properties.endpoint; teamsChannelEnabled = $true })
            }
            catch {
                New-AuthFailure -Code 'configuration.botIdentityInvalid' `
                    -Summary 'Azure Bot configuration could not be validated.' `
                    -Remediation 'Rerun provisioning or correct the Azure Bot identity, endpoint, or Teams channel.'
            }
        }

    New-AzdValidationCheckDefinition `
        -Id 'security.basic-publishing-disabled' `
        -Phase security `
        -Title 'Basic publishing credentials are disabled' `
        -Summary 'FTP and SCM basic publishing credentials are disabled for the Function App.' `
        -SideEffect readOnly `
        -DependsOn 'context.azure-session' `
        -Remediation 'Disable FTP and SCM basic publishing credentials and rerun validation.' `
        -Action {
            try {
                $context = Get-AuthContext
                foreach ($name in @('ftp', 'scm')) {
                    $id = "/subscriptions/$($context.AZURE_SUBSCRIPTION_ID)/resourceGroups/$($context.AZURE_RESOURCE_GROUP)/providers/Microsoft.Web/sites/$($context.AZURE_FUNCTION_APP_NAME)/basicPublishingCredentialsPolicies/$name"
                    $allow = az resource show --ids $id --api-version 2024-04-01 --query properties.allow --only-show-errors -o tsv
                    if ($LASTEXITCODE -ne 0 -or $allow -ne 'false') { throw "$name basic publishing credentials are enabled." }
                }
                New-AzdCheckOutcome -Summary 'FTP and SCM basic publishing credentials are disabled.' -Expected $false -Actual $false
            }
            catch {
                New-AuthFailure -Code 'security.basicPublishingEnabled' `
                    -Summary 'Function App basic publishing credentials are not disabled.' `
                    -Remediation 'Disable FTP and SCM basic publishing credentials and rerun validation.'
            }
        }

    New-AzdValidationCheckDefinition `
        -Id 'runtime.collection-readiness' `
        -Phase runtime `
        -Title 'Collection readiness is explicit' `
        -Summary 'Collection remains paused until configured delivery routes have explicit proof.' `
        -SideEffect readOnly `
        -DependsOn 'context.azure-session' `
        -Remediation 'Keep COLLECTION_ENABLED=false until every selected route passes delivery testing.' `
        -Action {
            try {
                $context = Get-AuthContext
                $setting = az functionapp config appsettings list --subscription $context.AZURE_SUBSCRIPTION_ID `
                    --resource-group $context.AZURE_RESOURCE_GROUP --name $context.AZURE_FUNCTION_APP_NAME `
                    --query "[?name=='COLLECTION_ENABLED'].value | [0]" --only-show-errors -o tsv
                if ($LASTEXITCODE -ne 0 -or $setting -notin @('true', 'false')) { throw 'COLLECTION_ENABLED is missing or invalid.' }
                if ($setting -eq 'false') {
                    return (New-AzdCheckOutcome -Status warning `
                        -Summary 'Infrastructure is ready, but collection remains paused pending delivery proof.' `
                        -Expected 'false until delivery testing is complete.' -Actual $setting `
                        -Remediation 'Install the Teams app, validate selected email and Teams routes, then enable collection deliberately.')
                }
                New-AzdCheckOutcome -Summary 'Collection is enabled; real-event validation remains an operational follow-up.' `
                    -Expected 'true after explicit enablement.' -Actual $setting
            }
            catch {
                New-AuthFailure -Code 'runtime.collectionSettingInvalid' `
                    -Summary 'The collection readiness setting is missing or invalid.' `
                    -Remediation 'Rerun provisioning and confirm COLLECTION_ENABLED is present.'
            }
        }

    New-AzdValidationCheckDefinition `
        -Id 'delivery.synthetic-notification' `
        -Phase delivery `
        -Title 'Configured notification routes deliver a synthetic event' `
        -Summary 'The explicit delivery test proves the selected email and Teams provider boundaries.' `
        -SideEffect syntheticDelivery `
        -DependsOn 'context.azure-session' `
        -Remediation 'Keep collection paused, correct the failed route, and rerun with -TestDelivery.' `
        -Action ({
            if (-not $DeliveryParameters.ContainsKey('UserId')) {
                return (New-AzdCheckOutcome -Status skipped -Summary 'Synthetic delivery was not requested; rerun Test-Deployment.ps1 with -TestDelivery and -UserId.')
            }
            try {
                & $deliveryScript @DeliveryParameters
                New-AzdCheckOutcome -Summary 'The selected notification routes were accepted by their providers.' `
                    -Expected 'All selected routes accepted.' -Actual 'Accepted'
            }
            catch {
                New-AzdCheckFailure -Code 'delivery.syntheticFailed' `
                    -Summary 'Synthetic notification delivery failed.' `
                    -Expected 'All selected routes accepted.' `
                    -Remediation 'Keep collection paused, inspect the route evidence, and rerun with -TestDelivery.'
            }
        }.GetNewClosure())
}

Export-ModuleMember -Function 'Get-ProjectValidationDefinition'
