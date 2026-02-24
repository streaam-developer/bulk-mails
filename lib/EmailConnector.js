const Imap = require('imap');
const { simpleParser } = require('mailparser');
const EventEmitter = require('events');

class EmailConnector extends EventEmitter {
  constructor(account, pollingInterval = 10000) {
    super();
    this.account = account;
    this.email = account.email;
    this.password = account.password;
    this.pollingInterval = pollingInterval;
    this.imap = null;
    this.isConnected = false;
    this.lastUid = 0;
    this.pollingTimer = null;
    this.isMonitoring = false;
  }

  // Connect to Outlook IMAP server
  connect() {
    return new Promise((resolve, reject) => {
      // Try different Outlook IMAP endpoints
      const hosts = [
        'outlook.office365.com',
        'smtp.office365.com',
        'outlook.office.com'
      ];
      
      let currentHostIndex = 0;
      
      const tryConnect = (host) => {
        console.log(`[${this.email}] Attempting connection to ${host}...`);
        
        this.imap = new Imap({
          user: this.email,
          password: this.password,
          host: host,
          port: 993,
          tls: true,
          tlsOptions: {
            rejectUnauthorized: false
          },
          authTimeout: 30000,
          connTimeout: 30000,
          // Try both LOGIN and XOAUTH2 mechanisms
          authenticationMethods: ['LOGIN', 'PLAIN']
        });

        this.imap.once('ready', () => {
          this.isConnected = true;
          console.log(`[${this.email}] Connected to IMAP server (${host})`);
          resolve();
        });

        this.imap.once('error', (err) => {
          console.error(`[${this.email}] IMAP Error (${host}):`, err.message);
          
          // Try next host if available
          currentHostIndex++;
          if (currentHostIndex < hosts.length) {
            console.log(`[${this.email}] Trying next host...`);
            tryConnect(hosts[currentHostIndex]);
          } else {
            this.isConnected = false;
            this.emit('error', new Error(`LOGIN failed. Please check password or use App Password if 2FA is enabled. Get App Password from: https://account.microsoft.com/security`));
            reject(err);
          }
        });

        this.imap.once('close', () => {
          this.isConnected = false;
          console.log(`[${this.email}] IMAP connection closed`);
          this.emit('disconnected');
        });

        this.imap.connect();
      };
      
      tryConnect(hosts[0]);
    });
  }

  // Open INBOX folder
  openInbox() {
    return new Promise((resolve, reject) => {
      this.imap.openBox('INBOX', true, (err, box) => {
        if (err) {
          reject(err);
        } else {
          resolve(box);
        }
      });
    });
  }

  // Fetch new emails since last check
  async fetchNewEmails() {
    if (!this.isConnected) {
      throw new Error('Not connected to IMAP server');
    }

    return new Promise((resolve, reject) => {
      const searchCriteria = ['UNSEEN'];
      
      this.imap.search(searchCriteria, (err, results) => {
        if (err) {
          reject(err);
          return;
        }

        if (results.length === 0) {
          resolve([]);
          return;
        }

        const fetch = this.imap.fetch(results, {
          bodies: '',
          struct: true,
          markSeen: false
        });

        const emails = [];
        let processed = 0;

        fetch.on('message', (msg, seqno) => {
          const emailData = {
            seqno,
            uid: null,
            headers: null,
            from: null,
            to: null,
            subject: null,
            date: null,
            text: '',
            html: '',
            attachments: []
          };

          msg.on('body', async (stream, info) => {
            try {
              const parsed = await simpleParser(stream);
              emailData.uid = info.uid;
              emailData.from = parsed.from?.text || '';
              emailData.to = parsed.to?.text || '';
              emailData.subject = parsed.subject || '(No Subject)';
              emailData.date = parsed.date || new Date();
              emailData.text = parsed.text || '';
              emailData.html = parsed.html || '';
              emailData.attachments = parsed.attachments?.map(att => ({
                filename: att.filename,
                contentType: att.contentType,
                size: att.size
              })) || [];
            } catch (parseErr) {
              console.error(`[${this.email}] Parse error:`, parseErr.message);
            }
          });

          msg.once('attributes', (attrs) => {
            emailData.uid = attrs.uid;
            emailData.flags = attrs.flags;
          });

          msg.once('end', () => {
            emails.push(emailData);
            processed++;
          });
        });

        fetch.once('error', (err) => {
          reject(err);
        });

        fetch.once('end', () => {
          // Update lastUid
          if (emails.length > 0) {
            const maxUid = Math.max(...emails.map(e => e.uid));
            if (maxUid > this.lastUid) {
              this.lastUid = maxUid;
            }
          }
          resolve(emails);
        });
      });
    });
  }

  // Mark email as read
  markAsSeen(uid) {
    return new Promise((resolve, reject) => {
      this.imap.addFlags(uid, '\\Seen', (err) => {
        if (err) {
          reject(err);
        } else {
          resolve();
        }
      });
    });
  }

  // Start monitoring for new emails
  async startMonitoring() {
    if (this.isMonitoring) return;
    
    this.isMonitoring = true;
    console.log(`[${this.email}] Starting email monitoring...`);
    
    try {
      await this.openInbox();
      await this.fetchInitialEmails();
      this.startPolling();
    } catch (err) {
      console.error(`[${this.email}] Failed to start monitoring:`, err.message);
      this.emit('error', err);
    }
  }

  // Fetch initial emails to set the baseline
  async fetchInitialEmails() {
    try {
      const box = await this.openInbox();
      if (box.messages.total > 0) {
        // Get the latest 10 emails as initial state
        const fetch = this.imap.fetch(`${box.messages.total - 9}:${box.messages.total}`, {
          bodies: '',
          struct: true
        });

        let processed = 0;
        let maxUid = 0;

        fetch.on('message', (msg) => {
          msg.once('attributes', (attrs) => {
            if (attrs.uid > maxUid) {
              maxUid = attrs.uid;
            }
            processed++;
          });
        });

        fetch.once('end', () => {
          this.lastUid = maxUid;
          console.log(`[${this.email}] Initial UID set to: ${this.lastUid}`);
        });
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
          console.log(`[${this.email}] Reconnecting...`);
          await this.connect();
          await this.openInbox();
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

  // Reconnect to IMAP server
  async reconnect() {
    try {
      if (this.imap) {
        this.imap.end();
      }
      this.isConnected = false;
      await this.connect();
      await this.openInbox();
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
    if (this.imap) {
      this.imap.end();
    }
    console.log(`[${this.email}] Stopped monitoring`);
  }

  // Get account info
  getAccountInfo() {
    return {
      email: this.email,
      isConnected: this.isConnected,
      isMonitoring: this.isMonitoring,
      lastUid: this.lastUid
    };
  }
}

module.exports = EmailConnector;
