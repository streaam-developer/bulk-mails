const fs = require('fs');
const path = require('path');
const EmailConnector = require('./EmailConnector');

class AccountManager {
  constructor(accountsFilePath, pollingInterval = 10000) {
    this.accountsFilePath = accountsFilePath;
    this.pollingInterval = pollingInterval;
    this.accounts = new Map(); // email -> { connector, info, status }
    this.listeners = new Map(); // email -> [callbacks]
  }

  // Load accounts from txt file
  loadAccounts() {
    const accounts = [];
    
    try {
      const content = fs.readFileSync(this.accountsFilePath, 'utf-8');
      const lines = content.split('\n');
      
      for (const line of lines) {
        const trimmed = line.trim();
        
        // Skip empty lines and comments
        if (!trimmed || trimmed.startsWith('#')) {
          continue;
        }
        
        // Parse email:password format
        if (trimmed.includes(':')) {
          const separatorIndex = trimmed.lastIndexOf(':');
          const email = trimmed.substring(0, separatorIndex).trim();
          const password = trimmed.substring(separatorIndex + 1).trim();
          
          if (email && password) {
            accounts.push({ email, password });
          }
        }
      }
      
      console.log(`Loaded ${accounts.length} account(s) from file`);
    } catch (err) {
      console.error('Error loading accounts:', err.message);
    }
    
    return accounts;
  }

  // Initialize and connect all accounts
  async initializeAccounts() {
    const accounts = this.loadAccounts();
    const results = [];
    
    // Connect accounts in parallel with batch processing
    const batchSize = 5; // Connect 5 accounts at a time
    
    for (let i = 0; i < accounts.length; i += batchSize) {
      const batch = accounts.slice(i, i + batchSize);
      const batchResults = await Promise.allSettled(
        batch.map(account => this.addAccount(account))
      );
      
      results.push(...batchResults);
      
      // Small delay between batches to avoid overwhelming the server
      if (i + batchSize < accounts.length) {
        await this.delay(1000);
      }
    }
    
    return results;
  }

  // Add a single account
  async addAccount(account) {
    const { email, password } = account;
    
    if (this.accounts.has(email)) {
      console.log(`Account ${email} already exists`);
      return { success: false, error: 'Account already exists' };
    }
    
    const connector = new EmailConnector(account, this.pollingInterval);
    
    // Set up event listeners
    connector.on('newEmails', (emails) => {
      this.notifyListeners(email, 'newEmails', emails);
    });
    
    connector.on('error', (err) => {
      this.notifyListeners(email, 'error', err);
      this.updateAccountStatus(email, 'error', err.message);
    });
    
    connector.on('disconnected', () => {
      this.updateAccountStatus(email, 'disconnected');
    });
    
    // Initialize account object
    const accountInfo = {
      email,
      connector,
      status: 'connecting',
      error: null,
      connectedAt: null,
      lastEmailAt: null,
      totalEmails: 0
    };
    
    this.accounts.set(email, accountInfo);
    
    try {
      await connector.connect();
      await connector.startMonitoring();
      
      accountInfo.status = 'connected';
      accountInfo.connectedAt = new Date();
      
      console.log(`[${email}] Account initialized successfully`);
      this.notifyListeners(email, 'statusChanged', { status: 'connected' });
      
      return { success: true, account: accountInfo };
    } catch (err) {
      accountInfo.status = 'error';
      accountInfo.error = err.message;
      
      console.error(`[${email}] Failed to initialize:`, err.message);
      this.notifyListeners(email, 'error', err);
      
      return { success: false, error: err.message };
    }
  }

  // Remove an account
  removeAccount(email) {
    const account = this.accounts.get(email);
    
    if (account) {
      account.connector.stopMonitoring();
      this.accounts.delete(email);
      console.log(`[${email}] Account removed`);
      return true;
    }
    
    return false;
  }

  // Get account status
  getAccountStatus(email) {
    const account = this.accounts.get(email);
    
    if (!account) {
      return null;
    }
    
    return {
      email: account.email,
      status: account.status,
      error: account.error,
      connectedAt: account.connectedAt,
      lastEmailAt: account.lastEmailAt,
      totalEmails: account.totalEmails
    };
  }

  // Get all accounts status
  getAllAccountsStatus() {
    const statusList = [];
    
    for (const [email, account] of this.accounts) {
      statusList.push({
        email: account.email,
        status: account.status,
        error: account.error,
        connectedAt: account.connectedAt,
        lastEmailAt: account.lastEmailAt,
        totalEmails: account.totalEmails
      });
    }
    
    return statusList;
  }

  // Update account status
  updateAccountStatus(email, status, error = null) {
    const account = this.accounts.get(email);
    
    if (account) {
      account.status = status;
      account.error = error;
    }
  }

  // Add listener for account events
  addListener(email, event, callback) {
    if (!this.listeners.has(email)) {
      this.listeners.set(email, new Map());
    }
    
    const eventListeners = this.listeners.get(email);
    
    if (!eventListeners.has(event)) {
      eventListeners.set(event, []);
    }
    
    eventListeners.get(event).push(callback);
  }

  // Notify all listeners for an account
  notifyListeners(email, event, data) {
    const eventListeners = this.listeners.get(email);
    
    if (eventListeners && eventListeners.has(event)) {
      for (const callback of eventListeners.get(event)) {
        try {
          callback(data);
        } catch (err) {
          console.error(`[${email}] Listener error:`, err.message);
        }
      }
    }
  }

  // Add global listener (for all accounts)
  addGlobalListener(event, callback) {
    for (const [email, account] of this.accounts) {
      account.connector.on(event, (data) => {
        callback(email, data);
      });
    }
  }

  // Get total accounts count
  getTotalAccounts() {
    return this.accounts.size;
  }

  // Get connected accounts count
  getConnectedAccounts() {
    let count = 0;
    
    for (const [, account] of this.accounts) {
      if (account.status === 'connected') {
        count++;
      }
    }
    
    return count;
  }

  // Reconnect all accounts
  async reconnectAll() {
    const results = [];
    
    for (const [email, account] of this.accounts) {
      try {
        await account.connector.reconnect();
        results.push({ email, success: true });
      } catch (err) {
        results.push({ email, success: false, error: err.message });
      }
    }
    
    return results;
  }

  // Stop all accounts
  stopAll() {
    for (const [email, account] of this.accounts) {
      account.connector.stopMonitoring();
    }
    console.log('All accounts stopped');
  }

  // Utility: delay
  delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

module.exports = AccountManager;
