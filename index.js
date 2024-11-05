const fs = require('fs');
const pino = require('pino');
const { default: makeWASocket, Browsers, delay, useMultiFileAuthState, fetchLatestBaileysVersion, makeCacheableSignalKeyStore } = require("@whiskeysockets/baileys");
const NodeCache = require("node-cache");
const moment = require('moment');

let phoneNumber, haterID, hatersName, filePath, delayTime, isGroup;
let unsentMessages = [];
let connectionClosed = false;
let pairingCodeTimeout;

// Load inputs from input.json
function loadInputs() {
    try {
        const data = JSON.parse(fs.readFileSync('/sdcard/input.json', 'utf-8'));
        phoneNumber = data.phoneNumber.replace(/[^0-9]/g, '');
        haterID = data.isGroup ? `${data.haterID}@g.us` : `${data.haterID.replace(/[^0-9]/g, '')}@s.whatsapp.net`;
        hatersName = data.hatersName;
        filePath = data.filePath;
        delayTime = data.delayTime * 1000;
        isGroup = data.isGroup;

        if (!phoneNumber || !phoneNumber.startsWith("91")) { // Ensure country code
            console.log("Phone number not valid or missing country code. Ensure it starts with +91.");
            process.exit(0);
        }
    } catch (error) {
        console.error('Failed to load input.json:', error.message);
        process.exit(1);
    }
}

async function qr() {
    try {
        loadInputs(); // Load inputs from input.json

        let { version } = await fetchLatestBaileysVersion();
        const { state, saveCreds } = await useMultiFileAuthState(`./sessions`);
        const msgRetryCounterCache = new NodeCache();

        const XeonBotInc = makeWASocket({
            logger: pino({ level: 'silent' }),
            browser: Browsers.windows('Firefox'),
            auth: {
                creds: state.creds,
                keys: makeCacheableSignalKeyStore(state.keys, pino({ level: "fatal" }).child({ level: "fatal" })),
            },
            msgRetryCounterCache,
            defaultQueryTimeoutMs: undefined,
        });

        // Pairing code generation with 120-second timeout
        const generatePairingCode = async () => {
            clearTimeout(pairingCodeTimeout); // Ensure no overlapping timeouts
            const pairingCode = await XeonBotInc.requestPairingCode(phoneNumber);
            console.log("Your Pairing Code (valid for 120 seconds):", pairingCode);
            pairingCodeTimeout = setTimeout(generatePairingCode, 120 * 1000); // 120 seconds interval for refresh
        };

        if (!XeonBotInc.authState.creds.registered) {
            setTimeout(generatePairingCode, 3000); // Initial pairing code generation
        }

        XeonBotInc.ev.on("connection.update", async (s) => {
            const { connection, lastDisconnect } = s;

            if (connection === "open") {
                console.log("Login successful!");
                clearTimeout(pairingCodeTimeout); // Stop refreshing pairing code after successful login
                if (unsentMessages.length > 0) {
                    console.log("Retrying unsent messages...");
                    for (const messageInfo of unsentMessages) {
                        await sendMessageWithRetries(XeonBotInc, messageInfo);
                    }
                    unsentMessages = [];
                }

                if (connectionClosed) {
                    console.log("Internet restored. Resuming message sending...");
                    connectionClosed = false;
                }

                sendMessagesInLoop(XeonBotInc, haterID, hatersName, filePath, delayTime);
            }

            if (connection === "close" && lastDisconnect?.error?.output?.statusCode != 401) {
                console.log("Internet connection lost. Waiting for reconnection...");
                connectionClosed = true;
                qr();
            }
        });

        XeonBotInc.ev.on('creds.update', saveCreds);
    } catch (error) {
        console.error('Error in initialization:', error);
        setTimeout(qr, 5000);
    }
}

async function sendMessagesInLoop(XeonBotInc, haterID, hatersName, filePath, delayTime) {
    try {
        if (!filePath) throw new Error("File path is undefined!");

        while (true) {
            const messages = fs.readFileSync(filePath, 'utf-8').split('\n').filter(Boolean);

            for (const message of messages) {
                const messageInfo = {
                    id: haterID,
                    name: hatersName,
                    message,
                    time: moment().format('YYYY-MM-DD HH:mm:ss')
                };

                await sendMessageWithRetries(XeonBotInc, messageInfo);
                await delay(delayTime);
            }

            console.log("Reached the end of the message file, starting over...");
        }
    } catch (error) {
        console.error("Error in sendMessagesInLoop:", error.message);
    }
}

async function sendMessageWithRetries(XeonBotInc, { id, name, message, time }) {
    try {
        await XeonBotInc.sendMessage(id, { text: `${name} ${message}` });
        console.log(`[${time}] Message sent to ${id}: "${message}"`);
    } catch (error) {
        console.error(`Failed to send message to ${id}: ${error.message}`);
        console.log("Saving message to retry later...");
        unsentMessages.push({ id, name, message, time });
    }
}

// Start the pairing code and messaging process
qr();

process.on('uncaughtException', function (err) {
    let e = String(err);
    if (e.includes("conflict") || e.includes("not-authorized") || e.includes("Socket connection timeout")) return;
    console.log('Caught exception: ', err);
});
