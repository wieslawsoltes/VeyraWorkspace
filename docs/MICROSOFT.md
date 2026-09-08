# Documented Microsoft integration

## Authentication boundaries

The SPA uses the official MSAL browser SDK with authorization code + PKCE. Browser configuration contains public client/tenant identifiers only. The popup returns through `auth.html`; do not add application boot code to that page without reviewing the pinned SDK’s redirect requirements. The default integration uses MSAL 4.26.1. Major SDK upgrades, including redirect-bridge changes, require explicit regression testing rather than silently changing the CDN version.

Tokens remain in MSAL's session-scoped cache and are never included in workspace export. A script executing in this origin can access browser data: CSP and escaped rendering reduce risk, but this is not a token vault. Microsoft’s sign-in session and Veyra’s HttpOnly server session are distinct.

## Delegated permissions requested by feature

The source requests permissions on the relevant foreground action; background polling never opens consent windows. A tenant may require administrator approval. Grant the narrowest effective set for the features you deploy.

| Feature | Delegated permission used |
|---|---|
| Profile / sign-in | `User.Read` |
| Chat discovery and reading | `Chat.Read` |
| Team/channel discovery | `Team.ReadBasic.All`, `Channel.ReadBasic.All` |
| Channel posts/replies | `ChannelMessage.Read.All` |
| Send chat / channel message | `ChatMessage.Send` / `ChannelMessage.Send` |
| Edit/delete/react | `Chat.ReadWrite` / `ChannelMessage.ReadWrite`, subject to endpoint rules |
| Create chats | `Chat.Create` |
| Calendar read / write | `Calendars.Read` / `Calendars.ReadWrite` |
| Own OneDrive upload/share | `Files.ReadWrite` |

These are delegated user operations, not application-only migration APIs. The server never uses a Graph application secret. Being able to authenticate does not mean the account has the required license, membership, consent or service eligibility. The adapter propagates errors instead of manufacturing successful results.

### Graph behavior

The adapter reads chats, channels, posts and expanded channel replies; sends messages; edits/deletes owned messages; changes reactions; creates chats with known directory members; and accesses the user’s calendar. Calendar updates use PATCH on the existing Graph event identifier. Events created for an eligible work account request a Teams meeting link. No attendee invitations are inferred from a Veyra room.

Chat replies are rendered as quoted content; this does not promise native Teams threaded-chat semantics. Channel replies use the channel replies endpoint. Full Graph/Teams formatting, cards, message types, system events and hosted content are not all reproduced.

The polling transport defaults to 15 seconds, pauses when hidden, and is not a Graph change-notification subscription service. Reads follow bounded pagination. Authenticated requests and next links are restricted to `https://graph.microsoft.com/v1.0/`; tokens are never forwarded to attachment URLs or arbitrary next-link hosts. GET throttling uses bounded retries and `Retry-After`. Mutations are not automatically retried because an ambiguous response can otherwise duplicate an operation. Graph does not inherit Veyra’s server-side message idempotency guarantee.

Microsoft attachments are shared reference links. Chat uploads go to the signed-in user's OneDrive and attempt to grant read access to known chat recipients; failures are explicit and may leave a file in the owner’s OneDrive for review. Channel uploads require the supported Teams/SharePoint workflow and are deliberately rejected here. The adapter does not pretend to infer private/shared channel ACLs from channel discovery.

## ACS Teams interoperability

The meeting adapter loads the official ACS calling/common SDKs. The Node broker uses the official communication-identity SDK and issues `voip` tokens to authenticated Veyra accounts, with an additional issuance rate limit. A broad VoIP token is a capability: use policy, quotas, monitoring and resource configuration to control its use. The sample broker is not a tenant administration system.

Only commercial Teams work/school meeting HTTPS URLs on explicitly allowed Microsoft hosts are accepted. Teams consumer meetings, sovereign-cloud routing, anonymous-access policy overrides, lobby bypass and joining as a native organizational Teams user are not implemented. The Microsoft Graph login profile supplies a display name, not proof of a Teams meeting identity.

Actual meeting admission, device compatibility, SDK support and available functions depend on Microsoft/Azure policy and the host organization. The UI exposes microphone, camera, screen sharing and real remote video streams; it does not claim full Teams meeting controls, recording, transcription or native meeting chat parity.

## Authoritative reference material

- Microsoft identity platform, authorization code + PKCE: https://learn.microsoft.com/en-us/entra/identity-platform/v2-oauth2-auth-code-flow
- MSAL browser: https://learn.microsoft.com/en-us/entra/msal/javascript/browser/
- Graph permissions: https://learn.microsoft.com/en-us/graph/permissions-reference
- List chats / account support: https://learn.microsoft.com/en-us/graph/api/chat-list?view=graph-rest-1.0
- Update messages: https://learn.microsoft.com/en-us/graph/api/chatmessage-update?view=graph-rest-1.0
- Soft-delete messages: https://learn.microsoft.com/en-us/graph/api/chatmessage-softdelete?view=graph-rest-1.0
- Reactions: https://learn.microsoft.com/en-us/graph/api/chatmessage-setreaction?view=graph-rest-1.0
- ACS / Teams interoperability: https://learn.microsoft.com/en-us/azure/communication-services/concepts/teams-interop
- Join a Teams meeting with ACS: https://learn.microsoft.com/en-us/azure/communication-services/quickstarts/voice-video-calling/get-started-teams-interop?pivots=platform-web

Review the current documentation and service terms before enabling an organization-wide deployment. This delivery does not include an independently verified live Microsoft tenant integration.
