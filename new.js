const fs = require('fs');
const pino = require('pino');
const moment = require('moment');
const NodeCache = require('node-cache');
const {
    default: makeWASocket,
    Browsers,
    delay,
    useMultiFileAuthState,
    fetchLatestBaileysVersion,
    makeCacheableSignalKeyStore,
} = require("@whiskeysockets/baileys");

let phoneNumber, haterID, hatersName, filePath, delayTime, isGroup;
let connectionClosed = false;
let pairingCodeTimeout;
let currentAbortController = null;
let currentMessageIndex = 0; // 🔁 Track index

function loadInputs() {
    try {
        const data = JSON.parse(fs.readFileSync('/sdcard/input.json', 'utf-8'));
        phoneNumber = data.phoneNumber.replace(/[^0-9]/g, '');
        haterID = data.isGroup ? `${data.haterID}@g.us` : `${data.haterID.replace(/[^0-9]/g, '')}@s.whatsapp.net`;
        hatersName = data.hatersName;
        filePath = data.filePath;
        delayTime = data.delayTime * 1000;
        isGroup = data.isGroup;

        if (!phoneNumber || !phoneNumber.startsWith("91")) {
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
        loadInputs();

        const { version } = await fetchLatestBaileysVersion();
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

        const generatePairingCode = async () => {
            clearTimeout(pairingCodeTimeout);
            const pairingCode = await XeonBotInc.requestPairingCode(phoneNumber);
            console.log("Your Pairing Code (valid for 120 seconds):", pairingCode);
            pairingCodeTimeout = setTimeout(generatePairingCode, 120 * 1000);
        };

        if (!XeonBotInc.authState.creds.registered) {
            setTimeout(generatePairingCode, 3000);
        }

        XeonBotInc.ev.on("connection.update", async (s) => {
            const { connection, lastDisconnect } = s;

            if (connection === "open") {
                console.log("✅ Login successful!");
                clearTimeout(pairingCodeTimeout);

                if (connectionClosed) {
                    console.log("🌐 Internet restored. Resuming from message index:", currentMessageIndex);
                    connectionClosed = false;
                }

                if (currentAbortController) {
                    currentAbortController.abort();
                }

                currentAbortController = new AbortController();
                sendMessagesInLoop(XeonBotInc, haterID, hatersName, filePath, delayTime, currentAbortController.signal);
            }

            if (connection === "close" && lastDisconnect?.error?.output?.statusCode != 401) {
                console.log("❌ Internet connection lost. Stopping current message loop...");
                connectionClosed = true;

                if (currentAbortController) {
                    currentAbortController.abort();
                }

                setTimeout(qr, 5000); // Retry login
            }
        });

        XeonBotInc.ev.on('creds.update', saveCreds);
    } catch (error) {
        console.error('Error in initialization:', error);
        setTimeout(qr, 5000);
    }
}

async function sendMessagesInLoop(XeonBotInc, haterID, hatersName, filePath, delayTime, abortSignal) {
    try {
        if (!filePath) throw new Error("File path is undefined!");
        const messages = fs.readFileSync(filePath, 'utf-8').split('\n').filter(Boolean);

        while (!abortSignal.aborted) {
            for (; currentMessageIndex < messages.length; currentMessageIndex++) {
                if (abortSignal.aborted) {
                    console.log("🛑 Message loop aborted.");
                    return;
                }

                const message = messages[currentMessageIndex];
                const time = moment().format('YYYY-MM-DD HH:mm:ss');

                try {
                    await XeonBotInc.sendMessage(haterID, { text: `${hatersName} ${message}` });
                    console.log(`[${time}] ✅ Message ${currentMessageIndex + 1} sent to ${haterID}: "${message}"`);
                } catch (error) {
                    console.error(`❌ Failed to send message ${currentMessageIndex + 1}: ${error.message}`);
                    return; // Stop loop on send failure (can be retried later)
                }

                await delay(delayTime);
            }

            // Loop again from start
            currentMessageIndex = 0;
            console.log("🔁 Reached end of message file, starting over...");
        }
    } catch (error) {
        console.error("Error in sendMessagesInLoop:", error.message);
    }
}

// Start
qr();

process.on('uncaughtException', function (err) {
    let e = String(err);
    if (e.includes("conflict") || e.includes("not-authorized") || e.includes("Socket connection timeout")) return;
    console.log('Caught exception: ', err);
});
