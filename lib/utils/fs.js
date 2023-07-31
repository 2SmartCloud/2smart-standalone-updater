const fs = require('fs');
const { promises } = require('fs');
const fse = require('fs-extra');

async function fileExists(filePath) {
    try {
        const stat = await promises.stat(filePath);

        if (!stat.isFile()) return false;

        await fse.access(filePath, fs.constants.R_OK);

        return true;
    } catch (error) {
        return false;
    }
}

async function directoryExists(directoryPath) {
    try {
        const stat = await fse.stat(directoryPath);

        if (!stat.isDirectory()) return false;

        await fse.access(directoryPath, fs.constants.R_OK);

        return true;
    } catch (error) {
        return false;
    }
}


module.exports = {
    fileExists,
    directoryExists
};
