const request = require('request-promise');

class ReleaseApi {
    constructor({ STORAGE_URL, CHANGELOG_PATH, DOCKER_COMPOSE_PATH, RELEASES_LIST_PATH }) {
        this.STORAGE_URL         = STORAGE_URL;
        this.CHANGELOG_PATH      = CHANGELOG_PATH;
        this.RELEASES_LIST_PATH  = RELEASES_LIST_PATH;
        this.DOCKER_COMPOSE_PATH = DOCKER_COMPOSE_PATH;
    }

    getDockerCompose() {
        return request({
            uri : `${this.STORAGE_URL}/${this.DOCKER_COMPOSE_PATH}`
        });
    }

    getReleaseList() {
        return request({
            uri : `${this.STORAGE_URL}/${this.RELEASES_LIST_PATH}`
        });
    }

    getChangelog(filename) {
        if (!filename) throw new Error('Filename is required!');

        return request({
            uri : `${this.STORAGE_URL}/${this.CHANGELOG_PATH}/${filename}`
        });
    }

    async getLatestVersion() {
        const releasesString = await request({
            uri : `${this.STORAGE_URL}/${this.RELEASES_LIST_PATH}`
        });
        const releases = releasesString.split(',');
        const [ latestRelease ] = releases[releases.length - 1].split('.');

        return latestRelease;
    }
}

module.exports = ReleaseApi;
