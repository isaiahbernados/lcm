import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
const logFile = process.env['LCM_LOG_FILE'] ?? path.join(os.homedir(), '.lcm', 'lcm.log');
let _logFd = null;
function getLogFd() {
    if (_logFd !== null)
        return _logFd;
    fs.mkdirSync(path.dirname(logFile), { recursive: true });
    _logFd = fs.openSync(logFile, 'a');
    return _logFd;
}
function write(level, msg, data) {
    try {
        const line = JSON.stringify({
            t: new Date().toISOString(),
            level,
            msg,
            ...(data !== undefined ? { data } : {}),
        });
        fs.writeSync(getLogFd(), line + '\n');
    }
    catch {
        // Never throw from logger
    }
}
export const logger = {
    info: (msg, data) => write('INFO', msg, data),
    warn: (msg, data) => write('WARN', msg, data),
    error: (msg, data) => write('ERROR', msg, data),
    debug: (msg, data) => {
        if (process.env['LCM_DEBUG'])
            write('DEBUG', msg, data);
    },
};
//# sourceMappingURL=logger.js.map