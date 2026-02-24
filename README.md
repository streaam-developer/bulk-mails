# 📧 Outlook Email Monitor

Advanced real-time email monitoring system for multiple Outlook accounts with web dashboard.

## Features

- 🔐 **Multi-Account Login** - Automatically login to all Outlook accounts from txt file
- ⚡ **Real-Time Monitoring** - Instant notifications when new emails arrive
- 📊 **Web Dashboard** - Modern, responsive UI to view all emails
- 🔄 **Auto-Reconnect** - Automatic reconnection on connection failures
- 📈 **Statistics** - Track emails, accounts, and session activity

## Prerequisites

- Node.js 14.x or higher
- Outlook account(s) with App Passwords (if 2FA enabled)

## Installation

1. **Install dependencies:**
```bash
npm install
```

2. **Configure accounts:**
Edit `accounts.txt` and add your Outlook accounts:
```
email@outlook.com:password
another@outlook.com:password
```

### ⚠️ Important: Using App Passwords

If your Outlook account has **Two-Factor Authentication (2FA)** enabled, you MUST use an App Password instead of your regular password:

1. Go to [https://account.microsoft.com/security](https://account.microsoft.com/security)
2. Click on "Password security"
3. Under "Two-step verification", click "Set up two-step verification"
4. After setting up 2FA, go to "App passwords"
5. Create a new app password and use it in your `accounts.txt`

## Usage

### Start the server:
```bash
npm start
```

The server will start on `http://localhost:3000`

### Open the dashboard:
Navigate to `http://localhost:3000` in your browser

## Configuration

Edit `.env` file to customize:

```env
PORT=3000              # Server port
POLLING_INTERVAL=5000 # Check every 5 seconds
MAX_EMAILS_STORED=1000 # Keep last 1000 emails
```

## API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/emails` | GET | Get all emails (supports ?limit, ?offset, ?account) |
| `/api/emails/:id` | GET | Get single email |
| `/api/accounts` | GET | Get all account statuses |
| `/api/accounts` | POST | Add new account |
| `/api/accounts/:email` | DELETE | Remove account |
| `/api/accounts/reload` | POST | Reload accounts from file |
| `/api/accounts/reconnect` | POST | Reconnect all accounts |
| `/api/statistics` | GET | Get statistics |
| `/api/health` | GET | Health check |

## Architecture

```
┌─────────────────┐     ┌──────────────────┐     ┌─────────────────┐
│  Outlook IMAP   │────▶│  EmailConnector  │────▶│AccountManager   │
│  Servers        │     │  (per account)   │     │                 │
└─────────────────┘     └──────────────────┘     └────────┬────────┘
                                                          │
                                                          ▼
┌─────────────────┐     ┌──────────────────┐     ┌─────────────────┐
│  Web Dashboard  │◀────│  WebSocket       │◀────│  Express Server │
│  (Real-time)    │     │  (Push updates)  │     │                 │
└─────────────────┘     └──────────────────┘     └─────────────────┘
```

## Troubleshooting

### Connection Issues
- Check your internet connection
- Verify account credentials
- Ensure App Password is used if 2FA is enabled
- Check firewall settings (port 993 for IMAP)

### Slow Performance
- Reduce `POLLING_INTERVAL` in `.env`
- Limit number of accounts
- Increase server resources

### Error: "Authentication Failed"
- Verify username and password
- Use App Password for 2FA accounts
- Check if account has IMAP enabled in Outlook settings

## Security Notes

- ⚠️ Store passwords securely in production
- Use environment variables for sensitive data
- Consider encrypting the accounts.txt file
- Use HTTPS in production (configure SSL/TLS)

## License

MIT License
