# 2smart-updater

Service for checking for system updates, downloading updates and restarting services.
The service runs in docker and controls the operation of other services through docker.

`docker.sock` file must be in `/var/run/docker.sock`

Services configs (`docker-compose.yml` and `.env` files) are read from the folder specified in the config

## Configs
`mqtt`: permissions to the mqtt broker

* `uri` - URL to connect to the broker
* `username` - login to connect
* `password` - password to connect

* `systemDir` - folder with `docker-compose.yml` and `.env` configs
* `ignoreYmlFiles` - files to ignore when parsing services. Format: 'docker-compose.1.yml;docker-compose.2.yml'
* `ignoreRestart` - an array of services that will be ignored on a system restart event

## Multi-stage builds for arm32v7 and amd64:

1. Build images for AMD and ARM (you need to build an ARM image on the target platform):

    ```
    docker build --file Dockerfile -t <IMAGE>:latest-amd64  --build-arg ARCH=amd64/ .
    docker build --file Dockerfile.arm32 -t <IMAGE>:latest-arm32v7  --build-arg ARCH=arm32v7/ .
    ```

2. Push to registry:

    ```
    docker push <IMAGE>:latest-amd64
    docker push <IMAGE>:latest-arm32v7
    ```

3. Compile docker manifest:

    ```
    docker manifest create \
    <IMAGE>:latest \
        --amend <IMAGE>:latest-amd64 \
        --amend <IMAGE>:latest-arm32v7
    ```

4. Push manifest to registry:

    ```
    docker manifest push <IMAGE>:latest
    ```
