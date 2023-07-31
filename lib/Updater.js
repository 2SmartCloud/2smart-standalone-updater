/* eslint-disable max-len */
const EE            = require('events');
const fs            = require('fs');
const childProcess  = require('child_process');
const { promisify } = require('util');
const path          = require('path');
const dotenv        = require('dotenv');

const Promise       = require('bluebird');
const YAML          = require('yaml');
const Docker        = require('dockerode');
const _merge        = require('lodash/merge');
const _diff         = require('lodash/difference');
const _reverse      = require('lodash/reverse');
const _slice        = require('lodash/slice');
const { CronJob }   = require('cron');

const MQTT          = require('homie-sdk/lib/Broker/mqtt');
const Homie         = require('homie-sdk/lib/homie/Homie');
const HomieServer   = require('homie-sdk/lib/homie/HomieServer');
const HomieMigrator = require('homie-sdk/lib/homie/HomieMigrator');
const Debugger      = require('homie-sdk/lib/utils/debugger');
const X             = require('homie-sdk/lib/utils/X');

const {
    NOT_FOUND,
    UNKNOWN_ERROR
} = require('homie-sdk/lib/utils/errors');

const ReleaseApi   = require('./ReleaseApi');
const stateManager = require('./stateManager');
const config       = require('./../etc/config');

// async function exec(cmd, options) {
//     console.log({
//         func : 'EXEC',
//         cmd,
//         options
//     });

//     return { stderr: 'STDERR', stdout: 'STROUT' };
// }

const exec      = promisify(childProcess.exec);
const readdir   = promisify(fs.readdir);
const writeFile = promisify(fs.writeFile);

const dockerComposeYml = 'docker-compose.yml';
const envFile = '.env';

class Updater extends EE {
    constructor() {
        super();
        this.mqttCreds   = config.mqtt;
        this.homie       = new Homie({ transport: new MQTT({ ...this.mqttCreds }) });
        this.homieServer = new HomieServer({ homie: this.homie });
        this.homieMigrator = new HomieMigrator({ homie: this.homie });

        const debugConfig = process.env.DEBUG || '*';
        this.debug        = new Debugger(debugConfig);

        this.debug.initEvents();

        this.docker = new Docker({ socketPath: '/var/run/docker.sock' });

        this.releaseApi = new ReleaseApi(config.releaseApi);

        this.entityType         = 'SYSTEM_UPDATES';
        this.rootTopic          = undefined;
        this.errorTopic         = undefined;
        this.entityId           = 'services';
        this.serviceName        = '2smart-updater';
        this.serviceManagerName = '2smart-updater-manager';

        this.services = {};

        // yml files to ignore on docker-compose parse
        this.ignoreFiles = config.ignoreYmlFiles.split(';').map(filename => filename.replace('.yml', ''));

        this.handleSetEvent     = this.handleSetEvent.bind(this);
        this.checkForUpdate     = this.checkForUpdate.bind(this);
        this.handleCronTask     = this.handleCronTask.bind(this);
        this._checkSystemStatus = this._checkSystemStatus.bind(this);

        this.cronJob = undefined;

        this.defaultEnvPath     = `${config.systemDir}/${envFile}`;
        this.defaultComposePath = `${config.systemDir}/${dockerComposeYml}`;

        this.debug.info('Updater.constructor');
    }

    async init() {
        this.debug.info('Updater.init');

        try {
            await stateManager.init();
            await this.homieServer.initWorld();
            await this.sync();

            this.rootTopic  = this.homie.getEntityRootTopicByType(this.entityType);
            this.errorTopic = `${this.homie.errorTopic}/${this.rootTopic}`;

            // find entity or create
            try {
                this.entity = this.homie.getEntityById(this.entityType, this.entityId);
            } catch (e) {
                this.debug.info('Updater.init', 'Entity not found! Creating default...');
                const state = await stateManager.getState();

                const updatedAt = new Date(state.updated_at).getTime();
                this.entity = await this.homieMigrator.attachEntity(this.entityType, {
                    id            : this.entityId,
                    status        : 'up-to-date',
                    'last-update' : updatedAt
                });
            }

            if (!this.entity) throw new NOT_FOUND('SYSTEM_UPDATES entity not found!');

            await this._checkSystemStatus();

            this.entity.onAttributeSet(this.handleSetEvent);

            // check system status on reconnect to broker
            this.homie.on('online', this._checkSystemStatus);

            // midnight job to check for updates
            this.cronJob = new CronJob('0 0 * * *', this.handleCronTask);

            await this._removeRelatedServiceManager(); // remove the container which restarts 2smart-updater

            this.debug.info('Updater.init', 'finish');
        } catch (e) {
            this.debug.error(e);
            process.exit(1);
        }
    }

