You have a Chrome browser connected via my-browser MCP. WhatsApp Web is open.

Your task: reply "1" to the Twilio sandbox contact "Escher" on WhatsApp Web.

Steps (follow exactly, minimize snapshots to save context):
1. Use browser_snapshot with depth=3 to get just the top-level layout
2. If you see a QR code or login screen, STOP immediately
3. Click the search box (textbox "Search or start a new chat"), type "Escher", then click the matching chat result
4. Once the chat is open, click the message input (textbox "Type a message"), type "1", and press Enter
5. Done — do NOT take another snapshot to verify

Key selectors:
- Search box: textbox "Search or start a new chat"
- Message input: [data-testid='conversation-compose-box-input']

This is a CONFIRMATION gate.
