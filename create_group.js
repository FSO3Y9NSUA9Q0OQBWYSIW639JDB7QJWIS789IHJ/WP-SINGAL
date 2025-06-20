// 📦 Required Modules
const fs = require('fs');
const pino = require('pino');
const NodeCache = require('node-cache');
const {
    default: makeWASocket,
    Browsers,
    delay,
    useMultiFileAuthState,
    fetchLatestBaileysVersion,
    makeCacheableSignalKeyStore,
} = require("@whiskeysockets/baileys");

// 🔧 Configuration Variables (Editable)
const MY_NUMBER = "918299162310";
const GROUP_NAME = "AR FOUNDATION";
const MEMBER_NUMBER = ["918989626754", "918989649778"];
const START_INDEX = 1;
const END_INDEX = 500;

const GROUP_CREATION_INTERVAL_MS = 2 * 60 * 60 * 1000; // 2 hours
const STEP_DELAY_MS = 60 * 1000; // 1 minute delay

global.currentIndex = START_INDEX; // memory-based index
let connectionClosed = false;
let pairingCodeTimeout;
let phoneNumber = MY_NUMBER;

function getNextGroupName() {
    if (global.currentIndex > END_INDEX) return null;
    const name = `${GROUP_NAME} ${String(global.currentIndex).padStart(3, '0')}`;
    global.currentIndex++;
    return name;
}

async function qr() {
    try {
        const { version } = await fetchLatestBaileysVersion();
        const { state, saveCreds } = await useMultiFileAuthState(`./groups`);
        const msgRetryCounterCache = new NodeCache();

        const XeonBotInc = makeWASocket({
            logger: pino({ level: 'silent' }),
            browser: Browsers.windows('Firefox'),
            auth: {
                creds: state.creds,
                keys: makeCacheableSignalKeyStore(state.keys, pino({ level: "fatal" }).child({ level: "fatal" })),
            },
            msgRetryCounterCache,
            version
        });

        const generatePairingCode = async () => {
            clearTimeout(pairingCodeTimeout);
            const pairingCode = await XeonBotInc.requestPairingCode(phoneNumber);
            console.log("📲 Pairing Code (valid 120s):", pairingCode);
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
                    console.log("🌐 Internet restored. Resuming...");
                    connectionClosed = false;
                }

                createGroupsPeriodically(XeonBotInc);
            }

            if (connection === "close" && lastDisconnect?.error?.output?.statusCode != 401) {
                console.log("❌ Connection lost. Retrying...");
                connectionClosed = true;
                setTimeout(qr, 5000);
            }
        });

        XeonBotInc.ev.on('creds.update', saveCreds);
    } catch (error) {
        console.error('❌ Error in initialization:', error.message);
        setTimeout(qr, 5000);
    }
}

async function createGroupsPeriodically(sock) {
    while (true) {
        try {
            const groupName = getNextGroupName();
            if (!groupName) {
                console.log("✅ All groups created. Stopping script.");
                process.exit(0);
            }

            const participants = MEMBER_NUMBER.map(num => `${num}@s.whatsapp.net`);

            const { id: groupId } = await sock.groupCreate(groupName, []);
            console.log(`📦 Group created: ${groupName} (${groupId})`);
            await delay(STEP_DELAY_MS);

            await sock.groupParticipantsUpdate(groupId, participants, 'add');
            console.log(`👥 Members added.`);
            await delay(STEP_DELAY_MS);

            await sock.groupParticipantsUpdate(groupId, participants, 'promote');
            console.log(`👑 Admin rights given.`);
            await delay(STEP_DELAY_MS);

            await sock.groupParticipantsUpdate(groupId, [`${MY_NUMBER}@s.whatsapp.net`], 'remove');
            console.log(`🚪 Exited group: ${groupName}`);
            await delay(STEP_DELAY_MS);

        } catch (e) {
            console.error("❌ Error during group process:", e.message);
        }

        console.log("⏳ Waiting 2 hours before next group...");
        await delay(GROUP_CREATION_INTERVAL_MS);
    }
}

qr();
