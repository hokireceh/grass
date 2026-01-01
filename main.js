require('dotenv').config();
const cloudscraper = require('cloudscraper');
const cron = require('node-cron');
const fs = require('fs');
const path = require('path');

class GrassAutomation {
    constructor() {
        this.config = {
            authToken: process.env.GRASS_AUTH_TOKEN,
            deviceId: process.env.GRASS_DEVICE_ID,
            userId: process.env.GRASS_USER_ID,
            username: process.env.GRASS_USERNAME,
            email: process.env.GRASS_EMAIL,
            walletAddress: process.env.GRASS_WALLET_ADDRESS,
            extensionId: process.env.GRASS_EXTENSION_ID,
            ipAddress: process.env.DEFAULT_IP,
            backupIp: process.env.BACKUP_IP,
            userAgent: process.env.USER_AGENT
        };

        this.baseURL = 'https://api.grass.io';
        this.directorURL = 'https://director.getgrass.io';
        
        this.headers = {
            'authorization': this.config.authToken,
            'user-agent': this.config.userAgent,
            'accept': 'application/json, text/plain, */*',
            'accept-language': 'id-ID,id;q=0.9,en-US;q=0.8,en;q=0.7',
            'dnt': '1',
            'origin': `chrome-extension://${this.config.extensionId}`,
            'sec-fetch-site': 'none',
            'sec-fetch-mode': 'cors',
            'sec-fetch-dest': 'empty',
            'referer': `chrome-extension://${this.config.extensionId}/`,
            'accept-encoding': 'gzip, deflate, br, zstd'
        };

        this.rateLimiter = {
            lastRequest: 0,
            minInterval: 30000, // 30 detik
            requestsPerMinute: 3,
            requestCount: 0,
            minuteStart: Date.now()
        };

        this.logFile = path.join(__dirname, 'grass.log');
        this.statsFile = path.join(__dirname, 'stats.json');
        
        this.initialize();
    }

    initialize() {
        this.log('info', 'Grass Automation Initialized');
        this.loadStats();
    }

    // Logging dengan level
    log(level, message, data = null) {
        const timestamp = new Date().toISOString();
        const logLevel = process.env.LOG_LEVEL || 'info';
        const levels = { error: 0, warn: 1, info: 2, debug: 3 };
        
        if (levels[level] <= levels[logLevel]) {
            const logMessage = `[${timestamp}] [${level.toUpperCase()}] ${message}`;
            console.log(logMessage);
            if (data) console.log('Data:', data);
            
            if (process.env.LOG_TO_FILE === 'true') {
                fs.appendFileSync(this.logFile, logMessage + '\n');
            }
        }
    }

    // Load/Save stats
    loadStats() {
        try {
            if (fs.existsSync(this.statsFile)) {
                this.stats = JSON.parse(fs.readFileSync(this.statsFile, 'utf8'));
            } else {
                this.stats = {
                    totalCheckins: 0,
                    successfulCheckins: 0,
                    failedCheckins: 0,
                    lastCheckin: null,
                    totalPoints: 0,
                    uptimeHours: 0,
                    ipRotations: 0
                };
            }
        } catch (error) {
            this.log('error', 'Failed to load stats', error);
            this.stats = {
                totalCheckins: 0,
                successfulCheckins: 0,
                failedCheckins: 0,
                lastCheckin: null,
                totalPoints: 0,
                uptimeHours: 0,
                ipRotations: 0
            };
        }
    }

    saveStats() {
        try {
            fs.writeFileSync(this.statsFile, JSON.stringify(this.stats, null, 2));
        } catch (error) {
            this.log('error', 'Failed to save stats', error);
        }
    }

    // Rate limiting handler
    async waitForRateLimit() {
        const now = Date.now();
        
        // Reset counter setiap menit
        if (now - this.rateLimiter.minuteStart > 60000) {
            this.rateLimiter.requestCount = 0;
            this.rateLimiter.minuteStart = now;
        }
        
        // Cek rate limit per menit
        if (this.rateLimiter.requestCount >= this.rateLimiter.requestsPerMinute) {
            const waitTime = 60000 - (now - this.rateLimiter.minuteStart);
            this.log('warn', `Rate limit reached, waiting ${waitTime}ms`);
            await this.sleep(waitTime);
            this.rateLimiter.requestCount = 0;
            this.rateLimiter.minuteStart = Date.now();
        }
        
        // Cek interval minimal antara request
        const timeSinceLast = now - this.rateLimiter.lastRequest;
        if (timeSinceLast < this.rateLimiter.minInterval) {
            const waitTime = this.rateLimiter.minInterval - timeSinceLast;
            await this.sleep(waitTime);
        }
        
        this.rateLimiter.lastRequest = Date.now();
        this.rateLimiter.requestCount++;
    }

