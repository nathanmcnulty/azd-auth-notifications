# Deployment

## Configure

Install Node.js 22+, PowerShell 7, Azure CLI, and azd. Use normal cached/broker/browser login when needed. Clone this repository, then run npm ci.

    azd env new auth-notifications
    azd env set AZURE_TENANT_ID <tenant-guid>
    azd env set AZURE_SUBSCRIPTION_ID <subscription-guid>
    azd env set AZURE_LOCATION <region>
    azd env set USER_CHANNELS email,teams
    azd env set ADMIN_CHANNELS email,teams
    azd env set ADMIN_USER_IDS <admin-object-id>
    azd env set PILOT_USER_IDS <pilot-object-id>
    azd env set EMAIL_SENDER_USER_ID <sender-mailbox-object-id>
    azd env set HELPDESK_TEXT "Contact your security helpdesk immediately."
    azd provision

Use a comma-separated list for multiple user IDs. Omit administrator channels/IDs to disable admin notifications. The interactive hook prompts for missing channel selections. Configuration can also be supplied ahead of time for CI. COLLECTION_ENABLED defaults false. ALL_USERS defaults false.

The template creates a resource group, Flex Consumption Function, user-assigned identity, storage, workspace, Application Insights, and a Teams bot only when Teams is selected. Review Azure region availability, pricing, and tenant licensing before broader deployment. Polling requires available Entra audit retention and Graph access; email recipients/sender need Exchange mailboxes and Teams recipients need Teams service access.

## Graph permissions

    ./scripts/Configure-Permissions.ps1 -WhatIf
    ./scripts/Configure-Permissions.ps1

This explicit step grants tenant-wide AuditLog.Read.All and User.Read.All to the exact deployed managed identity. Pilot scope limits notification recipients, not those read permissions. It does not grant Mail.Send or Teams installation privileges.

## Email sender

Use a dedicated existing mailbox. Configure Exchange Online RBAC for Applications for the deployed managed identity, granting Application Mail.Send scoped to only that mailbox. Do not also grant unscoped Entra Mail.Send; permissions are additive.

From a normal Connect-ExchangeOnline session, create the Exchange service-principal reference using AZURE_WORKLOAD_CLIENT_ID and AZURE_WORKLOAD_PRINCIPAL_ID, then an exact mailbox management scope and role assignment. Verify with Test-ServicePrincipalAuthorization against the sender and a different mailbox. Follow the [Microsoft application RBAC procedure](https://learn.microsoft.com/en-us/exchange/permissions-exo/application-rbac). Record exact created object names for cleanup. No Exchange objects are created by provisioning hooks.

## Teams

Generate the personal app package with scripts/New-TeamsAppPackage.ps1 (Get-Help shows required parameters). Publish it in your tenant app catalog and install it personally for each pilot/admin recipient. The bot must receive the installation event before delivery works. Runtime identity is not granted catalog or installation permissions.

The package requires valid public developer/privacy/terms URLs supplied by the administrator. Personal Teams messages are supported; Teams channel webhooks are not part of this milestone.

## Deploy and activate

    npm test
    azd deploy

The deploy hook builds the package and deploys it with remote build disabled. Validate selected delivery routes before enabling collection:

    azd env set COLLECTION_ENABLED true
    azd provision

The first enabled cycle establishes its start boundary. Register a method afterward with a pilot account and verify actual receipt on each chosen channel. Automatic method registration on behalf of a user is not included. Pause by setting COLLECTION_ENABLED=false and reprovisioning.
