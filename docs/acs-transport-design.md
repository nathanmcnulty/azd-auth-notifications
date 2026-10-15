# Azure Communication Services transport assessment

**Assessment date:** 2026-10-15  
**Decision:** blocked pending an explicit product decision; recommend retaining
the existing routes and not adding a new ACS dependency.

Microsoft has announced standalone ACS retirement for 2028-09-30. The retirement
notice explicitly includes ACS Email and SMS. It also describes onboarding
restrictions beginning 2026-10-23, including phone-number purchase restrictions
for customers without a qualifying pre-restriction ACS resource. ACS is not
asserted to be unavailable today, but accepting its finite lifecycle and future
migration cost requires an explicit product decision before implementation.
Until then, do not add a temporary resource, sender, role assignment, secret, or
provider integration.

Keep the existing Graph email and Teams transports unchanged. Do not silently
migrate an accepted email route between providers, enable two email providers
for the same logical route, or treat provider acceptance as delivery or human
receipt. The current approved email boundary remains the affected user's
validated `mail`; configured administrator recipient object IDs must likewise
resolve through the existing approved directory/mail policy. Neither audience
falls back to an actor, UPN, mobile phone, audit record, or a newly registered
recipient method.

SMS remains unresolved. If SMS is still required, create a separate product
decision for a replacement provider before changing configuration, permissions,
state, or code. That decision must select the provider and document its supported
regions, sender ownership and eligibility, opt-in/opt-out and revocation rules,
approved E.164 recipient registry, managed-identity/workload authentication,
exact resource-scoped permissions, bounded request/response evidence, current
dated quotas, and pricing. No replacement provider is selected here, and
Microsoft Graph `mobilePhone` is not an approved SMS recipient source.

Any future provider migration must preserve a stable logical route identity for
deduplication and freeze the provider on pending rows. A provider attempt ID is
separate evidence; changing the provider portion of a delivery key would permit
duplicates. Ambiguous outcomes remain reviewable and are never automatically
replayed.

No ACS resource, phone number, domain, Event Grid subscription, role assignment,
secret, authentication flow, provider request, or recipient delivery was
performed. No ACS permissions are approved in `azd-permissions.json`; the
existing mailbox-scoped Exchange/Graph email permission and Teams path remain
the deployed design. ACS pricing and quota pages are estimates and service
limits, not a durable implementation commitment; no flat price or quota is
asserted here.

Official sources reviewed on 2026-10-15:

- [ACS retirement and breaking changes guide](https://learn.microsoft.com/en-us/azure/communication-services/acs-retirement-and-breaking-changes-guide)
- [ACS email overview](https://learn.microsoft.com/en-us/azure/communication-services/concepts/email/email-overview)
- [ACS SMS FAQ and service limits](https://learn.microsoft.com/en-us/azure/communication-services/concepts/sms/sms-faq)
- [ACS service limits](https://learn.microsoft.com/en-us/azure/communication-services/concepts/service-limits)
- [ACS authentication](https://learn.microsoft.com/en-us/rest/api/communication/authentication)
- [ACS pricing](https://azure.microsoft.com/en-us/pricing/details/communication-services/)