    // Cloudscraper request wrapper
    async makeRequest(method, url, options = {}) {
        await this.waitForRateLimit();
        
        const defaultOptions = {
            method: method,
            url: url,
            headers: { ...this.headers, ...options.headers },
            json: options.json || true,
            formData: options.formData,
            body: options.body,
            timeout: parseInt(process.env.CLOUDFLARE_TIMEOUT) || 30000,
            challengesToSolve: 3,
            followAllRedirects: true,
            gzip: true
        };

        try {
            this.log('debug', `Making ${method} request to ${url}`);
            const response = await cloudscraper(defaultOptions);
            return response;
        } catch (error) {
            this.log('error', `Request failed: ${url}`, error.message);
            throw error;
        }
    }

    // API Calls menggunakan Cloudscraper
    async getUserProfile() {
        try {
            const response = await this.makeRequest('GET', `${this.baseURL}/retrieveUser`);
            this.log('info', 'User profile retrieved');
            return response.result?.data;
        } catch (error) {
            this.log('error', 'Failed to get user profile', error);
            return null;
        }
    }

    async getDeviceStatus() {
        try {
            const input = encodeURIComponent(JSON.stringify({
                deviceId: this.config.deviceId,
                ipAddress: this.config.ipAddress
            }));
            
            const response = await this.makeRequest(
                'GET',
                `${this.baseURL}/retrieveDevice?input=${input}`
            );
            
            this.log('info', 'Device status retrieved');
            return response.result?.data;
        } catch (error) {
            this.log('error', 'Failed to get device status', error);
            return null;
        }
    }

    async getActiveIps() {
        try {
            const response = await this.makeRequest('GET', `${this.baseURL}/activeIps`);
            this.log('info', 'Active IPs retrieved');
            
            // Update IP list dari response
            if (response.result?.data) {
                this.availableIps = response.result.data.map(ip => ip.ipAddress);
                this.log('debug', `Available IPs: ${this.availableIps.join(', ')}`);
            }
            
            return response.result?.data;
        } catch (error) {
            this.log('error', 'Failed to get active IPs', error);
            return null;
        }
    }

    async rotateIp() {
        try {
            const activeIps = await this.getActiveIps();
            if (activeIps && activeIps.length > 1) {
                // Pilih IP yang bukan IP saat ini
                const newIp = activeIps.find(ip => ip.ipAddress !== this.config.ipAddress)?.ipAddress;
                if (newIp) {
                    this.config.ipAddress = newIp;
                    this.stats.ipRotations++;
                    this.log('info', `IP rotated to: ${newIp}`);
                    return true;
                }
            }
            return false;
        } catch (error) {
            this.log('error', 'Failed to rotate IP', error);
            return false;
        }
    }

    async checkIn() {
        try {
            this.stats.totalCheckins++;
            
            // Generate checkin token (simplified - perlu implementasi JWT generation)
            const checkinToken = await this.generateCheckinToken();
            
            const payload = {
                destinations: ["45.38.56.70"], // Default destination
                token: checkinToken
            };

            const response = await this.makeRequest('POST', `${this.directorURL}/checkin`, {
                headers: {
                    ...this.headers,
                    'content-type': 'application/json'
                },
                body: JSON.stringify(payload)
            });

            this.stats.successfulCheckins++;
            this.stats.lastCheckin = new Date().toISOString();
            this.log('info', 'Check-in successful');
            
            // Update stats dari response jika ada
            if (response && response.points) {
                this.stats.totalPoints += response.points;
            }
            
            this.saveStats();
            return response;
        } catch (error) {
            this.stats.failedCheckins++;
            this.saveStats();
            
            // Coba rotate IP jika check-in gagal
            if (error.response?.status === 429 || error.message.includes('rate limit')) {
                this.log('warn', 'Rate limited, rotating IP...');
                await this.rotateIp();
            }
            
            this.log('error', 'Check-in failed', error);
            return null;
        }
    }

