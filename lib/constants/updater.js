const STATUSES = {
    FREE     : 'FREE',
    UPDATING : 'UPDATING',
    CHECKING : 'CHECKING'
};

const STAGES = {
    SYNC_SERVICES            : 'SYNC_SERVICES',
    PULL_IMAGES              : 'PULL_IMAGES',
    DOWNLOAD_DOCKER_COMPOSES : 'DOWNLOAD_DOCKER_COMPOSES',
    RECREATE_SERVICES        : 'RECREATE_SERVICES',
    EMPTY                    : ''
};

module.exports = {
    STATUSES,
    STAGES
};
