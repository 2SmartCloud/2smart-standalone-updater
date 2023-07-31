FROM docker:stable AS docker-stage
FROM node:14.18.2-slim

RUN echo "deb http://archive.debian.org/debian stretch main" > /etc/apt/sources.list

RUN apt-get update && apt-get -y install git apt-transport-https curl

WORKDIR /app

COPY --from=docker-stage /usr/local/bin/docker /usr/local/bin/docker

COPY compose-downloader.sh /compose-downloader.sh
RUN /compose-downloader.sh
RUN chmod +x /usr/local/bin/docker-compose

COPY etc etc
COPY lib lib
COPY app.js app.js
COPY runner.js runner.js
COPY package.json package.json
COPY package-lock.json package-lock.json

RUN npm i --production

CMD npm start
