# The web wallet as a static site behind nginx. Railway builds this (railway up); nothing in the
# image is secret and the page talks only to the Koinos node the user picks.
FROM node:22-alpine AS build
RUN apk add --no-cache git \
 && git config --global url."https://github.com/".insteadOf "ssh://git@github.com/"
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . .
ARG RAILWAY_GIT_COMMIT_SHA
ENV RAILWAY_GIT_COMMIT_SHA=$RAILWAY_GIT_COMMIT_SHA
RUN npm run build

FROM nginx:1.27-alpine
# the official image renders *.template with envsubst at start, so nginx listens on Railway's $PORT
ENV PORT=80
COPY deploy/default.conf.template /etc/nginx/templates/default.conf.template
COPY deploy/headers.conf /etc/nginx/headers.conf
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 80
