module.exports = {
    mqtt : {
        uri      : process.env.MQTT_URI  || 'mqtt://localhost:1883',
        username : process.env.MQTT_USER || '',
        password : process.env.MQTT_PASS || ''
    },
    releaseApi : {
        STORAGE_URL         : `https://${process.env.SMART_DOMAIN || ''}`,
        CHANGELOG_PATH      : process.env.CHANGELOG_PATH      || 'releases/changelog',
        DOCKER_COMPOSE_PATH : process.env.DOWNLOAD_DOCKER_COMPOSE_PATH || 'releases/docker-compose.yml',
        RELEASES_LIST_PATH  : process.env.RELEASES_LIST_PATH  || 'releases/releases-list.csv'
    },
    systemDir          : '/2smart',
    ignoreYmlFiles     : process.env.IGNORE_YML_FILES || '',
    ignoreRestart      : [],
    changelogFilenames : {
        0 : 'current',
        1 : 'previous',
        2 : 'old'
    },
    changelogPath : 'system/changelogs',
    dataDir       : 'system/updater'
};
