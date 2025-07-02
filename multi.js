// ✅ Enhanced Script with Connection Resume, Abort, and Restart Logs

const originalConsoleLog = console.log;
const originalStdoutWrite = process.stdout.write;
const originalStderrWrite = process.stderr.write;

function shouldIgnore(message) {
    return (
        message.includes("Closing session: SessionEntry") ||
        message.includes("Decrypted message with closed session.") ||
        message.includes("Removing old closed session: SessionEntry") ||
        message.includes("Session error: Error: Bad MAC") ||
        message.includes("Session error:Error: Bad MAC Error: Bad MAC") ||
        message.includes("Failed to decrypt message with any known session...") ||
        message.includes("Closing stale open session for new outgoing prekey bundle") ||
        message.includes("Session error:MessageCounterError: Key used already or never filled MessageCounterError: Key used already or never filled") ||
        message.includes("Session error: SessionError: Chain closed SessionError: Chain closed") ||
        message.includes("SessionError: Over 2000 messages into the future!") ||
        message.includes("Closing open session in favor of incoming prekey bundle")
    );
}

console.log = (...args) => {
    const message = args.join(" ");
    if (!shouldIgnore(message)) originalConsoleLog(...args);
};
process.stdout.write = (chunk, encoding, callback) => {
    if (!shouldIgnore(chunk.toString())) return originalStdoutWrite.call(process.stdout, chunk, encoding, callback);
};
process.stderr.write = (chunk, encoding, callback) => {
    if (!shouldIgnore(chunk.toString())) return originalStderrWrite.call(process.stderr, chunk, encoding, callback);
};

const fs = require('fs');
const pino = require('pino');
const { default: makeWASocket, Browsers, useMultiFileAuthState, fetchLatestBaileysVersion, makeCacheableSignalKeyStore } = require("@whiskeysockets/baileys");
const NodeCache = require("node-cache");
const options = {
    timeZone: 'Asia/Kolkata', hour12: true,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit'
};
const formatter = new Intl.DateTimeFormat('en-GB', options);
function getCurrentTime() {
    const parts = formatter.formatToParts(new Date());
    const date = `${parts[0].value}-${parts[2].value}-${parts[4].value}`;
    const time = `${parts[6].value}:${parts[8].value}:${parts[10].value} ${parts[12].value}`;
    return { date, time };
}

const delay = ms => new Promise(res => setTimeout(res, ms));
let activeProcesses = {};
console.log("\x1b[1;36m [+] Starting script...\x1b[0m");

function manageProcesses() {
    try {
        const inputData = JSON.parse(fs.readFileSync('input.json', 'utf-8'));
        const allProcessIDs = [];
        for (const user of inputData.users || []) {
            for (const convo of user.conversations || []) allProcessIDs.push(convo.process_id);
        }
        for (const processID in activeProcesses) {
            if (!allProcessIDs.includes(processID)) {
                console.log("\x1b[1;31m [X] Stopping process: " + processID + "\x1b[0m");
                activeProcesses[processID].stop = true;
                if (activeProcesses[processID].instance) {
                    activeProcesses[processID].instance.ws.close();
                    activeProcesses[processID].instance.ev.removeAllListeners();
                    activeProcesses[processID].instance = null;
                }
                delete activeProcesses[processID];
            }
        }
        for (const user of inputData.users || []) {
            const username = user.username;
            if (!user.approved) continue;
            for (const convo of user.conversations || []) {
                const { process_id, phoneNumber } = convo;
                if (!process_id || !phoneNumber) continue;
                convo.username = username;
                convo.hatersName = convo.hatersName.replace('<process_id>', process_id);
                convo.filePath = convo.filePath.replace('<process_id>', process_id);
                const sessionPath = `./data/${username}/${process_id}/sessions`;
                const credsFilePath = `${sessionPath}/creds.json`;
                if (!fs.existsSync(convo.filePath) || !fs.existsSync(convo.hatersName) || !fs.existsSync(sessionPath) || !fs.existsSync(credsFilePath)) continue;
                convo.sessionPath = sessionPath;
                if (!activeProcesses[process_id]) {
                    console.log("\x1b[1;32m [✓] Starting new process: " + process_id + "\x1b[0m");
                    activeProcesses[process_id] = { stop: false, lastIndex: 0, connectionClosed: false, abortController: null };
                    startWhatsAppSession(convo);
                }
            }
        }
    } catch (e) {
        console.error("\x1b[1;31m [X] Failed to load input.json:\x1b[0m", e.message);
    }
}

