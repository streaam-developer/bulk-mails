const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');
const AccountManager = require('./lib/AccountManager');
const { v4: uuidv4 } = require('uuid');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// Store for emails and statistics
const emailStore = {
  emails: [],
  statistics: {
    totalEmails: 0,
    todayEmails: 0,
    accountsConnected: 0,
    accountsTotal: 0
  }
};

// Configuration
const CONFIG = {
  accountsFile: 'accounts.txt',
  pollingInterval: 5000, // Check for new emails every 5 seconds
  maxEmailsStored: 1000, // Keep last 1000 emails in memory
  serverPort: process.env.PORT || 3000
};

// Initialize Account Manager
const accountManager = new AccountManager(CONFIG.accountsFile, CONFIG.pollingInterval);

// Middleware
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// WebSocket connections
const clients = new Set();

wss.on('connection', (ws) => {
  clients.add(ws);
  console.log('WebSocket client connected');
  
  // Send current state to new client
  ws.send(JSON.stringify({
    type: 'init',
    data: {
      emails: emailStore.emails,
      statistics: emailStore.statistics,
      accounts: accountManager.getAllAccountsStatus()
    }
  }));
  
  ws.on('close', () => {
    clients.delete(ws);
    console.log('WebSocket client disconnected');
  });
  
  ws.on('error', (err) => {
    console.error('WebSocket error:', err.message);
    clients.delete(ws);
  });
});

// Broadcast to all connected clients
function broadcast(type, data) {
  const message = JSON.stringify({ type, data });
  
  for (const client of clients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(message);
    }
  }
}

// Set up account event listeners
accountManager.addGlobalListener('newEmails', (email, emails) => {
  console.log(`New emails from ${email}: ${emails.length}`);
  
  for (const emailData of emails) {
    const storedEmail = {
      id: uuidv4(),
      account: email,
      uid: emailData.uid,
      from: emailData.from,
      to: emailData.to,
      subject: emailData.subject,
      date: emailData.date,
      text: emailData.text.substring(0, 500), // Store first 500 chars
      html: emailData.html,
      preview: emailData.text.substring(0, 100).replace(/\n/g, ' '),
      receivedAt: new Date()
    };
    
    emailStore.emails.unshift(storedEmail);
    
    // Keep only last N emails
    if (emailStore.emails.length > CONFIG.maxEmailsStored) {
      emailStore.emails.pop();
    }
  }
  
  // Update statistics
  emailStore.statistics.totalEmails += emails.length;
  emailStore.statistics.todayEmails += emails.length;
  emailStore.statistics.accountsConnected = accountManager.getConnectedAccounts();
  
  // Broadcast new emails to all clients
  broadcast('newEmails', {
    emails,
    account: email,
    count: emails.length
  });
});

accountManager.addGlobalListener('error', (email, error) => {
  console.error(`Account ${email} error:`, error.message);
  emailStore.statistics.accountsConnected = accountManager.getConnectedAccounts();
  
  broadcast('accountError', {
    account: email,
    error: error.message
  });
});

accountManager.addGlobalListener('statusChanged', (email, data) => {
  console.log(`Account ${email} status:`, data.status);
  emailStore.statistics.accountsConnected = accountManager.getConnectedAccounts();
  
  broadcast('accountStatusChanged', {
    account: email,
    ...data
  });
});

// API Routes

// Get all emails
app.get('/api/emails', (req, res) => {
  const { limit = 50, offset = 0, account } = req.query;
  
  let filteredEmails = emailStore.emails;
  
  if (account) {
    filteredEmails = filteredEmails.filter(e => e.account === account);
  }
  
  const paginatedEmails = filteredEmails.slice(
    parseInt(offset),
    parseInt(offset) + parseInt(limit)
  );
  
  res.json({
    success: true,
    data: paginatedEmails,
    total: filteredEmails.length,
    statistics: emailStore.statistics
  });
});

