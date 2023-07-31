#!/bin/sh

KERNEL_NAME=$(uname -s)
MACHINE=$(uname -m)

if [ $MACHINE = "armv7l" ]; then
    KERNEL_NAME=linux
    MACHINE=armv7
fi

echo "https://github.com/docker/compose/releases/download/v2.2.2/docker-compose-$KERNEL_NAME-$MACHINE"

curl -sfL "https://github.com/docker/compose/releases/download/1.25.5/docker-compose-$(uname -s)-$(uname -m)" -o /usr/local/bin/docker-compose