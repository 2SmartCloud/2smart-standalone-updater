const path           = require('path');
const fse            = require('fs-extra');
const config         = require('../etc/config');
const { fileExists } = require('./utils/fs');
const { STATUSES }   = require('./constants/updater');

class stateManager {
    constructor() {
        this.stateFilePath = path.join(config.systemDir, config.dataDir, 'state.json');
    }

    async init() {
        const isStateExists = await fileExists(this.stateFilePath);

        if (isStateExists) return;

        const state = JSON.stringify({
            status            : STATUSES.FREE,
            version           : 'Latest',
            available_version : '',
            updated_at        : Date.now()
        }, null, 4);

        return fse.writeFile(this.stateFilePath, state);
    }

    async getState() {
        const statusFileRaw = await fse.readFile(this.stateFilePath);
        const statusObj = JSON.parse(statusFileRaw);

        return statusObj;
    }

    async setState(fields) {
        const prevStatus = await this.getState();
        const newStatus = JSON.stringify({
            ...prevStatus,
            ...fields
        }, null, 4);

        return fse.writeFile(this.stateFilePath, newStatus);
    }
}

module.exports = new stateManager();

