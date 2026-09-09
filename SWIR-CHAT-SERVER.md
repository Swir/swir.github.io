# SWIR Chat Server

SWIR Chat is split into two parts:

- **Client:** `swir-chat.html` running inside SWIR OS on GitHub Pages.
- **Server:** `swir-chat-api.php` running on your own PHP + MySQL/MariaDB hosting.

GitHub Pages cannot run PHP or a database, so the chat server must live on another host.

## Requirements

- PHP 8.0 or newer
- PDO MySQL extension
- MySQL or MariaDB
- HTTPS strongly recommended
- A hosting account where PHP can write `swir-chat-config.php` next to the API file during installation

## Installation

1. Create an empty MySQL/MariaDB database in your hosting panel.
2. Create a database user and give it access to that database.
3. Upload `swir-chat-api.php` to your PHP hosting.
4. Open the uploaded file in your browser, for example:

   `https://example.com/swir-chat-api.php`

5. Enter:
   - database host
   - database port (usually `3306`)
   - database name
   - database user
   - database password
   - Allowed Origin: `https://swir.github.io`
   - room name
6. Click **INSTALL DATABASE + GENERATE API KEYS**.
7. The installer creates:
   - `swir_chat_messages`
   - `swir_chat_presence`
   - `swir-chat-config.php`
8. Copy the generated **API URL** and **Public Chat Key**.
9. Open SWIR Chat inside SWIR OS and paste those two values into the first-run setup screen.
10. Save the **Admin Key** somewhere private. It is reserved for a future moderation/admin console and must never be placed in client-side JavaScript.

## Security model

The **Public Chat Key is not a password**. It is intentionally safe to use in the browser and identifies your SWIR Chat instance. Anyone who can use the public chat can technically inspect it in browser developer tools.

The **Admin Key is secret**. Do not commit it to GitHub, put it in `swir-chat.html`, or share it publicly.

The server also restricts browser access using CORS. For the GitHub Pages edition the Allowed Origin should be:

`https://swir.github.io`

## Live behavior

Version 1 uses short polling (about every 1.5 seconds) because it works on almost every shared PHP hosting account. Presence is refreshed separately and users disappear from the online list after roughly 45 seconds without a heartbeat.

A future server adapter can replace polling with WebSocket/SSE without changing the SWIR OS app concept.

## Updating / reinstalling

The generated file `swir-chat-config.php` contains database credentials and API keys. It is created only on the PHP host and should not be uploaded to the public GitHub repository.

To reinstall from scratch, back up messages if needed, remove `swir-chat-config.php` from the PHP host, and open `swir-chat-api.php` again.