    async sync() {
        this.debug.info('Updater.sync');

        await this.syncComposeFiles();
        await Promise.all(Object.keys(this.services).map(async name => {
            const service = this.services[name];
            const { image, container } = service;

            this.debug.info('Updater.sync', `Check image digest - ${image}`);

            try {
                const { Id } = await this.docker.getImage(image).inspect();

                service.digest.image = Id;
            } catch (e) {
                this.debug.info('Updater.sync.getImage', e);
            }

            this.debug.info('Updater.sync', `Check image digest in container - ${container}`);

            try {
                const { Image, Config: { Labels, Image: containerImage } } = await this.docker.getContainer(container).inspect();
                service.digest.container = Image;
                service.containerImage = containerImage;

                // define project name to use same docker-compose context in container
                // default project name equals dir name where docker-compose is stored
                if (Labels['com.docker.compose.project'] && !this.projectName) {
                    this.projectName = Labels['com.docker.compose.project'] || '2smart';
                }
            } catch (e) {
                this.debug.info('Updater.sync.getContainer', e);
            }
        }));

        this.debug.info('Updater.sync', 'Finish');
    }

    _getDateFromVersion(version) {
        return version.split('-').slice(0, -1).join('-');
    }

    async checkForUpdate() {
        this.debug.info('Updater.checkForUpdate');

        try {
            const latestVersion = await this.releaseApi.getLatestVersion();
            const { version } = await stateManager.getState();

            if (version !== latestVersion) {
                this.debug.info('Updater.checkForUpdate', `update available: ${latestVersion}`);
                this.entity.publish({
                    event              : 'check',
                    status             : 'download-available',
                    'available-update' : new Date(this._getDateFromVersion(latestVersion)).getTime()
                });

                await stateManager.setState({ available_version: latestVersion });

                return;
            }
        } catch (e) {
            this.debug.info('Updater.checkForUpdate', e);
        }
        this.entity.publish({
            status : 'up-to-date',
            event  : 'check'
        });
    }

    async updateServices() {
        this.debug.info('Updater.updateServices', 'start');

        await this.sync();

        const beforeUpdateStatus = this.getEntityStatus();
        try {
            this.debug.info('Updater.updateServices', `Before update - ${beforeUpdateStatus}`);

            this.entity.publish({
                event  : 'update',
                status : 'updating'
            });

            await this.syncComposeFiles();

            this.debug.info('Updater.updateServices', 'Compose synced!');
            this.debug.info('Updater.updateServices', `Project name - ${this.projectName}`);

            // possible error when project name is not defined
            // an error will occur on "docker-compose up -d" execution
            if (!this.projectName) throw new UNKNOWN_ERROR('Project name is not defined!');

            const servicesToUpdate = [];
            let selfUpdate = false;

            this.debug.info('Updater.updateServices', 'Filter services to update');

            for (const name in this.services) {
                const {
                    image,
                    containerImage,
                    digest: {
                        image     : imageDigest,
                        container : containerDigest
                    }
                } = this.services[name];

                // Is service should be updated
                if (imageDigest !== containerDigest || image !== containerImage) {
                    // To update service itself it should trigger 2smart-updater-manager service
                    // because when docker-compose should update container config it kills it
                    // and 2smart-updater can't update itself
                    if (name === this.serviceName) {
                        selfUpdate = true;

                        continue;
                    }

                    servicesToUpdate.push(name);
                }
            }

            this.debug.info('Updater.updateServices', `2smart-updater update available - ${selfUpdate}`);
            this.debug.info('Updater.updateServices updating', { servicesToUpdate });

            if (servicesToUpdate.length) {
                this.debug.info('Updater.updateServices', `Executing: docker-compose -f ${dockerComposeYml} ${this._getFilesCmd()} -p ${this.projectName} --env-file ${envFile} up -d --force-recreate --remove-orphans ${servicesToUpdate.join(' ')}`);
                // run with -p flag to be able to work with containers that was created on server
                // running this command without flag will create conflict between same services
                const { stdout, stderr } = await exec(
                    `docker-compose -f ${dockerComposeYml} ${this._getFilesCmd()} -p ${this.projectName} --env-file ${envFile} up -d --force-recreate --remove-orphans ${servicesToUpdate.join(' ')}`,
                    { cwd: config.systemDir }
                );

                if (stderr) this.debug.info('Updater.updateServices.stderr', stderr);
                if (stdout) this.debug.info('Updater.updateServices.stdout', stdout);

                this.debug.info('Updater.updateServices', 'System services updated!');
            }

            await this.downloadChangelogs();
            const { available_version } = await stateManager.getState();

            await stateManager.setState({ version: available_version });

            if (selfUpdate) {
                this.debug.info('Updater.updateServices', 'Updating 2smart-updater...');
                this.debug.info('Updater.updateServices', `Executing: docker-compose -p ${this.projectName} run -e DOCKER_COMPOSE_PATH=${this.defaultComposePath} -e PROJECT_NAME=${this.projectName} -e ENV_PATH=${this.defaultEnvPath} --entrypoint /app/run.sh --rm ${this.serviceManagerName}`);

                await this._selfRecreate();
            }

            await this._setSystemUpdated();
        } catch (e) {
            this.entity.publishAttribute('status', beforeUpdateStatus);
            this.debug.error(e);
            throw e;
        }

        this.debug.info('Updater.updateServices', 'Clear cache');

        // clear cached info about services after update
        this._clearStateCache();

        try {
            this.debug.info('Updater.updateServices.pruneImages', 'start');

            await this.docker.pruneImages();

            this.debug.info('Updater.updateServices.pruneImages', 'finish');
        } catch (e) {
            this.debug.warning('Updater.updateServices.pruneImages', e);
        }

        this.debug.info('Updater.updateServices', 'finish');
    }