    async generateCheckinToken() {
        // Implementasi JWT generation
        // Ini adalah placeholder - Anda perlu implementasi JWT signing yang benar
        const payload = {
            browserId: this.config.deviceId,
            userId: this.config.userId,
            version: "6.1.3",
            extensionId: this.config.extensionId,
            userAgent: this.config.userAgent,
            deviceType: "extension",
            iss: "director-server",
            sub: "jeYkUsu31nAW",
            aud: [this.config.ipAddress],
            exp: Math.floor(Date.now() / 1000) + 300, // 5 menit
            nbf: Math.floor(Date.now() / 1000),
            iat: Math.floor(Date.now() / 1000),
            jti: `checkin_${Date.now()}`
        };
        
        // Return token dummy (dalam real implementation, sign dengan private key)
        return `eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.${btoa(JSON.stringify(payload))}.signature`;
    }

    async monitorAndMaintain() {
        try {
            this.log('info', 'Starting monitoring cycle');
            
            // 1. Check device status
            const deviceStatus = await this.getDeviceStatus();
            
            if (deviceStatus) {
                if (!deviceStatus.isConnected) {
                    this.log('warn', 'Device disconnected, attempting recovery...');
                    // Implementasi reconnection logic
                }
                
                // Update stats
                if (deviceStatus.totalUptime) {
                    this.stats.uptimeHours = Math.floor(deviceStatus.totalUptime / 3600000);
                }
            }
            
            // 2. Check active IPs dan rotate jika perlu
            await this.getActiveIps();
            
            // 3. Rotate IP setiap 12 jam untuk menghindari flagging
            const hoursSinceLastRotation = this.stats.ipRotations > 0 ? 
                (Date.now() - new Date(this.stats.lastCheckin).getTime()) / 3600000 : 24;
            
            if (hoursSinceLastRotation >= 12) {
                await this.rotateIp();
            }
            
            // 4. Perform check-in
            await this.checkIn();
            
            // 5. Update user profile untuk melihat points
            const userProfile = await this.getUserProfile();
            if (userProfile?.totalPoints) {
                this.stats.totalPoints = userProfile.totalPoints;
            }
            
            this.saveStats();
            this.log('info', 'Monitoring cycle completed');
            
        } catch (error) {
            this.log('error', 'Monitoring cycle failed', error);
        }
    }

    sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    async start() {
        this.log('info', 'Grass Automation Started');
        
        // Schedule monitoring setiap X menit
        const intervalMinutes = parseInt(process.env.CHECK_INTERVAL_MINUTES) || 5;
        
        cron.schedule(`*/${intervalMinutes} * * * *`, async () => {
            await this.monitorAndMaintain();
        });
        
        // Juga jalankan segera
        await this.monitorAndMaintain();
        
        // Keep alive
        setInterval(() => {
            this.log('debug', 'Service alive');
        }, 60000); // Log setiap menit
    }
}

// **4. File `index.js`** (entry point)
```javascript
const GrassAutomation = require('./grass');

async function main() {
    try {
        const grass = new GrassAutomation();
        await grass.start();
        
        // Handle graceful shutdown
        process.on('SIGINT', async () => {
            console.log('\nGracefully shutting down...');
            grass.log('info', 'Shutdown initiated');
            process.exit(0);
        });
        
        process.on('unhandledRejection', (error) => {
            grass.log('error', 'Unhandled rejection', error);
        });
        
    } catch (error) {
        console.error('Failed to start Grass automation:', error);
        process.exit(1);
    }
}

// Start dengan retry
async function startWithRetry(maxRetries = 3, delay = 5000) {
    for (let i = 0; i < maxRetries; i++) {
        try {
            await main();
            break;
        } catch (error) {
            console.error(`Start attempt ${i + 1} failed:`, error.message);
            if (i < maxRetries - 1) {
                console.log(`Retrying in ${delay/1000} seconds...`);
                await new Promise(resolve => setTimeout(resolve, delay));
            } else {
                console.error('Max retries reached. Exiting.');
                process.exit(1);
            }
        }
    }
}

startWithRetry();
