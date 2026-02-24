const { Client } = require('@microsoft/microsoft-graph-client');
const EventEmitter = require('events');
const axios = require('axios');

class GraphConnector extends EventEmitter {
  constructor(account, pollingInterval = 10000) {
    super();
    this.account = account;
    this.email = account.email;
    this.accessToken = null;
    this.client = null;
    this.pollingInterval = pollingInterval;
    this.isConnected = false;
    this.lastEmailDate = null;
    this.pollingTimer = null;
    this.isMonitoring = false;
  }

  // Initialize Microsoft Graph client with OAuth2
  async connect() {
    return new Promise(async (resolve, reject) => {
      try {
        console.log(`[${this.email}] Initializing Microsoft Graph API...`);
        
        // Check if we have OAuth credentials
        if (!this.account.clientId || !this.account.clientSecret || !this.account.tenantId) {
          throw new Error('OAuth2 credentials not configured. Please set clientId, clientSecret, and tenantId in accounts.txt');
        }

        // Get access token using client credentials flow (for single tenant app)
        // Or use refresh token flow for delegated access
        this.accessToken = await this.getAccessToken();
        
        if (!this.accessToken) {
          throw new Error('Failed to obtain access token');
        }

        // Create Graph client
        this.client = Client.init({
          authProvider: (done) => {
            done(null, this.accessToken);
          }
        });

        // Test connection by getting user's profile
        const me = await this.client.api('/me').get();
        
        if (me) {
          this.isConnected = true;
          console.log(`[${this.email}] Connected to Microsoft Graph API`);
          console.log(`[${this.email}] User: ${me.displayName || this.email}`);
          resolve();
        }
      } catch (err) {
        console.error(`[${this.email}] Graph API Error:`, err.message);
        this.isConnected = false;
        this.emit('error', err);
        reject(err);
      }
    });
  }

  // Get access token using client credentials or refresh token
  async getAccessToken() {
    const { clientId, clientSecret, tenantId, refreshToken } = this.account;
    
    // Try to use refresh token if available
    if (refreshToken) {
      try {
        const tokenUrl = `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`;
        const response = await axios.post(tokenUrl, 
          new URLSearchParams({
            client_id: clientId,
            client_secret: clientSecret,
            refresh_token: refreshToken,
            grant_type: 'refresh_token',
            scope: 'https://graph.microsoft.com/.default offline_access'
          }), {
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
          }
        );
        
        console.log(`[${this.email}] Access token obtained via refresh token`);
        return response.data.access_token;
      } catch (err) {
        console.error(`[${this.email}] Refresh token failed:`, err.message);
        // Continue to try client credentials
      }
    }

    // Use client credentials flow (app-only)
    try {
      const tokenUrl = `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`;
      const response = await axios.post(tokenUrl,
        new URLSearchParams({
          client_id: clientId,
          client_secret: clientSecret,
          scope: 'https://graph.microsoft.com/.default',
          grant_type: 'client_credentials'
        }), {
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
        }
      );
      
      console.log(`[${this.email}] Access token obtained via client credentials`);
      return response.data.access_token;
    } catch (err) {
      console.error(`[${this.email}] Failed to get access token:`, err.message);
      throw new Error(`OAuth2 authentication failed: ${err.message}`);
    }
  }

  // Fetch new emails since last check
  async fetchNewEmails() {
    if (!this.isConnected) {
      throw new Error('Not connected to Microsoft Graph API');
    }

    try {
      // Build query for unread emails
      let query = this.client.api('/me/messages')
        .filter('isRead eq false')
        .select('id,subject,from,to,receivedDateTime,bodyPreview,hasAttachments,attachments')
        .orderby('receivedDateTime desc')
        .top(50);

      // If we have a lastEmailDate, only get emails after that
      if (this.lastEmailDate) {
        query = this.client.api('/me/messages')
          .filter(`receivedDateTime gt ${this.lastEmailDate}`)
          .select('id,subject,from,to,receivedDateTime,bodyPreview,hasAttachments,attachments')
          .orderby('receivedDateTime desc')
          .top(50);
      }

      const messages = await query.get();

      if (!messages.value || messages.value.length === 0) {
        return [];
      }

      // Update lastEmailDate to the most recent email
      if (messages.value.length > 0) {
        this.lastEmailDate = messages.value[0].receivedDateTime;
      }

      const emails = messages.value.map(msg => ({
        id: msg.id,
        uid: msg.id,
        from: msg.from?.emailAddress?.address || '',
        fromName: msg.from?.emailAddress?.name || '',
        to: msg.toRecipients?.map(r => r.emailAddress.address).join(', ') || '',
        subject: msg.subject || '(No Subject)',
        date: msg.receivedDateTime,
        text: msg.bodyPreview || '',
        html: '',
        hasAttachments: msg.hasAttachments
      }));

      return emails;
    } catch (err) {
      console.error(`[${this.email}] Error fetching emails:`, err.message);
      throw err;
    }
  }