    async restartSystem() {
        this.debug.info('Updater.restartSystem');

        const beforeRestartStatus = this.getEntityStatus();

        this.debug.info('Updater.restartSystem', `Before restart - ${beforeRestartStatus}`);

        this.entity.publish({
            event  : 'restart',
            status : 'restarting'
        });

        await this.syncComposeFiles();

        let servicesToRestart = [];
        let selfRestart = false;

        for (const name in this.services) {
            if (!config.ignoreRestart.includes(name)) servicesToRestart.push(name);
        }

        if (servicesToRestart.includes(this.serviceName)) {
            selfRestart = true;
            servicesToRestart = servicesToRestart.filter(serviceName => serviceName !== this.serviceName);
        }

        this.debug.info('Updater.restartSystem', 'restart');

        try {
            // run with -p flag to be able to work with containers that was created on server
            // running this command without flag will create conflict between same services
            const { stderr, stdout } = await exec(
                `docker-compose -f ${dockerComposeYml} ${this._getFilesCmd()} -p ${this.projectName} --env-file ${envFile} up -d --force-recreate --remove-orphans ${servicesToRestart.join(' ')}`,
                { cwd: config.systemDir }
            );

            if (stderr) this.debug.info('Updater.restartSystem.stderr', stderr);
            if (stdout) this.debug.info('Updater.restartSystem.stdout', stdout);

            this.entity.publishAttribute('status', beforeRestartStatus);
        } catch (e) {
            this.entity.publishAttribute('status', beforeRestartStatus);
            this.debug.error(e);
            throw e;
        } finally {
            if (selfRestart) {
                await this._selfRecreate();
            }
        }

        this.debug.info('Updater.restartSystem', 'finish');
    }

    handleSetEvent(data) {
        this.debug.info('Updater.handleSetEvent', 'start');
        const { field, value, entity } = data;

        this.debug.info('Updater.handleSetEvent', { field, value });

        try {
            switch (field) {
                case 'event':
                    this._handleEvent(value);
                    break;
                default:
                    break;
            }
        } catch (e) {
            this.debug.warning('Updater.handleSetEvent', e);
            entity.publishError(field, this.prepareError(e));
        }
    }

    getEntityStatus() {
        return this.entity.getAttribute('status') || 'up-to-date';
    }

