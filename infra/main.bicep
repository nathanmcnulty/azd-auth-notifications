targetScope = 'subscription'

@minLength(1)
param environmentName string
param location string
param tenantId string = tenant().tenantId
param userChannels string = ''
param adminChannels string = ''
param adminUserIds string = ''
param pilotUserIds string = ''
param allUsers bool = false
param collectionEnabled bool = false
param emailSenderUserId string = ''
param helpdeskText string = ''
@minValue(1)
@maxValue(1440)
param auditOverlapMinutes int = 60
var teamsBotEnabled = contains(split('${userChannels},${adminChannels}', ','), 'teams')

var resourceToken = toLower(uniqueString(subscription().id, environmentName))
var resourceGroupName = 'rg-${environmentName}'
var tags = {
  'azd-env-name': environmentName
  workload: 'auth-notifications'
}

resource resourceGroup 'Microsoft.Resources/resourceGroups@2024-03-01' = {
  name: resourceGroupName
  location: location
  tags: tags
}

module resources 'resources.bicep' = {
  name: 'auth-notifications'
  scope: resourceGroup
  params: {
    location: location
    namePrefix: take(replace(environmentName, '-', ''), 12)
    resourceToken: resourceToken
    environmentName: environmentName
    tenantId: tenantId
    subscriptionId: subscription().subscriptionId
    resourceGroupName: resourceGroup.name
    userChannels: userChannels
    adminChannels: adminChannels
    adminUserIds: adminUserIds
    pilotUserIds: pilotUserIds
    allUsers: allUsers
    collectionEnabled: collectionEnabled
    emailSenderUserId: emailSenderUserId
    helpdeskText: helpdeskText
    auditOverlapMinutes: auditOverlapMinutes
    teamsBotEnabled: teamsBotEnabled
    tags: tags
  }
}

output AZURE_RESOURCE_GROUP string = resourceGroup.name
output AZURE_FUNCTION_APP_NAME string = resources.outputs.functionAppName
output AZURE_FUNCTION_APP_URL string = resources.outputs.functionAppUrl
output AZURE_STORAGE_ACCOUNT_NAME string = resources.outputs.storageAccountName
output AZURE_WORKLOAD_CLIENT_ID string = resources.outputs.workloadClientId
output AZURE_WORKLOAD_PRINCIPAL_ID string = resources.outputs.workloadPrincipalId
output MANAGED_IDENTITY_CLIENT_ID string = resources.outputs.workloadClientId
output STORAGE_ACCOUNT_NAME string = resources.outputs.storageAccountName
output TEAMS_BOT_APP_ID string = resources.outputs.workloadClientId
output TEAMS_APP_PACKAGE_VALUES string = '${resources.outputs.workloadClientId}|${tenantId}|${resources.outputs.functionAppUrl}'