// Get single email by ID
app.get('/api/emails/:id', (req, res) => {
  const email = emailStore.emails.find(e => e.id === req.params.id);
  
  if (email) {
    res.json({ success: true, data: email });
  } else {
    res.status(404).json({ success: false, error: 'Email not found' });
  }
});

// Get all accounts status
app.get('/api/accounts', (req, res) => {
  res.json({
    success: true,
    data: accountManager.getAllAccountsStatus(),
    statistics: {
      total: accountManager.getTotalAccounts(),
      connected: accountManager.getConnectedAccounts()
    }
  });
});

// Get statistics
app.get('/api/statistics', (req, res) => {
  res.json({
    success: true,
    data: emailStore.statistics
  });
});

// Add new account
app.post('/api/accounts', async (req, res) => {
  const { email, password } = req.body;
  
  if (!email || !password) {
    return res.status(400).json({
      success: false,
      error: 'Email and password are required'
    });
  }
  
  try {
    const result = await accountManager.addAccount({ email, password });
    
    if (result.success) {
      emailStore.statistics.accountsTotal = accountManager.getTotalAccounts();
      emailStore.statistics.accountsConnected = accountManager.getConnectedAccounts();
    }
    
    res.json(result);
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Remove account
app.delete('/api/accounts/:email', (req, res) => {
  const email = decodeURIComponent(req.params.email);
  const result = accountManager.removeAccount(email);
  
  if (result) {
    emailStore.statistics.accountsTotal = accountManager.getTotalAccounts();
    emailStore.statistics.accountsConnected = accountManager.getConnectedAccounts();
    res.json({ success: true });
  } else {
    res.status(404).json({ success: false, error: 'Account not found' });
  }
});

// Reconnect all accounts
app.post('/api/accounts/reconnect', async (req, res) => {
  try {
    const results = await accountManager.reconnectAll();
    res.json({ success: true, results });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Reload accounts from file
app.post('/api/accounts/reload', async (req, res) => {
  try {
    // Stop all current accounts
    accountManager.stopAll();
    emailStore.statistics.accountsTotal = 0;
    emailStore.statistics.accountsConnected = 0;
    
    // Reinitialize
    await accountManager.initializeAccounts();
    
    emailStore.statistics.accountsTotal = accountManager.getTotalAccounts();
    emailStore.statistics.accountsConnected = accountManager.getConnectedAccounts();
    
    res.json({
      success: true,
      accounts: accountManager.getAllAccountsStatus()
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Health check
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    uptime: process.uptime(),
    memory: process.memoryUsage(),
    clients: clients.size
  });
});

// Serve the dashboard
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Start server
async function start() {
  try {
    // Initialize accounts
    emailStore.statistics.accountsTotal = (await accountManager.initializeAccounts()).length;
    emailStore.statistics.accountsConnected = accountManager.getConnectedAccounts();
    
    server.listen(CONFIG.serverPort, () => {
      console.log(`
╔══════════════════════════════════════════════════════════╗
║        OUTLOOK EMAIL MONITOR - SERVER STARTED            ║
╠══════════════════════════════════════════════════════════╣
║  Server URL: http://localhost:${CONFIG.serverPort}                   ║
║  WebSocket:  ws://localhost:${CONFIG.serverPort}                      ║
║  Accounts:   ${emailStore.statistics.accountsTotal} loaded, ${emailStore.statistics.accountsConnected} connected              ║
║  Polling:    Every ${CONFIG.pollingInterval / 1000} seconds                         ║
╚══════════════════════════════════════════════════════════╝
      `);
    });
  } catch (err) {
    console.error('Failed to start server:', err);
    process.exit(1);
  }
}

// Handle graceful shutdown
process.on('SIGTERM', () => {
  console.log('Shutting down...');
  accountManager.stopAll();
  server.close(() => {
    process.exit(0);
  });
});

process.on('SIGINT', () => {
  console.log('Shutting down...');
  accountManager.stopAll();
  server.close(() => {
    process.exit(0);
  });
});

start();