    async downloadUpdate() {
        this.debug.info('Updater.downloadUpdate', 'start');

        this.entity.publish({
            status : 'downloading',
            event  : 'download'
        });

        await this.downloadDockerCompose();
        await this.sync();

        this.debug.info('Updater.downloadUpdate', this.services);

        try {
            await Promise.all(Object.keys(this.services).map(async name => {
                const service = this.services[name];
                const { image } = service;

                this.debug.info('Updater.downloadUpdate', `Start of download - ${name}(${image})`);

                const stream = await this.docker.pull(image);

                let stdout = '';

                await new Promise((resolve) => {
                    const go = () => {
                        stream.off('close', go);
                        stream.off('end', go);
                        resolve();
                    };
                    stream.on('data', data => stdout += data.toString());
                    stream.on('close', go);
                    stream.on('end', go);
                    stream.on('error', e => this.debug.warning('Updater.downloadUpdate.error', e));
                });

                const { Id, Created } = await this.docker.getImage(image).inspect();

                // update image digest and creation date after pull
                service.digest.image = Id;
                service.createdAt = new Date(Created).getTime();

                this.debug.info('Updater.downloadUpdate.stdout', stdout);
                this.debug.info('Updater.downloadUpdate', `End of download - ${name}(${image})`);
            }));
        } catch (e) {
            this.entity.publishAttribute('status', 'download-available');
            this.debug.warning('Updater.downloadUpdate', e);
            throw e;
        }

        this.entity.publishAttribute('status', 'update-available');
        this.debug.info('Updater.downloadUpdate', 'Finish');
    }

    _handleEvent(value) {
        switch (value) {
            case 'check':
                this.checkForUpdate();
                break;
            case 'download':
                this.downloadUpdate();
                break;
            case 'update':
                this.updateServices();
                break;
            case 'restart':
                this.restartSystem();
                break;
            default:
                break;
        }
    }

    prepareError(error) {
        if (!(error instanceof X)) error = new X({ code: UNKNOWN_ERROR, fields: {}, message: 'Something went wrong' });

        return error;
    }

    handleCronTask() {
        try {
            this.checkForUpdate();
        } catch (e) {
            this.debug.error(e);
        }
    }

    async syncComposeFiles() {
        this.debug.info('Updater.syncComposeFiles', 'start');

        const data = fs.readFileSync(`${config.systemDir}/${dockerComposeYml}`, 'utf-8');
        const { services } = YAML.parse(data);

        const files = await readdir(config.systemDir);

        this.additionalComposeFiles = [];

        for (const file of files) {
            const filePath = path.join(config.systemDir, file);
            const { ext, name } = path.parse(filePath);

            // ignore non .yml file
            // ignore main docker-compose file
            // ignore files from env config
            if (ext === '.yml' && name !== 'docker-compose' && !this.ignoreFiles.includes(name)) this.additionalComposeFiles.push(filePath);
        }

        this.additionalComposeFiles.sort();

        this.additionalComposeFiles.forEach(file => {
            const fileData = fs.readFileSync(file, 'utf-8');
            const {
                services : overwrite
            } = YAML.parse(fileData);

            _merge(services, overwrite);
        });

        if (this.additionalComposeFiles.length) this.debug.info('Updater.syncComposeFiles.additionalComposeFiles', this.additionalComposeFiles);

        // delete orphan services from collection
        _diff(Object.keys(this.services), Object.keys(services))
            .forEach(orphanService => delete this.services[orphanService]);

        for (const name in services) {
            const defaultState = this.services[name] || {
                name           : undefined,
                image          : undefined,
                container      : undefined,
                containerImage : undefined,
                createdAt      : undefined,
                updatedAt      : undefined,
                digest         : {
                    image     : undefined, // image digest in system
                    registry  : undefined, // image digest in registry
                    container : undefined  // image digest in container
                }
            };

            const image = this._resolveEnvVariable(services[name].image);

            this.services[name] = {
                ...defaultState,
                name,
                image,
                container : services[name].container_name
            };
        }

        this.debug.info('Updater.syncComposeFiles', this.services);
    }

    _resolveEnvVariable(data) {
        let res = data;

        const envVars = dotenv.config({ path: this.defaultEnvPath }).parsed;
        const regex = /\$\{([^}^{]+)\}/g;
        const match = regex.exec(res);

        if (!match) return res;

        // split string by :- to check for default value
        const split = match[1].split(':-');

        switch (split.length) {
            case 1: // no default value
                res = res.replace(match[0], envVars[split[0]] || '');
                break;
            case 2: // default value specified
                res = res.replace(match[0], envVars[split[0]] || split[1]);
                break;
            default:
                break;
        }

        return res;
    }

