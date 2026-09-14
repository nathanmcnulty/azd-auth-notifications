# Privacy

This self-hosted solution processes Microsoft Entra authentication registration audit data in your tenant. It stores event/user identifiers, method categories, times, delivery status, and Teams conversation references in your Azure storage account. It sends notifications through your selected Microsoft 365 channels. No data is sent to the repository author.

Your organization operates the deployment and determines recipients, access controls, retention, and support procedures. Raw authentication secrets and newly registered contact details are not included in messages. Review docs/operations.md before deployment; table records currently require operator-managed retention.