  // Mark email as read
  async markAsSeen(messageId) {
    if (!this.isConnected) {
      throw new Error('Not connected to Microsoft Graph API');
    }

    try {
      await this.client.api(`/me/messages/${messageId}`)
        .patch({ isRead: true });
    } catch (err) {
      console.error(`[${this.email}] Error marking email as read:`, err.message);
      throw err;
    }
  }

  // Get email full details including HTML body
  async getEmailDetails(messageId) {
    if (!this.isConnected) {
      throw new Error('Not connected to Microsoft Graph API');
    }

    try {
      const message = await this.client.api(`/me/messages/${messageId}`)
        .select('id,subject,from,to,receivedDateTime,body,hasAttachments,attachments')
        .get();

      return {
        id: message.id,
        from: message.from?.emailAddress?.address || '',
        fromName: message.from?.emailAddress?.name || '',
        to: message.toRecipients?.map(r => r.emailAddress.address).join(', ') || '',
        subject: message.subject || '(No Subject)',
        date: message.receivedDateTime,
        text: message.bodyPreview || '',
        html: message.body?.content || '',
        hasAttachments: message.hasAttachments
      };
    } catch (err) {
      console.error(`[${this.email}] Error getting email details:`, err.message);
      throw err;
    }
  }

  // Start monitoring for new emails
  async startMonitoring() {
    if (this.isMonitoring) return;
    
    this.isMonitoring = true;
    console.log(`[${this.email}] Starting email monitoring with Graph API...`);
    
    try {
      // Get initial emails to set baseline
      await this.fetchInitialEmails();
      this.startPolling();
    } catch (err) {
      console.error(`[${this.email}] Failed to start monitoring:`, err.message);
      this.emit('error', err);
    }
  }

  // Fetch initial emails to set baseline
  async fetchInitialEmails() {
    try {
      // Get the most recent email to set lastEmailDate
      const messages = await this.client.api('/me/messages')
        .select('receivedDateTime')
        .orderby('receivedDateTime desc')
        .top(1)
        .get();

      if (messages.value && messages.value.length > 0) {
        this.lastEmailDate = messages.value[0].receivedDateTime;
        console.log(`[${this.email}] Initial email date set to: ${this.lastEmailDate}`);
      }
    } catch (err) {
      console.error(`[${this.email}] Error fetching initial emails:`, err.message);
    }
  }

  // Start polling for new emails
  startPolling() {
    this.pollingTimer = setInterval(async () => {
      try {
        if (!this.isConnected) {
          console.log(`[${this.email}] Reconnecting to Graph API...`);
          await this.connect();
        }

        const newEmails = await this.fetchNewEmails();
        
        if (newEmails.length > 0) {
          console.log(`[${this.email}] Found ${newEmails.length} new email(s)!`);
          this.emit('newEmails', newEmails);
        }
      } catch (err) {
        console.error(`[${this.email}] Polling error:`, err.message);
        // Try to reconnect on error
        this.reconnect();
      }
    }, this.pollingInterval);
  }

  // Reconnect to Graph API
  async reconnect() {
    try {
      this.isConnected = false;
      await this.connect();
      console.log(`[${this.email}] Reconnected successfully`);
    } catch (err) {
      console.error(`[${this.email}] Reconnection failed:`, err.message);
    }
  }

  // Stop monitoring
  stopMonitoring() {
    this.isMonitoring = false;
    if (this.pollingTimer) {
      clearInterval(this.pollingTimer);
      this.pollingTimer = null;
    }
    console.log(`[${this.email}] Stopped monitoring`);
  }

  // Get account info
  getAccountInfo() {
    return {
      email: this.email,
      isConnected: this.isConnected,
      isMonitoring: this.isMonitoring,
      lastEmailDate: this.lastEmailDate,
      type: 'Microsoft Graph API'
    };
  }
}

module.exports = GraphConnector;