    async _setSystemUpdated() {
        const time = Date.now();
        this.entity.publish({
            status        : 'up-to-date',
            'last-update' : time
        });

        await stateManager.setState({ updated_at: time });
    }

    async _checkSystemStatus() {
        this.debug.info('Updater._checkSystemStatus', 'start');
        const status = this.entity.getAttribute('status');

        this.debug.info('Updater._checkSystemStatus', `Current status - ${status}`);

        switch (status) {
            case 'downloading':
                this.entity.publishAttribute('status', 'update-available');
                break;
            case 'updating':
                await this._setSystemUpdated();
                break;
            case 'restarting':
                this.entity.publishAttribute('status', 'up-to-date');
                break;
            default:
                break;
        }

        this.debug.info('Updater._checkSystemStatus', 'finish');
    }

    _getFilesCmd() {
        return this.additionalComposeFiles.length ? `-f ${this.additionalComposeFiles.join(' -f ')}` : '';
    }

    async _selfRecreate() {
        this.debug.info('Updater._selfRecreate', 'start');

        // this will recreate 2smart-updater service
        // NOTE: env variables in "2smart-updater-manager" container will override envs in .env file
        // NOTE is related to bug with DOCKER_COMPOSE_PATH env (etc/config.js => releaseApi.DOCKER_COMPOSE_PATH)
        const { stdout, stderr } = await exec(
            `docker-compose -p ${this.projectName} run ` +
            `-e DOCKER_COMPOSE_PATH=${this.defaultComposePath} ` +
            `-e PROJECT_NAME=${this.projectName} ` +
            `-e ENV_PATH=${this.defaultEnvPath} ` +
            `--entrypoint /app/run.sh ${this.serviceManagerName}`,
            { cwd: config.systemDir }
        );

        if (stdout) this.debug.info('Updater._selfRecreate.stdout', stdout);
        if (stderr) this.debug.warning('Updater._selfRecreate.stderr', stderr);

        this.debug.info('Updater._selfRecreate', 'finish');
    }

    async _removeRelatedServiceManager() {
        this.debug.info('Updater._removeRelatedServiceManager', 'start');

        const { stdout, stderr } = await exec(
            `docker-compose -p ${this.projectName} ` +
            `rm -f ${this.serviceManagerName}`,
            { cwd: config.systemDir }
        );

        if (stdout) this.debug.info('Updater._removeRelatedServiceManager.exec.stdout', stdout);
        if (stderr) this.debug.info('Updater._removeRelatedServiceManager.exec.stderr', stderr);

        this.debug.info('Updater._removeRelatedServiceManager', 'finish');
    }

    _clearStateCache() {
        this.services = {};
    }

    async downloadDockerCompose() {
        try {
            this.debug.info('Updater.downloadDockerCompose', 'Start');

            const data = await this.releaseApi.getDockerCompose();
            const { services } = YAML.parse(data);

            if (!services) throw new Error('Wrong docker-compose format');

            await writeFile(`${config.systemDir}/${dockerComposeYml}`, data);

            this.debug.info('Updater.downloadDockerCompose', 'Finish');
        } catch (e) {
            this.debug.error(e);

            throw new X({
                code    : UNKNOWN_ERROR,
                fields  : {},
                message : 'Failed to download configuration files'
            });
        }
    }

    async downloadChangelogs() {
        try {
            this.debug.info('Updater.downloadChangelogs', 'Start');

            const data = await this.releaseApi.getReleaseList();
            const list = _slice(_reverse(data.replace('\n', '').split(',')), 0, 3);

            this.debug.info('Updater.downloadChangelogs', list);

            const changelogs = await Promise.all(list.map(changelog => {
                return this.releaseApi.getChangelog(changelog);
            }));

            await Promise.all(changelogs.map((changelog, key) => {
                writeFile(`${config.systemDir}/${config.changelogPath}/${config.changelogFilenames[key]}.md`, changelog);
            }));

            this.debug.info('Updater.downloadChangelogs', 'Finish');
        } catch (e) {
            this.debug.error(e);

            throw new X({
                code    : UNKNOWN_ERROR,
                fields  : {},
                message : 'Failed to download changelogs'
            });
        }
    }
}

module.exports = Updater;