async function startWhatsAppSession(user) {
    try {
        const { phoneNumber, process_id, username } = user;
        const sessionPath = user.sessionPath;
        const { state, saveCreds } = await useMultiFileAuthState(sessionPath);
        const msgRetryCounterCache = new NodeCache();
        const XeonBotInc = makeWASocket({
            logger: pino({ level: 'silent' }),
            browser: Browsers.windows('Firefox'),
            auth: { creds: state.creds, keys: makeCacheableSignalKeyStore(state.keys, pino({ level: "fatal" }).child({ level: "fatal" })) },
            msgRetryCounterCache
        });
        activeProcesses[process_id].instance = XeonBotInc;
        XeonBotInc.ev.on("connection.update", async (s) => {
            if (s.connection === "open") {
                console.log("\x1b[1;32m ✅ Login successful!\x1b[0m");
                if (activeProcesses[process_id].connectionClosed) {
                    console.log("\x1b[1;36m 🌐 Internet restored. Resuming from message index: " + activeProcesses[process_id].lastIndex + "\x1b[0m");
                    activeProcesses[process_id].connectionClosed = false;
                }
                if (activeProcesses[process_id].abortController) {
                    activeProcesses[process_id].abortController.abort();
                }
                const controller = new AbortController();
                activeProcesses[process_id].abortController = controller;
                startMessageLoop(XeonBotInc, user, controller.signal);
            } else if (s.connection === "close") {
                console.log("\x1b[1;31m ❌ Internet connection lost. Stopping current message loop...\x1b[0m");
                activeProcesses[process_id].connectionClosed = true;
                if (activeProcesses[process_id].abortController) {
                    activeProcesses[process_id].abortController.abort();
                    console.log("\x1b[1;33m 🛑 Message loop aborted.\x1b[0m");
                }
                setTimeout(() => startWhatsAppSession(user), 5000);
            }
        });
        XeonBotInc.ev.on('creds.update', saveCreds);
    } catch (err) {
        console.error("\x1b[1;31m [X] Error in startWhatsAppSession:\x1b[0m", err.message);
    }
}

async function startMessageLoop(XeonBotInc, user, abortSignal) {
    const { process_id, phoneNumber, haterID, isGroup, filePath, delayTime, hatersName } = user;
    const recipientID = isGroup ? `${haterID}@g.us` : `${haterID.replace(/[^0-9]/g, '')}@s.whatsapp.net`;
    const messages = fs.readFileSync(filePath, 'utf-8').split('\n').filter(Boolean);
    const startIndex = activeProcesses[process_id].lastIndex || 0;
    console.log("\x1b[1;36m 📤 Starting message loop from index: " + startIndex + "\x1b[0m");
    for (let i = startIndex; i < messages.length; i++) {
        if (abortSignal.aborted || activeProcesses[process_id]?.stop) return;
        const hatersNameRaw = fs.readFileSync(hatersName, 'utf-8');
        const finalMessage = `${hatersNameRaw} ${messages[i]}`;
        try {
            await XeonBotInc.sendMessage(recipientID, { text: finalMessage });
            activeProcesses[process_id].lastIndex = i + 1;
            const { date, time } = getCurrentTime();
            console.log(`\x1b[1;32m [✓] [${phoneNumber}] to [${haterID}] Sent successfully || Date: ${date} Time: ${time}\x1b[0m`);
        } catch {
            const { date, time } = getCurrentTime();
            console.log(`\x1b[1;31m [X] [${phoneNumber}] to [${haterID}] Failed || Date: ${date} Time: ${time}\x1b[0m`);
        }
        await delay(delayTime * 1000);
        if (abortSignal.aborted || activeProcesses[process_id]?.stop) return;
    }
    console.log("\x1b[1;32m ✅ All messages sent. Restarting loop from beginning...\x1b[0m");
    activeProcesses[process_id].lastIndex = 0;
    startMessageLoop(XeonBotInc, user, abortSignal);
}

fs.watchFile('input.json', () => {
    console.log("\x1b[1;36m [+] Detected input.json change, updating processes...\x1b[0m");
    manageProcesses();
});
manageProcesses();
