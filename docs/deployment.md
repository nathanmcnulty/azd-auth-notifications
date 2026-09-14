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

Generate the personal package, then publish/install it for an explicit pilot:

    ./scripts/New-TeamsAppPackage.ps1
    ./scripts/Install-TeamsApp.ps1 -AdminUpn <admin-UPN> -UserId <pilot-object-id>

The installer checks the deployed identity, personal-scope manifest, published version, and recorded catalog ID. It refuses silent package updates or replacement of a missing recorded app. Use -WhatIf for a plan. If normal Graph PowerShell WAM fails with a missing window handle, -UseCachedWam tries the selected administrator's existing broker session without opening a device-code flow. Missing cache/consent remains an authentication blocker.

Teams availability is a separate administration step. When installation returns App is blocked by app permission policy, use Teams admin center or Teams PowerShell to allow this app for the pilot. In Teams PowerShell, Get-M365TeamsApp requires the **catalog ID** saved as TEAMS_CATALOG_APP_ID, not the manifest/bot client ID:

    Connect-MicrosoftTeams -TenantId <tenant-id> -AccountId <admin-UPN>
    Get-M365TeamsApp -Id <catalog-id>
    Update-M365TeamsApp -Id <catalog-id> -AppAssignmentType UsersAndGroups -OperationType Add -Users <pilot-object-id>

Teams PowerShell also supports -DisableWAM for normal browser authentication when required by the host. Verify the connected tenant before changes. A newly published app can be visible in app management while Graph catalog queries do not yet return it; wait for availability propagation and retry the same recorded app instead of creating another one.

If a send returns TeamsHttp403_BotDisabledByAdmin, verify the app is unblocked and available to the recipient. [Microsoft documents up to 24 hours for availability changes](https://learn.microsoft.com/en-us/microsoftteams/app-centric-management). An installed app alone does not prove sending is permitted; do not broaden tenant policy just to work around propagation.

The bot must receive the personal installation event before delivery works. Runtime identity is not granted catalog or installation permissions. The current installer deliberately limits automatic installation to configured PILOT_USER_IDS; additional administrator recipients need personal installation through your normal Teams administration process.

The package requires valid public developer/privacy/terms URLs supplied by the administrator. Personal Teams messages are supported; Teams channel webhooks are not part of this milestone.

## Deploy and activate

    npm test
    azd deploy

The deploy hook builds the package and deploys it with remote build disabled. Validate selected delivery routes before enabling collection:

    azd env set COLLECTION_ENABLED true
    azd provision

The first enabled cycle establishes its start boundary. Register a method afterward with a pilot account and verify actual receipt on each chosen channel. Automatic method registration on behalf of a user is not included. Pause by setting COLLECTION_ENABLED=false and reprovisioning.

## Scoped email setup script

After setting EMAIL_SENDER_USER_ID, run scripts/Configure-Exchange.ps1 -AdminUpn <administrator-UPN>. Use -WhatIf for a read-only plan and -OtherMailbox <different-mailbox> to verify that the send scope excludes another mailbox. On hosts where WAM cannot acquire a window handle, -DisableWAM selects normal Exchange browser authentication. The script checks the connected Exchange tenant before changing objects.

## Delivery proof

With collection disabled and an explicit pilot configured, run scripts/Test-NotificationDelivery.ps1 -UserId <pilot-object-id>. Add -Channel teams or -Channel email to test only configured routes for that channel, -HealthOnly to check readiness without sending, or -WhatIf to preview the send. Channel selection filters both user and administrator routes; inspect the returned recipient IDs to establish which audience was tested. The command checks the Azure target and keeps the Function key in memory. It fails if any selected route is not accepted.

For direct API use, POST to /api/test-delivery with a Function key in the x-functions-key header and JSON body containing userId. Only a configured pilot user is accepted; channels and administrator destinations come from deployment configuration. This creates labeled synthetic delivery records and can send real notifications. It cannot accept arbitrary recipients or run while collection is enabled. Confirm receipt separately from an accepted provider result.

For a read-only audit replay, set AZURE_TENANT_ID and optionally AUDIT_INSPECTION_HOURS (1 through 168), then run npx tsx scripts/Inspect-Audits.ts. Output is aggregate counts; it does not send notifications or store raw audit records.
